import fs from "node:fs";
import * as XLSX from "xlsx";
const directory = new URL("../tests/fixtures/", import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("사용법: node scripts/create-fixtures.mjs [--check]");
  process.exit(1);
}
const check = args[0] === "--check";
// Generate every byte before touching the fixture directory. Check mode never writes.
const fixtures = new Map();
const write = (name, contents) => {
  if (fixtures.has(name)) throw new Error(`중복 생성 규칙: ${name}`);
  fixtures.set(name, Buffer.from(contents));
};
const csv =
  '학생번호,이름,점수,집단,조사일,메모\n00123,가람,10,A,2026-09-01,"쉼표, 포함"\n00124,나래,20,A,2026-09-02,"여러 줄\n메모"\n00125,다온,30,B,2026-09-03,\n00126,라온,40,B,2026-09-04,NA\n00126,라온,40,B,2026-09-04,NA\n00127,마루,,B,2026-09-05,0\n';
write("korean-utf8.csv", csv);
write("korean-bom.csv", "\uFEFF" + csv);
write(
  "korean-euckr.csv",
  new Uint8Array([
    0xc0, 0xcc, 0xb8, 0xa7, 44, 0xc1, 0xa1, 0xbc, 0xf6, 10, 0xb0, 0xa1, 44, 49,
    10, 0xb3, 0xaa, 44, 50,
  ]),
);
write("empty.csv", "");
write("malformed.csv", '이름,값\n가,"닫히지 않은 값');
write("uneven.csv", "이름,이름,\n가,나,1,추가\n다");
write("semicolon.csv", "가;1\n나;2");
write(
  "large.csv",
  "학생번호,점수,집단,메모\n" +
    Array.from(
      { length: 20000 },
      (_, i) =>
        `${String(i).padStart(6, "0")},${i % 101},${i % 3},검증 자료 ${i}`,
    ).join("\n"),
);
const wb = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet([
  ["학생코드", "조사일", "점수", "동의", "메모"],
  [123, 45292, 10, true, null],
  [456, 45293, 20, false, "NA"],
  [789, 45294, 30, true, "0"],
]);
for (const row of [2, 3, 4]) {
  sheet[`A${row}`].z = "00000";
  sheet[`B${row}`].z = "yyyy-mm-dd";
}
XLSX.utils.book_append_sheet(wb, sheet, "수업 자료");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "빈 시트");
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    ["지역코드", "점수"],
    ["001", 80],
    ["002", 90],
  ]),
  "다른 시트",
);
write(
  "multiple-sheets.xlsx",
  XLSX.write(wb, { bookType: "xlsx", type: "buffer" }),
);
write("invalid.xlsx", "not a workbook");
write(
  "preprocessing.csv",
  "학생번호,측정값,분류\n001,1.0,A\n002,2.0,A\n003,3.0,B\n004,4.0,B\n005,100.0,A\n006,,\n007,2.0,A\n",
);
write(
  "stage5-left.csv",
  "코드,집단,값,분모,날짜\n001,A,2.5,2.0,2024-02-29\n001,A,5.5,0.0,2024-03-31T23:59:58\n002,B,,4.0,2025-01-01\n003,B,10.5,5.0,2024-12-31\n004,,0.5,1.0,\n",
);
write(
  "stage5-right.csv",
  "코드,집단,비교값\n001,A,10.5\n001,A,20.5\n003,B,30.5\n005,C,40.5\n",
);
write(
  "stage5-large.csv",
  "집단,값\n" +
    Array.from(
      { length: 49999 },
      (_, i) => `${String.fromCharCode(65 + (i % 8))},${i}.5`,
    ).join("\n"),
);

write(
  "cancel-large.csv",
  "학생번호," +
    Array.from({ length: 9 }, (_, j) => `점수${j + 1}`).join(",") +
    "\n" +
    Array.from(
      { length: 49999 },
      (_, i) =>
        [String(i).padStart(6, "0"), ...Array.from({ length: 9 }, (_, j) => i + j)].join(","),
    ).join("\n") +
    "\n",
);
write(
  "stage7-regression.csv",
  "학습 시간,연습 횟수,점수\n" +
    Array.from({ length: 40 }, (_, i) => {
      const study = i + 0.25;
      const practice = ((i * 7) % 17) + 0.5;
      return `${i === 5 || i === 12 ? "" : study},${practice},${4 + 2 * study - 3 * practice}`;
    }).join("\n"),
);
write(
  "stage7-cancel.csv",
  "입력값,정답\n" +
    Array.from(
      { length: 10000 },
      // Division is intentional: multiplication by 0.01/0.005 changes some final digits.
      (_, i) => `${Math.sin(i) * 500 + i / 100},${Math.cos(i) * 300 + i / 200}`,
    ).join("\n"),
);
write(
  "stage8-large.csv",
  "\uFEFF온도,길이,무게,속도,넓이,시간,높이,깊이\n" +
    Array.from({ length: 10000 }, (_, i) =>
      Array.from({ length: 8 }, (_, j) =>
        (Math.sin(i * (j + 1) * 0.71) * 100 + Math.cos(i / (j + 2)) * 20 + i * 0.005 + 0.123).toFixed(5),
      ).join(","),
    ).join("\n"),
);

