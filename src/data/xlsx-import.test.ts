import { crc32, deflateRawSync } from "node:zlib";
import { Inflate } from "pako";
import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { defaultImportOptions, parseXlsxBytes, readXlsxSheetNames } from "./import";
import { openXlsxArchive, xlsxZipLimits } from "./xlsx-zip";

type Part = {
  name: string;
  text: string;
  declared?: number;
  checksum?: number;
  descriptor?: "signed" | "unsigned";
  payload?: Buffer;
};

function zip(parts: Part[]) {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, directorySize = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const plain = Buffer.from(part.text);
    const compressed = part.payload ?? deflateRawSync(plain);
    const checksum = part.checksum ?? crc32(plain);
    const size = part.declared ?? plain.length;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(part.descriptor === "signed" ? 16 : part.descriptor ? 12 : 0);
    if (part.descriptor) {
      header.writeUInt16LE(8, 6);
      entry.writeUInt16LE(8, 8);
      const start = part.descriptor === "signed" ? 4 : 0;
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, start);
      descriptor.writeUInt32LE(compressed.length, start + 4);
      descriptor.writeUInt32LE(size, start + 8);
    } else {
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(size, 22);
    }
    local.push(header, name, compressed, descriptor);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length + descriptor.length;
    directorySize += entry.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...local, ...central, end])).buffer;
}

const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRel = "http://schemas.openxmlformats.org/package/2006/relationships";
const ct = "http://schemas.openxmlformats.org/package/2006/content-types";
const sheet = (contents: string) => `<worksheet xmlns="${ns}">${contents}</worksheet>`;
const normal = sheet('<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>');
const shared = sheet('<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>');
const relationships = (entries: Array<[string, string, string]>) =>
  `<Relationships xmlns="${packageRel}">${entries.map(([id, type, target]) =>
    `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

