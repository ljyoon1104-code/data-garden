import { validateResultState } from '../domain/results';
import {
  validateAssociationConfig,
  validateAssociationRecord,
  validateAssociationView,
  associationValidationBudget,
} from "../domain/association-validation";
import { analysisConfigKey } from "../domain/clustering";
import {
  validateClusteringConfig,
  validateClusteringRecord,
  clusteringValidationBudget,
} from "../domain/clustering-validation";
import {
  validateRegressionConfig,
  validateRegressionRecord,
} from "../domain/regression-validation";
import { validateGraph, calculateGraph } from "../domain/graphs";
import { validateWranglingRecord } from "../domain/wrangling-validation";
import { traceProcessing } from "../domain/processing";
import { validatePreprocessingRecord } from "../domain/preprocessing-validation";
import { snapshot } from "../domain/model";
import type { AnalysisConfig, VersionRef } from "../domain/types";
import type { WorkspaceState } from "../state/workspace";

import { FORMAT } from "./backup";
import type { Backup } from "./backup";
export { FORMAT, makeBackup } from "./backup";
export type { Backup } from "./backup";
export const RESTORE_BYTES = 80 * 1024 * 1024;
import { MAX_PRESERVED_CELLS } from "../domain/limits";
export const RESTORE_CELLS = MAX_PRESERVED_CELLS;

type Check = (value: unknown, path: string) => void;
const fail = (path: string, reason: string): never => {
  throw new Error(`${path}: ${reason}`);
};
const check =
  (test: (value: unknown) => boolean, reason: string): Check =>
  (v, p) => {
    if (!test(v)) fail(p, reason);
  };
const str = check((v) => typeof v === "string", "문자열이 필요합니다.");
const id = check(
  (v) =>
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 200 &&
    !["__proto__", "constructor", "prototype"].includes(v),
  "올바른 ID가 필요합니다.",
);
const bool = check((v) => typeof v === "boolean", "불리언이 필요합니다.");
const num = check(
  (v) => typeof v === "number" && Number.isFinite(v),
  "유한한 수가 필요합니다.",
);
const nat = check(
  (v) => Number.isSafeInteger(v) && Number(v) >= 0,
  "0 이상의 정수가 필요합니다.",
);
const time = check(
  (v) => typeof v === "string" && Number.isFinite(Date.parse(v)),
  "시각 형식 오류입니다.",
);
const one = (...values: unknown[]): Check =>
  check((v) => values.includes(v), "지원하지 않는 값입니다.");
const nullable =
  (test: Check): Check =>
  (v, p) => {
    if (v !== null) test(v, p);
  };
const optional =
  (test: Check): Check =>
  (v, p) => {
    if (v !== undefined) test(v, p);
  };