// The three transaction encodings preserve the same six baskets, including two empty ones.
const baskets = [["A", "B", "C", "D"], ["A", "B", "C", "D"], ["A", "B", "C"], ["A"], [], []];
write(
  "stage9-list.csv",
  "거래,항목목록\n" +
    baskets.map((items, i) => `T${i + 1},${items.length > 1 ? `"${items.join(",")}"` : items.join(",")}`).join("\n") +
    "\n",
);
write(
  "stage9-binary.csv",
  "거래,A,B,C,D\n" +
    baskets.map((items, i) => `T${i + 1},${["A", "B", "C", "D"].map((item) => Number(items.includes(item))).join(",")}`).join("\n") +
    "\n",
);
write(
  "stage9-vertical.csv",
  "거래ID,항목\n" +
    baskets.flatMap((items, i) =>
      (items.length ? items : [""]).map((item) => `${String(i + 1).padStart(3, "0")},${item}`),
    ).join("\n") +
    "\n",
);
write("stage9-category.csv", "학년,선호과목\n1,수학\n1,수학\n1,국어\n2,수학\n2,국어\n2,\n");
// Valid outer CSV; the decoded list value is an unterminated quoted item ("A).
write("stage9-invalid.csv", '거래,항목목록\nT1,"""A"\n');
write(
  "stage9-limit.csv",
  `항목목록\n"${Array.from({ length: 33 }, (_, i) => `I${i}`).join(",")}"\n`,
);
const largeBasket = Array.from({ length: 12 }, (_, i) => `I${i}`).join(",");
write(
  "stage9-large.csv",
  "거래,항목목록\n" +
    Array.from({ length: 6500 }, (_, i) => `T${i},"${largeBasket}"`).join("\n"),
);

