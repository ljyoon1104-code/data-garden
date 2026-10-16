import type { DataVersion, Dataset, DeepReadonly } from "./types";
import { preprocessingLineage, isNumeric } from "./preprocessing";
import { isMissing, convertCell } from "./table";

/** Called after structural JSON validation; checks references and method-specific fitted values. */
export function validatePreprocessingRecord(
  dataset: Dataset,
  version: DeepReadonly<DataVersion>,
) {
  const op = version.operation,
    record = op.preprocessing;
  const require = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`전처리 기록: ${message}`);
  };
  if (op.kind !== "preprocess") {
    require(!record, "다른 작업에 전처리 기록이 있습니다.");
    return;
  }
  require(record, "처리 기준이 없습니다.");
  if (!record) return;
  const { fitted, input } = record,
    s = fitted.settings;
  require(op.inputVersionIds.length === 1 &&
    op.outputVersionIds.length === 1 &&
    input.datasetId === dataset.id &&
    input.versionId === op.inputVersionIds[0], "입력 참조 오류입니다.");
  const before = dataset.versions.find((v) => v.id === input.versionId)!;
  require(fitted.source.datasetId === dataset.id &&
    fitted.source.versionId === input.versionId, "기준 계산 자료가 다릅니다.");
  require(JSON.stringify(op.settings) ===
    JSON.stringify(s), "설정 사본이 다릅니다.");
  const lineage = preprocessingLineage(dataset, before.id);
  require(JSON.stringify(lineage.origin) === JSON.stringify(record.origin) &&
    JSON.stringify(lineage.previousOperationIds) ===
      JSON.stringify(
        record.previousOperationIds,
      ), "전처리 순서 또는 최초 입력 참조가 다릅니다.");
  const ids = s.attributeIds,
    selected = new Set(ids),
    fitIds = new Set(fitted.fitRows.rowIds),
    rows = new Map(before.rows.map((r) => [r.id, r]));
  require(ids.length > 0 &&
    selected.size === ids.length &&
    Object.keys(fitted.columns).length ===
      ids.length, "대상 속성 수가 잘못되었습니다.");
  require(fitIds.size === fitted.fitRows.count &&
    fitIds.size === fitted.fitRows.rowIds.length &&
    fitIds.size > 0 &&
    [...fitIds].every((id) =>
      rows.has(id),
    ), "기준 계산 행 참조 또는 개수 오류입니다.");
  require(fitted.fitRows.kind !== "all" ||
    fitIds.size === before.rows.length, "전체 행 기준에 일부 행이 없습니다.");
  require(JSON.stringify(
    before.rows.filter((r) => fitIds.has(r.id)).map((r) => r.id),
  ) === JSON.stringify(fitted.fitRows.rowIds), "기준 계산 행 순서 오류입니다.");
  if (s.kind === "outliers")
    require(s.multiplier >= 0 && s.lower <= s.upper, "경계 설정 오류입니다.");
  for (const id of ids) {
    const c = before.columns.find((c) => c.id === id),
      b = fitted.columns[id];
    require(c && b, "없는 속성 참조입니다.");
    if (!c || !b) continue;
    require(b.storageType === c.storageType &&
      b.semanticType === c.semanticType, "기준 자료형이 다릅니다.");
    const missing = fitted.fitRows.rowIds.filter((r) =>
      isMissing(rows.get(r)!.values[id]),
    ).length;
    require(b.missingCount === missing &&
      b.validCount ===
        fitIds.size - missing, "기준 유효값·결측값 개수가 다릅니다.");
    if (
      s.kind === "scale" ||
      s.kind === "outliers" ||
      (s.kind === "missing" && ["mean", "median"].includes(s.method))
    )
      require(isNumeric(c), "수치 속성이 아닙니다.");
    if (s.kind === "missing" && s.method === "mode")
      require(c.semanticType === "categorical", "범주 속성이 아닙니다.");
    if (
      (s.kind === "missing" && s.method !== "remove") ||
      (s.kind === "outliers" && s.action === "median")
    ) {
      require(b.replacement !== undefined &&
        !isMissing(b.replacement!), "대체값이 없습니다.");
      require(c.storageType === "mixed" ||
        typeof b.replacement === c.storageType, "대체값 자료형이 다릅니다.");
      if (c.semanticType === "date") convertCell(b.replacement!, { ...c });
      if (s.kind === "missing") {
        if (s.method === "fixed")
          require(id in s.fixedValues &&
            convertCell(s.fixedValues[id], { ...c }) ===
              b.replacement, "고정값 설정이 다릅니다.");
        else require(b.validCount > 0, "기준 유효값이 없습니다.");
      }
    }
    if (s.kind === "scale")
      require(b.validCount >= 2 &&
        b.min !== undefined &&
        b.max !== undefined &&
        b.mean !== undefined &&
        b.stddev !== undefined &&
        b.min < b.max &&
        Number.isFinite(b.max - b.min) &&
        b.stddev > 0 &&
        b.mean >= b.min &&
        b.mean <= b.max, "변환 기준 오류입니다.");
    if (s.kind === "outliers") {
      require(b.lower !== undefined &&
        b.upper !== undefined &&
        b.lower <= b.upper, "이상값 경계 오류입니다.");
      if (s.detection === "iqr")
        require(b.validCount > 0 &&
          b.q1 !== undefined &&
          b.q3 !== undefined &&
          b.q1 <= b.q3, "사분위수 오류입니다.");
      else
        require(b.lower === s.lower &&
          b.upper === s.upper, "직접 입력 경계가 다릅니다.");
      if (s.action === "mark")
        require(false, "표시 전용 작업은 자료 버전을 만들지 않습니다.");
    }
  }
  require(JSON.stringify(before.columns) ===
    JSON.stringify(version.columns), "전처리에서 속성 정보가 바뀌었습니다.");
  const removed = new Set(record.removedRowIds),
    afterRows = new Map(version.rows.map((r) => [r.id, r]));
  require(removed.size === record.removedRowIds.length &&
    [...removed].every(
      (id) => rows.has(id) && !afterRows.has(id),
    ), "제거 행 참조 오류입니다.");
  require(JSON.stringify(
    before.rows.filter((r) => !removed.has(r.id)).map((r) => r.id),
  ) ===
    JSON.stringify(
      version.rows.map((r) => r.id),
    ), "행 순서·ID 또는 제거 행 개수가 다릅니다.");
  let changed = 0;
  for (const row of version.rows)
    for (const c of version.columns)
      if (row.values[c.id] !== rows.get(row.id)!.values[c.id]) {
        require(selected.has(c.id), "선택하지 않은 속성이 바뀌었습니다.");
        changed++;
      }
  require(changed === record.changedCells &&
    (changed > 0 || removed.size > 0), "변경 개수 오류입니다.");
}
