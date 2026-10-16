import type {
  AnalysisConfig,
  AnalysisRecord,
  DataVersion,
  DeepReadonly,
  OriginalData,
  TableData,
  VersionRef,
} from "./types";

function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
/** Clone at the boundary; no caller-owned references enter preserved records. */
export function snapshot<T>(value: T): DeepReadonly<T> {
  return freeze(structuredClone(value));
}
export function preserveOriginal(
  table: TableData,
  cellMetadata?: OriginalData["cellMetadata"],
): DeepReadonly<OriginalData> {
  return snapshot({ table, ...(cellMetadata ? { cellMetadata } : {}) });
}
export function createVersion(
  table: DeepReadonly<TableData>,
  metadata: Omit<DataVersion, keyof TableData>,
): DeepReadonly<DataVersion> {
  return snapshot({
    ...structuredClone(table),
    ...metadata,
  }) as DeepReadonly<DataVersion>;
}
export function createAnalysisRecord(
  config: AnalysisConfig,
  id: string,
  now: string,
): AnalysisRecord {
  return {
    id,
    kind: config.kind,
    configSnapshot: snapshot(config),
    status: "pending",
    result: null,
    interpretationIds: [],
    createdAt: now,
  };
}
// Object key order is irrelevant; array order remains significant.
function canonical(value: unknown, omitSource = false): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return "[" + value.map((item) => canonical(item)).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .filter(([key]) => !omitSource || key !== "source")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
      .join(",") +
    "}"
  );
}
export type Freshness = {
  state: "current" | "stale" | "unavailable";
  reasons: string[];
};
/** Past snapshots and source versions remain readable even when a result is stale. */
export function getResultFreshness(
  record: AnalysisRecord,
  currentSource: VersionRef | null,
  currentConfig: AnalysisConfig | null,
): Freshness {
  if (record.status !== "completed")
    return { state: "unavailable", reasons: ["완료된 분석 결과가 없습니다."] };
  const reasons: string[] = [];
  const saved = record.configSnapshot;
  if (
    !currentSource ||
    currentSource.datasetId !== saved.source.datasetId ||
    currentSource.versionId !== saved.source.versionId
  )
    reasons.push("자료 버전이 달라졌습니다.");
  if (!currentConfig) reasons.push("현재 분석 설정이 없습니다.");
  else {
    if (
      currentSource &&
      (currentConfig.source.datasetId !== currentSource.datasetId ||
        currentConfig.source.versionId !== currentSource.versionId)
    )
      reasons.push("분석 설정이 현재 자료를 참조하지 않습니다.");
    if (canonical(saved, true) !== canonical(currentConfig, true))
      reasons.push("분석 조건이 달라졌습니다.");
  }
  return { state: reasons.length ? "stale" : "current", reasons };
}
