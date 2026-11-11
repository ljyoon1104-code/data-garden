import { SaxesParser, type SaxesTagNS } from "saxes";
import * as XLSX from "xlsx";
import { openXlsxArchive, partSegment, xlsxZipLimits, type XlsxArchive } from "./xlsx-zip";

const MiB = 1024 * 1024;
const partLimits = {
  metadata: MiB,
  styles: 4 * MiB,
  strings: 16 * MiB,
  sheet: 32 * MiB,
};
const logicalTextLimit = 16 * MiB;
const displayBudget = 64 * MiB;
const sheetNamespaces = [
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
];
const officeRelationships = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
];
const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypes = "http://schemas.openxmlformats.org/package/2006/content-types";
const workbookType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

function invalidXlsx(): never {
  throw new Error("유효한 XLSX 통합 문서가 아닙니다. XML과 시트 참조가 손상되지 않은 XLSX로 다시 저장하세요.");
}

function tableLimit(): never {
  throw new Error("XLSX 시트가 50,000행·200열·500,000셀 한도를 넘었습니다. 시트를 나누어 다시 열어 주세요.");
}

function textLimit(): never {
  throw new Error("XLSX 셀 텍스트 또는 표시 형식의 확장 한도를 넘었습니다. 긴 문자열과 서식을 줄이거나 시트를 나누세요.");
}

function attribute(tag: SaxesTagNS, name: string): string | undefined {
  return tag.attributes[name]?.value;
}

interface XmlOptions {
  root: string;
  namespaces: string[];
  maxElements: number;
  open?: (tag: SaxesTagNS, parent: SaxesTagNS | undefined) => void;
  close?: (tag: SaxesTagNS) => void;
  text?: (text: string) => void;
}

function scanXml(bytes: Uint8Array<ArrayBuffer>, options: XmlOptions) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 60 && bytes[1] === 0
    ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 60
      ? "utf-16be"
      : "utf-8";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return invalidXlsx();
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  let elements = 0, attributes = 0;
  const xmlLimit = () => {
    throw new Error("XLSX XML 요소 또는 중첩 한도를 넘었습니다. 파일을 나누거나 다시 저장하세요.");
  };
  parser.on("error", invalidXlsx);
  parser.on("doctype", invalidXlsx);
  parser.on("opentagstart", (tag) => {
    if (++elements > options.maxElements || stack.length >= 64 || tag.name.length > 256) xmlLimit();
    attributes = 0;
  });
  parser.on("attribute", (attr) => {
    if (++attributes > 96 || attr.name.length > 256 || attr.value.length > 65536) xmlLimit();
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (!parent && (tag.local !== options.root || !options.namespaces.includes(tag.uri))) invalidXlsx();
    options.open?.(tag, parent);
    stack.push(tag);
  });
  parser.on("closetag", (tag) => {
    options.close?.(tag);
    stack.pop();
  });
  if (options.text) {
    parser.on("text", options.text);
    parser.on("cdata", options.text);
  }
  for (let offset = 0; offset < text.length; offset += 8192)
    parser.write(text.slice(offset, offset + 8192));
  parser.close();
}

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

function resolvePart(base: string, target: string): string {
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const raw of target.replace(/^\//, "").split("/")) {
    const segment = partSegment(raw);
    if (segment === "..") {
      if (!parts.length) invalidXlsx();
      parts.pop();
    } else if (segment !== ".") parts.push(segment);
  }
  if (!parts.length) invalidXlsx();
  return parts.join("/");
}

function relationKind(relation: Relationship, kind: string) {
  return officeRelationships.some((ns) => relation.type === `${ns}/${kind}`);
}

async function readRelationships(archive: XlsxArchive, path: string) {
  const relationships = new Map<string, Relationship>();
  scanXml(await archive.read(path, partLimits.metadata), {
    root: "Relationships",
    namespaces: [packageRelationships],
    maxElements: 2048,
    open(tag, parent) {
      if (tag.local !== "Relationship" || tag.uri !== packageRelationships || parent?.local !== "Relationships" || parent.uri !== packageRelationships) return;
      const id = attribute(tag, "Id");
      const type = attribute(tag, "Type");
      const target = attribute(tag, "Target");
      if (!id || !type || !target || relationships.has(id)) invalidXlsx();
      const mode = attribute(tag, "TargetMode");
      if (mode !== undefined && mode !== "Internal" && mode !== "External") invalidXlsx();
      relationships.set(id, { type, target, external: mode === "External" });
    },
  });
  return relationships;
}