const obj: Check = check(
  (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  "객체가 필요합니다.",
);
const shape =
  (fields: Record<string, Check>): Check =>
  (v, p) => {
    obj(v, p);
    for (const [k, test] of Object.entries(fields))
      test((v as Record<string, unknown>)[k], `${p}.${k}`);
  };
const array =
  (test: Check): Check =>
  (v, p) => {
    if (!Array.isArray(v)) fail(p, "배열이 필요합니다.");
    (v as unknown[]).forEach((item, i) => test(item, `${p}[${i}]`));
  };
const dict =
  (test: Check): Check =>
  (v, p) => {
    obj(v, p);
    for (const [k, item] of Object.entries(v as object)) {
      id(k, p);
      test(item, `${p}.${k}`);
    }
  };
// The whole input is traversed before typed access, including arbitrary settings/results.
function json(value: unknown) {
  let nodes = 0;
  function visit(v: unknown, depth: number) {
    if (++nodes > 20_000_000 || depth > 60)
      fail("프로젝트", "구조가 너무 큽니다. 작은 프로젝트로 나누세요.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || v === undefined)
      fail("프로젝트", "JSON에 저장할 수 없는 값입니다.");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      fail("프로젝트", "일반 JSON 객체만 지원합니다.");
    for (const [k, item] of Object.entries(v as object)) {
      if (["__proto__", "constructor", "prototype"].includes(k))
        fail(k, "허용하지 않는 키입니다.");
      visit(item, depth + 1);
    }
  }
  visit(value, 0);
}
const anyJson: Check = (v) => json(v);
const ids = array(id);
const ref = shape({ datasetId: id, versionId: id });
const column = shape({
  id,
  name: str,
  storageType: one("number", "string", "boolean", "mixed"),
  semanticType: one("numeric", "categorical", "date", "identifier", "text"),
  description: str,
  useInAnalysis: bool,
});
const cell = check(
  (v) =>
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)),
  "지원하지 않는 셀 값입니다.",
);
const table = {
  columns: array(column),
  rows: array(shape({ id, values: dict(cell) })),
};
const preprocessingSettings: Check = (v, p) => {
  shape({
    kind: one("missing", "duplicates", "outliers", "scale"),
    attributeIds: ids,
  })(v, p);
  const kind = (v as { kind: string }).kind;
  if (kind === "missing")
    shape({
      method: one("remove", "mean", "median", "mode", "fixed"),
      rowRule: one("any", "all"),
      fixedValues: dict(str),
    })(v, p);
  if (kind === "duplicates") shape({ keep: one("first", "last") })(v, p);
  if (kind === "scale") shape({ method: one("minmax", "zscore") })(v, p);
  if (kind === "outliers")
    shape({
      detection: one("iqr", "bounds"),
      multiplier: num,
      lower: num,
      upper: num,
      action: one("mark", "remove", "missing", "clip", "median"),
      rowRule: one("any", "all"),
    })(v, p);
};
const preprocessingRecord = shape({
  formatVersion: one(1),
  input: ref,
  origin: ref,
  previousOperationIds: ids,
  changedCells: nat,
  removedRowIds: ids,
  fitted: shape({
    formatVersion: one(1),
    source: ref,
    settings: preprocessingSettings,
    fitRows: shape({ kind: one("all", "training"), rowIds: ids, count: nat }),
    columns: dict(
      shape({
        storageType: one("number", "string", "boolean", "mixed"),
        semanticType: one(
          "numeric",
          "categorical",
          "date",
          "identifier",
          "text",
        ),
        validCount: nat,
        missingCount: nat,
        replacement: optional(cell),
        min: optional(num),
        max: optional(num),
        mean: optional(num),
        stddev: optional(num),
        q1: optional(num),
        q3: optional(num),
        lower: optional(num),
        upper: optional(num),
      }),
    ),
    conventions: shape({
      missing: one("null-or-empty"),
      modeTie: one("first-in-fit-order"),
      quantile: one("linear-n-minus-one"),
      standardDeviation: one("population-n"),
      duplicateEquality: one("typed-json"),
    }),
  }),
});
const operation = shape({
  id,
  kind: one(
    "wrangle",
    "preprocess",
    "sample",
    "import",
    "clean",
    "derive",
    "join",
    "transform",
    "edit-cell",
    "edit-attribute",
  ),
  datasetId: id,
  inputVersionIds: ids,
  outputVersionIds: ids,
  settings: anyJson,
  executedAt: time,
  preprocessing: optional(preprocessingRecord),
  wrangling: optional(anyJson),
});
const kind = one("regression", "clustering", "association");
const config = shape({
  kind,
  source: ref,
  attributeIds: ids,
  parameters: anyJson,
  preprocessing: shape({
    steps: array(shape({ method: str, attributeIds: ids, settings: anyJson })),
  }),
  calculation: shape({
    missingValuePolicy: nullable(str),
    method: nullable(str),
    settings: anyJson,
  }),
  split: shape({
    method: one("none", "holdout", "cross-validation"),
    settings: anyJson,
  }),
  randomness: shape({ seed: nullable(num), settings: anyJson }),
});
const importOptions = shape({
  encoding: one("utf-8", "euc-kr"),
  delimiter: one(",", ";", "\t", "|"),
  header: bool,
  sheet: str,
  xlsxValues: one("smart", "raw", "display"),
});
const viewCheck = shape({
  currentGraphId: optional(nullable(id)),
  currentAnalysisId: optional(nullable(id)),
  comparisonAnalysisId: optional(nullable(id)),
  comparisonGraphId: optional(nullable(id)),
  menu: one("data", "prepare", "visualize", "analyze", "results"),
  density: one("comfortable", "compact"),
  inspectorOpen: bool,
  selectedAttributeByDataset: dict(nullable(id)),
  tables: dict(
    shape({
      sort: nullable(shape({ attributeId: id, direction: one("asc", "desc") })),
      filter: nullable(
        shape({
          attributeId: id,
          operator: one("contains", "equals", "gt", "lt", "missing", "present"),
          value: str,
        }),
      ),
      selectedRowIds: ids,
      selectedColumnIds: ids,
      page: nat,
      pageSize: one(25, 50, 100),
      duplicatesOnly: bool,
      statisticsScope: one("all", "filtered"),
    }),
  ),
});
const projectCheck = shape({
  id,
  name: check(
    (v) => typeof v === "string" && !!v.trim(),
    "프로젝트 이름이 필요합니다.",
  ),
  schemaVersion: one(6),
  createdAt: time,
  updatedAt: time,
  datasets: array(
    shape({
      id,
      name: str,
      source: shape({
        kind: one("sample", "file", "manual", "derived"),
        label: str,
        importedAt: time,
        fileName: optional(str),
        mimeType: optional(str),
        importOptions: optional(importOptions),
      }),
      original: shape({
        table: shape(table),
        cellMetadata: optional(
          dict(dict(shape({ display: str, format: str, type: str }))),
        ),
      }),
      versions: array(
        shape({
          ...table,
          id,
          datasetId: id,
          parentVersionIds: ids,
          createdAt: time,
          operation,
        }),
      ),
    }),
  ),
  activeVersions: dict(nullable(id)),
  selection: nullable(ref),
  operations: array(operation),
  history: shape({
    cursor: nat,
    entries: array(
      shape({
        id,
        label: str,
        datasetId: id,
        beforeVersionId: nullable(id),
        afterVersionId: nullable(id),
        beforeSelection: nullable(ref),
        afterSelection: nullable(ref),
        operationIds: ids,
        executedAt: time,
      }),
    ),
  }),
  analysisConfigs: dict(config),
  analyses: array(
    shape({
      id,
      kind,
      configSnapshot: config,
      status: one("pending", "running", "completed", "failed", "cancelled"),
      result: anyJson,
      interpretationIds: ids,
      createdAt: time,
      completedAt: optional(time),
      error: optional(
        shape({
          code: str,
          message: str,
          cause: optional(str),
          remedy: optional(str),
        }),
      ),
    }),
  ),
  graphs: array(
    shape({
      id,
      source: ref,
      kind: one(
        "bar",
        "line",
        "scatter",
        "histogram",
        "box",
        "pie",
        "area",
        "heatmap",
      ),
      visual: optional(anyJson),
      axes: shape({ x: optional(id), y: optional(id), settings: anyJson }),
      grouping: shape({ attributeIds: ids, settings: anyJson }),
      bins: shape({ method: nullable(str), settings: anyJson }),
      aggregation: shape({
        method: nullable(str),
        attributeIds: ids,
        settings: anyJson,
      }),
    }),
  ),
  interpretations: array(
    shape({
      id,
      target: shape({ kind: one("analysis", "graph", "project"), id }),
      text: str,
      createdAt: time,
      updatedAt: time,
    }),
  ),
});

