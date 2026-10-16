import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBytes, registerImport, defaultImportOptions } from "./import";
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const parse = (s: string) =>
  parseBytes(bytes(s), "자료.csv", defaultImportOptions);
describe("CSV input and preservation", () => {
  it("decodes Korean UTF-8, BOM and EUC-KR without dynamic typing", () => {
    for (const text of ["이름,점수\n가,1", "\uFEFF이름,점수\n가,1"]) {
      const p = parse(text);
      expect(p.proposed.columns[0].name).toBe("이름");
      expect(p.original.rows[0].values[p.original.columns[1].id]).toBe("1");
    }
    const korean = new Uint8Array([
      0xc0, 0xcc, 0xb8, 0xa7, 44, 0xc1, 0xa1, 0xbc, 0xf6, 10, 0xb0, 0xa1, 44,
      49,
    ]);
    const p = parseBytes(korean.buffer, "한글.csv", {
      ...defaultImportOptions,
      encoding: "euc-kr",
    });
    expect(p.proposed.columns.map((c) => c.name)).toEqual(["이름", "점수"]);
    expect(p.original.rows[0].values[p.original.columns[0].id]).toBe("가");
    expect(() =>
      parseBytes(korean.buffer, "한글.csv", defaultImportOptions),
    ).toThrow("인코딩");
  });
  it("handles quoted delimiters, escaped quotes, embedded newlines and empty values", () => {
    const p = parse('이름,메모,값\n가,"쉼표, 줄\n바꿈 ""인용""",\n나,NA,0\n');
    expect(p.original.rows).toHaveLength(2);
    const ids = p.original.columns.map((c) => c.id);
    expect(p.original.rows[0].values[ids[1]]).toBe('쉼표, 줄\n바꿈 "인용"');
    expect(p.original.rows[0].values[ids[2]]).toBe("");
    expect(p.original.rows[1].values[ids[2]]).toBe("0");
  });
  it("conservatively suggests identifiers and numeric codes, preserves leading zeros", () => {
    const p = parse(
      "학생번호,지역코드,정수값,점수\n00123,11,1,80\n00456,26,2,90",
    );
    expect(p.proposed.columns.map((c) => c.semanticType)).toEqual([
      "identifier",
      "identifier",
      "categorical",
      "numeric",
    ]);
    const dataset = registerImport(p, p.proposed.columns, true);
    const code = p.proposed.columns[0].id;
    expect(dataset.versions[1].rows[0].values[code]).toBe("00123");
    const columns = p.proposed.columns.map((c) => ({ ...c }));
    columns[0].storageType = "number";
    expect(() => registerImport(p, columns, false)).toThrow("확인");
    expect(
      registerImport(p, columns, true).versions[1].rows[0].values[code],
    ).toBe(123);
  });
  it("reports mismatched rows and blank/duplicate headers, keeps every value", () => {
    const p = parse("이름,이름,\n가,나,1,추가\n다");
    expect(p.issues.length).toBeGreaterThanOrEqual(3);
    expect(p.proposed.columns.map((c) => c.name)).toEqual([
      "이름",
      "이름 (2)",
      "열 3",
      "열 4",
    ]);
    expect(p.original.rows).toHaveLength(2);
    expect(Object.values(p.original.rows[0].values)).toEqual([
      "가",
      "나",
      "1",
      "추가",
    ]);
    expect(Object.values(p.original.rows[1].values)).toEqual([
      "다",
      null,
      null,
      null,
    ]);
    expect(p.original.columns.map((c) => c.name)).toEqual([
      "이름",
      "이름",
      "",
      "",
    ]);
    expect(() => registerImport(p, p.proposed.columns, false)).toThrow();
  });
  it("handles delimiter/header changes, empty files and malformed quotes", () => {
    const p = parseBytes(bytes("가;1\n나;2"), "test.csv", {
      ...defaultImportOptions,
      delimiter: ";",
      header: false,
    });
    expect(p.proposed.rows).toHaveLength(2);
    expect(p.proposed.columns[0].name).toBe("열 1");
    expect(() => parse("")).toThrow("빈 파일");
    expect(parse("이름,값\n").empty).toBe(true);
    expect(() => parse('이름,값\n가,"끝나지 않은 따옴표')).toThrow("따옴표");
    expect(() => registerImport(parse("\n"), [], true)).toThrow("빈");
  });
  it("creates unique datasets, original + typed versions and operation lineage", () => {
    const p = parse("점수\n1\n2");
    const a = registerImport(p, p.proposed.columns, true);
    const again = parse("점수\n1\n2");
    const b = registerImport(again, again.proposed.columns, true);
    expect(a.id).not.toBe(b.id);
    expect(a.versions).toHaveLength(2);
    expect(a.versions[1].parentVersionIds).toEqual([a.versions[0].id]);
    expect(
      a.original.table.rows[0].values[a.original.table.columns[0].id],
    ).toBe("1");
    expect(a.versions[1].rows[0].values[a.original.table.columns[0].id]).toBe(
      1,
    );
    expect(a.versions[0].operation.kind).toBe("import");
    expect(a.source.importOptions?.encoding).toBe("utf-8");
  });
});

