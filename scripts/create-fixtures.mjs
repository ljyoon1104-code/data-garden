import fs from "node:fs";
import * as XLSX from "xlsx";
const directory = new URL("../tests/fixtures/", import.meta.url);
fs.mkdirSync(directory, { recursive: true });
const write = (name, contents) =>
  fs.writeFileSync(new URL(name, directory), contents);
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
console.log("Created CSV/XLSX fixtures in tests/fixtures");
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
