import Papa from "papaparse";
import * as XLSX from "xlsx";
import type {
  Attribute,
  Cell,
  Dataset,
  ImportIssue,
  ImportOptions,
  ParsedImport,
  TableData,
} from "../domain/types";
import {
  applySchema,
  conversionWarnings,
  isMissing,
  numericValue,
  validDate,
} from "../domain/table";
import { createVersion, preserveOriginal } from "../domain/model";

export { defaultImportOptions } from "./import-options";
export const limits = {
  bytes: 20 * 1024 * 1024,
  rows: 50000,
  columns: 200,
  cells: 500000,
};
function checkSize(rows: number, columns: number, header: boolean) {
  if (
    rows - (header ? 1 : 0) > limits.rows ||
    columns > limits.columns ||
    rows * columns > limits.cells
  )
    throw new Error(
      "현재 지원 범위는 50,000행·200열·500,000셀입니다. 파일을 나누어 다시 여세요. 자료를 일부만 불러오지는 않습니다.",
    );
}
function infer(name: string, values: Cell[], id: string): Attribute {
  const valid = values.filter((v) => !isMissing(v));
  const identity =
    /(^id$|번호|코드|학번|식별|우편|전화|_id$)/i.test(name) ||
    valid.some((v) => typeof v === "string" && /^0\d/.test(v));
  let storageType: Attribute["storageType"] = "string";
  let semanticType: Attribute["semanticType"] = identity
    ? "identifier"
    : "text";
  if (!identity && valid.length) {
    if (valid.every((v) => typeof v === "string" && validDate(v)))
      semanticType = "date";
    else if (
      valid.every(
        (v) => typeof v === "boolean" || /^(true|false)$/i.test(String(v)),
      )
    ) {
      storageType = "boolean";
      semanticType = "categorical";
    } else if (
      valid.every((v) => {
        try {
          numericValue(v);
          return true;
        } catch {
          return false;
        }
      })
    ) {
      storageType = "number";
      // Integer columns are conservatively categorical unless their name indicates a measurement.
      semanticType =
        valid.some((v) => !Number.isInteger(Number(v))) ||
        /점수|시간|온도|길이|무게|키$|나이|금액|수량|score|height|weight|age|amount/i.test(
          name,
        )
          ? "numeric"
          : "categorical";
    } else semanticType = "categorical";
  }
  return {
    id,
    name,
    storageType,
    semanticType,
    description: "",
    useInAnalysis:
      !identity && semanticType !== "date" && semanticType !== "text",
  };
}
type CellInfo = { display: string; format: string; type: string };
function excelDate(serial: number, date1904: boolean): string | null {
  const d = XLSX.SSF.parse_date_code(serial, { date1904 });
  if (!d) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const date = `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
  const milliseconds = Math.floor((d.u || 0) * 1000);
  const result =
    d.H || d.M || d.S || milliseconds
      ? `${date}T${pad(d.H)}:${pad(d.M)}:${pad(d.S)}${milliseconds ? "." + pad(milliseconds, 3) : ""}`
      : date;
  return validDate(result) ? result : null;
}
export function parseBytes(
  bytes: ArrayBuffer,
  fileName: string,
  options: ImportOptions,
): ParsedImport {
  if (!bytes.byteLength)
    throw new Error("빈 파일입니다. 열 이름과 자료가 있는 파일을 선택하세요.");
  if (bytes.byteLength > limits.bytes)
    throw new Error("파일 크기가 20MB를 넘습니다. 파일을 나누어 불러오세요.");
  let matrix: Cell[][] = [];
  let normalized: Cell[][] = [];
  let sheets: string[] = [];
  const metadata: Record<string, CellInfo> = {};
  const issues: ImportIssue[] = [];
  const actualOptions = { ...options };
  const isXlsx = /\.xlsx$/i.test(fileName);
  if (!isXlsx && !/\.csv$/i.test(fileName))
    throw new Error("CSV 또는 XLSX 파일만 지원합니다. 파일 형식을 확인하세요.");
  if (!isXlsx) {
    let text: string;
    try {
      text = new TextDecoder(options.encoding, { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, "");
    } catch {
      throw new Error(
        "선택한 인코딩으로 읽을 수 없습니다. UTF-8 또는 EUC-KR(CP949) 설정을 바꾸어 보세요.",
      );
    }
    if (!text.length) throw new Error("내용이 없는 파일입니다.");
    const result = Papa.parse<string[]>(text, {
      delimiter: options.delimiter,
      header: false,
      dynamicTyping: false,
      skipEmptyLines: false,
    });
    if (result.errors.length)
      throw new Error(
        result.errors
          .map(
            (e) =>
              `CSV 레코드 ${(e.row ?? 0) + 1}: ${e.code === "MissingQuotes" ? "닫는 따옴표가 없습니다." : e.code === "InvalidQuotes" ? "따옴표 형식이 올바르지 않습니다." : e.message}`,
          )
          .join(" / ") + " 따옴표와 구분자를 확인하세요.",
      );
    matrix = result.data;
    // A final line terminator is not a data row. Interior empty records are retained.
    if (
      /[\r\n]$/.test(text) &&
      matrix.at(-1)?.length === 1 &&
      matrix.at(-1)?.[0] === ""
    )
      matrix.pop();
    let width = 0;
    matrix.forEach((r) => {
      width = Math.max(width, r.length);
    });
    checkSize(matrix.length, width, options.header);
    const mismatches = matrix
      .map((r, i) => (r.length !== matrix[0]?.length ? i + 1 : 0))
      .filter(Boolean);
    if (mismatches.length)
      issues.push({
        message: `열 개수가 다른 레코드 ${mismatches.length}개: ${mismatches.slice(0, 30).join(", ")}${mismatches.length > 30 ? " 외 나머지" : ""}. 가장 넓은 ${width}열을 모두 보존하고 없는 칸만 빈 값(null)으로 채웁니다.`,
        remedy:
          "구분자 설정을 확인하거나 이 보존 방식을 확인한 뒤 불러오세요. 레코드 번호는 따옴표 안 줄바꿈을 한 행으로 센 번호입니다.",
      });
    matrix = matrix.map((r) =>
      Array.from({ length: width }, (_, i) => r[i] ?? null),
    );
    normalized = matrix.map((r) => [...r]);
  } else {
    const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
    if (signature[0] !== 0x50 || signature[1] !== 0x4b)
      throw new Error(
        "유효한 XLSX 통합 문서가 아닙니다. Excel에서 XLSX로 다시 저장하세요.",
      );
    const workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: false,
      cellNF: true,
      cellText: true,
      sheetStubs: true,
    });
    sheets = workbook.SheetNames;
    actualOptions.sheet = options.sheet || sheets[0] || "";
    if (!sheets.includes(actualOptions.sheet))
      throw new Error("선택한 시트가 없습니다. 파일을 다시 선택하세요.");
    const sheet = workbook.Sheets[actualOptions.sheet];
    if (sheet["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      checkSize(
        range.e.r - range.s.r + 1,
        range.e.c - range.s.c + 1,
        options.header,
      );
      let dateCount = 0;
      let codeCount = 0;
      let formulaCount = 0;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const raw: Cell[] = [];
        const proposed: Cell[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const address = XLSX.utils.encode_cell({ r, c });
          const cell = sheet[address] as XLSX.CellObject | undefined;
          if (cell?.t === "e")
            throw new Error(
              `${actualOptions.sheet}!${address}: Excel 오류 값 ${cell.w || cell.v}. 오류를 수정한 뒤 다시 불러오세요.`,
            );
          if (cell?.f) {
            formulaCount++;
            if (cell.v === undefined)
              throw new Error(
                `${address}: 계산된 값이 없는 수식입니다. Excel에서 다시 계산하고 저장하세요.`,
              );
          }
          const value: Cell =
            cell?.v === undefined || cell.t === "z"
              ? null
              : cell.t === "d"
                ? String(cell.v)
                : (cell.v as Cell);
          if (typeof value === "number" && !Number.isFinite(value))
            throw new Error(
              `${address}: 유한하지 않은 숫자는 불러올 수 없습니다.`,
            );
          raw.push(value);
          let adjusted = value;
          const display = cell?.w ?? (value === null ? "" : String(value));
          const format = String(cell?.z || "General");
          if (cell)
            metadata[`${r - range.s.r}:${c - range.s.c}`] = {
              display,
              format,
              type: cell.t,
            };
          if (options.xlsxValues === "display" && value !== null)
            adjusted = display;
          if (options.xlsxValues === "smart" && typeof value === "number") {
            if (XLSX.SSF.is_date(format)) {
              const iso = excelDate(
                value,
                Boolean(workbook.Workbook?.WBProps?.date1904),
              );
              if (!iso)
                issues.push({
                  message: `${address}: 날짜 일련번호 ${value}를 유효한 날짜로 바꿀 수 없어 실제 값을 유지합니다.`,
                  remedy:
                    "원본 셀 형식을 확인하거나 날짜가 아닌 의미 유형을 사용하세요.",
                });
              else {
                adjusted = iso;
                dateCount++;
              }
            } else if (/^0\d/.test(display) && /^\d+$/.test(display)) {
              adjusted = display;
              codeCount++;
            }
          }
          proposed.push(adjusted);
        }
        matrix.push(raw);
        normalized.push(proposed);
      }
      if (dateCount || codeCount)
        issues.push({
          message: `날짜 ${dateCount}셀은 ISO 날짜 문자열, 앞자리 0 표시 코드 ${codeCount}셀은 표시 문자열로 제안했습니다. 실제 셀 값과 표시 형식은 원본에 별도 보존됩니다.`,
          remedy:
            "미리보기의 원본/적용 값과 XLSX 값 기준을 확인하세요. 파일에 이미 없는 앞자리 0이나 정밀도는 복구하지 않습니다.",
        });
      if (formulaCount)
        issues.push({
          message: `수식 ${formulaCount}셀은 파일에 저장된 계산 결과를 읽습니다. 수식을 실행하거나 다시 계산하지 않습니다.`,
          remedy: "최신 값이 필요하면 Excel에서 계산·저장한 후 다시 여세요.",
        });
      if (sheet["!merges"]?.length)
        issues.push({
          message:
            "병합 셀이 있습니다. 병합 영역의 빈 칸은 채우지 않고 그대로 보존합니다.",
          remedy: "필요하면 원본 프로그램에서 병합을 해제하고 값을 확인하세요.",
        });
    }
  }
  const width = matrix[0]?.length ?? 0;
  const headerOffset = options.header ? 1 : 0;
  const empty =
    !matrix.length ||
    !matrix.some((row) => row.some((v) => !isMissing(v))) ||
    matrix.length <= headerOffset;
  const columnIds = Array.from({ length: width }, () => crypto.randomUUID());
  const used = new Set<string>();
  const originalNames = columnIds.map((_, i) =>
    options.header ? String(matrix[0]?.[i] ?? "") : `열 ${i + 1}`,
  );
  const names = originalNames.map((original, i) => {
    let name = original.trim() || `열 ${i + 1}`;
    const base = name;
    let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name);
    if (name !== original)
      issues.push({
        message: `${i + 1}열 이름 ${JSON.stringify(original)} → ${JSON.stringify(name)} 제안`,
        remedy:
          "빈 이름·중복 이름을 보정했습니다. 아래 열 설정에서 직접 바꿀 수 있습니다.",
      });
    return name;
  });
  const rows = matrix
    .slice(headerOffset)
    .map((row) => ({
      id: crypto.randomUUID(),
      values: Object.fromEntries(columnIds.map((id, i) => [id, row[i]])),
    }));
  const proposedRows = normalized
    .slice(headerOffset)
    .map((row, index) => ({
      id: rows[index].id,
      values: Object.fromEntries(columnIds.map((id, i) => [id, row[i]])),
    }));
  const originalColumns: Attribute[] = columnIds.map((id, i) => ({
    id,
    name: originalNames[i],
    storageType: isXlsx ? "mixed" : "string",
    semanticType: "text",
    description: "입력 당시의 열 정보와 원본 값",
    useInAnalysis: false,
  }));
  const cellMetadata: ParsedImport["cellMetadata"] = {};
  rows.forEach((row, i) => {
    const fields: Record<string, CellInfo> = {};
    columnIds.forEach((id, j) => {
      const meta = metadata[`${i + headerOffset}:${j}`];
      if (meta) fields[id] = meta;
    });
    if (Object.keys(fields).length) cellMetadata[row.id] = fields;
  });
  const proposed: TableData = {
    rows: proposedRows,
    columns: columnIds.map((id, i) =>
      infer(
        names[i],
        proposedRows.map((row) => row.values[id]),
        id,
      ),
    ),
  };
  return {
    fileName,
    mimeType: isXlsx
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "text/csv",
    options: actualOptions,
    sheets,
    original: { columns: originalColumns, rows },
    proposed,
    cellMetadata,
    issues,
    empty,
  };
}
export function registerImport(
  parsed: ParsedImport,
  columns: Attribute[],
  acknowledged: boolean,
): Dataset {
  if (parsed.empty)
    throw new Error(
      "빈 시트 또는 자료 행이 없는 파일은 등록할 수 없습니다. 다른 시트나 파일을 선택하세요.",
    );
  if (
    (parsed.issues.length ||
      conversionWarnings(parsed.proposed, columns).length) &&
    !acknowledged
  )
    throw new Error("입력 보정 및 변환 주의 사항을 확인하세요.");
  const typed = applySchema(parsed.proposed, columns);
  const now = new Date().toISOString();
  const datasetId = crypto.randomUUID();
  const rawId = crypto.randomUUID();
  const typedId = crypto.randomUUID();
  const source = {
    kind: "file" as const,
    label: parsed.options.sheet
      ? `${parsed.fileName} · ${parsed.options.sheet}`
      : parsed.fileName,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    importedAt: now,
    importOptions: parsed.options,
  };
  const raw = createVersion(parsed.original, {
    id: rawId,
    datasetId,
    parentVersionIds: [],
    createdAt: now,
    operation: {
      id: crypto.randomUUID(),
      kind: "import",
      datasetId,
      inputVersionIds: [],
      outputVersionIds: [rawId],
      settings: JSON.parse(
        JSON.stringify({ fileName: parsed.fileName, ...parsed.options }),
      ),
      executedAt: now,
    },
  });
  const applied = createVersion(typed, {
    id: typedId,
    datasetId,
    parentVersionIds: [rawId],
    createdAt: now,
    operation: {
      id: crypto.randomUUID(),
      kind: "transform",
      datasetId,
      inputVersionIds: [rawId],
      outputVersionIds: [typedId],
      settings: JSON.parse(
        JSON.stringify({
          columns,
          acknowledged,
          inputIssues: parsed.issues,
          conversionWarnings: conversionWarnings(parsed.proposed, columns),
          xlsxValues: parsed.options.xlsxValues,
        }),
      ),
      executedAt: now,
    },
  });
  return {
    id: datasetId,
    name:
      parsed.fileName.replace(/\.(csv|xlsx)$/i, "") +
      (parsed.options.sheet ? ` · ${parsed.options.sheet}` : ""),
    source,
    original: preserveOriginal(parsed.original, parsed.cellMetadata),
    versions: [raw, applied],
  };
}