// Freeze the stage-3 synthetic project independently of today's sample/schema.
// Fixed IDs, timestamps, key order and compact JSON retain the original backup bytes.
function futureProject() {
  const datasetId = "sample-school-life";
  const initialId = "sample-v1";
  const editedId = "bd67e635-45b4-4a4d-8843-d7ab11a487aa";
  const importedAt = "2026-10-12T01:34:48.915Z";
  const editedAt = "2026-10-12T01:35:32.725Z";
  const columns = [
    ["student-id", "학생 번호", "number", "identifier", "가상의 학생을 구분하는 번호입니다. 숫자로 저장하지만 계산할 수치로 사용하지 않습니다.", false],
    ["grade", "학년", "number", "categorical", "학생의 학년입니다. 숫자로 표현된 범주형 속성입니다.", true],
    ["commute", "등교 방법", "string", "categorical", "주로 이용하는 등교 방법입니다.", true],
    ["sleep", "수면 시간", "number", "numeric", "하루 평균 수면 시간입니다. 단위는 시간입니다.", true],
    ["reading", "독서 시간", "number", "numeric", "하루 평균 독서 시간입니다. 단위는 분입니다.", true],
    ["survey-date", "조사일", "string", "date", "조사 날짜입니다. YYYY-MM-DD 형식의 문자열로 저장합니다.", false],
  ].map(([id, name, storageType, semanticType, description, useInAnalysis]) => ({
    id, name, storageType, semanticType, description, useInAnalysis,
  }));
  const rows = [
    [1, "도보", 7.5, 30], [1, "버스", 6.5, 20], [2, "자전거", 8, 45],
    [2, "도보", 7, 15], [3, "버스", 6, 30], [1, "도보", 8.5, 60],
    [3, "자전거", 7, 25], [2, "버스", 6.5, 40], [1, "도보", 8, 20],
    [3, "버스", 7.5, 50], [2, "자전거", 7, 35], [3, "도보", 6.5, 15],
  ].map(([grade, commute, sleep, reading], i) => ({
    id: `sample-row-${i + 1}`,
    values: {
      "student-id": 101 + i,
      grade, commute, sleep, reading,
      "survey-date": `2026-09-0${Math.floor(i / 3) + 1}`,
    },
  }));
  const sampleOperation = {
    id: "sample-operation", kind: "sample", datasetId,
    inputVersionIds: [], outputVersionIds: [initialId],
    settings: { generator: "school-life-v1" }, executedAt: importedAt,
  };
  const editOperation = {
    id: "2d919de6-5f88-49f6-aff4-a1801fb33c04", kind: "edit-cell", datasetId,
    inputVersionIds: [initialId], outputVersionIds: [editedId],
    settings: { kind: "cell", rowId: "sample-row-1", attributeId: "sleep", value: "9", missing: false },
    executedAt: editedAt,
  };
  const selection = { datasetId, versionId: editedId };
  return {
    format: "data-garden-project",
    formatVersion: 99,
    exportedAt: "2026-10-12T01:40:36.249Z",
    workspace: {
      project: {
        id: "e7390b95-09ba-4166-809a-883cb200f1e7",
        name: "3단계 검증 수업", schemaVersion: 2,
        activeVersions: { [datasetId]: editedId },
        history: {
          entries: [{
            id: "942a0ab9-a401-4be8-ba03-9b1750235fb3", label: "셀 값 수정", datasetId,
            beforeVersionId: initialId, afterVersionId: editedId,
            beforeSelection: { datasetId, versionId: initialId }, afterSelection: selection,
            operationIds: [editOperation.id], executedAt: "2026-10-12T01:35:32.726Z",
          }],
          cursor: 1,
        },
        datasets: [{
          id: datasetId, name: "우리 반 생활 습관",
          source: { kind: "sample", label: "화면 확인용 가상 자료 · 실제 학생 자료가 아닙니다.", importedAt },
          original: { table: { columns, rows } },
          versions: [
            { columns, rows, id: initialId, datasetId, parentVersionIds: [], createdAt: importedAt, operation: sampleOperation },
            {
              columns,
              rows: rows.map((row, i) => i === 0 ? { ...row, values: { ...row.values, sleep: 9 } } : row),
              id: editedId, datasetId, parentVersionIds: [initialId], createdAt: editedAt, operation: editOperation,
            },
          ],
        }],
        selection,
        operations: [sampleOperation, editOperation],
        graphs: [], analysisConfigs: {}, analyses: [], interpretations: [],
        createdAt: importedAt, updatedAt: "2026-10-12T01:35:33.397Z",
      },
      view: {
        menu: "data", selectedAttributeByDataset: { [datasetId]: "sleep" },
        density: "comfortable", inspectorOpen: true,
        tables: {
          [datasetId]: {
            sort: { attributeId: "sleep", direction: "asc" }, filter: null,
            selectedRowIds: ["sample-row-1"], selectedColumnIds: [],
            page: 0, pageSize: 25, duplicatesOnly: false, statisticsScope: "all",
          },
        },
      },
    },
  };
}
write("future-project.json", JSON.stringify(futureProject()));

if (check) {
  let passed = 0;
  let failed = 0;
  for (const [name, expected] of fixtures) {
    try {
      const actual = fs.readFileSync(new URL(name, directory));
      if (!actual.equals(expected)) {
        let offset = 0;
        while (offset < Math.min(actual.length, expected.length) && actual[offset] === expected[offset]) offset++;
        console.error(`불일치: ${name} (기존 ${actual.length} / 생성 ${expected.length} 바이트, 첫 차이 ${offset})`);
        failed++;
      } else {
        console.log(`일치: ${name} (${actual.length} 바이트)`);
        passed++;
      }
    } catch (error) {
      console.error(`${error.code === "ENOENT" ? "누락" : "읽기 실패"}: ${name} (${error.code ?? error.message})`);
      failed++;
    }
  }
  // A new fixture must not silently fall outside the reproducibility check.
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (/\.(csv|xlsx|json)$/i.test(name) && !fixtures.has(name)) {
        console.error(`생성 규칙 없음: ${name}`);
        failed++;
      }
    }
  }
  console.log(`검증 자료 검사: ${passed}개 일치, ${failed}개 실패. 파일을 쓰지 않았습니다.`);
  if (failed) process.exitCode = 1;
} else {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, contents] of fixtures) fs.writeFileSync(new URL(name, directory), contents);
  console.log(`Created ${fixtures.size} CSV/XLSX/JSON fixtures in tests/fixtures`);
}