function relatedPart(relationships: Map<string, Relationship>, from: string, kind: string) {
  const matches = [...relationships.values()].filter((relation) => relationKind(relation, kind));
  if (matches.length > 1 || matches[0]?.external) invalidXlsx();
  return matches[0] ? resolvePart(from, matches[0].target) : undefined;
}

async function readWorkbook(archive: XlsxArchive) {
  const root = await readRelationships(archive, "_rels/.rels");
  const path = relatedPart(root, "", "officeDocument");
  if (!path) invalidXlsx();
  let recognized = false;
  scanXml(await archive.read("[Content_Types].xml", partLimits.metadata), {
    root: "Types",
    namespaces: [contentTypes],
    maxElements: 2048,
    open(tag, parent) {
      const name = attribute(tag, "PartName");
      if (tag.local !== "Override" || tag.uri !== contentTypes || parent?.local !== "Types" || parent.uri !== contentTypes || !name) return;
      if (resolvePart("", name).toLowerCase() !== path.toLowerCase()) return;
      if (recognized || attribute(tag, "ContentType") !== workbookType) invalidXlsx();
      recognized = true;
    },
  });
  if (!recognized) invalidXlsx();

  const sheets: Array<{ name: string; id: string }> = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  let date1904 = false;
  scanXml(await archive.read(path, partLimits.metadata), {
    root: "workbook",
    namespaces: sheetNamespaces,
    maxElements: 8192,
    open(tag, parent) {
      if (!sheetNamespaces.includes(tag.uri)) return;
      if (parent?.local === "workbook" && sheetNamespaces.includes(parent.uri) && tag.local === "workbookPr") {
        const value = attribute(tag, "date1904");
        if (value !== undefined && !["0", "1", "false", "true"].includes(value)) invalidXlsx();
        date1904 = value === "1" || value === "true";
      }
      if (parent?.local !== "sheets" || !sheetNamespaces.includes(parent.uri) || tag.local !== "sheet") return;
      const name = attribute(tag, "name");
      const id = Object.values(tag.attributes).find((attr) =>
        attr.local === "id" && officeRelationships.includes(attr.uri))?.value;
      if (!name || !id || name.length > 31 || names.has(name.toLowerCase()) || ids.has(id)) invalidXlsx();
      names.add(name.toLowerCase());
      ids.add(id);
      sheets.push({ name, id });
    },
  });
  const slash = path.lastIndexOf("/") + 1;
  const relationships = await readRelationships(archive, `${path.slice(0, slash)}_rels/${path.slice(slash)}.rels`);
  const worksheets = new Map<string, string>();
  for (const sheet of sheets) {
    const relationship = relationships.get(sheet.id);
    if (!relationship) invalidXlsx();
    if (!relationKind(relationship, "worksheet")) continue;
    if (relationship.external) invalidXlsx();
    worksheets.set(sheet.name, resolvePart(path, relationship.target));
  }
  if (!worksheets.size) invalidXlsx();
  return { path, worksheets, relationships, date1904 };
}

export async function readXlsxSheetNames(bytes: ArrayBuffer): Promise<string[]> {
  const { worksheets } = await readWorkbook(openXlsxArchive(bytes));
  return [...worksheets.keys()];
}

function position(ref: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
  if (!match) invalidXlsx();
  const row = Number(match[2]);
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  if (row > 1048576 || column > 16384) invalidXlsx();
  return { row, column };
}

function rectangle(ref: string) {
  const [start, end = start, extra] = ref.split(":");
  if (extra !== undefined) invalidXlsx();
  const a = position(start), b = position(end);
  if (a.row > b.row || a.column > b.column) invalidXlsx();
  return { a, b };
}

function integer(value: string, minimum: number, maximum: number) {
  if (!/^\d{1,8}$/.test(value)) invalidXlsx();
  const result = Number(value);
  if (result < minimum || result > maximum) invalidXlsx();
  return result;
}

function xmlEscape(text: string) {
  return text.replace(/[&<>"\r]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\r": "&#13;",
  })[character]!);
}

function xmlOutput(maximum: number) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  let buffer = new Uint8Array(Math.min(16 * 1024, maximum));
  let used = 0;
  function nextBuffer() {
    if (used) chunks.push(buffer.subarray(0, used));
    buffer = new Uint8Array(Math.min(16 * 1024, maximum - length));
    used = 0;
  }
  return {
    add(part: string) {
      if (part.length > maximum - length) textLimit();
      let position = 0;
      while (position < part.length) {
        const { read, written } = encoder.encodeInto(part.slice(position), buffer.subarray(used));
        if (!read) {
          if (!used || length === maximum) textLimit();
          nextBuffer();
          continue;
        }
        position += read;
        used += written;
        length += written;
        if (used === buffer.length && position < part.length) nextBuffer();
      }
    },
    encode() {
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      result.set(buffer.subarray(0, used), offset);
      return result;
    },
  };
}

