import { describe, expect, it, vi } from "vitest";
import { csvReadLimits, parseCsv } from "./csv-input";
import { defaultImportOptions } from "./import-options";
import { parseBytes, parseCsvFile } from "./import";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const read = (text: string) =>
  parseCsv(bytes(text), defaultImportOptions, () => {}).rows;
const parse = (text: string) =>
  parseBytes(bytes(text), "검증.csv", defaultImportOptions);

describe("bounded CSV input", () => {
  it("keeps leading and interior blank records, quoted line breaks and trailing fields", () => {
    expect(read('\uFEFF\r\n"가\r\n나","쉼표,와 ""인용""" \t\r\n\r\n끝,\r\n')).toEqual([
      [""],
      ["가\r\n나", '쉼표,와 "인용"'],
      [""],
      ["끝", ""],
    ]);
    expect(read("가\r나\r")).toEqual([["가"], ["나"]]);
    expect(read('앞"뒤\n')).toEqual([['앞"뒤']]);
    expect(() => read('"닫힘"뒤에 문자')).toThrow("따옴표 형식");
    expect(() => read('"닫히지 않음')).toThrow("닫는 따옴표");
    expect(() => read("\uFEFF")).toThrow("내용이 없는");
  });

  it("continues UTF-8, doubled quotes and CRLF across byte chunks", () => {
    const chunk = csvReadLimits.chunkBytes;
    const multibyte = "a".repeat(chunk - 6);
    expect(read(`열\n"${multibyte}가"\n`)).toEqual([["열"], [`${multibyte}가`]]);

    const quote = "a".repeat(chunk - 2);
    expect(read(`"${quote}""끝"\n`)).toEqual([[`${quote}"끝`]]);

    const lineEnd = "a".repeat(chunk - 3);
    expect(read(`"${lineEnd}"\r\n\n끝\n`)).toEqual([[lineEnd], [""], ["끝"]]);
  });

  it("removes only the file BOM and preserves another BOM as cell content", () => {
    expect(read("\uFEFF\uFEFF=열\n값")).toEqual([["\uFEFF=열"], ["값"]]);
    expect(read('"a",\uFEFF값\n')).toEqual([["a", "\uFEFF값"]]);
    expect(read('"값" \t')).toEqual([["값"]]);
    expect(() => read('"값" \t잘못된 내용')).toThrow("따옴표 형식");
  });

  it.each([",", ";", "\t", "|"] as const)(
    "preserves quoted formula-looking content with %j and each line ending",
    async (delimiter) => {
      for (const lineEnd of ["\r", "\n", "\r\n"]) {
        const cell = "앞" + delimiter + "\uFEFF\u200B＝1+1" + lineEnd + '뒤"인용"';
        const source = '"' + cell.replaceAll('"', '""') + '"' + delimiter + "00123" + lineEnd;
        const options = { ...defaultImportOptions, delimiter, header: false };
        const expected = [[cell, "00123"]];
        expect(parseCsv(bytes(source), options, () => {}).rows).toEqual(expected);
        const result = await parseCsvFile(new File([source], "검증.csv"), options);
        expect(Object.values(result.original.rows[0].values)).toEqual(expected[0]);
      }
    },
  );

  it("continues a CP949 character across chunks without losing its bytes", () => {
    const chunk = csvReadLimits.chunkBytes;
    const input = new Uint8Array(chunk + 3);
    input.fill(97, 0, chunk - 1);
    input.set([0xb0, 0xa1, 13, 10], chunk - 1);
    const result = parseCsv(
      input.buffer,
      { ...defaultImportOptions, encoding: "euc-kr" },
      () => {},
    );
    expect(result.rows).toEqual([["a".repeat(chunk - 1) + "가"]]);
  });

  it("stops at the row limit without reading a later malformed byte chunk", async () => {
    const prefix = bytes("열\n" + "a\n".repeat(50_000));
    const input = new Uint8Array(csvReadLimits.chunkBytes * 3);
    input.fill(97);
    input.set(new Uint8Array(prefix));
    input[input.length - 1] = 0xff;
    expect(() =>
      parseBytes(input.buffer, "검증.csv", defaultImportOptions),
    ).toThrow("50,000행");

    const file = new File([input], "검증.csv");
    const slices = vi.spyOn(file, "slice");
    const wholeFile = vi.spyOn(file, "arrayBuffer");
    await expect(parseCsvFile(file, defaultImportOptions)).rejects.toThrow("50,000행");
    expect(wholeFile).not.toHaveBeenCalled();
    expect(slices.mock.calls).toEqual([
      [0, csvReadLimits.chunkBytes],
      [csvReadLimits.chunkBytes, 2 * csvReadLimits.chunkBytes],
    ]);
  });

  it("keeps quoted separators and pads ragged rows in the File entry point", async () => {
    for (const delimiter of [",", ";", "\t", "|"] as const) {
      const text = `"왼쪽${delimiter}오른쪽"${delimiter}값\r\n하나\r\n둘${delimiter}\r\n`;
      const result = await parseCsvFile(new File([text], "검증.CSV"), {
        ...defaultImportOptions,
        delimiter,
      });
      expect(result.original.columns.map((c) => c.name)).toEqual([
        `왼쪽${delimiter}오른쪽`,
        "값",
      ]);
      expect(result.original.rows.map((r) => Object.values(r.values))).toEqual([
        ["하나", null],
        ["둘", ""],
      ]);
    }
  });

  it("rejects extra columns and padded cells as soon as a delimiter exceeds the limit", () => {
    expect(() => parse(",".repeat(200) + '"닫히지 않음')).toThrow("200열");
    const ragged = "이름\n" + "가\n".repeat(2499) + ",".repeat(199);
    expect(() => parse(ragged + '"닫히지 않음')).toThrow("500,000셀");
  });

  it("counts decoded field length and bounds the full logical record", () => {
    const field = "x".repeat(csvReadLimits.fieldUnits);
    expect(read(`"${field}"`)).toEqual([[field]]);
    expect(() => read(`"${field}x`)).toThrow("셀 텍스트");

    const fields = Array.from({ length: 16 }, () => field.slice(1));
    fields[0] = field;
    const fullRecord = fields.join(",");
    expect(fullRecord.length).toBe(csvReadLimits.recordUnits);
    expect(read(fullRecord)).toEqual([fields]);
    fields[1] = field;
    expect(() => read(fields.join(","))).toThrow("레코드 텍스트");
  });
});