function workbook(date1904 = false): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["학생코드", "조사일", "동의", "메모"],
    [123, 45292, true, null],
    [456, 45293, false, "NA"],
  ]);
  sheet.A2.z = "00000";
  sheet.A3.z = "00000";
  sheet.B2.z = "yyyy-mm-dd";
  sheet.B3.z = "yyyy-mm-dd";
  XLSX.utils.book_append_sheet(wb, sheet, "첫 시트");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "빈 시트");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["점수"], [10], [20]]),
    "둘째",
  );
  wb.Workbook = { WBProps: { date1904 } };
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}
describe("XLSX actual values and formats", () => {
  it("lists sheets and preserves raw serials, display codes, booleans and empty cells", () => {
    const p = parseBytes(workbook(), "수업.xlsx", defaultImportOptions);
    expect(p.sheets).toEqual(["첫 시트", "빈 시트", "둘째"]);
    const ids = p.original.columns.map((c) => c.id);
    expect(p.original.rows[0].values[ids[0]]).toBe(123);
    expect(p.proposed.rows[0].values[ids[0]]).toBe("00123");
    expect(p.original.rows[0].values[ids[1]]).toBe(45292);
    expect(p.proposed.rows[0].values[ids[1]]).toBe("2024-01-01");
    expect(p.proposed.rows[0].values[ids[2]]).toBe(true);
    expect(p.proposed.rows[0].values[ids[3]]).toBeNull();
    expect(p.cellMetadata[p.original.rows[0].id][ids[0]]).toMatchObject({
      display: "00123",
      format: "00000",
    });
    expect(p.issues.length).toBeGreaterThan(0);
  });
  it("supports sheet switching, empty sheet, actual value mode, and 1904 dates", () => {
    const buffer = workbook();
    expect(
      parseBytes(buffer, "수업.xlsx", {
        ...defaultImportOptions,
        sheet: "빈 시트",
      }).empty,
    ).toBe(true);
    expect(
      parseBytes(buffer, "수업.xlsx", {
        ...defaultImportOptions,
        sheet: "둘째",
      }).proposed.rows,
    ).toHaveLength(2);
    const raw = parseBytes(buffer, "수업.xlsx", {
      ...defaultImportOptions,
      xlsxValues: "raw",
    });
    expect(Object.values(raw.proposed.rows[0].values)[0]).toBe(123);
    const old = parseBytes(workbook(true), "수업.xlsx", defaultImportOptions);
    expect(Object.values(old.proposed.rows[0].values)[1]).toBe("2028-01-02");
    expect(() =>
      parseBytes(bytes("not xlsx"), "오류.xlsx", defaultImportOptions),
    ).toThrow("XLSX");
  });
});