function sheetTag(tag: SaxesTagNS, parent: SaxesTagNS | undefined, name: string, inTag: string) {
  if (tag.local !== name || parent?.local !== inTag) return false;
  if (!sheetNamespaces.includes(tag.uri) || !sheetNamespaces.includes(parent.uri)) invalidXlsx();
  return true;
}

function parseStyles(bytes: Uint8Array<ArrayBuffer>) {
  const formats = new Map<number, string>();
  const numberFormats: number[] = [];
  scanXml(bytes, {
    root: "styleSheet", namespaces: sheetNamespaces, maxElements: 200000,
    open(tag, parent) {
      if (sheetTag(tag, parent, "numFmt", "numFmts")) {
        const id = integer(attribute(tag, "numFmtId") ?? "", 0, 65535);
        const format = attribute(tag, "formatCode");
        if (!format || format.length > 1024 || formats.has(id)) invalidXlsx();
        formats.set(id, format);
      }
      if (sheetTag(tag, parent, "xf", "cellXfs")) {
        if (numberFormats.length === 65536) tableLimit();
        numberFormats.push(integer(attribute(tag, "numFmtId") ?? "0", 0, 65535));
      }
    },
  });
  const output = xmlOutput(partLimits.styles);
  output.add(`<styleSheet xmlns="${sheetNamespaces[0]}"><numFmts>`);
  for (const [id, format] of formats)
    output.add(`<numFmt numFmtId="${id}" formatCode="${xmlEscape(format)}"/>`);
  output.add("</numFmts><cellXfs>");
  for (const id of numberFormats) output.add(`<xf numFmtId="${id}"/>`);
  output.add("</cellXfs></styleSheet>");
  const builtIn: Record<number, string> = XLSX.SSF.get_table();
  return { content: output.encode(), formats: numberFormats.map((id) => formats.get(id) ?? builtIn[id] ?? "General") };
}

function parseStrings(bytes: Uint8Array<ArrayBuffer>) {
  const output = xmlOutput(partLimits.strings);
  output.add(`<sst xmlns="${sheetNamespaces[0]}">`);
  const lengths: number[] = [];
  let text = "";
  let stringTag: SaxesTagNS | undefined, textTag: SaxesTagNS | undefined;
  scanXml(bytes, {
    root: "sst", namespaces: sheetNamespaces, maxElements: 1000000,
    open(tag, parent) {
      if (sheetTag(tag, parent, "si", "sst")) {
        if (stringTag) invalidXlsx();
        if (lengths.length >= 500000) tableLimit();
        stringTag = tag;
        text = "";
      }
      if (stringTag && (sheetTag(tag, parent, "t", "si") || sheetTag(tag, parent, "t", "r")))
        textTag = tag;
    },
    close(tag) {
      if (tag === textTag) textTag = undefined;
      if (tag === stringTag) {
        lengths.push(text.length);
        output.add(`<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`);
        stringTag = undefined;
      }
    },
    text(fragment) {
      if (!textTag) return;
      if (text.length + fragment.length > 32767) tableLimit();
      text += fragment;
    },
  });
  output.add("</sst>");
  return { content: output.encode(), lengths };
}

function cellAddress(at: { row: number; column: number }) {
  return XLSX.utils.encode_cell({ r: at.row - 1, c: at.column - 1 });
}

