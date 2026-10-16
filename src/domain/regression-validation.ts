import type {
  AnalysisConfig,
  AnalysisRecord,
  Project,
  TableData,
} from "./types";
import type {
  RegressionResult,
  FittedRegressionStep,
} from "./regression-types";
import {
  applyRegressionStep,
  buildRegressionPlan,
  fitRegressionStep,
  reconstructMatrix,
  splitObservations,
  validateRegressionSettings,
} from "./regression";
import {
  evaluationRow,
  predictModel,
  REGRESSION_LIMITS,
  regressionMetrics,
  requireRegression as assert,
} from "./regression-models";
import { fitPreprocessing } from "./preprocessing";

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function close(a: number, b: number) {
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  );
}
function numbers(value: unknown, depth = 0): void {
  assert(depth < 40, "회귀 모델 구조가 너무 깊습니다.");
  if (typeof value === "number")
    assert(Number.isFinite(value), "회귀 모델에 유한하지 않은 수가 있습니다.");
  if (value && typeof value === "object")
    Object.values(value).forEach((v) => numbers(v, depth + 1));
}
export function validateRegressionConfig(c: AnalysisConfig, project: Project) {
  if (!c.regression) return;
  assert(c.kind === "regression", "회귀 설정의 분석 종류가 다릅니다.");
  validateRegressionSettings(c.regression);
  const s = c.regression,
    v = project.datasets
      .find((d) => d.id === c.source.datasetId)
      ?.versions.find((v) => v.id === c.source.versionId);
  assert(v, "회귀 자료 버전 참조가 없습니다.");
  assert(
    equal(c.attributeIds, [s.target, ...s.features].filter(Boolean)),
    "회귀 속성 설정 참조가 다릅니다.",
  );
  assert(
    c.calculation.method === "regression-1" &&
      c.calculation.missingValuePolicy === s.missing &&
      c.split.method === "holdout" &&
      c.randomness.seed === s.seed &&
      equal(c.split.settings, { trainRatio: s.trainRatio }) &&
      c.preprocessing.steps.length === 0,
    "회귀 공통 설정이 일치하지 않습니다.",
  );
  const availableRows = new Set(v.rows.map((r) => r.id));
  assert(
    [
      ...s.scope.rowIds,
      ...(s.reuseSplit
        ? [...s.reuseSplit.train, ...s.reuseSplit.evaluation]
        : []),
    ].every((id) => availableRows.has(id)),
    "회귀 범위·분할에 없는 행 참조가 있습니다.",
  );
  if (s.scope.filter)
    assert(
      v.columns.some((c) => c.id === s.scope.filter!.attributeId),
      "회귀 필터 속성이 없습니다.",
    );
}
/** Validates saved inference state without re-training a model. All work runs in restore's Worker. */
export function validateRegressionRecord(
  record: AnalysisRecord,
  project: Project,
) {
  const c = record.configSnapshot as AnalysisConfig;
  validateRegressionConfig(c, project);
  if (!c.regression) {
    assert(!record.regression, "설정 없는 회귀 결과입니다.");
    return;
  }
  const s = c.regression,
    r = record.regression;
  if (record.status !== "completed") {
    assert(!r, "완료되지 않은 분석에 부분 회귀 결과가 있습니다.");
    return;
  }
  assert(
    r && r.formatVersion === 1 && r.calculationVersion === "regression-1",
    "지원하지 않거나 누락된 회귀 결과 버전입니다.",
  );
  numbers(r);
  assert(
    JSON.stringify(r).length <= 12 * 1024 * 1024,
    "회귀 결과가 실행당 12 MiB 한도를 넘습니다.",
  );
  const plan = buildRegressionPlan(project, c);
  assert(
    equal(r.source, plan.source) &&
      equal(r.references, plan.references) &&
      equal(r.target, plan.target) &&
      equal(r.features, plan.features) &&
      equal(r.scopeRowIds, plan.scopeRowIds),
    "회귀 자료·속성·범위·가공 참조가 일치하지 않습니다.",
  );
  assert(
    r.unit === plan.target.name + " · 원래 관측값 단위" &&
      r.predictionBlock === plan.predictionBlock,
    "회귀 평가 단위·지원 경로 정보가 다릅니다.",
  );
  assert(
    r.sampling?.method === "reservoir" &&
      r.sampling.limit === 1000 &&
      r.sampling.seed === s.seed &&
      Number.isFinite(Date.parse(r.startedAt)) &&
      Number.isFinite(Date.parse(r.completedAt)),
    "회귀 표본·시각 정보가 잘못되었습니다.",
  );
  assert(
    Array.isArray(r.split?.train) &&
      Array.isArray(r.split?.evaluation) &&
      new Set([...r.split.train, ...r.split.evaluation]).size ===
        r.split.train.length + r.split.evaluation.length,
    "회귀 학습·평가 행이 중복되거나 겹칩니다.",
  );
  let truth: TableData = structuredClone(plan.root) as TableData;
  for (const step of plan.steps)
    if (
      step.kind === "edit" &&
      (step.edit.kind === "cell"
        ? step.edit.attributeId
        : step.edit.attribute.id) === s.target
    )
      truth = applyRegressionStep(truth, {
        kind: "edit",
        operationId: step.operationId,
        edit: step.edit,
      });
  const valid = truth.rows.filter(
    (row) =>
      typeof row.values[s.target] === "number" &&
      Number.isFinite(row.values[s.target]),
  );
  const expected = splitObservations(
    valid.map((row) => row.id),
    plan.observationUnits,
    s,
  );
  assert(
    equal(expected, r.split),
    "관측 단위·seed·학습/평가 분할이 저장 조건과 다릅니다.",
  );
  let train: TableData = {
    columns: plan.root.columns.map((c) => ({ ...c })),
    rows: plan.root.rows
      .filter((row) => r.split.train.includes(row.id))
      .map((row) => ({ id: row.id, values: { ...row.values } })),
  };
  let evaluation: TableData = {
    columns: train.columns,
    rows: plan.root.rows
      .filter((row) => r.split.evaluation.includes(row.id))
      .map((row) => ({ id: row.id, values: { ...row.values } })),
  };
  const expectedSteps: FittedRegressionStep[] = [];
  const add = (step: FittedRegressionStep) => {
    expectedSteps.push(step);
    train = applyRegressionStep(train, step);
    evaluation = applyRegressionStep(evaluation, step);
  };
  for (const step of plan.steps)
    add(
      fitRegressionStep(
        { columns: train.columns, rows: [...train.rows, ...evaluation.rows] },
        step,
        train.rows.map((row) => row.id),
      ),
    );
  add({
    kind: "preprocess",
    operationId: "regression-missing",
    fitted: structuredClone(
      fitPreprocessing(
        train,
        plan.source,
        {
          kind: "missing",
          attributeIds: s.features,
          method: s.missing,
          rowRule: "any",
          fixedValues: {},
        },
        { kind: "training", rowIds: train.rows.map((row) => row.id) },
      ),
    ),
  });
  const ranges = r.features.map((c) => ({
    attributeId: c.id,
    min: Math.min(...train.rows.map((row) => row.values[c.id] as number)),
    max: Math.max(...train.rows.map((row) => row.values[c.id] as number)),
  }));
  if (s.scaling !== "none")
    add({
      kind: "preprocess",
      operationId: "regression-scale",
      fitted: structuredClone(
        fitPreprocessing(
          train,
          plan.source,
          { kind: "scale", attributeIds: s.features, method: s.scaling },
          { kind: "training", rowIds: train.rows.map((row) => row.id) },
        ),
      ),
    });
  assert(
    equal(expectedSteps, r.pipeline?.steps) &&
      equal(ranges, r.pipeline.ranges) &&
      equal(plan.rawInputs, r.pipeline.rawInputs),
    "가공 순서·학습 기준 또는 기준 계산 행 범위가 일치하지 않습니다.",
  );
  const tr = reconstructMatrix(plan, r, r.split.train),
    ev = reconstructMatrix(plan, r, r.split.evaluation);
  assert(
    equal(
      tr.map((row) => row.id),
      r.trainRowIds,
    ) &&
      equal(
        ev.map((row) => row.id),
        r.evaluationRowIds,
      ),
    "전처리 후 학습·평가 행 참조가 다릅니다.",
  );
  const excluded: RegressionResult["excluded"] = truth.rows
    .filter((row) => !valid.some((v) => v.id === row.id))
    .map((row) => ({
      rowId: row.id,
      phase: "target",
      reason: "원래 관측 정답이 결측 또는 유효한 수치가 아님",
    }));
  for (const id of r.split.train)
    if (!r.trainRowIds.includes(id))
      excluded.push({
        rowId: id,
        phase: "training",
        reason: "공통 가공·결측 제거 정책",
      });
  for (const id of r.split.evaluation)
    if (!r.evaluationRowIds.includes(id))
      excluded.push({
        rowId: id,
        phase: "evaluation",
        reason: "공통 가공·결측 제거 정책",
      });
  assert(equal(excluded, r.excluded), "회귀 제외 행·사유가 일치하지 않습니다.");
  assert(
    Array.isArray(r.models) &&
      equal(
        r.models.map((m) => m.kind),
        s.models,
      ) &&
      r.models.length * ev.length <= REGRESSION_LIMITS.resultRows,
    "회귀 모델·결과 크기가 올바르지 않습니다.",
  );
  assert(
    !s.models.includes("knn") ||
      tr.length * ev.length * s.features.length <= REGRESSION_LIMITS.distances,
    "복원 회귀 거리 계산 한도를 넘습니다.",
  );
  for (const m of r.models) {
    assert(m.durationMs >= 0, "모델 실행 시각이 잘못되었습니다.");
    if (m.status === "failed") {
      assert(
        typeof m.reason === "string" && m.reason.length > 0,
        "모델 실패 원인이 없습니다.",
      );
      continue;
    }
    assert(
      m.status === "completed" &&
        m.model?.kind === m.kind &&
        Array.isArray(m.rows),
      "회귀 모델 실행 상태가 잘못되었습니다.",
    );
    const model = m.model;
    if (model.kind === "linear")
      assert(
        model.algorithm === "scaled-householder-qr-v1" &&
          typeof model.intercept === "number" &&
          Array.isArray(model.coefficients) &&
          model.coefficients.length === s.features.length &&
          model.coefficients.every((v) => typeof v === "number") &&
          close(model.tolerance, 1e-10 * Math.sqrt(tr.length)),
        "선형회귀 계수·특성·계산 방식이 잘못되었습니다.",
      );
    if (model.kind === "knn")
      assert(
        model.k === s.k &&
          model.k <= tr.length &&
          model.weights === s.weights &&
          equal(model.trainRowIds, r.trainRowIds),
        "최근접 이웃의 k·학습 참조가 잘못되었습니다.",
      );
    if (model.kind === "tree") {
      assert(
        Array.isArray(model.nodes) &&
          model.nodes.length > 0 &&
          model.nodes.length <= REGRESSION_LIMITS.nodes &&
          model.maxDepth === s.maxDepth &&
          model.minLeaf === s.minLeaf &&
          Number.isInteger(model.work) &&
          model.work >= 0 &&
          model.work <= REGRESSION_LIMITS.treeWork,
        "트리 구조·한도가 잘못되었습니다.",
      );
      const seen = new Set<number>();
      const visit = (id: number, depth: number, rows: typeof tr) => {
        assert(
          Number.isInteger(id) && !seen.has(id) && model.nodes[id],
          "트리에 순환·없는 노드 참조가 있습니다.",
        );
        seen.add(id);
        const n = model.nodes[id];
        assert(
          n.id === id &&
            n.depth === depth &&
            depth <= s.maxDepth &&
            n.count === rows.length &&
            rows.length > 0 &&
            close(
              n.prediction,
              rows.reduce((sum, r) => sum + r.y / rows.length, 0),
            ),
          "트리 노드의 행 수·리프 평균·깊이가 다릅니다.",
        );
        if (n.feature === null) {
          assert(
            n.left === null && n.right === null && n.threshold === null,
            "트리 리프 참조가 잘못되었습니다.",
          );
          return;
        }
        assert(
          Number.isInteger(n.feature) &&
            n.feature >= 0 &&
            n.feature < s.features.length &&
            typeof n.threshold === "number" &&
            n.left !== null &&
            n.right !== null,
          "트리 분할 참조가 잘못되었습니다.",
        );
        const left = rows.filter((r) => r.x[n.feature!] <= n.threshold!),
          right = rows.filter((r) => r.x[n.feature!] > n.threshold!);
        assert(
          left.length >= s.minLeaf && right.length >= s.minLeaf,
          "트리 최소 리프 기준이 다릅니다.",
        );
        visit(n.left, depth + 1, left);
        visit(n.right, depth + 1, right);
      };
      visit(0, 0, tr);
      assert(
        seen.size === model.nodes.length,
        "도달할 수 없는 트리 노드가 있습니다.",
      );
    }
    const rows = ev.map((row) =>
      evaluationRow(row.id, row.y, predictModel(model, row.x, tr).predicted),
    );
    assert(rows.length === m.rows.length, "평가 행 수가 다릅니다.");
    rows.forEach((row, i) => {
      const stored = m.rows[i];
      assert(
        row.rowId === stored.rowId &&
          (
            [
              "actual",
              "predicted",
              "residual",
              "absoluteError",
              "squaredError",
            ] as const
          ).every((k) => close(row[k], stored[k])),
        "개별 평가값·정답·잔차가 저장 모델과 다릅니다.",
      );
    });
    const metrics = regressionMetrics(rows);
    for (const [key, value] of Object.entries(metrics)) {
      const saved = m.metrics?.[key as keyof typeof metrics];
      assert(
        typeof value === "number"
          ? typeof saved === "number" && close(value, saved)
          : saved === value,
        "평가 요약 점수·분자·분모가 개별 결과와 다릅니다.",
      );
    }
  }
}
