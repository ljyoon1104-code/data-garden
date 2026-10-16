import { createVersion, preserveOriginal } from "../domain/model";
import type { Dataset, OperationRecord, TableData } from "../domain/types";

export const SAMPLE_ID = "sample-school-life";
export function createSample(now: string): Dataset {
  const table: TableData = {
    columns: [
      {
        id: "student-id",
        name: "학생 번호",
        storageType: "number",
        semanticType: "identifier",
        description:
          "가상의 학생을 구분하는 번호입니다. 숫자로 저장하지만 계산할 수치로 사용하지 않습니다.",
        useInAnalysis: false,
      },
      {
        id: "grade",
        name: "학년",
        storageType: "number",
        semanticType: "categorical",
        description: "학생의 학년입니다. 숫자로 표현된 범주형 속성입니다.",
        useInAnalysis: true,
      },
      {
        id: "commute",
        name: "등교 방법",
        storageType: "string",
        semanticType: "categorical",
        description: "주로 이용하는 등교 방법입니다.",
        useInAnalysis: true,
      },
      {
        id: "sleep",
        name: "수면 시간",
        storageType: "number",
        semanticType: "numeric",
        description: "하루 평균 수면 시간입니다. 단위는 시간입니다.",
        useInAnalysis: true,
      },
      {
        id: "reading",
        name: "독서 시간",
        storageType: "number",
        semanticType: "numeric",
        description: "하루 평균 독서 시간입니다. 단위는 분입니다.",
        useInAnalysis: true,
      },
      {
        id: "survey-date",
        name: "조사일",
        storageType: "string",
        semanticType: "date",
        description: "조사 날짜입니다. YYYY-MM-DD 형식의 문자열로 저장합니다.",
        useInAnalysis: false,
      },
    ],
    rows: [
      [101, 1, "도보", 7.5, 30, "2026-09-01"],
      [102, 1, "버스", 6.5, 20, "2026-09-01"],
      [103, 2, "자전거", 8, 45, "2026-09-01"],
      [104, 2, "도보", 7, 15, "2026-09-02"],
      [105, 3, "버스", 6, 30, "2026-09-02"],
      [106, 1, "도보", 8.5, 60, "2026-09-02"],
      [107, 3, "자전거", 7, 25, "2026-09-03"],
      [108, 2, "버스", 6.5, 40, "2026-09-03"],
      [109, 1, "도보", 8, 20, "2026-09-03"],
      [110, 3, "버스", 7.5, 50, "2026-09-04"],
      [111, 2, "자전거", 7, 35, "2026-09-04"],
      [112, 3, "도보", 6.5, 15, "2026-09-04"],
    ].map((values, index) => ({
      id: `sample-row-${index + 1}`,
      values: Object.fromEntries(
        [
          "student-id",
          "grade",
          "commute",
          "sleep",
          "reading",
          "survey-date",
        ].map((id, i) => [id, values[i]]),
      ),
    })),
  };
  const operation: OperationRecord = {
    id: "sample-operation",
    kind: "sample",
    datasetId: SAMPLE_ID,
    inputVersionIds: [],
    outputVersionIds: ["sample-v1"],
    settings: { generator: "school-life-v1" },
    executedAt: now,
  };
  return {
    id: SAMPLE_ID,
    name: "우리 반 생활 습관",
    source: {
      kind: "sample",
      label: "화면 확인용 가상 자료 · 실제 학생 자료가 아닙니다.",
      importedAt: now,
    },
    original: preserveOriginal(table),
    versions: [
      createVersion(table, {
        id: "sample-v1",
        datasetId: SAMPLE_ID,
        parentVersionIds: [],
        createdAt: now,
        operation,
      }),
    ],
  };
}