function inspectWorksheet(bytes: Uint8Array<ArrayBuffer>, header: boolean) {
  const output = xmlOutput(partLimits.sheet);
  output.add(`<worksheet xmlns="${sheetNamespaces[0]}"><sheetData>`);
  let hasMerges = false;
  let top = Infinity, left = Infinity, bottom = 0, right = 0;
  let row = 0, column = 0, cells = 0, formulaCount = 0, logicalUnits = 0;
  const stylesUsed = new Map<number, number>();
  const stringsUsed = new Map<number, number>();
  let dataTag: SaxesTagNS | undefined, rowTag: SaxesTagNS | undefined;
  let inlineTag: SaxesTagNS | undefined, textTag: SaxesTagNS | undefined;
  let cell: { tag: SaxesTagNS; address: string; kind: string; style?: number; value: string; cached: boolean; formula: boolean } | undefined;
  function checkBounds() {
    const rows = bottom - top + 1, columns = right > 0 ? right - left + 1 : 0;
    if (rows - Number(header) > 50000 || columns > 200 || rows * columns > 500000) tableLimit();
  }
  function extend(at: { row: number; column: number }) {
    top = Math.min(top, at.row);
    left = Math.min(left, at.column);
    bottom = Math.max(bottom, at.row);
    right = Math.max(right, at.column);
    checkBounds();
  }
  scanXml(bytes, {
    root: "worksheet",
    namespaces: sheetNamespaces,
    maxElements: 2000000,
    open(tag, parent) {
      const ref = attribute(tag, "ref");
      if (sheetTag(tag, parent, "dimension", "worksheet") && ref) {
        const { a, b } = rectangle(ref);
        extend(a);
        extend(b);
      }
      if (sheetTag(tag, parent, "mergeCell", "mergeCells") && ref) {
        rectangle(ref);
        hasMerges = true;
      }
      if (sheetTag(tag, parent, "sheetData", "worksheet")) {
        if (dataTag) invalidXlsx();
        dataTag = tag;
      }
      if (sheetTag(tag, parent, "row", "sheetData") && parent === dataTag) {
        if (rowTag) invalidXlsx();
        row = integer(attribute(tag, "r") ?? String(row + 1), row + 1, 1048576);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        checkBounds();
        column = 0;
        rowTag = tag;
        output.add(`<row r="${row}">`);
      }
      if (sheetTag(tag, parent, "c", "row") && parent === rowTag) {
        if (cell) invalidXlsx();
        if (++cells > 500000) tableLimit();
        const address = attribute(tag, "r");
        const at = address ? position(address) : { row, column: column + 1 };
        if (at.row !== row || at.column <= column || at.column > 16384) invalidXlsx();
        extend(at);
        column = at.column;
        const kind = attribute(tag, "t") ?? "n";
        const style = attribute(tag, "s");
        if (!["n", "s", "str", "b", "d", "e", "inlineStr"].includes(kind)) invalidXlsx();
        cell = { tag, address: cellAddress(at), kind, value: "", cached: false, formula: false };
        if (style !== undefined) {
          cell.style = integer(style, 0, 65535);
        }
      }
      if (!cell) return;
      if (sheetTag(tag, parent, "f", "c") && parent === cell.tag) cell.formula = true;
      if (sheetTag(tag, parent, "is", "c") && parent === cell.tag) {
        if (cell.kind !== "inlineStr" || cell.cached) invalidXlsx();
        inlineTag = tag;
        cell.cached = true;
      }
      if (sheetTag(tag, parent, "v", "c") && parent === cell.tag) {
        if (cell.kind === "inlineStr" || cell.cached) invalidXlsx();
        cell.cached = true;
        textTag = tag;
      }
      if (inlineTag && (sheetTag(tag, parent, "t", "is") || sheetTag(tag, parent, "t", "r"))) textTag = tag;
    },
    text(fragment) {
      if (!cell || !textTag) return;
      if (cell.value.length + fragment.length > 32767) tableLimit();
      cell.value += fragment;
    },
    close(tag) {
      if (tag === textTag) textTag = undefined;
      if (tag === inlineTag) inlineTag = undefined;
      if (tag === rowTag) {
        output.add("</row>");
        rowTag = undefined;
      }
      if (!cell || tag !== cell.tag) return;
      const { address, kind, style, value, cached, formula } = cell;
      if (formula) {
        formulaCount++;
        if (!cached || kind === "inlineStr" || (!value && kind !== "str"))
          throw new Error(`${address}: 계산된 값이 없는 수식입니다. Excel에서 다시 계산하고 저장하세요.`);
      }
      if (kind === "s" && value) {
        const index = integer(value, 0, 499999);
        stringsUsed.set(index, (stringsUsed.get(index) ?? 0) + 1);
      } else if (kind === "str" || kind === "inlineStr" || kind === "e") {
        logicalUnits += value.length;
        if (logicalUnits > logicalTextLimit) textLimit();
      }
      if (kind === "n" && value && (value.length > 64 ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))))
        invalidXlsx();
      if ((kind === "s" || kind === "b") && cached && !value) invalidXlsx();
      if (kind === "b" && (!cached || !["0", "1", "false", "true"].includes(value))) invalidXlsx();
      if (kind === "d" && value.length > 64) invalidXlsx();
      const styleId = style ?? -1;
      stylesUsed.set(styleId, (stylesUsed.get(styleId) ?? 0) + 1);
      const cellStyle = style === undefined ? "" : ` s="${style}"`;
      const escaped = xmlEscape(value);
      const content = kind === "inlineStr" ? `<is><t xml:space="preserve">${escaped}</t></is>` : `<v>${escaped}</v>`;
      output.add(`<c r="${address}" t="${kind}"${cellStyle}>${cached ? content : ""}</c>`);
      cell = undefined;
    },
  });
  output.add("</sheetData>");
  output.add("</worksheet>");
  const range = bottom > 0 && right > 0 ? `${cellAddress({ row: top, column: left })}:${cellAddress({ row: bottom, column: right })}` : undefined;
  return { content: output.encode(), range, formulaCount, hasMerges, logicalUnits, stringsUsed, stylesUsed };
}