function workbook(
  first: Partial<Part> = {}, second: Partial<Part> = {}, optional: Array<[string, Part]> = [],
  replacements: Record<string, Partial<Part>> = {},
) {
  return zip([
    { name: "_rels/.rels", text: relationships([["root", "officeDocument", "tables/work.xml"]]) },
    { name: "[Content_Types].xml", text: `<Types xmlns="${ct}"><Override PartName="/tables/work.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: "tables/work.xml", text: `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="첫 표" r:id="one"/><sheet name="둘째 표" r:id="two"/></sheets></workbook>` },
    { name: "tables/_rels/work.xml.rels", text: relationships([
      ["one", "worksheet", "selected/one.xml"], ["two", "worksheet", "/other/two.xml"],
      ...optional.map(([kind, part]): [string, string, string] => [kind, kind, "/" + part.name]),
    ]) },
    { name: "tables/selected/one.xml", text: normal, ...first },
    { name: "other/two.xml", text: normal, ...second },
    ...optional.map(([, part]) => part),
  ].map((part) => ({ ...part, ...replacements[part.name] })));
}

function parse(input: ArrayBuffer, name = "첫 표") {
  return parseXlsxBytes(input, "가상.xlsx", { ...defaultImportOptions, header: false, sheet: name });
}

describe("bounded XLSX ZIP", () => {
  it.each(["signed", "unsigned"] as const)("accepts a valid %s data descriptor", async (descriptor) => {
    const archive = openXlsxArchive(zip([{ name: "doc.xml", text: "정상", descriptor }]));
    expect(new TextDecoder().decode(await archive.read("doc.xml", 1024))).toBe("정상");
  });

  it("rejects central/local discrepancies, duplicate paths and oversized declared total", () => {
    const inconsistent = zip([{ name: "part.xml", text: "example" }]);
    new DataView(inconsistent).setUint16(6, 1, true);
    expect(() => openXlsxArchive(inconsistent)).toThrow("ZIP 구조");
    expect(() => openXlsxArchive(zip([
      { name: "a.xml", text: "a" }, { name: "A.XML", text: "b" },
    ]))).toThrow("ZIP 구조");
    expect(() => openXlsxArchive(zip([{ name: "xl/%2E%2E/part.xml", text: "a" }]))).toThrow("ZIP 구조");
    expect(() => openXlsxArchive(zip(Array.from({ length: 3 }, (_, i) => ({
      name: `part${i}.xml`, text: "a", declared: xlsxZipLimits.declaredEntryBytes,
    }))))).toThrow("한도");
  });

  it("stops actual inflation on a forged size without feeding all compressed bytes", async () => {
    const text = "A".repeat(8 * 1024 * 1024);
    const compressedBytes = deflateRawSync(Buffer.from(text)).length;
    const archive = openXlsxArchive(zip([{ name: "doc.xml", text, declared: 128 }]));
    const push = Inflate.prototype.push;
    let fed = 0, largest = 0;
    const spy = vi.spyOn(Inflate.prototype, "push").mockImplementation(function (this: Inflate, chunk, mode) {
      const length = chunk.byteLength;
      fed += length;
      largest = Math.max(largest, length);
      return push.call(this, chunk, mode);
    });
    try {
      await expect(archive.read("doc.xml", 1024)).rejects.toThrow("한도");
      expect(largest).toBe(1024);
      expect(fed).toBeLessThan(compressedBytes);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects truncated streams and trailing compressed bytes even with plausible CRC and sizes", async () => {
    const text = "검증용 문자열";
    const compressed = deflateRawSync(Buffer.from(text));
    for (const payload of [compressed.subarray(0, compressed.length - 1), Buffer.concat([compressed, Buffer.from([0, 1])])]) {
      const archive = openXlsxArchive(zip([{ name: "doc.xml", text, payload }]));
      await expect(archive.read("doc.xml", 1024)).rejects.toThrow("ZIP 구조");
    }
  });
});

describe("selected XLSX worksheet projection", () => {
  it("lists only workbook metadata and never inflates an unselected corrupt sheet", async () => {
    const input = workbook({ checksum: 0 });
    await expect(readXlsxSheetNames(input)).resolves.toEqual(["첫 표", "둘째 표"]);
    await expect(parse(input, "첫 표")).rejects.toThrow("ZIP 구조");
    const result = await parse(input, "둘째 표");
    expect(Object.values(result.original.rows[0].values)).toEqual([7]);
  });

  it("bounds a selected sheet and the shared style/string parts before inflation", async () => {
    const MiB = 1024 * 1024;
    const largeUnselected = workbook({ declared: 32 * MiB + 1 });
    await expect(readXlsxSheetNames(largeUnselected)).resolves.toEqual(["첫 표", "둘째 표"]);
    await expect(parse(largeUnselected, "둘째 표")).resolves.toMatchObject({ empty: false });
    await expect(parse(largeUnselected)).rejects.toThrow("한도");
    const styled = normal.replace('<c r="A1">', '<c r="A1" s="0">');
    const largeStyles = workbook({ text: styled }, {}, [["styles", {
      name: "styles.xml", text: "", declared: 4 * MiB + 1,
    }]]);
    await expect(parse(largeStyles)).rejects.toThrow("한도");
    await expect(parse(largeStyles, "둘째 표")).resolves.toMatchObject({ empty: false });
    const input = workbook({}, { text: shared }, [["sharedStrings", {
      name: "strings.xml", text: "", declared: 16 * MiB + 1,
    }]]);
    await expect(parse(input)).resolves.toMatchObject({ empty: false });
    await expect(parse(input, "둘째 표")).rejects.toThrow("한도");
  });

  it("keeps ordinary compressed shared strings, rich text and formats", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["<가상> & 글자", 42]]);
    ws.B1.z = "0000";
    XLSX.utils.book_append_sheet(wb, ws, "첫 표");
    const input = XLSX.write(wb, { type: "array", compression: true, bookSST: true }) as ArrayBuffer;
    const result = await parse(input);
    expect(Object.values(result.original.rows[0].values)).toEqual(["<가상> & 글자", 42]);
    expect(Object.values(result.proposed.rows[0].values)).toEqual(["<가상> & 글자", "0042"]);
  });

  it("drops raw look-alike markup and formula execution paths while retaining cached values and text", async () => {
    const marker = '<hyperlink ref="A1:XFD1048576"/>';
    const xml = sheet(`<sheetData><row r="1"><c r="A1"><f t="array" ref="A1:XFD1048576">1+1</f><v>2</v></c><c r="B1" t="inlineStr"><is><t><![CDATA[${marker}]]></t></is></c></row></sheetData><!--${marker}--><hyperlinks xmlns:ext="urn:test"><ext:hyperlink ref="A1:XFD1048576"/></hyperlinks>`);
    const parsed = await parse(workbook({ text: xml }));
    expect(Object.values(parsed.original.rows[0].values)).toEqual([2, marker]);
    expect(parsed.issues.some((issue) => issue.message.includes("수식 1셀"))).toBe(true);
  });

  it("rejects missing formula cache, invalid cell coordinates, DTD, and false dimensions", async () => {
    await expect(parse(workbook({ text: sheet('<sheetData><row><c r="A1"><f>2+2</f></c></row></sheetData>') }))).rejects.toThrow("계산된 값");
    await expect(parse(workbook({ text: sheet('<sheetData><row><c r="A2"><v>2</v></c></row></sheetData>') }))).rejects.toThrow("XLSX");
    await expect(parse(workbook({ text: '<!DOCTYPE worksheet [<!ENTITY x "y">]>' + normal }))).rejects.toThrow("XLSX");
    await expect(parse(workbook({ text: sheet('<dimension ref="A1"/><sheetData><row r="60000"><c r="A60000"><v>2</v></c></row></sheetData>') }))).rejects.toThrow("한도");
  });

  it("rejects repetitive shared strings and repeated display formatting before SheetJS", async () => {
    const rows = (length: number, cell: (row: number) => string) => sheet(`<sheetData>${Array.from(
      { length }, (_, i) => `<row r="${i + 1}">${cell(i + 1)}</row>`,
    ).join("")}</sheetData>`);
    const sst = { name: "strings.xml", text: `<sst xmlns="${ns}"><si><t>${"한".repeat(32767)}</t></si></sst>` };
    await expect(parse(workbook({ text: rows(600, (row) => `<c r="A${row}" t="s"><v>0</v></c>`) }, {}, [
      ["sharedStrings", sst],
    ]))).rejects.toThrow("텍스트 또는 표시 형식");
    const style = {
      name: "styles.xml",
      text: `<styleSheet xmlns="${ns}"><numFmts><numFmt numFmtId="165" formatCode="${"@".repeat(1024)}"/></numFmts><cellXfs><xf numFmtId="165"/></cellXfs></styleSheet>`,
    };
    await expect(parse(workbook({ text: rows(4, (row) => `<c r="A${row}" t="s" s="0"><v>0</v></c>`) }, {}, [
      ["sharedStrings", sst], ["styles", style],
    ]))).rejects.toThrow("텍스트 또는 표시 형식");
  });

  it("enforces XML attribute limits while reading a single tag", async () => {
    const attributes = Array.from({ length: 97 }, (_, i) => ` a${i}="x"`).join("");
    await expect(parse(workbook({ text: sheet(`<unused${attributes}/>` ) }))).rejects.toThrow("XML 요소");
  });

  it("encodes canonical non-ASCII XML through bounded output buffers", async () => {
    const text = "한🌿".repeat(3000);
    const input = workbook({ text: sheet(`<sheetData><row><c t="inlineStr"><is><t>${text}</t></is></c></row></sheetData>`) });
    const encode = TextEncoder.prototype.encode;
    const encodeInto = TextEncoder.prototype.encodeInto;
    let largestEncode = 0, largestBuffer = 0;
    const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, value = "") {
      largestEncode = Math.max(largestEncode, value.length);
      return encode.call(this, value);
    });
    const intoSpy = vi.spyOn(TextEncoder.prototype, "encodeInto").mockImplementation(function (this: TextEncoder, value, buffer) {
      largestBuffer = Math.max(largestBuffer, buffer.byteLength);
      return encodeInto.call(this, value, buffer);
    });
    try {
      const result = await parse(input);
      expect(Object.values(result.original.rows[0].values)).toEqual([text]);
      expect(largestEncode).toBeLessThan(2048);
      expect(largestBuffer).toBeLessThanOrEqual(16 * 1024);
    } finally {
      spy.mockRestore();
      intoSpy.mockRestore();
    }
  });

  it("rejects invalid boolean cells, shared-string/style references, entities, and date-system flags", async () => {
    for (const content of [
      '<c r="A1" t="b"><v/></c>', '<c r="A1" t="b"/>',
      '<c r="A1" t="s"><v/></c>', '<c r="A1" s="1"><v>1</v></c>',
      '<c r="A1" t="inlineStr"><is><t>&unknown;</t></is></c>',
    ]) await expect(parse(workbook({ text: sheet(`<sheetData><row>${content}</row></sheetData>`) }))).rejects.toThrow("XLSX");
    const invalidDate = `<workbook xmlns="${ns}" xmlns:r="${rel}"><workbookPr date1904="invalid"/><sheets><sheet name="첫 표" r:id="one"/></sheets></workbook>`;
    await expect(readXlsxSheetNames(workbook({}, {}, [], {
      "tables/work.xml": { text: invalidDate },
    }))).rejects.toThrow("XLSX");
    await expect(readXlsxSheetNames(workbook({}, {}, [], {
      "tables/work.xml": { declared: 1024 * 1024 + 1 },
    }))).rejects.toThrow("한도");
  });
});
