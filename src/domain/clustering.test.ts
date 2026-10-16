import { describe, it, expect } from "vitest";
import {
  defaultClustering,
  experimentDataset,
  clusteringConfig,
  buildClusteringPlan,
  runClustering,
  silhouettePoint,
  clusterDetail,
  compareClusters,
  analysisConfigKey,
  checkClusterBudget,
  prepareClusters,
} from "./clustering";
import type {
  ClusteringSettings,
  ClusterQuery,
  ClusteringPlan,
} from "./clustering-types";
import type { AnalysisRecord } from "./types";
import { createWorkspace, workspaceReducer } from "../state/workspace";
import { snapshot, createAnalysisRecord, getResultFreshness } from "./model";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
} from "../persistence/format";
import { regressionConfig, defaultRegression } from "./regression";
import { validateClusteringRecord } from "./clustering-validation";
import { JobGate } from "../workers/protocol";
function fixture(values = [0, 1, 9, 10]) {
  const dataset = experimentDataset(
    values.map((x, i) => ({ id: "r" + String(i).padStart(5, "0"), x, y: 0 })),
  );
  const state = workspaceReducer(createWorkspace(false), {
    type: "import",
    dataset,
  });
  const settings: ClusteringSettings = {
    ...defaultClustering(),
    features: ["x"],
    ks: [2],
    scaling: "none",
    initialization: "manual",
    manualCenters: [[0], [10]],
    restarts: 1,
  };
  const config = clusteringConfig(state.project.selection!, settings),
    plan = buildClusteringPlan(state.project, config);
  return { state, dataset, settings, config, plan };
}
function record(f = fixture()) {
  const r = runClustering(f.plan, f.settings);
  const a: AnalysisRecord = {
    ...createAnalysisRecord(f.config, "analysis-one", new Date().toISOString()),
    status: "completed",
    clustering: r,
    completedAt: new Date().toISOString(),
  };
  return { r, a };
}
const query: ClusterQuery = {
  candidate: 0,
  restart: null,
  iteration: null,
  phase: "final",
  x: "x",
  y: "",
  cluster: null,
  page: 0,
  rowId: null,
  region: null,
};
describe("K-means independent numerical cases", () => {
  it("hand computed 0,1,9,10: centers .5/9.5, SSE 1 and exact silhouettes", () => {
    const f = fixture(),
      { r } = record(f),
      a = r.candidates[0];
    expect(a.centers).toEqual([[0.5], [9.5]]);
    expect(a.counts).toEqual([2, 2]);
    expect(a.squaredDistances).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(a.clusterSse).toEqual([0.5, 0.5]);
    expect(a.sse).toBe(1);
    const expected = [17 / 19, 15 / 17, 15 / 17, 17 / 19];
    expected.forEach((v, i) =>
      expect(
        silhouettePoint([[0], [1], [9], [10]], a.labels, i, r.rowIds[i]).value,
      ).toBeCloseTo(v, 14),
    );
    expect(a.silhouette!.mean).toBeCloseTo(
      expected.reduce((a, b) => a + b) / 4,
      14,
    );
    expect(a.restarts[0].converged).toBe(true);
  });
  it("multiple dimensions and true means", () => {
    const f = fixture();
    f.settings.features = ["x", "y"];
    f.settings.manualCenters = [
      [0, 0],
      [10, 10],
    ];
    f.plan.table.columns.push({
      ...f.plan.table.columns[0],
      id: "y",
      name: "Y",
    });
    f.plan.table.rows.forEach((r, i) => (r.values.y = [0, 2, 8, 10][i]));
    const a = runClustering(f.plan, f.settings).candidates[0];
    expect(a.centers).toEqual([
      [0.5, 1],
      [9.5, 9],
    ]);
    expect(a.sse).toBe(5);
  });
  it("stable IDs, row sorting, seed and restarts", () => {
    const f = fixture([0, 1, 2, 8, 9, 10, 20, 21]);
    const s = {
      ...f.settings,
      initialization: "kmeans++" as const,
      restarts: 3,
    };
    const a = runClustering(f.plan, s);
    const reversed = {
      ...f.plan,
      table: { ...f.plan.table, rows: [...f.plan.table.rows].reverse() },
    };
    const b = runClustering(reversed, s);
    expect(a.candidates[0].labels).toEqual(b.candidates[0].labels);
    expect(a.candidates[0].restarts.map((r) => r.centers)).toEqual(
      b.candidates[0].restarts.map((r) => r.centers),
    );
    expect(a.candidates[0].restarts.map((r) => r.seed)).toEqual([
      42, 2654435803, 1013904268,
    ]);
    const tie = runClustering(fixture().plan, {
      ...fixture().settings,
      initialization: "kmeans++",
      restarts: 3,
    });
    expect(tie.candidates[0].bestRestart).toBe(0);
  });
  it("keeps repeated vectors and prevents k exceeding distinct vectors", () => {
    const f = fixture([0, 0, 10, 10]);
    const s = {
      ...f.settings,
      initialization: "kmeans++" as const,
      ks: [2, 3],
    };
    const r = runClustering(f.plan, s);
    expect(r.candidates[0].counts).toEqual([2, 2]);
    expect(r.candidates[0].sse).toBe(0);
    expect(r.candidates[1].error).toMatch(/서로 다른/);
    expect(r.rowIds).toHaveLength(4);
  });
  it("k=1 and k=N have undefined silhouette, no fake 0", () => {
    const f = fixture();
    const r = runClustering(f.plan, {
      ...f.settings,
      initialization: "random",
      ks: [1, 4],
    });
    expect(r.candidates[0].centers).toEqual([[5]]);
    expect(r.candidates[0].sse).toBe(82);
    expect(r.candidates[1].sse).toBe(0);
    for (const c of r.candidates) {
      expect(c.silhouette?.mean).toBeNull();
      expect(c.silhouette?.reason).toMatch(/정의/);
    }
  });
  it("singleton and zero distances are explicitly 0 within valid k range", () => {
    expect(silhouettePoint([[0], [0], [10]], [0, 0, 1], 2, "c").value).toBe(0);
    expect(silhouettePoint([[0], [0], [0]], [0, 0, 1], 0, "a").value).toBe(0);
    const p = silhouettePoint([[0], [1], [9], [10]], [0, 0, 1, 1], 0, "a");
    expect(p.a).toBe(1);
    expect(p.b).toBe(9.5);
    expect(p.sums).toEqual([1, 19]);
    expect(p.denominators).toEqual([1, 2]);
  });
  it("sample evaluation uses ALL reference members and shared sample across k", () => {
    const f = fixture([0, 1, 2, 8, 9, 10]);
    const s = {
      ...f.settings,
      initialization: "kmeans++" as const,
      ks: [2, 3],
      silhouette: { mode: "sample" as const, sampleSize: 1, seed: 23 },
    };
    const r = runClustering(f.plan, s);
    for (const a of r.candidates) {
      expect(a.silhouette!.evaluationRowIds).toEqual(r.evaluationRowIds);
      const i = r.rowIds.indexOf(r.evaluationRowIds[0]);
      const p = silhouettePoint(
        prepareClusters(f.plan, s).matrix,
        a.labels,
        i,
        r.rowIds[i],
      );
      expect(a.silhouette!.mean).toBe(p.value);
      expect(p.denominators.reduce((a, b) => a + b)).toBe(5);
      expect(
        a.silhouette!.clusters.some(
          (c) => c.evaluated === 0 && c.mean === null && !!c.reason,
        ),
      ).toBe(true);
    }
  });
  it("limits iteration without falsely reporting convergence; final nearest labels and SSE", () => {
    const f = fixture([0, 1, 2, 3, 10]);
    const r = runClustering(f.plan, {
        ...f.settings,
        manualCenters: [[0], [1]],
        maxIterations: 1,
      }),
      a = r.candidates[0];
    expect(a.restarts[0].converged).toBe(false);
    expect(a.restarts[0].reason).toMatch(/최대 반복/);
    expect(a.restarts[0].finalReassignment).toBe(true);
    expect(a.centers).toEqual([[0], [4]]);
    expect(a.labels).toEqual([0, 0, 0, 1, 1]);
    expect(a.squaredDistances).toEqual([0, 1, 4, 1, 36]);
    expect(a.sse).toBe(42);
  });
  it("resolves empty centers deterministically and stores events", () => {
    const f = fixture([0, 1, 9, 10]);
    const s = { ...f.settings, ks: [3], manualCenters: [[0], [0.1], [100]] };
    const r = runClustering(f.plan, s);
    expect(r.candidates[0].bestRestart).not.toBeNull();
    expect(
      r.candidates[0].restarts[0].history[0].events.length,
    ).toBeGreaterThan(0);
    expect(r.candidates[0].counts.every((v) => v > 0)).toBe(true);
  });
  it("all-missing, constants, invalid numeric and overflow are rejected", () => {
    const f = fixture();
    const missing = structuredClone(f.plan);
    missing.table.rows.forEach((r) => (r.values.x = null));
    expect(() =>
      runClustering(missing, { ...f.settings, missing: "mean" }),
    ).toThrow(/전부 결측/);
    expect(() =>
      runClustering(fixture([1, 1, 1]).plan, {
        ...f.settings,
        scaling: "zscore",
      }),
    ).toThrow(/상수/);
    for (const v of ["NA", Infinity, NaN]) {
      const p = structuredClone(f.plan);
      p.table.rows[0].values.x = v;
      expect(() => runClustering(p, f.settings)).toThrow();
    }
    const overflow = structuredClone(f.plan);
    overflow.table.rows[0].values.x = 1e308;
    expect(runClustering(overflow, f.settings).candidates[0].error).toMatch(
      /범위/,
    );
  });
  it("missing removal and mean imputation use scoped values, original unchanged", () => {
    const f = fixture(),
      before = JSON.stringify(f.plan);
    const p = structuredClone(f.plan);
    p.table.rows[1].values.x = null;
    const r = runClustering(p, { ...f.settings, missing: "mean" });
    expect(r.basis[0].fill).toBeCloseTo(19 / 3);
    expect(r.imputed[0].rowId).toBe("r00001");
    expect(runClustering(p, f.settings).excluded[0].rowId).toBe("r00001");
    expect(JSON.stringify(f.plan)).toBe(before);
  });
  it("manual centers use source units and the same scaling basis", () => {
    const f = fixture();
    const r = runClustering(f.plan, { ...f.settings, scaling: "minmax" });
    expect(r.candidates[0].centers[0][0]).toBeCloseTo(0.05);
    expect(r.candidates[0].centers[1][0]).toBeCloseTo(0.95);
    expect(r.basis[0].divisor).toBe(10);
  });
  it("rejects duplicate/manual dimensions and work/memory limits before calculation", () => {
    const f = fixture();
    expect(() =>
      runClustering(f.plan, { ...f.settings, manualCenters: [[0], [0]] }),
    ).toThrow(/서로 다른/);
    expect(() => checkClusterBudget(20001, f.settings)).toThrow(/20,000/);
    expect(() =>
      checkClusterBudget(20000, {
        ...f.settings,
        initialization: "random",
        ks: [20],
        maxIterations: 100,
        restarts: 10,
        silhouette: { ...f.settings.silhouette, mode: "none" },
      }),
    ).toThrow(/계산/);
    expect(() => checkClusterBudget(10000, f.settings)).toThrow(/실루엣/);
  });
});
describe("cluster inspection, state, backup and task boundaries", () => {
  it("numeric distributions share whole-input boundaries and never use a display sample", () => {
    const f = fixture(),
      { r } = record(f);
    const d = clusterDetail(f.dataset.versions[0], r, { ...query, cluster: 0 });
    const bins = d.distributions.find(
      (d) => d.attributeId === "x" && d.space === "observed",
    )!.bins;
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ lower: 0, upper: 1, selected: 1, all: 1 });
    expect(bins[9]).toEqual({ lower: 9, upper: 10, selected: 0, all: 2 });
    expect(bins.reduce((s, b) => s + b.selected, 0)).toBe(2);
  });
  it("missing values on a non-calculation display axis never invent a zero center", () => {
    const f = fixture(),
      { r } = record(f),
      table = structuredClone(f.dataset.versions[0]);
    table.rows.forEach(
      (row) => ((row.values as Record<string, number | null>).y = null),
    );
    const d = clusterDetail(table, r, { ...query, y: "y" });
    expect(d.marks).toHaveLength(0);
    expect(d.centers).toHaveLength(0);
    expect(d.total).toBe(4);
  });
  it("display axes and region query never change labels and find every overlapping row", () => {
    const f = fixture([0, 0, 10, 10]),
      { r } = record(f),
      before = JSON.stringify(r);
    const d = clusterDetail(f.dataset.versions[0], r, {
      ...query,
      region: { x0: 0, x1: 0, y0: 0, y1: 0 },
    });
    expect(d.matched).toBe(2);
    expect(d.rows.map((a) => a.rowId)).toEqual(["r00000", "r00001"]);
    clusterDetail(f.dataset.versions[0], r, { ...query, x: "y", y: "x" });
    expect(JSON.stringify(r)).toBe(before);
  });
  it("exact observed statistics and stage assignment versus updated mean", () => {
    const f = fixture(),
      { r } = record(f);
    const d = clusterDetail(f.dataset.versions[0], r, {
      ...query,
      cluster: 0,
      rowId: "r00000",
      iteration: 0,
      phase: "assignment",
    });
    expect(d.statistics.x.numeric?.mean).toBe(0.5);
    expect(d.statistics.x.numeric?.median).toBe(0.5);
    expect(d.overall.x.numeric?.mean).toBe(5);
    expect(d.point?.distances).toEqual([0, 10]);
    const after = clusterDetail(f.dataset.versions[0], r, {
      ...query,
      iteration: 0,
      phase: "update",
      rowId: "r00000",
    });
    expect(after.point?.distances).toEqual([0.5, 9.5]);
    expect(r.candidates[0].restarts[0].history[0].counts).toEqual([2, 2]);
  });
  it("empty selection remains empty; ID features rejected", () => {
    const f = fixture();
    expect(() =>
      buildClusteringPlan(
        f.state.project,
        clusteringConfig(f.config.source, {
          ...f.settings,
          scope: { ...f.settings.scope, kind: "selected", rowIds: [] },
        }),
      ),
    ).toThrow(/입력 행/);
    const state = structuredClone(f.state);
    (state.project.datasets[0].versions[0].columns[0] as any).semanticType =
      "identifier";
    expect(() => buildClusteringPlan(state.project, f.config)).toThrow(/수치/);
  });
  it("manual data original/history/undo/redo and analysis engine match general imported table", () => {
    const f = fixture();
    expect(f.dataset.source.kind).toBe("manual");
    expect(f.dataset.original.table.rows).toEqual(f.dataset.versions[0].rows);
    let state = workspaceReducer(f.state, { type: "undo" });
    expect(state.project.selection).toBeNull();
    state = workspaceReducer(state, { type: "redo" });
    expect(state.project.selection).toEqual(f.config.source);
    const plan: ClusteringPlan = structuredClone(f.plan);
    expect(runClustering(plan, f.settings).candidates[0].sse).toBe(1);
  });
  it("independent regression/clustering configurations, frozen snapshots, axes freshness", () => {
    const f = fixture();
    const reg = regressionConfig(f.config.source, defaultRegression());
    let state = workspaceReducer(f.state, {
      type: "analysis-config",
      config: reg,
    });
    state = workspaceReducer(state, {
      type: "analysis-config",
      config: f.config,
    });
    expect(Object.keys(state.project.analysisConfigs)).toHaveLength(2);
    const { a } = record(f);
    state = workspaceReducer(state, { type: "analysis-record", record: a });
    f.settings.seed = 99;
    expect(state.project.analyses[0].configSnapshot.randomness.seed).toBe(42);
    state = workspaceReducer(state, {
      type: "cluster-axes",
      id: a.id,
      x: "y",
      y: "x",
    });
    expect(
      getResultFreshness(state.project.analyses[0], f.config.source, f.config)
        .state,
    ).toBe("current");
    const config = clusteringConfig(f.config.source, {
      ...f.config.clustering,
      seed: 99,
    });
    expect(getResultFreshness(a, f.config.source, config).state).toBe("stale");
    expect(
      getResultFreshness(a, { ...f.config.source, versionId: "new" }, f.config)
        .state,
    ).toBe("stale");
    expect(
      state.project.analysisConfigs[
        analysisConfigKey(f.dataset.id, "regression")
      ].kind,
    ).toBe("regression");
  });
  it("comparison uses contingency instead of numeric label equality", () => {
    const f = fixture(),
      { r } = record(f),
      b = structuredClone(r);
    b.candidates[0].labels = b.candidates[0].labels.map((c) => 1 - c);
    const c = compareClusters(r, b);
    expect(c.comparable).toBe(true);
    expect(c.overlap).toEqual([
      [0, 2],
      [2, 0],
    ]);
    b.basis[0].divisor = 10;
    expect(compareClusters(r, b).comparable).toBe(false);
  });
  it("JSON round trip validates fixed stored centers without invoking clustering", () => {
    const f = fixture(),
      { a } = record(f);
    const state = workspaceReducer(f.state, {
      type: "analysis-record",
      record: a,
    });
    const restored = readBackup(JSON.stringify(makeBackup(state)), true);
    expect(restored.project.analyses[0].clustering).toEqual(a.clustering);
    expect(restored.project.id).not.toBe(state.project.id);
    expect(restored.project.schemaVersion).toBe(6);
    expect(Object.isFrozen(restored.project.analyses[0].clustering)).toBe(true);
  });
  it("schema 5 dataset keys migrate and prior regression records remain", () => {
    const f = fixture(),
      old: any = structuredClone(f.state);
    old.project.schemaVersion = 5;
    old.project.analysisConfigs = {
      [f.dataset.id]: regressionConfig(f.config.source, defaultRegression()),
    };
    const copy = validateWorkspace(old);
    expect(copy.project.schemaVersion).toBe(6);
    expect(
      copy.project.analysisConfigs[
        analysisConfigKey(f.dataset.id, "regression")
      ],
    ).toEqual(old.project.analysisConfigs[f.dataset.id]);
  });
  it("corrupt centers, labels, SSE, history, scope, basis, sample, termination are refused", () => {
    const f = fixture(),
      { a } = record(f);
    const mutations: ((a: AnalysisRecord) => void)[] = [
      (a) => (a.clustering!.candidates[0].centers[0][0] = 33),
      (a) => (a.clustering!.candidates[0].labels[0] = 9),
      (a) => (a.clustering!.candidates[0].sse = 0),
      (a) => (a.clustering!.rowIds[0] = "absent"),
      (a) => (a.clustering!.basis[0].divisor = 2),
      (a) =>
        (a.clustering!.candidates[0].restarts[0].history[0].after[0][0] = 2),
      (a) => (a.clustering!.evaluationRowIds = ["absent"]),
      (a) => (a.clustering!.candidates[0].silhouette!.mean = 1.2),
      (a) => (a.clustering!.candidates[0].restarts[0].converged = false),
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(a);
      mutate(copy);
      expect(() => validateClusteringRecord(copy, f.state.project)).toThrow();
    }
    expect(f.state.project.analyses).toHaveLength(0);
  });
  it("cancel/changed conditions reject old worker completion across job and scope", () => {
    const f = fixture(),
      g = new JobGate(),
      task = {
        kind: "clustering-run" as const,
        plan: f.plan,
        settings: f.settings,
      };
    const first = g.startTask("cluster", task);
    expect(g.invalidate("cluster")?.jobId).toBe(first.jobId);
    const next = g.startTask("cluster", task);
    let calls = 0;
    expect(
      g.receive(
        {
          type: "complete",
          jobId: first.jobId,
          scopeId: "cluster",
          result: null,
        },
        () => calls++,
      ),
    ).toBe(false);
    expect(
      g.receive(
        {
          type: "complete",
          jobId: next.jobId,
          scopeId: "another-project",
          result: null,
        },
        () => calls++,
      ),
    ).toBe(false);
    expect(calls).toBe(0);
  });
  it("running restore interrupted and frozen result cannot overwrite a completed record", () => {
    const f = fixture(),
      { a } = record(f);
    let state = workspaceReducer(f.state, {
      type: "analysis-record",
      record: a,
    });
    state = workspaceReducer(state, {
      type: "analysis-record",
      record: { ...a, status: "cancelled" },
    });
    expect(state.project.analyses[0].status).toBe("completed");
    state.project.analyses = [
      {
        ...createAnalysisRecord(f.config, "pending", new Date().toISOString()),
        status: "running",
      },
    ];
    state.view.clusterSelection = { current: "pending", comparison: null };
    const restored = validateWorkspace(state);
    expect(restored.project.analyses[0].status).toBe("cancelled");
    expect(snapshot(a).clustering?.candidates[0].sse).toBe(1);
  });
});
