import { describe, expect, it } from "vitest";
import type {
  Attribute,
  Cell,
  Dataset,
  TableData,
  AnalysisRecord,
} from "./types";
import type { RegressionSettings, MatrixRow } from "./regression-types";
import {
  createAnalysisRecord,
  createVersion,
  getResultFreshness,
  preserveOriginal,
} from "./model";
import {
  buildRegressionPlan,
  comparableRegression,
  defaultRegression,
  predictRegression,
  regressionConfig,
  runRegression,
} from "./regression";
import {
  evaluationRow,
  fitLinear,
  fitTree,
  predictModel,
  regressionMetrics,
  REGRESSION_LIMITS,
} from "./regression-models";
import {
  createWorkspace,
  getSelection,
  workspaceReducer,
  type WorkspaceState,
} from "../state/workspace";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
} from "../persistence/format";
import {
  commitPreprocessing,
  fitPreprocessing,
  preprocessingLineage,
} from "./preprocessing";
import type { PreprocessingSettings } from "./preprocessing-types";
import { commitWrangling, fitWrangling } from "./wrangling";
import type { WranglingSettings, InputTable } from "./wrangling-types";
import { editVersion } from "./table";
import { JobGate } from "../workers/protocol";
import {
  parseBytes,
  registerImport,
  defaultImportOptions,
} from "../data/import";

const col = (
  id: string,
  storageType: Attribute["storageType"] = "number",
  semanticType: Attribute["semanticType"] = "numeric",
): Attribute => ({
  id,
  name: id,
  storageType,
  semanticType,
  useInAnalysis: true,
  description: "",
});
function dataset(
  values: Cell[][],
  columns = [col("x"), col("y")],
  id = "r",
): Dataset {
  const now = "2026-10-12T00:00:00.000Z",
    table: TableData = {
      columns,
      rows: values.map((values, i) => ({
        id: id + "-" + String(i).padStart(3, "0"),
        values: Object.fromEntries(columns.map((c, j) => [c.id, values[j]])),
      })),
    };
  const v = createVersion(table, {
    id: id + "-v",
    datasetId: id,
    parentVersionIds: [],
    createdAt: now,
    operation: {
      id: id + "-op",
      kind: "import",
      datasetId: id,
      inputVersionIds: [],
      outputVersionIds: [id + "-v"],
      settings: {},
      executedAt: now,
    },
  });
  return {
    id,
    name: id,
    source: { kind: "manual", label: "독립 검증 자료", importedAt: now },
    original: preserveOriginal(table),
    versions: [v],
  };
}
function state(
  values: Cell[][] = Array.from({ length: 12 }, (_, i) => [i, 2 + 3 * i]),
  columns?: Attribute[],
) {
  return workspaceReducer(createWorkspace(false), {
    type: "import",
    dataset: dataset(values, columns),
  });
}
function config(st: WorkspaceState, patch: Partial<RegressionSettings> = {}) {
  return regressionConfig(st.project.selection!, {
    ...defaultRegression(),
    target: "y",
    features: ["x"],
    ...patch,
  });
}
function run(st: WorkspaceState, patch: Partial<RegressionSettings> = {}) {
  const c = config(st, patch),
    p = buildRegressionPlan(st.project, c);
  return { config: c, plan: p, result: runRegression(p, c.regression) };
}
function save(st: WorkspaceState, patch: Partial<RegressionSettings> = {}) {
  const r = run(st, patch);
  const record: AnalysisRecord = {
    ...createAnalysisRecord(r.config, "analysis-1", "2026-10-12T00:00:00.000Z"),
    status: "completed",
    regression: r.result,
    completedAt: r.result.completedAt,
  };
  return {
    state: workspaceReducer(st, { type: "analysis-record", record }),
    record,
    ...r,
  };
}
function pre(st: WorkspaceState, settings: PreprocessingSettings) {
  const v = getSelection(st).version!,
    source = st.project.selection!,
    next = commitPreprocessing(
      v,
      source,
      fitPreprocessing(v, source, settings),
      preprocessingLineage(getSelection(st).dataset!, source.versionId),
    );
  return next
    ? workspaceReducer(st, {
        type: "commit-version",
        datasetId: source.datasetId,
        baseVersionId: source.versionId,
        version: next,
      })
    : st;
}
function wrangle(
  st: WorkspaceState,
  settings: WranglingSettings,
  inputs?: InputTable[],
) {
  const source = st.project.selection!,
    v = getSelection(st).version!,
    i = inputs ?? [{ source, name: "입력", table: v }],
    out = commitWrangling(i, fitWrangling(i, settings), 3_000_000, true);
  return workspaceReducer(
    st,
    out.dataset
      ? {
          type: "register-derived",
          dataset: out.dataset,
          expectedInputs: i.map((x) => x.source),
        }
      : {
          type: "commit-version",
          datasetId: source.datasetId,
          baseVersionId: source.versionId,
          version: out.version,
        },
  );
}
const matrix = (xs: number[][], ys: number[]): MatrixRow[] =>
  xs.map((x, i) => ({ id: String(i), x, y: ys[i] }));