function unique(values: readonly string[], where: string) {
  if (new Set(values).size !== values.length) fail(where, "중복 ID입니다.");
}

/** Schema 1 had no undo journal. Its selected version wins, other datasets use their last version. */
export function validateWorkspace(input: unknown): WorkspaceState {
  json(input);
  const data = structuredClone(input) as WorkspaceState;
  obj(data, "작업 공간");
  obj(data.project, "프로젝트");
  const schema = Number(data.project.schemaVersion);
  if (schema === 1) {
    // Validate the old shape with the current checks after only these explicit additions.
    if (!Array.isArray(data.project.datasets))
      fail("자료", "배열이 필요합니다.");
    data.project.activeVersions = Object.fromEntries(
      data.project.datasets.map((d) => [
        d.id,
        data.project.selection?.datasetId === d.id
          ? data.project.selection.versionId
          : (d.versions?.at(-1)?.id ?? null),
      ]),
    );
    data.project.history = { entries: [], cursor: 0 };
    data.project.schemaVersion = 6;
  } else if (schema === 2 || schema === 3 || schema === 4) {
    data.project.schemaVersion = 6;
  } else if (schema === 5) {
    data.project.schemaVersion = 6;
  } else if (schema !== 6)
    fail(
      "데이터 구조 버전",
      "지원하지 않는 버전입니다. 이 파일을 만든 버전의 앱을 사용하세요.",
    );
  if (schema <= 5 && data.project.analysisConfigs)
    data.project.analysisConfigs = Object.fromEntries(
      Object.values(data.project.analysisConfigs).map((c) => [
        analysisConfigKey(c.source.datasetId, c.kind),
        c,
      ]),
    );
  if (schema <= 5) {
    const old = data.project.analyses?.find(
      (a) => a.id === data.view.currentAnalysisId,
    );
    if (old?.kind === "clustering") {
      data.view.clusterSelection = { current: old.id, comparison: null };
      data.view.currentAnalysisId = null;
      data.view.analysisFamily = "clustering";
    }
    if (
      data.project.analyses?.find(
        (a) => a.id === data.view.comparisonAnalysisId,
      )?.kind === "clustering"
    )
      data.view.comparisonAnalysisId = null;
  }
  projectCheck(data.project, "프로젝트");
  viewCheck(data.view, "화면 설정");
  const p = data.project;
  unique(
    p.datasets.map((d) => d.id),
    "자료",
  );
  unique(
    p.operations.map((o) => o.id),
    "작업",
  );
  unique(
    p.datasets.flatMap((d) => d.versions.map((v) => v.id)),
    "버전",
  );
  unique(
    p.analyses.map((a) => a.id),
    "분석",
  );
  unique(
    p.graphs.map((g) => g.id),
    "그래프",
  );
  unique(
    p.interpretations.map((i) => i.id),
    "해석",
  );
  unique(
    p.history.entries.map((h) => h.id),
    "기록",
  );
  const versions = new Map(
    p.datasets.flatMap((d) => d.versions.map((v) => [v.id, v] as const)),
  );
  const operations = new Map(p.operations.map((o) => [o.id, o]));
  let cells = 0;
  for (const d of p.datasets) {
    if (!d.versions.length) fail(d.name, "자료 버전이 없습니다.");
    if (d.source.kind === "derived" && !d.versions[0].operation.wrangling)
      fail(d.id, "파생 자료 최초 작업 기록이 없습니다.");
    const earlier = new Set<string>();
    for (const t of [d.original.table, ...d.versions]) {
      unique(
        t.columns.map((c) => c.id),
        "열",
      );
      unique(
        t.rows.map((r) => r.id),
        "행",
      );
      cells += t.rows.length * t.columns.length;
      if (
        t.columns.length > 200 ||
        t.rows.length > 50000 ||
        cells > RESTORE_CELLS
      )
        fail(
          d.name,
          "복원 한도(전체 보존 셀 300만 개)를 초과합니다. 프로젝트를 나누세요.",
        );
      const cols = new Set(t.columns.map((c) => c.id));
      for (const row of t.rows) {
        if (
          Object.keys(row.values).length !== cols.size ||
          Object.keys(row.values).some((c) => !cols.has(c))
        )
          fail(row.id, "열 참조 또는 셀 개수가 다릅니다.");
        for (const column of t.columns) {
          const value = row.values[column.id];
          if (
            value !== null &&
            column.storageType !== "mixed" &&
            typeof value !== column.storageType
          )
            fail(`${row.id}/${column.id}`, "셀 값과 저장 자료형이 다릅니다.");
        }
      }
    }
    const originalRows = new Set(d.original.table.rows.map((r) => r.id)),
      originalColumns = new Set(d.original.table.columns.map((c) => c.id));
    if (d.original.cellMetadata)
      for (const [r, cols] of Object.entries(d.original.cellMetadata)) {
        if (
          !originalRows.has(r) ||
          Object.keys(cols).some((c) => !originalColumns.has(c))
        )
          fail("원본 표시 형식", "행 또는 열 참조 오류입니다.");
      }
    for (const v of d.versions) {
      if (
        v.datasetId !== d.id ||
        v.parentVersionIds.some((id) => !earlier.has(id))
      )
        fail(v.id, "버전 계보가 잘못되었습니다.");
      unique(v.parentVersionIds, "이전 버전");
      const op = operations.get(v.operation.id);
      if (
        !op ||
        JSON.stringify(op) !== JSON.stringify(v.operation) ||
        !op.outputVersionIds.includes(v.id) ||
        (op.kind !== "wrangle" &&
          JSON.stringify(op.inputVersionIds) !==
            JSON.stringify(v.parentVersionIds))
      )
        fail(v.id, "작업 기록과 버전이 일치하지 않습니다.");
      validatePreprocessingRecord(d, v);
      earlier.add(v.id);
    }
    if (!(d.id in p.activeVersions)) fail(d.id, "현재 버전 지정이 없습니다.");
  }
  function reference(r: VersionRef | null) {
    if (r && versions.get(r.versionId)?.datasetId !== r.datasetId)
      fail("참조", "존재하지 않는 자료 또는 버전입니다.");
  }
  for (const [datasetId, versionId] of Object.entries(p.activeVersions)) {
    if (!p.datasets.some((d) => d.id === datasetId))
      fail(datasetId, "없는 자료입니다.");
    if (versionId !== null) reference({ datasetId, versionId });
  }
  reference(p.selection);
  if (
    p.selection &&
    p.activeVersions[p.selection.datasetId] !== p.selection.versionId
  )
    fail("선택", "현재 버전과 다릅니다.");
  for (const op of p.operations) {
    if (op.kind !== "wrangle" && op.wrangling)
      fail(op.id, "다른 작업에 가공 기록이 있습니다.");
    if (
      op.kind === "preprocess" &&
      (!op.preprocessing ||
        op.inputVersionIds.length !== 1 ||
        op.outputVersionIds.length !== 1 ||
        versions.get(op.outputVersionIds[0])?.operation.id !== op.id)
    )
      fail(op.id, "전처리 입력·출력 또는 계산 기준이 없습니다.");
    if (op.kind !== "preprocess" && op.preprocessing)
      fail(op.id, "다른 작업에 전처리 기록이 있습니다.");
    if (!p.datasets.some((d) => d.id === op.datasetId))
      fail(op.id, "작업 대상이 없습니다.");
    unique(op.inputVersionIds, "작업 입력");
    unique(op.outputVersionIds, "작업 출력");
    [
      ...(op.kind === "wrangle" ? [] : op.inputVersionIds),
      ...op.outputVersionIds,
    ].forEach((versionId) => reference({ datasetId: op.datasetId, versionId }));
  }
  for (const d of p.datasets)
    for (const v of d.versions) {
      traceProcessing(p, { datasetId: d.id, versionId: v.id });
      validateWranglingRecord(p, v);
    }
  for (const op of p.operations)
    if (
      op.kind === "wrangle" &&
      (!op.wrangling ||
        op.outputVersionIds.length !== 1 ||
        versions.get(op.outputVersionIds[0])?.operation.id !== op.id)
    )
      fail(op.id, "가공 출력 기록 오류입니다.");
  if (p.history.cursor > p.history.entries.length)
    fail("기록 위치", "범위를 벗어났습니다.");
  for (const h of p.history.entries) {
    if (!p.datasets.some((d) => d.id === h.datasetId))
      fail(h.id, "기록 대상이 없습니다.");
    [h.beforeVersionId, h.afterVersionId].forEach((v) => {
      if (v) reference({ datasetId: h.datasetId, versionId: v });
    });
    reference(h.beforeSelection);
    reference(h.afterSelection);
    if (
      h.operationIds.some((id) => operations.get(id)?.datasetId !== h.datasetId)
    )
      fail(h.id, "작업 참조 오류입니다.");
  }
  // Walk both directions from the saved cursor: reject a journal that could activate impossible refs.
  for (const direction of [-1, 1]) {
    const active = { ...p.activeVersions };
    for (
      let i = direction < 0 ? p.history.cursor - 1 : p.history.cursor;
      i >= 0 && i < p.history.entries.length;
      i += direction
    ) {
      const h = p.history.entries[i],
        undo = direction < 0;
      if (active[h.datasetId] !== (undo ? h.afterVersionId : h.beforeVersionId))
        fail(h.id, "되돌리기 순서가 현재 버전과 맞지 않습니다.");
      active[h.datasetId] = undo ? h.beforeVersionId : h.afterVersionId;
      const selection = undo ? h.beforeSelection : h.afterSelection;
      if (selection && active[selection.datasetId] !== selection.versionId)
        fail(h.id, "기록 선택과 현재 버전이 다릅니다.");
    }
  }
  function attrs(r: VersionRef, ids: readonly string[]) {
    reference(r);
    unique(ids, "속성 참조");
    if (
      ids.some(
        (id) => !versions.get(r.versionId)!.columns.some((c) => c.id === id),
      )
    )
      fail("속성 참조", "없는 열입니다.");
  }
  function analysis(c: AnalysisConfig) {
    validateRegressionConfig(c, p);
    validateClusteringConfig(c, p);
    validateAssociationConfig(c, p);
    attrs(c.source, c.attributeIds);
    c.preprocessing.steps.forEach((s) => attrs(c.source, s.attributeIds));
  }
  Object.entries(p.analysisConfigs).forEach(([key, c]) => {
    if (key !== analysisConfigKey(c.source.datasetId, c.kind))
      fail("분석 설정 키", "자료·분석 종류가 일치하지 않습니다.");
    analysis(c);
  });
  clusteringValidationBudget(p.analyses);
  associationValidationBudget(p.analyses);
  validateAssociationView(data.view, p.analyses);
  if (p.analyses.length > 50) fail("분석 기록", "50개 한도");
  if (
    data.view.analysisFamily &&
    !["regression", "clustering", "experiment", "association"].includes(
      data.view.analysisFamily,
    )
  )
    fail("분석 영역", "잘못된 종류");
  for (const id of Object.values(data.view.clusterSelection ?? {}))
    if (id && !p.analyses.some((a) => a.id === id && a.kind === "clustering"))
      fail("군집 선택", "없는 군집 기록");
  for (const [id, axes] of Object.entries(data.view.clusterAxes ?? {})) {
    const a = p.analyses.find((a) => a.id === id && a.kind === "clustering");
    if (!a) fail("군집 축", "없는 기록");
    const v = p.datasets
      .find((d) => d.id === a!.configSnapshot.source.datasetId)
      ?.versions.find((v) => v.id === a!.configSnapshot.source.versionId);
    for (const col of [axes.x, axes.y])
      if (
        col &&
        !v?.columns.some((c) => c.id === col && c.storageType === "number")
      )
        fail("군집 축", "없는 수치 속성");
  }
  if (p.analyses.filter((a) => a.configSnapshot.regression).length > 50)
    fail("회귀 기록", "50개 한도를 넘습니다.");
  for (const selected of [
    data.view.currentAnalysisId,
    data.view.comparisonAnalysisId,
  ])
    if (selected && !p.analyses.some((a) => a.id === selected))
      fail("회귀 선택", "없는 분석 참조");
  for (const a of p.analyses) {
    validateRegressionRecord(a, p);
    validateClusteringRecord(a, p);
    validateAssociationRecord(a, p);
    analysis(a.configSnapshot as AnalysisConfig);
    if (
      a.kind !== a.configSnapshot.kind ||
      a.interpretationIds.some(
        (id) =>
          !p.interpretations.some(
            (i) =>
              i.id === id &&
              i.target.kind === "analysis" &&
              i.target.id === a.id,
          ),
      )
    )
      fail(a.id, "분석 기록 참조 오류입니다.");
    if (a.status === "pending" || a.status === "running") {
      a.status = "cancelled";
      a.error = {
        code: "RESTORED_INTERRUPTED",
        message: "저장 당시 완료되지 않은 작업입니다.",
        remedy: "필요하면 다시 실행하세요.",
      };
    }
    a.configSnapshot = snapshot(a.configSnapshot);
    if (a.association)
      a.association = snapshot(a.association) as typeof a.association;
    if (a.clustering)
      a.clustering = snapshot(a.clustering) as typeof a.clustering;
    if (a.regression)
      a.regression = snapshot(a.regression) as typeof a.regression;
  }
  for (const selected of [
    data.view.currentGraphId,
    data.view.comparisonGraphId,
  ])
    if (selected && !p.graphs.some((g) => g.id === selected))
      fail("그래프 선택", "없는 그래프 참조");
  p.graphs.forEach((g) => {
    const table = p.datasets
      .find((d) => d.id === g.source.datasetId)
      ?.versions.find((v) => v.id === g.source.versionId);
    if (!table) fail("그래프", "없는 자료 버전");
    validateGraph(g, table!);
    if (g.visual && g.kind === "histogram") {
      const result = calculateGraph(table!, g);
      if (
        JSON.stringify(result.boundaries) !==
        JSON.stringify(g.visual.boundaries)
      )
        fail("그래프", "저장한 실제 구간 경계가 없습니다.");
    }
    attrs(g.source, [
      ...new Set(
        [
          g.axes.x,
          g.axes.y,
          ...g.grouping.attributeIds,
          ...g.aggregation.attributeIds,
        ].filter((x): x is string => !!x),
      ),
    ]);
  });
  for (const i of p.interpretations)
    if (
      !(i.target.kind === "project"
        ? i.target.id === p.id
        : i.target.kind === "analysis"
          ? p.analyses.some((a) => a.id === i.target.id)
          : p.graphs.some((g) => g.id === i.target.id))
    )
      fail(i.id, "해석 대상이 없습니다.");
  for (const [datasetId, attributeId] of Object.entries(
    data.view.selectedAttributeByDataset,
  )) {
    const d = p.datasets.find((d) => d.id === datasetId);
    if (
      !d ||
      (attributeId &&
        !d.versions.some((v) => v.columns.some((c) => c.id === attributeId)))
    )
      fail("선택 속성", "없는 자료 또는 열입니다.");
  }
  for (const [datasetId, t] of Object.entries(data.view.tables)) {
    const d = p.datasets.find((d) => d.id === datasetId);
    if (!d) fail("표 설정", "없는 자료입니다.");
    const allCols = new Set(
        d!.versions.flatMap((v) => v.columns.map((c) => c.id)),
      ),
      allRows = new Set(d!.versions.flatMap((v) => v.rows.map((r) => r.id)));
    if (
      [...t.selectedColumnIds, t.sort?.attributeId, t.filter?.attributeId].some(
        (c) => c && !allCols.has(c),
      ) ||
      t.selectedRowIds.some((r) => !allRows.has(r))
    )
      fail("표 설정", "없는 행 또는 열입니다.");
    unique(t.selectedRowIds, "행 선택");
    unique(t.selectedColumnIds, "열 선택");
  }
  p.datasets = p.datasets.map((d) => ({
    ...d,
    original: snapshot(d.original),
    versions: d.versions.map((v) => snapshot(v)),
  }));
  validateResultState(p,data.view);
  p.operations = p.operations.map((o) => snapshot(o));
  return data;
}


export function readBackup(text: string, asCopy = false): WorkspaceState {
  if (new Blob([text]).size > RESTORE_BYTES)
    throw new Error(
      "프로젝트 파일은 80 MiB 이하만 복원할 수 있습니다. 보존 버전과 JSON 복사에 필요한 메모리 한도입니다.",
    );
  const value: unknown = JSON.parse(text);
  shape({
    format: one(FORMAT),
    formatVersion: one(1),
    exportedAt: time,
    workspace: obj,
  })(value, "백업 파일");
  return asCopy
    ? restoreAsCopy((value as Backup).workspace)
    : validateWorkspace((value as Backup).workspace);
}
/** Always create a distinct project; dataset/version IDs are project-local and stay intact. */
export function restoreAsCopy(state: WorkspaceState): WorkspaceState {
  const next = validateWorkspace(state),
    old = next.project.id;
  next.project.id = crypto.randomUUID();
  next.project.name += " (복원 사본)";
  next.project.updatedAt = new Date().toISOString();
  next.project.interpretations = next.project.interpretations.map((i) =>
    i.target.kind === "project" && i.target.id === old
      ? { ...i, target: { kind: "project", id: next.project.id } }
      : i,
  );
  return next;
}
