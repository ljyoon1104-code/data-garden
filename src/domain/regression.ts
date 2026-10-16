import type { PreprocessingSettings } from "./preprocessing-types";
import type {
  AnalysisConfig,
  Attribute,
  Cell,
  DeepReadonly,
  Project,
  TableData,
  TableEdit,
  VersionRef,
} from "./types";
import type {
  RegressionConfig,
  RegressionSettings,
  RegressionPlan,
  RegressionStep,
  RegressionSplit,
  RegressionResult,
  FittedRegressionStep,
  MatrixRow,
  RegressionPrediction,
  RegressionPipeline,
} from "./regression-types";
import type { FittedWrangling } from "./wrangling-types";
import {
  attributeAncestors,
  processingInputs,
  resolveVersion,
  traceProcessing,
} from "./processing";
import { scopedRows } from "./graphs";
import { applyPreprocessing, fitPreprocessing } from "./preprocessing";
import { applyWrangling, fitWrangling } from "./wrangling";
import { applySchema, convertCell, isMissing } from "./table";
import {
  evaluationRow,
  fitModel,
  predictModel,
  REGRESSION_LIMITS,
  regressionMetrics,
  requireRegression as assert,
} from "./regression-models";

export function defaultRegression(): RegressionSettings {
  return {
    formatVersion: 1,
    target: "",
    features: [],
    scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
    models: ["linear", "tree", "knn"],
    trainRatio: 0.7,
    seed: 2026,
    missing: "remove",
    scaling: "none",
    k: 3,
    weights: "uniform",
    maxDepth: 4,
    minLeaf: 2,
    reuseSplit: null,
  };
}
export function regressionConfig(
  source: VersionRef,
  s: RegressionSettings,
): RegressionConfig {
  return {
    kind: "regression",
    source,
    attributeIds: [s.target, ...s.features].filter(Boolean),
    parameters: {},
    preprocessing: { steps: [] },
    calculation: {
      method: "regression-1",
      missingValuePolicy: s.missing,
      settings: {},
    },
    split: { method: "holdout", settings: { trainRatio: s.trainRatio } },
    randomness: { seed: s.seed, settings: {} },
    regression: structuredClone(s),
  };
}
export function validateRegressionSettings(
  value: unknown,
): asserts value is RegressionSettings {
  const s = value as RegressionSettings;
  assert(s && s.formatVersion === 1, "회귀 설정 버전이 올바르지 않습니다.");
  assert(
    typeof s.target === "string" &&
      Array.isArray(s.features) &&
      s.features.every((v) => typeof v === "string") &&
      new Set(s.features).size === s.features.length &&
      s.features.length <= REGRESSION_LIMITS.features,
    "회귀 입력은 중복 없이 40개 이하로 선택하세요.",
  );
  assert(
    Array.isArray(s.models) &&
      s.models.length <= 3 &&
      new Set(s.models).size === s.models.length &&
      s.models.every((v) => ["linear", "tree", "knn"].includes(v)),
    "회귀 모델 설정이 잘못되었습니다.",
  );
  assert(
    Number.isFinite(s.trainRatio) && s.trainRatio >= 0.1 && s.trainRatio <= 0.9,
    "학습 비율은 10~90%로 입력하세요.",
  );
  assert(
    Number.isInteger(s.seed) && s.seed >= 0 && s.seed <= 4294967295,
    "seed는 0~4,294,967,295 정수입니다.",
  );
  assert(
    ["remove", "mean", "median"].includes(s.missing) &&
      ["none", "minmax", "zscore"].includes(s.scaling) &&
      ["uniform", "distance"].includes(s.weights),
    "결측·정규화·가중 설정이 잘못되었습니다.",
  );
  assert(
    Number.isInteger(s.k) &&
      s.k >= 1 &&
      s.k <= 200 &&
      Number.isInteger(s.maxDepth) &&
      s.maxDepth >= 1 &&
      s.maxDepth <= 10 &&
      Number.isInteger(s.minLeaf) &&
      s.minLeaf >= 1 &&
      s.minLeaf <= 20000,
    "k 1~200, 깊이 1~10, 최소 리프 1~20,000 범위를 확인하세요.",
  );
  assert(
    s.scope &&
      ["all", "filtered", "selected"].includes(s.scope.kind) &&
      typeof s.scope.duplicatesOnly === "boolean" &&
      Array.isArray(s.scope.rowIds) &&
      s.scope.rowIds.every((id) => typeof id === "string") &&
      new Set(s.scope.rowIds).size === s.scope.rowIds.length,
    "분석 범위 설정이 잘못되었습니다.",
  );
  assert(
    s.scope.filter === null ||
      (typeof s.scope.filter === "object" && !Array.isArray(s.scope.filter)),
    "필터는 조건 객체 또는 null이어야 합니다.",
  );
  assert(
    s.reuseSplit === null ||
      (typeof s.reuseSplit === "object" && !Array.isArray(s.reuseSplit)),
    "분할 재사용 설정이 잘못되었습니다.",
  );
  if (s.scope.filter)
    assert(
      typeof s.scope.filter.attributeId === "string" &&
        typeof s.scope.filter.value === "string" &&
        ["contains", "equals", "gt", "lt", "missing", "present"].includes(
          s.scope.filter.operator,
        ),
      "필터 설정이 잘못되었습니다.",
    );
  if (s.reuseSplit) {
    const a = s.reuseSplit;
    assert(
      Array.isArray(a.train) &&
        Array.isArray(a.evaluation) &&
        [...a.train, ...a.evaluation].every((id) => typeof id === "string") &&
        new Set([...a.train, ...a.evaluation]).size ===
          a.train.length + a.evaluation.length,
      "재사용할 분할에 중복·겹침이 있습니다.",
    );
  }
}
/** Uses the concrete dependency path, not merely shared root ancestors. */
function dependsOnTarget(
  project: Project,
  ref: VersionRef,
  id: string,
  target: string,
): boolean {
  if (ref.datasetId + ":" + id === target) return true;
  const v = resolveVersion(project, ref),
    wr = v.operation.wrangling;
  const refs = wr?.fitted.columnSources[id];
  if (refs)
    return refs.some((a) =>
      dependsOnTarget(project, wr!.inputs[a.input], a.attributeId, target),
    );
  return processingInputs(v).some(
    (r) =>
      resolveVersion(project, r).columns.some((c) => c.id === id) &&
      dependsOnTarget(project, r, id, target),
  );
}
function observationOrigin(
  project: Project,
  ref: VersionRef,
  attributeId: string,
  rowId: string,
): string[] {
  const v = resolveVersion(project, ref),
    wr = v.operation.wrangling;
  if (wr) {
    assert(
      wr.fitted.settings.kind !== "aggregate",
      "집계된 관측의 정답 단위를 복원할 수 없습니다. 집계 전 개별 관측 자료로 분석하세요.",
    );
    const allRefs = wr.fitted.columnSources[attributeId];
    const refs =
      wr.fitted.settings.kind === "join" ? allRefs?.slice(0, 1) : allRefs;
    if (refs) {
      return [
        ...new Set(
          refs.flatMap((a) =>
            (
              wr.rowSources[rowId]?.find((s) => s.input === a.input)?.rowIds ??
              []
            ).flatMap((id) =>
              observationOrigin(project, wr.inputs[a.input], a.attributeId, id),
            ),
          ),
        ),
      ];
    }
  }
  const parents = processingInputs(v).filter((r) =>
    resolveVersion(project, r).columns.some((c) => c.id === attributeId),
  );
  if (parents.length)
    return [
      ...new Set(
        parents.flatMap((r) =>
          observationOrigin(project, r, attributeId, rowId),
        ),
      ),
    ];
  return [v.datasetId + ":" + rowId];
}
/** Only ancestors of the chosen version and needed columns enter the worker plan. */
export function buildRegressionPlan(
  project: Project,
  config: AnalysisConfig,
): RegressionPlan {
  const s = config.regression;
  validateRegressionSettings(s);
  assert(config.kind === "regression", "회귀 설정이 아닙니다.");
  const source = resolveVersion(project, config.source),
    trace = traceProcessing(project, config.source);
  assert(
    s.target && s.features.length && s.models.length,
    "예측 대상, 입력 속성, 모델을 선택하세요.",
  );
  const get = (id: string) => {
    const c = source.columns.find((c) => c.id === id);
    assert(c, `없는 속성: ${id}`);
    assert(
      c.useInAnalysis,
      `${c.name}: 분석 제외 상태입니다. 데이터 메뉴의 속성 편집에서 분석 사용을 켜세요.`,
    );
    assert(
      c.storageType === "number" && c.semanticType === "numeric",
      `${c.name}: 숫자 저장형·수치 의미만 허용합니다. 범주에는 정리 메뉴의 원핫 인코딩을 사용하세요.`,
    );
    return { ...c };
  };
  const target = get(s.target),
    features = s.features.map(get);
  const targetRoots = attributeAncestors(project, config.source, s.target);
  const directTargetIds = new Set([config.source.datasetId + ":" + s.target]);
  if (
    trace.steps.some(
      (v) => v.operation.wrangling?.fitted.settings.kind === "join",
    )
  ) {
    const targetPath = (ref: VersionRef, id: string): void => {
      const v = resolveVersion(project, ref),
        w = v.operation.wrangling;
      const refs = w?.fitted.columnSources[id];
      if (refs) {
        (w!.fitted.settings.kind === "join" ? refs.slice(0, 1) : refs).forEach(
          (a) => targetPath(w!.inputs[a.input], a.attributeId),
        );
      } else {
        directTargetIds.add(ref.datasetId + ":" + id);
      }
    };
    targetPath(config.source, s.target);
  }
  assert(targetRoots.length > 0, "예측 대상의 출처가 없습니다.");
  for (const id of s.features) {
    attributeAncestors(project, config.source, id);
    assert(
      ![...directTargetIds].some((t) =>
        dependsOnTarget(project, config.source, id, t),
      ),
      "입력이 예측 대상 자체 또는 대상값으로 계산한 속성입니다. 예측 시 알 수 없는 정답 의존 특성을 제외하세요.",
    );
  }
  const scopeRows = scopedRows(source, s.scope),
    scopeRowIds = scopeRows.map((r) => r.id).sort();
  assert(
    scopeRowIds.length > 0,
    "분석 범위가 비었습니다. 빈 선택은 전체 행으로 대체하지 않습니다. 행을 선택하거나 범위를 바꾸세요.",
  );
  assert(
    scopeRowIds.length <= REGRESSION_LIMITS.rows,
    "회귀는 한 실행에 20,000행까지 지원합니다. 필터·선택 범위를 줄이세요. 자료를 자동 절단하지 않습니다.",
  );
  const observationUnits: Record<string, string> = {};
  for (const r of scopeRows) {
    const origins = observationOrigin(project, config.source, s.target, r.id);
    assert(
      origins.length === 1,
      "대상의 관측 출처가 여러 개이거나 없습니다. 단일 관측의 정답을 가진 결합 전 자료를 사용하세요.",
    );
    observationUnits[r.id] = origins[0];
  }
  const multi = trace.steps.some(
    (v) =>
      v.operation.wrangling &&
      ["join", "stack", "aggregate"].includes(
        v.operation.wrangling.fitted.settings.kind,
      ),
  );
  if (multi) {
    assert(
      !trace.steps.some(
        (v) =>
          v.operation.preprocessing ||
          (v.operation.wrangling &&
            ["aggregate", "encode", "bin"].includes(
              v.operation.wrangling.fitted.settings.kind,
            )),
      ),
      "다중 자료 경로에 전체 자료의 통계·집계·인코딩·구간 기준이 있습니다. 그룹 평균 재결합 등의 누수를 안전하게 재계산하지 못하므로 평가를 차단합니다. 통계 가공 전 단일 관측 자료를 사용하세요.",
    );
    const columns = [target, ...features],
      root = {
        columns,
        rows: scopeRows
          .map((r) => ({
            id: r.id,
            values: Object.fromEntries(
              columns.map((c) => [c.id, r.values[c.id]]),
            ),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    return {
      source: { ...config.source },
      references: trace.steps.map((v) => ({
        datasetId: v.datasetId,
        versionId: v.id,
      })),
      root,
      rootSource: { ...config.source },
      steps: [],
      target,
      features,
      scopeRowIds,
      observationUnits,
      rawInputs: features,
      predictionBlock:
        "결합·누적 자료의 새 관측에는 입력별 키·행 대응이 필요합니다. 이 경로의 새 입력 예측은 지원하지 않습니다. 결합 전 단일 자료에서 분석하세요.",
    };
  }
  assert(
    trace.roots.length === 1,
    "하나의 원자료에서 시작하는 가공 경로를 선택하세요.",
  );
  const needed = new Set([s.target, ...s.features]),
    steps: RegressionStep[] = [];
  // Import's confirmed cell-format/schema conversion is row-local, not fitted
  // statistics. Start from that preserved version (not raw XLSX display guesses).
  const imported = trace.steps[1];
  const importBase =
    imported?.operation.kind === "transform" &&
    trace.steps[0].operation.kind === "import" &&
    imported.parentVersionIds.length === 1 &&
    imported.parentVersionIds[0] === trace.steps[0].id &&
    project.datasets.find((d) => d.id === imported.datasetId)?.source.kind ===
      "file";
  const rootV = importBase ? imported : resolveVersion(project, trace.roots[0]);
  // Walk backwards to retain necessary operations and dependencies, then replay in original order.
  for (const v of trace.steps.slice(importBase ? 2 : 1).reverse()) {
    const op = v.operation,
      wr = op.wrangling,
      pre = op.preprocessing;
    if (wr) {
      const selected = wr.fitted.columns.filter((c) => needed.has(c.id));
      if (!selected.length) continue;
      assert(
        !(
          wr.fitted.settings.kind === "encode" &&
          wr.fitted.settings.method === "code"
        ),
        "범주 코드로 만든 속성을 연속형 입력으로 사용할 수 없습니다. 숫자 의미로 바꾸어도 코드 간 거리가 정의되지 않습니다. 원핫 인코딩을 사용하세요.",
      );
      assert(
        !selected.some((c) => c.id === s.target) &&
          !wr.fitted.referencedAttributes.some(
            (a) => a.attributeId === s.target,
          ),
        "파생 정답 또는 정답을 사용하는 가공 경로입니다. 원래 관측한 정답 열을 선택하세요.",
      );
      // All outputs of one operation are needed by its fixed apply schema.
      wr.fitted.columns.forEach((c) => needed.delete(c.id));
      wr.fitted.referencedAttributes.forEach((a) => needed.add(a.attributeId));
      steps.unshift({
        kind: "wrangle",
        operationId: op.id,
        source: wr.inputs[0],
        fitted: structuredClone(wr.fitted) as FittedWrangling,
      });
    } else if (pre) {
      const settings = structuredClone(
        pre.fitted.settings,
      ) as PreprocessingSettings;
      const rowPolicy =
        settings.kind === "duplicates" ||
        (settings.kind === "missing" && settings.method === "remove") ||
        (settings.kind === "outliers" && settings.action === "remove");
      if (rowPolicy) settings.attributeIds.forEach((id) => needed.add(id));
      else
        settings.attributeIds = settings.attributeIds.filter((id) =>
          needed.has(id),
        );
      if (!settings.attributeIds.length) continue;
      if (settings.attributeIds.includes(s.target)) {
        assert(
          settings.kind === "missing",
          "정답에 정규화·이상값·중복 처리가 적용되었습니다. 원래 단위의 정답을 안전하게 복원할 수 없으므로 처리 전 버전으로 분석하세요.",
        );
        // Never impute a ground truth. Its original missingness is recovered below.
        if (settings.method !== "remove")
          settings.attributeIds = settings.attributeIds.filter(
            (id) => id !== s.target,
          );
      }
      if (settings.attributeIds.length)
        steps.unshift({
          kind: "preprocess",
          operationId: op.id,
          source: pre.input,
          settings,
        });
    } else if (op.kind === "edit-cell" || op.kind === "edit-attribute") {
      const edit = structuredClone(op.settings) as unknown as TableEdit,
        id = edit.kind === "cell" ? edit.attributeId : edit.attribute.id;
      if (needed.has(id))
        steps.unshift({
          kind: "edit",
          operationId: op.id,
          source: { datasetId: v.datasetId, versionId: v.parentVersionIds[0] },
          edit,
        });
    } else
      assert(
        ["sample", "import"].includes(op.kind),
        "재생할 수 없는 과거 가공 작업입니다. 원자료에서 지원하는 가공으로 다시 준비하세요.",
      );
  }
  const ids = new Set(scopeRowIds),
    columns = rootV.columns
      .filter((c) => needed.has(c.id))
      .map((c) => ({ ...c }));
  assert(
    columns.length * scopeRowIds.length <= REGRESSION_LIMITS.replayCells,
    "가공 재생 입력이 1,000,000셀을 넘습니다. 범위·입력 속성을 줄이세요.",
  );
  const root = {
    columns,
    rows: rootV.rows
      .filter((r) => ids.has(r.id))
      .map((r) => ({
        id: r.id,
        values: Object.fromEntries(columns.map((c) => [c.id, r.values[c.id]])),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  assert(
    root.rows.length === scopeRowIds.length,
    "원자료의 관측 행과 현재 자료가 대응하지 않습니다. 단일 관측 자료를 사용하세요.",
  );
  const rawInputs = columns.filter((c) => c.id !== s.target);
  let workingColumns = columns.length;
  for (const step of steps)
    if (step.kind === "wrangle") {
      assert(
        step.fitted.columns.length <= REGRESSION_LIMITS.features,
        "원핫·가공 출력은 한 작업당 40열까지 분석 재생합니다. 범주 수를 줄이세요.",
      );
      workingColumns += step.fitted.columns.length;
      assert(
        workingColumns * scopeRowIds.length <= REGRESSION_LIMITS.replayCells,
        "분석 재생 중간 표가 1,000,000셀을 넘습니다. 행·가공 출력을 줄이세요.",
      );
    }
  return {
    source: { ...config.source },
    references: trace.steps.map((v) => ({
      datasetId: v.datasetId,
      versionId: v.id,
    })),
    root,
    rootSource: { datasetId: rootV.datasetId, versionId: rootV.id },
    steps,
    target,
    features,
    scopeRowIds,
    observationUnits,
    rawInputs,
    predictionBlock: null,
  };
}
export function splitObservations(
  ids: string[],
  units: Record<string, string>,
  s: RegressionSettings,
): RegressionSplit {
  const sorted = [...new Set(ids.map((id) => units[id]))].sort();
  let train: string[], evaluation: string[];
  if (s.reuseSplit) {
    const present = new Set(ids),
      old = new Set([...s.reuseSplit.train, ...s.reuseSplit.evaluation]);
    assert(
      ids.every((id) => old.has(id)),
      "기존 분할에 없는 관측입니다. 분할 재사용을 해제하세요.",
    );
    train = s.reuseSplit.train.filter((id) => present.has(id)).sort();
    evaluation = s.reuseSplit.evaluation.filter((id) => present.has(id)).sort();
  } else {
    let seed = s.seed >>> 0;
    for (let i = sorted.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = Math.floor((seed / 4294967296) * (i + 1));
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    }
    const count = Math.floor(sorted.length * s.trainRatio),
      training = new Set(sorted.slice(0, count));
    train = ids.filter((id) => training.has(units[id])).sort();
    evaluation = ids.filter((id) => !training.has(units[id])).sort();
  }
  assert(
    train.length >= 2 && evaluation.length >= 1,
    "분할 후 학습 2행·평가 1행 이상이 필요합니다. 관측 수나 분할 비율을 변경하세요.",
  );
  const trainUnits = new Set(train.map((id) => units[id]));
  assert(
    !evaluation.some((id) => trainUnits.has(units[id])),
    "같은 관측 복제본이 학습과 평가에 겹칩니다. 분할 재사용을 해제하세요.",
  );
  return {
    method: "seeded-observation-holdout-v1",
    train,
    evaluation,
    units: Object.fromEntries(ids.map((id) => [id, units[id]])),
    rounding: "floor-unit-count-times-train-ratio",
  };
}
function editTable(
  table: DeepReadonly<TableData>,
  edit: TableEdit,
  predict = false,
): TableData {
  if (edit.kind === "attribute")
    return applySchema(
      table,
      table.columns.map((c) =>
        c.id === edit.attribute.id ? edit.attribute : { ...c },
      ),
    );
  const col = table.columns.find((c) => c.id === edit.attributeId);
  assert(col, "편집 속성 참조가 없습니다.");
  return {
    columns: table.columns.map((c) => ({ ...c })),
    rows: table.rows.map((r) => ({
      id: r.id,
      values: {
        ...r.values,
        ...(!predict && r.id === edit.rowId
          ? {
              [edit.attributeId]: edit.missing
                ? null
                : convertCell(edit.value, col),
            }
          : {}),
      },
    })),
  };
}
export function applyRegressionStep(
  table: DeepReadonly<TableData>,
  step: FittedRegressionStep,
  predict = false,
): TableData {
  if (step.kind === "edit") return editTable(table, step.edit, predict);
  if (step.kind === "preprocess")
    return applyPreprocessing(table, step.fitted).table;
  const p = applyWrangling(
    [{ source: step.fitted.inputs[0], name: "회귀 입력", table }],
    step.fitted,
  );
  assert(
    !p.issues.some((i) => i.blocking),
    p.issues.find((i) => i.blocking)?.message +
      " 고정된 가공 정책을 수정하고 다시 분석하세요.",
  );
  return p.table;
}
export function fitRegressionStep(
  table: TableData,
  step: RegressionStep,
  train: string[],
): FittedRegressionStep {
  if (step.kind === "edit")
    return { kind: "edit", operationId: step.operationId, edit: step.edit };
  if (step.kind === "preprocess")
    return {
      kind: "preprocess",
      operationId: step.operationId,
      fitted: structuredClone(
        fitPreprocessing(table, step.source, step.settings, {
          kind: "training",
          rowIds: train,
        }),
      ),
    };
  const old = step.fitted,
    settings = structuredClone(old.settings);
  if (settings.kind === "encode" && settings.order) {
    const ids = new Set(train),
      values = new Set(
        table.rows
          .filter((r) => ids.has(r.id))
          .map((r) => JSON.stringify(r.values[settings.attributeId])),
      );
    settings.order = settings.order.filter((v) =>
      values.has(JSON.stringify(v)),
    );
  }
  const fitted = structuredClone(
    fitWrangling(
      [{ source: step.source, name: "회귀 입력", table }],
      settings,
      ["encode", "bin"].includes(settings.kind)
        ? { kind: "training", rowIds: train }
        : undefined,
    ),
  ) as FittedWrangling;
  if (fitted.basis?.kind === "encode" && old.basis?.kind === "encode") {
    const oldBasis = old.basis;
    fitted.basis.categories.forEach((c) => {
      c.columnId =
        oldBasis.categories.find(
          (o) => JSON.stringify(o.value) === JSON.stringify(c.value),
        )?.columnId ?? null;
    });
  }
  // Fixed output IDs link saved feature selections to a train-only dictionary/boundary.
  fitted.columns = structuredClone(old.columns);
  fitted.columnSources = structuredClone(old.columnSources);
  return { kind: "wrangle", operationId: step.operationId, fitted };
}
function subset(
  table: DeepReadonly<TableData>,
  ids: readonly string[],
): TableData {
  const set = new Set(ids);
  return {
    columns: table.columns.map((c) => ({ ...c })),
    rows: table.rows
      .filter((r) => set.has(r.id))
      .map((r) => ({ id: r.id, values: { ...r.values } }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function matrix(
  table: TableData,
  features: Attribute[],
  target: string,
): MatrixRow[] {
  return table.rows.map((r) => ({
    id: r.id,
    x: features.map((c) => {
      const v = r.values[c.id];
      assert(
        typeof v === "number" && Number.isFinite(v),
        `${c.name}: 수치가 아닌 입력입니다.`,
      );
      return v;
    }),
    y: r.values[target] as number,
  }));
}
export function runRegression(
  plan: RegressionPlan,
  s: RegressionSettings,
  progress: (message: string) => void = () => {},
): RegressionResult {
  validateRegressionSettings(s);
  const startedAt = new Date().toISOString();
  progress("정답 관측과 공통 학습·평가 분할을 확인하는 중…");
  // Apply only explicit target edits to recover observed truth; target imputations are never used.
  let truth: TableData = subset(plan.root, plan.scopeRowIds);
  for (const step of plan.steps)
    if (
      step.kind === "edit" &&
      (step.edit.kind === "cell"
        ? step.edit.attributeId
        : step.edit.attribute.id) === s.target
    )
      truth = editTable(truth, step.edit);
  const excluded: RegressionResult["excluded"] = [],
    valid = truth.rows.filter((r) => {
      const y = r.values[s.target];
      if (typeof y === "number" && Number.isFinite(y)) return true;
      excluded.push({
        rowId: r.id,
        phase: "target",
        reason: "원래 관측 정답이 결측 또는 유효한 수치가 아님",
      });
      return false;
    });
  const split = splitObservations(
    valid.map((r) => r.id),
    plan.observationUnits,
    s,
  );
  let train = subset(plan.root, split.train),
    evaluation = subset(plan.root, split.evaluation);
  const pipeline: RegressionPipeline = {
    steps: [],
    ranges: [],
    rawInputs: structuredClone(plan.rawInputs),
  };
  function add(step: FittedRegressionStep) {
    pipeline.steps.push(step);
    train = applyRegressionStep(train, step);
    evaluation = applyRegressionStep(evaluation, step);
    assert(
      train.rows.length >= 2,
      "가공 후 학습 행이 부족합니다. 제거 정책을 수정하세요.",
    );
  }
  progress("학습 행에서만 전처리·인코딩·구간 기준을 재계산하는 중…");
  for (const step of plan.steps) {
    const table = {
      columns: train.columns,
      rows: [...train.rows, ...evaluation.rows],
    };
    add(
      fitRegressionStep(
        table,
        step,
        train.rows.map((r) => r.id),
      ),
    );
  }
  // Restore target truth even if a preceding operation would otherwise alter it.
  const truthById = new Map(valid.map((r) => [r.id, r.values[s.target]]));
  for (const t of [train, evaluation])
    for (const r of t.rows) r.values[s.target] = truthById.get(r.id)!;
  const ids = plan.features.map((c) => c.id);
  const missing = {
    kind: "missing" as const,
    attributeIds: ids,
    method: s.missing,
    rowRule: "any" as const,
    fixedValues: {},
  };
  add({
    kind: "preprocess",
    operationId: "regression-missing",
    fitted: structuredClone(
      fitPreprocessing(train, plan.source, missing, {
        kind: "training",
        rowIds: train.rows.map((r) => r.id),
      }),
    ),
  });
  pipeline.ranges = plan.features.map((c) => {
    const values = train.rows.map((r) => r.values[c.id]);
    assert(
      values.every((v) => typeof v === "number" && Number.isFinite(v)),
      `${c.name}: 학습 입력의 유형을 확인하세요.`,
    );
    return {
      attributeId: c.id,
      min: Math.min(...(values as number[])),
      max: Math.max(...(values as number[])),
    };
  });
  if (s.scaling !== "none")
    add({
      kind: "preprocess",
      operationId: "regression-scale",
      fitted: structuredClone(
        fitPreprocessing(
          train,
          plan.source,
          { kind: "scale", attributeIds: ids, method: s.scaling },
          { kind: "training", rowIds: train.rows.map((r) => r.id) },
        ),
      ),
    });
  const tr = matrix(train, plan.features, s.target),
    ev = matrix(evaluation, plan.features, s.target);
  assert(
    ev.length > 0,
    "전처리 후 평가 행이 없습니다. 결측·미등록 범주 정책을 변경하세요.",
  );
  const trIds = new Set(tr.map((r) => r.id)),
    evIds = new Set(ev.map((r) => r.id));
  for (const id of split.train)
    if (!trIds.has(id))
      excluded.push({
        rowId: id,
        phase: "training",
        reason: "공통 가공·결측 제거 정책",
      });
  for (const id of split.evaluation)
    if (!evIds.has(id))
      excluded.push({
        rowId: id,
        phase: "evaluation",
        reason: "공통 가공·결측 제거 정책",
      });
  assert(
    ev.length * s.models.length <= REGRESSION_LIMITS.resultRows,
    "개별 평가 결과 한도 30,000행을 넘습니다. 평가 비율·모델 수·범위를 줄이세요.",
  );
  assert(
    !s.models.includes("knn") ||
      tr.length * ev.length * ids.length <= REGRESSION_LIMITS.distances,
    "최근접 이웃의 거리 계산 한도 40,000,000 특성 비교를 넘습니다. 행·입력 수를 줄이거나 이 모델을 해제하세요.",
  );
  const models: RegressionResult["models"] = [];
  for (const kind of s.models) {
    progress(
      `${kind === "linear" ? "선형회귀 QR" : kind === "tree" ? "트리 분할" : "최근접 이웃 거리"} 학습·전체 평가 행을 계산하는 중…`,
    );
    const t = performance.now();
    try {
      const model = fitModel(kind, tr, s),
        rows = ev.map((r) =>
          evaluationRow(r.id, r.y, predictModel(model, r.x, tr).predicted),
        );
      models.push({
        kind,
        status: "completed",
        model,
        rows,
        metrics: regressionMetrics(rows),
        durationMs: performance.now() - t,
      });
    } catch (e) {
      models.push({
        kind,
        status: "failed",
        reason: e instanceof Error ? e.message : String(e),
        durationMs: performance.now() - t,
      });
    }
  }
  const result: RegressionResult = {
    formatVersion: 1,
    calculationVersion: "regression-1",
    source: plan.source,
    references: plan.references,
    target: plan.target,
    features: plan.features,
    scopeRowIds: plan.scopeRowIds,
    split,
    trainRowIds: tr.map((r) => r.id),
    evaluationRowIds: ev.map((r) => r.id),
    excluded,
    pipeline,
    models,
    unit: plan.target.name + " · 원래 관측값 단위",
    predictionBlock: plan.predictionBlock,
    sampling: { method: "reservoir", seed: s.seed, limit: 1000 },
    startedAt,
    completedAt: new Date().toISOString(),
  };
  assert(
    JSON.stringify(result).length <= 12 * 1024 * 1024,
    "회귀 결과의 12 MiB 한도를 넘었습니다. 행·입력·모델 수를 줄이세요.",
  );
  return result;
}
export function reconstructMatrix(
  plan: RegressionPlan,
  result: RegressionResult,
  ids: string[],
): MatrixRow[] {
  let table = subset(plan.root, ids);
  for (const step of result.pipeline.steps)
    table = applyRegressionStep(table, step);
  return matrix(table, result.features, result.target.id);
}
export function predictRegression(
  plan: RegressionPlan,
  result: RegressionResult,
  values: Record<string, Cell>,
  rowId?: string,
): RegressionPrediction {
  assert(!result.predictionBlock || rowId, result.predictionBlock ?? "");
  let table: TableData;
  if (rowId) table = subset(plan.root, [rowId]);
  else {
    const parsed: Record<string, Cell> = {};
    for (const c of result.pipeline.rawInputs) {
      const v = values[c.id] ?? null;
      parsed[c.id] = isMissing(v) ? null : convertCell(v, c);
    }
    parsed[result.target.id] = null;
    table = {
      columns: plan.root.columns.map((c) => ({ ...c })),
      rows: [{ id: "new-observation", values: parsed }],
    };
  }
  const warnings: string[] = [];
  for (const step of result.pipeline.steps) {
    if (step.operationId === "regression-scale") checkRange();
    table = applyRegressionStep(table, step, !rowId);
  }
  function checkRange() {
    for (const b of result.pipeline.ranges) {
      const v = table.rows[0]?.values[b.attributeId];
      if (typeof v === "number" && (v < b.min || v > b.max))
        warnings.push(
          `${result.features.find((c) => c.id === b.attributeId)?.name}: 학습 범위 [${b.min}, ${b.max}] 밖입니다. 외삽 예측입니다.`,
        );
    }
  }
  if (!result.pipeline.steps.some((s) => s.operationId === "regression-scale"))
    checkRange();
  assert(
    table.rows.length === 1,
    "새 입력이 제거 정책에 해당합니다. 결측·범위 값을 확인하세요.",
  );
  const x = result.features.map((c) => {
    const v = table.rows[0].values[c.id];
    assert(
      typeof v === "number" && Number.isFinite(v),
      `${c.name}: 고정 파이프라인 적용 후 유효한 수치가 없습니다.`,
    );
    return v;
  });
  const train = reconstructMatrix(plan, result, result.trainRowIds);
  const models = result.models.flatMap((m) =>
    m.status === "completed" ? [predictModel(m.model, x, train)] : [],
  );
  return { values, transformed: x, warnings, models };
}
export function comparableRegression(
  a: RegressionResult,
  b: RegressionResult,
): boolean {
  const key = (r: RegressionResult) => {
    const model = r.models.find((m) => m.status === "completed");
    return JSON.stringify({
      target: r.target.id,
      unit: r.unit,
      rows:
        model?.status === "completed"
          ? model.rows
              .map((x) => [x.rowId, x.actual, r.split.units[x.rowId]])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
          : [],
    });
  };
  return (
    a.models.some((m) => m.status === "completed") &&
    b.models.some((m) => m.status === "completed") &&
    key(a) === key(b)
  );
}