describe("독립 손계산 회귀 모델", () => {
  it("단순 회귀 y=2+3x와 다중 회귀 y=4+2x-3z를 QR로 복원한다", () => {
    const simple = fitLinear(matrix([[0], [1], [2], [3]], [2, 5, 8, 11]));
    expect(simple.intercept).toBeCloseTo(2, 11);
    expect(simple.coefficients[0]).toBeCloseTo(3, 11);
    expect(predictModel(simple, [5], []).predicted).toBeCloseTo(17, 11);
    const multi = fitLinear(
      matrix(
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
          [2, 1],
          [1, 2],
        ],
        [4, 6, 1, 3, 5, 0],
      ),
    );
    expect(multi.intercept).toBeCloseTo(4, 11);
    expect(multi.coefficients[0]).toBeCloseTo(2, 11);
    expect(multi.coefficients[1]).toBeCloseTo(-3, 11);
    expect(predictModel(multi, [3, 2], []).predicted).toBeCloseTo(4, 11);
  });
  it("상수·종속·학습 행 부족을 숨기지 않는다", () => {
    expect(() => fitLinear(matrix([[1], [1], [1]], [1, 2, 3]))).toThrow("상수");
    expect(() =>
      fitLinear(
        matrix(
          [
            [0, 0],
            [1, 2],
            [2, 4],
            [3, 6],
            [4, 8],
          ],
          [1, 2, 3, 4, 5],
        ),
      ),
    ).toThrow("종속");
    expect(() =>
      fitLinear(
        matrix(
          [
            [0, 1],
            [1, 2],
            [2, 3],
          ],
          [1, 2, 3],
        ),
      ),
    ).toThrow("학습 행");
  });
  it("큰 입력을 수치 균형 조정하고 표현 불가 제곱 오차는 차단한다", () => {
    const fit = fitLinear(
      matrix([[1e12], [2e12], [3e12], [4e12]], [3, 5, 7, 9]),
    );
    expect(fit.coefficients[0]).toBeCloseTo(2e-12, 23);
    expect(predictModel(fit, [5e12], []).predicted).toBeCloseTo(11, 10);
    expect(() => evaluationRow("a", 1e308, -1e308)).toThrow("범위");
  });
  it("트리는 경계 1.5, 리프 평균 1·9, 같은 분할이면 앞 특성을 쓴다", () => {
    const tr = matrix(
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [3, 3],
        ],
        [0, 2, 8, 10],
      ),
      fit = fitTree(tr, 1, 1);
    expect(fit.nodes[0]).toMatchObject({
      feature: 0,
      threshold: 1.5,
      count: 4,
      prediction: 5,
    });
    expect(fit.nodes[1].prediction).toBe(1);
    expect(fit.nodes[2].prediction).toBe(9);
    const out = predictModel(fit, [2.5, 2.5], tr);
    expect(out.predicted).toBe(9);
    expect(out.path?.map((n) => n.id)).toEqual([0, 2]);
  });
  it("kNN 거리·동률·평균·거리0 규칙과 k 범위", () => {
    const tr = matrix([[0], [2], [4]], [2, 6, 10]);
    const model = {
      kind: "knn" as const,
      k: 2,
      weights: "uniform" as const,
      trainRowIds: tr.map((r) => r.id),
    };
    const out = predictModel(model, [1], tr);
    expect(out.predicted).toBe(4);
    expect(out.neighbors).toEqual([
      { rowId: "0", distance: 1, target: 2, weight: 0.5 },
      { rowId: "1", distance: 1, target: 6, weight: 0.5 },
    ]);
    expect(
      predictModel({ ...model, weights: "distance" }, [0], tr).predicted,
    ).toBe(2);
    expect(
      predictModel({ ...model, weights: "distance" }, [0.5], tr).predicted,
    ).toBeCloseTo(3, 12);
    expect(() => predictModel({ ...model, k: 4 }, [0], tr)).toThrow("k");
  });
  it("MAE=1.5 MSE=2.5 RMSE=√2.5 R²=-1.5, 상수 정답 R²=null", () => {
    const m = regressionMetrics([
      evaluationRow("a", 1, 2),
      evaluationRow("b", 3, 5),
    ]);
    expect(m).toMatchObject({
      n: 2,
      absoluteSum: 3,
      squaredSum: 5,
      totalSumSquares: 2,
      mae: 1.5,
      mse: 2.5,
      r2: -1.5,
    });
    expect(m.rmse).toBe(Math.sqrt(2.5));
    expect(
      regressionMetrics([evaluationRow("a", 2, 1), evaluationRow("b", 2, 3)])
        .r2,
    ).toBeNull();
    expect(regressionMetrics([evaluationRow("a", 2, 1)]).r2Reason).toContain(
      "2개",
    );
  });
});
describe("분할과 학습 전용 파이프라인", () => {
  it("범주 코드의 의미 유형을 수치로 바꾸는 우회도 거부한다", () => {
    let st = state(
      Array.from({ length: 12 }, (_, i) => [i % 2 ? "A" : "B", i]),
      [col("x", "string", "categorical"), col("y")],
    );
    st = wrangle(st, {
      kind: "encode",
      attributeId: "x",
      method: "code",
      output: { name: "code", description: "" },
      order: null,
      dropBaseline: false,
      baseline: null,
      unknown: "missing",
    });
    const { dataset: d, version: v } = getSelection(st),
      c = v!.columns.find((c) => c.name === "code")!;
    const next = editVersion(d!, v!.id, {
      kind: "attribute",
      attribute: { ...c, semanticType: "numeric" },
      allowLoss: true,
    })!;
    st = workspaceReducer(st, {
      type: "commit-version",
      datasetId: d!.id,
      baseVersionId: v!.id,
      version: next,
    });
    expect(() => run(st, { features: [c.id] })).toThrow("범주 코드");
  });
  it("이상값 IQR과 후속 스케일링도 평가 극단값 없이 학습 기준을 다시 만든다", () => {
    let st = state([0, 1, 2, 3, 4, 5, 6, 1000].map((x) => [x, 1 + x]));
    st = pre(st, {
      kind: "outliers",
      attributeIds: ["x"],
      detection: "iqr",
      multiplier: 1.5,
      lower: 0,
      upper: 10,
      action: "clip",
      rowRule: "any",
    });
    const a = save(st, {
      models: ["tree"],
      scaling: "minmax",
      reuseSplit: {
        train: ["r-000", "r-001", "r-002", "r-003", "r-004", "r-005"],
        evaluation: ["r-006", "r-007"],
      },
    });
    const fitted = a.result.pipeline.steps[0];
    expect(fitted.kind).toBe("preprocess");
    if (fitted.kind === "preprocess")
      expect(fitted.fitted.columns.x).toMatchObject({
        q1: 1.25,
        q3: 3.75,
        lower: -2.5,
        upper: 7.5,
      });
    expect(a.result.pipeline.ranges[0]).toEqual({
      attributeId: "x",
      min: 0,
      max: 5,
    });
    expect(() => validateWorkspace(a.state)).not.toThrow();
  });
  it("행 제거의 all 규칙은 미선택 속성도 포함해 원래 순서로 재생한다", () => {
    let st = state(
      Array.from({ length: 12 }, (_, i) => [
        i < 2 ? null : i,
        i === 1 ? null : i + 1,
        i * 2,
      ]),
      [col("x"), col("z"), col("y")],
    );
    st = pre(st, {
      kind: "missing",
      attributeIds: ["x", "z"],
      method: "remove",
      rowRule: "all",
      fixedValues: {},
    });
    const a = save(st, { missing: "mean", models: ["tree"] });
    expect(a.result.scopeRowIds).toHaveLength(11);
    expect(a.result.excluded).toHaveLength(0);
    expect(a.plan.rawInputs.map((c) => c.id)).toContain("z");
    expect(() => validateWorkspace(a.state)).not.toThrow();
  });
  it("CSV 원본과 확정 자료형 버전을 구분하여 실제 가져온 자료를 분석한다", () => {
    const text =
      "입력,점수\n" +
      Array.from(
        { length: 12 },
        (_, i) => `${i + 0.25},${2 + 3 * (i + 0.25)}`,
      ).join("\n");
    const parsed = parseBytes(
      new TextEncoder().encode(text).buffer,
      "회귀.csv",
      defaultImportOptions,
    );
    const d = registerImport(parsed, parsed.proposed.columns, true),
      st = workspaceReducer(createWorkspace(false), {
        type: "import",
        dataset: d,
      });
    const [x, y] = d.versions[1].columns,
      a = save(st, { target: y.id, features: [x.id] });
    expect(a.plan.rootSource.versionId).toBe(d.versions[1].id);
    expect(d.original.table.rows[0].values[x.id]).toBe("0.25");
    expect(
      predictRegression(a.plan, a.result, { [x.id]: 5 }).models[0].predicted,
    ).toBeCloseTo(17, 10);
    expect(() => validateWorkspace(a.state)).not.toThrow();
  });
  it("seed·표 순서 독립, 세 모델의 정확히 같은 평가 집합", () => {
    const st = state(),
      a = run(st),
      b = run(st);
    expect(a.result.split).toEqual(b.result.split);
    const reversed = structuredClone(st);
    reversed.project.datasets[0].versions[0] = {
      ...reversed.project.datasets[0].versions[0],
      rows: [...reversed.project.datasets[0].versions[0].rows].reverse(),
    };
    expect(run(reversed).result.split).toEqual(a.result.split);
    for (const m of a.result.models) {
      expect(m.status).toBe("completed");
      if (m.status === "completed")
        expect(m.rows.map((r) => r.rowId)).toEqual(a.result.evaluationRowIds);
    }
  });
  it("평가 정답·극단값을 바꿔도 학습 기준과 모델은 같고 분할을 재사용한다", () => {
    const st = state(),
      a = run(st, { missing: "mean", scaling: "zscore" }),
      p = structuredClone(a.plan),
      evalSet = new Set(a.result.split.evaluation);
    p.root = {
      ...p.root,
      rows: p.root.rows.map((row) =>
        evalSet.has(row.id)
          ? { ...row, values: { ...row.values, x: 99999, y: -200 } }
          : row,
      ),
    };
    const b = runRegression(p, {
      ...a.config.regression,
      reuseSplit: {
        train: a.result.split.train,
        evaluation: a.result.split.evaluation,
      },
    });
    expect(b.pipeline).toEqual(a.result.pipeline);
    expect(
      b.models.map((m) => (m.status === "completed" ? m.model : null)),
    ).toEqual(
      a.result.models.map((m) => (m.status === "completed" ? m.model : null)),
    );
  });
  it("전체·필터·선택·빈 선택 범위와 숫자 범주 거절", () => {
    const st = state();
    expect(
      run(st, {
        scope: {
          kind: "filtered",
          filter: { attributeId: "x", operator: "gt", value: "4" },
          duplicatesOnly: false,
          rowIds: [],
        },
      }).result.scopeRowIds,
    ).toHaveLength(7);
    expect(
      run(st, {
        scope: {
          kind: "selected",
          filter: null,
          duplicatesOnly: false,
          rowIds: ["r-000", "r-001", "r-002", "r-003"],
        },
      }).result.scopeRowIds,
    ).toHaveLength(4);
    expect(() =>
      run(st, {
        scope: {
          kind: "selected",
          filter: null,
          duplicatesOnly: false,
          rowIds: [],
        },
      }),
    ).toThrow("비었");
    expect(() =>
      run(
        state(
          [
            [1, 2],
            [2, 3],
            [3, 4],
          ],
          [col("x", "number", "categorical"), col("y")],
        ),
      ),
    ).toThrow("수치");
  });
  it("정답 대체값은 정답으로 쓰지 않고 원래 결측 행을 제외한다", () => {
    const st = pre(
      state([
        [1, 3],
        [2, null],
        [3, 9],
        [4, 12],
        [5, 15],
        [6, 18],
      ]),
      {
        kind: "missing",
        method: "mean",
        attributeIds: ["y"],
        rowRule: "any",
        fixedValues: {},
      },
    );
    const r = run(st).result;
    expect(r.excluded).toContainEqual({
      rowId: "r-001",
      phase: "target",
      reason: "원래 관측 정답이 결측 또는 유효한 수치가 아님",
    });
    expect([...r.split.train, ...r.split.evaluation]).not.toContain("r-001");
  });
  it("전처리·계산·날짜·구간·원핫 경로를 재생하고 고정 기준으로 새 입력을 예측한다", () => {
    let st = state(
      Array.from({ length: 20 }, (_, i) => [
        i === 3 ? null : i,
        i * 2 + 1,
        "2026-09-" + String(i + 1).padStart(2, "0"),
      ]),
      [col("x"), col("y"), col("day", "string", "date")],
    );
    st = pre(st, {
      kind: "missing",
      method: "mean",
      attributeIds: ["x"],
      rowRule: "any",
      fixedValues: {},
    });
    st = wrangle(st, {
      kind: "calculate",
      operator: "multiply",
      operands: [
        { kind: "attribute", attributeId: "x" },
        { kind: "constant", value: 2 },
      ],
      missing: "propagate",
      invalid: "block",
      output: { name: "twice", description: "" },
    });
    st = wrangle(st, {
      kind: "date",
      attributeId: "day",
      parts: [
        {
          part: "day",
          name: "daynum",
          description: "",
          storageType: "number",
          semanticType: "numeric",
        },
      ],
      invalid: "block",
    });
    st = wrangle(st, {
      kind: "bin",
      attributeId: "x",
      method: "width",
      count: 2,
      labels: ["낮음", "높음"],
      outside: "edge",
      output: { name: "bins", description: "" },
    });
    const bin = getSelection(st).version!.columns.find(
      (c) => c.name === "bins",
    )!.id;
    st = wrangle(st, {
      kind: "encode",
      attributeId: bin,
      method: "onehot",
      output: { name: "hot", description: "" },
      order: null,
      dropBaseline: true,
      baseline: "낮음",
      unknown: "missing",
    });
    const columns = getSelection(st).version!.columns,
      features = columns
        .filter(
          (c) =>
            c.name === "twice" ||
            c.name === "daynum" ||
            c.name.startsWith("hot"),
        )
        .map((c) => c.id);
    const a = save(st, {
      features,
      models: ["tree", "knn"],
      missing: "mean",
      scaling: "zscore",
    });
    expect(
      a.result.pipeline.steps.filter((s) => s.kind === "wrangle"),
    ).toHaveLength(4);
    for (const step of a.result.pipeline.steps)
      if (step.kind === "preprocess")
        expect(
          step.fitted.fitRows.rowIds.every((id) =>
            a.result.split.train.includes(id),
          ),
        ).toBe(true);
    const before = JSON.stringify(a.result),
      prediction = predictRegression(a.plan, a.result, {
        x: 22,
        day: "2026-09-23",
      });
    expect(prediction.models).toHaveLength(2);
    expect(prediction.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.result)).toBe(before);
    const restored = readBackup(JSON.stringify(makeBackup(a.state)), true);
    expect(restored.project.analyses[0].regression).toEqual(a.result);
    expect(
      predictRegression(
        buildRegressionPlan(restored.project, a.config),
        restored.project.analyses[0].regression!,
        { x: 22, day: "2026-09-23" },
      ),
    ).toEqual(prediction);
  });
  it("평가 전용 새 범주는 학습 사전에 들어가지 않는다", () => {
    let st = state(
      Array.from({ length: 12 }, (_, i) => [i % 2 ? "A" : "B", 2 * i + 1]),
      [col("x", "string", "categorical"), col("y")],
    );
    st = wrangle(st, {
      kind: "encode",
      attributeId: "x",
      method: "onehot",
      output: { name: "hot", description: "" },
      order: null,
      dropBaseline: true,
      baseline: "A",
      unknown: "missing",
    });
    const feature = getSelection(st).version!.columns.find((c) =>
        c.name.startsWith("hot"),
      )!.id,
      a = run(st, { features: [feature], models: ["tree"], missing: "remove" }),
      plan = structuredClone(a.plan),
      ev = new Set(a.result.split.evaluation);
    plan.root = {
      ...plan.root,
      rows: plan.root.rows.map((row) =>
        ev.has(row.id)
          ? { ...row, values: { ...row.values, x: "평가 전용" } }
          : row,
      ),
    };
    expect(() => runRegression(plan, a.config.regression)).toThrow(
      "평가 행이 없습니다",
    );
    const step = a.result.pipeline.steps.find((s) => s.kind === "wrangle");
    if (step?.kind === "wrangle" && step.fitted.basis?.kind === "encode")
      expect(step.fitted.basis.categories.map((c) => c.value)).not.toContain(
        "평가 전용",
      );
  });
  it("대상 의존 계산은 차단하되 대상과 무관한 동일 원천 파생 입력은 허용한다", () => {
    let st = wrangle(state(), {
      kind: "calculate",
      operator: "multiply",
      operands: [
        { kind: "attribute", attributeId: "y" },
        { kind: "constant", value: 2 },
      ],
      missing: "propagate",
      invalid: "block",
      output: { name: "leak", description: "" },
    });
    let feature = getSelection(st).version!.columns.find(
      (c) => c.name === "leak",
    )!.id;
    expect(() => run(st, { features: [feature] })).toThrow("정답");
    st = wrangle(state(), {
      kind: "calculate",
      operator: "multiply",
      operands: [
        { kind: "attribute", attributeId: "x" },
        { kind: "constant", value: 2 },
      ],
      missing: "propagate",
      invalid: "block",
      output: { name: "safe", description: "" },
    });
    feature = getSelection(st).version!.columns.find(
      (c) => c.name === "safe",
    )!.id;
    expect(run(st, { features: [feature] }).result.models[0].status).toBe(
      "completed",
    );
  });
  it("편집·자료형 이력을 보존하고 당시 버전에서 예측한다", () => {
    let st = state();
    const d = st.project.datasets[0],
      version = editVersion(d, d.versions[0].id, {
        kind: "cell",
        rowId: "r-000",
        attributeId: "x",
        value: "0.5",
        missing: false,
      })!;
    st = workspaceReducer(st, {
      type: "commit-version",
      datasetId: d.id,
      baseVersionId: d.versions[0].id,
      version,
    });
    const a = save(st);
    expect(a.plan.steps[0].kind).toBe("edit");
    expect(a.plan.root.rows[0].values.x).toBe(0);
    expect(d.original.table.rows[0].values.x).toBe(0);
    expect(() => validateWorkspace(a.state)).not.toThrow();
  });
  it("다대다 복제는 대상 출처로 묶고 공통 참조 행으로 모두 묶지 않는다", () => {
    let st = state(
      Array.from({ length: 8 }, (_, i) => [i % 2, i, i * 3 + 1]),
      [col("key"), col("x"), col("y")],
    );
    const right = dataset(
      [
        [0, 8],
        [0, 9],
        [1, 7],
        [1, 6],
      ],
      [col("key"), col("z")],
      "right",
    );
    st = workspaceReducer(st, { type: "import", dataset: right });
    const left = st.project.datasets[0],
      inputs = [
        {
          source: { datasetId: left.id, versionId: left.versions[0].id },
          name: "left",
          table: left.versions[0],
        },
        {
          source: { datasetId: right.id, versionId: right.versions[0].id },
          name: "right",
          table: right.versions[0],
        },
      ];
    st = wrangle(
      st,
      {
        kind: "join",
        mode: "inner",
        keys: [{ left: "key", right: "key" }],
        columnNames: {},
        name: "joined",
      },
      inputs,
    );
    const cols = getSelection(st).version!.columns,
      a = run(st, {
        target: cols.find((c) => c.name === "y")!.id,
        features: [cols.find((c) => c.name === "x")!.id],
      });
    const train = new Set(
      a.result.split.train.map((id) => a.result.split.units[id]),
    );
    expect(train.size).toBe(5);
    expect(
      a.result.split.evaluation.every(
        (id) => !train.has(a.result.split.units[id]),
      ),
    ).toBe(true);
    expect(a.result.scopeRowIds).toHaveLength(16);
    expect(a.result.predictionBlock).toContain("結合".replace("結合", "결합"));
  });
  it("집계 후 재결합의 전체 자료 통계 누수는 평가 전에 차단한다", () => {
    let st = state(
      Array.from({ length: 8 }, (_, i) => [i % 2, i, i * 3 + 1]),
      [col("key"), col("x"), col("y")],
    );
    const left = st.project.datasets[0];
    st = wrangle(st, {
      kind: "aggregate",
      groupIds: ["key"],
      includeMissing: false,
      aggregates: [
        { method: "mean", attributeId: "x", name: "average", description: "" },
      ],
      name: "group",
    });
    const right = getSelection(st),
      key = right.version!.columns.find((c) => c.name === "key")!.id;
    st = wrangle(
      st,
      {
        kind: "join",
        mode: "left",
        keys: [{ left: "key", right: key }],
        columnNames: {},
        name: "joined",
      },
      [
        {
          source: { datasetId: left.id, versionId: left.versions[0].id },
          name: "left",
          table: left.versions[0],
        },
        { source: st.project.selection!, name: "right", table: right.version! },
      ],
    );
    const cols = getSelection(st).version!.columns;
    expect(() =>
      run(st, {
        target: cols.find((c) => c.name === "y")!.id,
        features: [cols.find((c) => c.name === "average")!.id],
      }),
    ).toThrow("누수");
  });
});
describe("기록·복원·최신 여부·원자적 한도", () => {
  it("자동 저장 대상 구조·백업·사본 복원에서 모델과 예측 보존, undo는 독립", () => {
    const a = save(state(), { scaling: "minmax" }),
      history = JSON.stringify(a.state.project.history),
      before = predictRegression(a.plan, a.result, { x: 5 });
    const restored = readBackup(JSON.stringify(makeBackup(a.state)), true);
    expect(restored.project.id).not.toBe(a.state.project.id);
    expect(
      predictRegression(
        buildRegressionPlan(restored.project, a.config),
        restored.project.analyses[0].regression!,
        { x: 5 },
      ),
    ).toEqual(before);
    expect(getResultFreshness(a.record, a.config.source, a.config).state).toBe(
      "current",
    );
    expect(
      getResultFreshness(a.record, a.config.source, {
        ...a.config,
        regression: { ...a.config.regression, k: 4 },
      }).state,
    ).toBe("stale");
    expect(comparableRegression(a.result, run(state(), { k: 4 }).result)).toBe(
      true,
    );
    expect(
      comparableRegression(a.result, run(state(), { seed: 10 }).result),
    ).toBe(false);
    const deleted = workspaceReducer(a.state, {
      type: "analysis-delete",
      id: a.record.id,
    });
    expect(deleted.view.currentAnalysisId).toBeNull();
    expect(JSON.stringify(deleted.project.history)).toBe(history);
    expect(Object.isFrozen(a.state.project.analyses[0].regression)).toBe(true);
  });
  it.each([
    "coefficient",
    "split",
    "reference",
    "basis",
    "score",
    "tree",
    "knn",
    "selection",
  ] as const)("손상 %s를 기존 프로젝트 교체 전에 거부", (kind) => {
    const a = save(state()),
      st = structuredClone(a.state),
      r = st.project.analyses[0].regression!;
    if (kind === "coefficient") {
      const m = r.models.find(
        (m) => m.status === "completed" && m.model.kind === "linear",
      );
      if (m?.status === "completed" && m.model.kind === "linear")
        m.model.coefficients = [999];
    }
    if (kind === "split") r.split.evaluation.push(r.split.train[0]);
    if (kind === "reference") r.trainRowIds[0] = "없는 행";
    if (kind === "basis") {
      const p = r.pipeline.steps[0];
      if (p.kind === "preprocess")
        (p.fitted.fitRows as unknown as { rowIds: string[] }).rowIds.push(
          r.split.evaluation[0],
        );
    }
    if (kind === "score") {
      const m = r.models[0];
      if (m.status === "completed") m.metrics.mae = 999;
    }
    if (kind === "tree") {
      const m = r.models.find(
        (m) => m.status === "completed" && m.kind === "tree",
      );
      if (m?.status === "completed" && m.model.kind === "tree")
        m.model.nodes[0].left = 0;
    }
    if (kind === "knn") {
      const m = r.models.find(
        (m) => m.status === "completed" && m.kind === "knn",
      );
      if (m?.status === "completed" && m.model.kind === "knn") m.model.k = 999;
    }
    if (kind === "selection") st.view.currentAnalysisId = "없는 기록";
    expect(() => validateWorkspace(st)).toThrow();
    expect(a.state.project.analyses[0].regression).toEqual(a.result);
  });
  it("진행 중 기록은 복원 시 취소되며 늦은 응답은 반영하지 않는다", () => {
    const st = state(),
      c = config(st),
      record = {
        ...createAnalysisRecord(c, "running", new Date().toISOString()),
        status: "running" as const,
      };
    const next = workspaceReducer(st, { type: "analysis-record", record });
    expect(validateWorkspace(next).project.analyses[0].status).toBe(
      "cancelled",
    );
    const gate = new JobGate(),
      task = {
        kind: "regression-run" as const,
        plan: buildRegressionPlan(st.project, c),
        settings: c.regression,
      },
      old = gate.startTask("regression", task);
    gate.invalidate("regression");
    gate.startTask("regression", task);
    let commits = 0;
    expect(
      gate.receive({ ...old, type: "complete", result: null }, () => commits++),
    ).toBe(false);
    expect(commits).toBe(0);
  });
  it("모델 실패는 점수0이 아니며 성공한 모델을 보존한다", () => {
    const a = run(state(Array.from({ length: 12 }, (_, i) => [1, i])));
    expect(a.result.models[0].status).toBe("failed");
    expect(a.result.models[1].status).toBe("completed");
    expect(a.result.models[2].status).toBe("completed");
  });
  it("거리 계산·행 수 한도를 절단 없이 원자적으로 차단한다", () => {
    const st = state(Array.from({ length: 15000 }, (_, i) => [i, i * 2]));
    expect(() => run(st)).toThrow("거리 계산 한도");
    expect(st.project.analyses).toHaveLength(0);
    const oversized = state(
      Array.from({ length: REGRESSION_LIMITS.rows + 1 }, (_, i) => [i, i * 2]),
    );
    expect(() => run(oversized)).toThrow("20,000행");
  });
});