function selectedWorkbook(
  sheet: Uint8Array<ArrayBuffer>, styles: Uint8Array<ArrayBuffer> | undefined,
  strings: Uint8Array<ArrayBuffer> | undefined, date1904: boolean,
) {
  // Give SheetJS only known names and verified bytes. Metadata, other worksheets,
  // comments, hyperlinks' relationships and external parts from the source never reach it.
  const packageFile = XLSX.CFB.utils.cfb_new();
  const text = new TextEncoder();
  const add = (name: string, content: Uint8Array<ArrayBuffer> | string) =>
    XLSX.CFB.utils.cfb_add(packageFile, name, typeof content === "string" ? text.encode(content) : content);
  const types: Array<[string, string]> = [["workbook.xml", workbookType], ["worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"]];
  if (styles) {
    types.push(["styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"]);
    add("xl/styles.xml", styles);
  }
  if (strings) {
    types.push(["sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"]);
    add("xl/sharedStrings.xml", strings);
  }
  add("[Content_Types].xml", `<Types xmlns="${contentTypes}">${types.map(([name, type]) =>
    `<Override PartName="/xl/${name}" ContentType="${type}"/>`).join("")}</Types>`);
  add("xl/workbook.xml", `<workbook xmlns="${sheetNamespaces[0]}" xmlns:r="${officeRelationships[0]}"><workbookPr date1904="${Number(date1904)}"/><sheets><sheet name="DataGardenSheet" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  add("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${packageRelationships}"><Relationship Id="rId1" Type="${officeRelationships[0]}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  add("xl/worksheets/sheet1.xml", sheet);
  return XLSX.read(XLSX.CFB.write(packageFile, { fileType: "zip", type: "array", compression: false }), {
    type: "array", sheets: 0, cellDates: false, cellNF: true, cellText: true,
    cellFormula: false, cellHTML: false, sheetStubs: true,
  }).Sheets.DataGardenSheet;
}

export async function readXlsxSheet(bytes: ArrayBuffer, requested: string, header: boolean) {
  const archive = openXlsxArchive(bytes);
  const { path, worksheets, relationships, date1904 } = await readWorkbook(archive);
  const sheets = [...worksheets.keys()];
  const name = requested || sheets[0];
  const selected = worksheets.get(name);
  if (!selected) throw new Error("선택한 시트가 없습니다. 파일을 다시 선택하세요.");
  const stylesPath = relatedPart(relationships, path, "styles");
  const stringsPath = relatedPart(relationships, path, "sharedStrings");
  const selection = inspectWorksheet(await archive.read(selected, partLimits.sheet), header);
  const needsStyles = [...selection.stylesUsed.keys()].some((index) => index >= 0);
  const styles = stylesPath && needsStyles ? parseStyles(await archive.read(stylesPath, partLimits.styles)) : undefined;
  const strings = stringsPath && selection.stringsUsed.size
    ? parseStrings(await archive.read(stringsPath, partLimits.strings)) : undefined;
  let logicalUnits = selection.logicalUnits;
  for (const [index, count] of selection.stringsUsed) {
    const length = strings?.lengths[index];
    if (length === undefined) invalidXlsx();
    logicalUnits += length * count;
    if (logicalUnits > logicalTextLimit) textLimit();
  }
  let formatUnits = 0, textCopies = 1;
  for (const [index, count] of selection.stylesUsed) {
    const format = index < 0 ? "General" : styles?.formats[index];
    if (format === undefined) invalidXlsx();
    // A small shared style can be expanded repeatedly in cell.w and cell.z.
    formatUnits += count * (32 + (format === "General" ? 0 : 8 * format.length));
    textCopies = Math.max(textCopies, format.match(/@/g)?.length ?? 0);
  }
  if (formatUnits + logicalUnits * textCopies > displayBudget) textLimit();
  if (selection.content.length + (styles?.content.length ?? 0) + (strings?.content.length ?? 0) > xlsxZipLimits.actualBytes)
    textLimit();
  const sheet = selectedWorkbook(selection.content, styles?.content, strings?.content, date1904);
  if (!sheet) invalidXlsx();
  if (selection.range) sheet["!ref"] = selection.range;
  return { sheet, name, sheets, date1904, formulaCount: selection.formulaCount, hasMerges: selection.hasMerges };
}
