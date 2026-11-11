import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { defaultImportOptions, parseBytes, parseXlsxBytes } from "./import";

const csv = (text: string) =>
  parseBytes(new TextEncoder().encode(text).buffer, "검증.csv", defaultImportOptions);

describe("bounded import diagnostics", () => {
  it("reports omitted ragged record numbers without dropping any rows", () => {
    const parsed = csv("이름,점수\n" + "가\n".repeat(40));
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("레코드 40개");
    expect(parsed.issues[0].message).toContain("외 10개(번호 안내 생략)");
    expect(parsed.original.rows).toHaveLength(40);
    const [name, score] = parsed.original.columns.map((column) => column.id);
    expect(parsed.original.rows.every((row) => row.values[name] === "가" && row.values[score] === null)).toBe(true);
  });

  it("keeps full column names while bounding their diagnostic previews", () => {
    const name = "가".repeat(1000);
    const parsed = csv(` ${name}\n자료`);
    expect(parsed.original.columns[0].name).toBe(` ${name}`);
    expect(parsed.proposed.columns[0].name).toBe(name);
    expect(parsed.issues[0].message).toContain("긴 이름 일부 표시");
    expect(parsed.issues[0].message.length).toBeLessThan(350);
  });

  it("limits invalid-date messages and preserves every invalid serial", async () => {
    const invalid = 40;
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["날짜"],
      ...Array.from({ length: invalid }, () => [-1]),
    ]);
    for (let row = 2; row <= invalid + 1; row++) sheet[`A${row}`].z = "yyyy-mm-dd";
    XLSX.utils.book_append_sheet(book, sheet, "검증");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const parsed = await parseXlsxBytes(bytes, "검증.xlsx", defaultImportOptions);
    expect(parsed.issues).toHaveLength(6);
    expect(parsed.issues[0].message).toContain("A2: 날짜 일련번호 -1");
    expect(parsed.issues[4].message).toContain("A6: 날짜 일련번호 -1");
    expect(parsed.issues[5].message).toContain("40셀 중 35셀의 개별 안내를 생략");
    const columnId = parsed.proposed.columns[0].id;
    expect(parsed.proposed.rows.map((row) => row.values[columnId])).toEqual(Array(invalid).fill(-1));
  });
});
