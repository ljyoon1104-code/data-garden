import type { ImportOptions } from "../domain/types";

export const csvReadLimits = {
  chunkBytes: 64 * 1024,
  fieldUnits: 64 * 1024,
  recordUnits: 1024 * 1024,
} as const;

type FieldState = "start" | "unquoted" | "quoted" | "closingQuote" | "afterQuote";
type TableSizeCheck = (rows: number, width: number) => void;
export type CsvRecords = { rows: string[][]; width: number };

function createCsvReader(
  { encoding, delimiter }: ImportOptions,
  checkTableSize: TableSizeCheck,
) {
  // Keep the decoder from swallowing a BOM before our one-time BOM handling.
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  const rows: string[][] = [];
  const fieldParts: string[] = [];
  let row: string[] = [];
  let width = 0;
  let state: FieldState = "start";
  let fieldUnits = 0;
  let recordUnits = 0;
  let recordStarted = false;
  let skipLF = false;
  let sawText = false;

  function fail(message: string): never {
    throw new Error(`CSV 레코드 ${rows.length + 1}: ${message}`);
  }
  function finishField() {
    row.push(fieldParts.join(""));
    fieldParts.length = 0;
    fieldUnits = 0;
    state = "start";
  }
  function finishRecord() {
    finishField();
    rows.push(row);
    row = [];
    recordStarted = false;
    recordUnits = 0;
  }
  function consume(text: string) {
    // Collect uninterrupted slices so a long field does not retain a rope node
    // or an array element for each character in the input.
    let runStart = -1;
    function finishRun(end: number) {
      if (runStart < 0) return;
      fieldParts.push(text.slice(runStart, end));
      runStart = -1;
    }
    function addCharacter(index: number) {
      if (++fieldUnits > csvReadLimits.fieldUnits)
        fail(
          "셀 텍스트가 UTF-16 65,536단위를 넘습니다. 긴 텍스트를 나누어 다시 여세요.",
        );
      if (runStart < 0) runStart = index;
    }

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (skipLF) {
        skipLF = false;
        if (char === "\n") continue;
      }
      if (!recordStarted) {
        width = Math.max(width, 1);
        checkTableSize(rows.length + 1, width);
        recordStarted = true;
      }
      const lineEnd = state !== "quoted" && (char === "\n" || char === "\r");
      if (!lineEnd && ++recordUnits > csvReadLimits.recordUnits)
        fail(
          "레코드 텍스트가 UTF-16 1,048,576단위를 넘습니다. 긴 레코드를 나누어 다시 여세요.",
        );

      if (state === "quoted") {
        if (char === '"') {
          finishRun(i);
          state = "closingQuote";
        } else addCharacter(i);
      } else if (state === "closingQuote" && char === '"') {
        addCharacter(i);
        state = "quoted";
      } else if (char === delimiter || lineEnd) {
        finishRun(i);
        if (lineEnd) {
          finishRecord();
          skipLF = char === "\r";
        } else {
          // A delimiter starts another field even when nothing follows it.
          // A wider record also widens every previously retained ragged row.
          const nextWidth = row.length + 2;
          if (nextWidth > width) {
            checkTableSize(rows.length + 1, nextWidth);
            width = nextWidth;
          }
          finishField();
        }
      } else if (state === "closingQuote" || state === "afterQuote") {
        if (char.trim())
          fail("따옴표 형식이 올바르지 않습니다. 따옴표와 구분자를 확인하세요.");
        state = "afterQuote";
      } else if (state === "start" && char === '"') {
        state = "quoted";
      } else {
        addCharacter(i);
        state = "unquoted";
      }
    }
    finishRun(text.length);
  }
  function decode(chunk?: Uint8Array) {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: chunk !== undefined });
    } catch {
      throw new Error(
        "선택한 인코딩으로 읽을 수 없습니다. UTF-8 또는 EUC-KR(CP949) 설정을 바꾸어 보세요.",
      );
    }
    if (!sawText && text.length) {
      sawText = true;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    consume(text);
  }
  function finishInput() {
    if (state === "quoted")
      fail("닫는 따옴표가 없습니다. 따옴표와 구분자를 확인하세요.");
    // A final line terminator does not start another record. Interior empty
    // records and the final empty field after a delimiter are retained.
    if (recordStarted) finishRecord();
    if (!rows.length) throw new Error("내용이 없는 파일입니다.");
  }

  return {
    push: (chunk: Uint8Array) => decode(chunk),
    finish(): CsvRecords {
      decode();
      finishInput();
      return { rows, width };
    },
  };
}

export function parseCsv(
  bytes: ArrayBuffer,
  options: ImportOptions,
  checkTableSize: TableSizeCheck,
): CsvRecords {
  const reader = createCsvReader(options, checkTableSize);
  const input = new Uint8Array(bytes);
  for (let start = 0; start < input.length; start += csvReadLimits.chunkBytes)
    reader.push(input.subarray(start, start + csvReadLimits.chunkBytes));
  return reader.finish();
}

export async function readCsvFile(
  file: Blob,
  options: ImportOptions,
  checkTableSize: TableSizeCheck,
): Promise<CsvRecords> {
  const reader = createCsvReader(options, checkTableSize);
  for (let start = 0; start < file.size; start += csvReadLimits.chunkBytes) {
    const bytes = await file
      .slice(start, start + csvReadLimits.chunkBytes)
      .arrayBuffer();
    reader.push(new Uint8Array(bytes));
  }
  return reader.finish();
}
