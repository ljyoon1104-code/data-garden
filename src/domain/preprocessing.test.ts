import { canAppendTable, MAX_PRESERVED_CELLS } from "./limits";
import { createVersion, preserveOriginal } from "./model";
import { describe, it, expect } from "vitest";
import {
  fitPreprocessing,
  applyPreprocessing,
  previewPreprocessing,
  commitPreprocessing,
  preprocessingLineage,
  defaultPreprocessing,
  quantile,
} from "./preprocessing";
import type { Attribute, Cell, TableData } from "./types";
import type { PreprocessingSettings } from "./preprocessing-types";
import {
  createWorkspace,
  getSelection,
  workspaceReducer,
} from "../state/workspace";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
} from "../persistence/format";
import { createAnalysisRecord, getResultFreshness } from "./model";
import type { AnalysisConfig } from "./types";
const config = (): AnalysisConfig => ({
  kind: "regression",
  source: { datasetId: "sample-school-life", versionId: "sample-v1" },
  attributeIds: ["sleep"],
  parameters: {},
  preprocessing: { steps: [] },
  calculation: { missingValuePolicy: null, method: null, settings: {} },
  split: { method: "none", settings: {} },
  randomness: { seed: null, settings: {} },
});

const source = { datasetId: "d", versionId: "v" };
const column = (
  id: string,
  storageType: Attribute["storageType"] = "number",
  semanticType: Attribute["semanticType"] = "numeric",
): Attribute => ({
  id,
  name: id,
  storageType,
  semanticType,
  description: "",
  useInAnalysis: true,
});
const table = (
  values: Cell[][],
  columns = [column("x"), column("y")],
): TableData => ({
  columns,
  rows: values.map((v, i) => ({
    id: `r${i}`,
    values: Object.fromEntries(columns.map((c, j) => [c.id, v[j]])),
  })),
});
const missing = (
  method: "remove" | "mean" | "median" | "mode" | "fixed" = "remove",
  attributeIds = ["x"],
): PreprocessingSettings => ({
  kind: "missing",
  method,
  attributeIds,
  rowRule: "any",
  fixedValues: {},
});
const outlier = (patch: object = {}): PreprocessingSettings => ({
  kind: "outliers",
  attributeIds: ["x"],
  detection: "iqr",
  multiplier: 1.5,
  lower: 0,
  upper: 10,
  action: "mark",
  rowRule: "any",
  ...patch,
});
const scale = (
  method: "minmax" | "zscore" = "minmax",
): PreprocessingSettings => ({ kind: "scale", method, attributeIds: ["x"] });
function run(t: TableData, s: PreprocessingSettings) {
  return applyPreprocessing(t, fitPreprocessing(t, source, s));
}
const x = (t: TableData) => t.rows.map((r) => r.values.x);
describe("preprocessing independently calculated answers (absolute tolerance 1e-10)", () => {
  it("removes any/all missing rows and preserves spaces, NA, zero and false", () => {
    const t = table(
      [
        [null, 1],
        [1, ""],
        [null, ""],
        [" ", 0],
        ["NA", false],
      ],
      [column("x", "mixed", "text"), column("y", "mixed", "text")],
    );
    const s = missing("remove", ["x", "y"]);
    expect(run(t, s).removedRowIds).toEqual(["r0", "r1", "r2"]);
    expect(
      run(t, { ...s, rowRule: "all" } as PreprocessingSettings).removedRowIds,
    ).toEqual(["r2"]);
    expect(t.rows).toHaveLength(5);
  });
  it("replaces mean and median excluding missing; snapshots settings", () => {
    const t = table([[2], [4], [12], [null]], [column("x")]),
      s = missing("mean");
    const fit = fitPreprocessing(t, source, s);
    s.attributeIds = [];
    expect(fit.columns.x.replacement).toBe(6);
    expect(x(applyPreprocessing(t, fit).table)).toEqual([2, 4, 12, 6]);
    expect(x(run(t, missing("median")).table)).toEqual([2, 4, 12, 4]);
    expect(Object.isFrozen(fit.columns.x)).toBe(true);
  });
  it("uses first-in-fit-order mode tie and typed categories", () => {
    const t = table(
      [["b"], ["a"], ["a"], ["b"], [null]],
      [column("x", "string", "categorical")],
    );
    expect(x(run(t, missing("mode")).table)).toEqual(["b", "a", "a", "b", "b"]);
    expect(() => run(t, missing("mean"))).toThrow(/수치/);
  });
  it("validates fixed values, dates, boolean and all-missing columns without losing input", () => {
    const t = table([[null]], [column("x")]);
    for (const method of ["mean", "median", "mode"] as const)
      expect(() =>
        run(
          method === "mode"
            ? table([[null]], [column("x", "string", "categorical")])
            : t,
          missing(method),
        ),
      ).toThrow(/유효값/);
    expect(
      x(
        run(t, {
          ...missing("fixed"),
          fixedValues: { x: "3.5" },
        } as PreprocessingSettings).table,
      ),
    ).toEqual([3.5]);
    for (const value of ["NaN", "Infinity", "abc", ""])
      expect(() =>
        run(t, {
          ...missing("fixed"),
          fixedValues: { x: value },
        } as PreprocessingSettings),
      ).toThrow();
    const date = table([[null]], [column("x", "string", "date")]);
    expect(() =>
      run(date, {
        ...missing("fixed"),
        fixedValues: { x: "2026-02-30" },
      } as PreprocessingSettings),
    ).toThrow();
    expect(
      x(
        run(date, {
          ...missing("fixed"),
          fixedValues: { x: "2024-02-29" },
        } as PreprocessingSettings).table,
      ),
    ).toEqual(["2024-02-29"]);
    const bool = table(
      [[null], [false]],
      [column("x", "boolean", "categorical")],
    );
    expect(
      x(
        run(bool, {
          ...missing("fixed"),
          fixedValues: { x: "true" },
        } as PreprocessingSettings).table,
      ),
    ).toEqual([true, false]);
    expect(t.rows[0].values.x).toBeNull();
  });
  it("compares chosen columns and preserves first/last in version order with stable IDs", () => {
    const t = table(
      [
        [1, "a"],
        [1, "b"],
        [1, "a"],
        [2, "a"],
      ],
      [column("x"), column("y", "string", "categorical")],
    );
    const s: PreprocessingSettings = {
      kind: "duplicates",
      attributeIds: ["x"],
      keep: "first",
    };
    expect(run(t, s).table.rows.map((r) => r.id)).toEqual(["r0", "r3"]);
    expect(run(t, { ...s, keep: "last" }).table.rows.map((r) => r.id)).toEqual([
      "r2",
      "r3",
    ]);
    expect(run(t, { ...s, attributeIds: ["x", "y"] }).removedRowIds).toEqual([
      "r2",
    ]);
    const typed = table(
      [[null], [""], [1], ["1"], [false], [null], [""], [1], ["1"]],
      [column("x", "mixed", "text")],
    );
    expect(run(typed, s).table.rows.map((r) => r.id)).toEqual([
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
    ]);
  });
  it("uses interpolated quartiles, strict boundaries and all outlier methods", () => {
    // Sorted 1,2,3,4,100: Q1=2, Q3=4, IQR=2, bounds=-1,7.
    const t = table([[1], [2], [3], [4], [100], [null]], [column("x")]);
    const fit = fitPreprocessing(t, source, outlier());
    expect(fit.columns.x).toMatchObject({ q1: 2, q3: 4, lower: -1, upper: 7 });
    expect(quantile([0, 10, 20, 30], 0.25)).toBe(7.5);
    expect(run(t, outlier()).candidates.map((c) => c.rowId)).toEqual(["r4"]);
    expect(run(t, outlier()).changes).toEqual([]);
    expect(x(run(t, outlier({ action: "remove" })).table)).toEqual([
      1,
      2,
      3,
      4,
      null,
    ]);
    expect(x(run(t, outlier({ action: "missing" })).table)).toEqual([
      1,
      2,
      3,
      4,
      null,
      null,
    ]);
    expect(x(run(t, outlier({ action: "clip" })).table)).toEqual([
      1,
      2,
      3,
      4,
      7,
      null,
    ]);
    expect(x(run(t, outlier({ action: "median" })).table)).toEqual([
      1,
      2,
      3,
      4,
      2.5,
      null,
    ]);
    const edge = table([[-1], [7], [-2], [8], [null]], [column("x")]);
    expect(
      run(
        edge,
        outlier({ detection: "bounds", lower: -1, upper: 7 }),
      ).candidates.map((c) => c.rowId),
    ).toEqual(["r2", "r3"]);
  });
  it("checks multi-column row rules and rejects bad/no-normal bounds", () => {
    const t = table([
        [20, 1],
        [20, 20],
        [1, 1],
      ]),
      s = outlier({
        attributeIds: ["x", "y"],
        detection: "bounds",
        action: "remove",
      });
    expect(run(t, s).removedRowIds).toEqual(["r0", "r1"]);
    expect(
      run(t, { ...s, rowRule: "all" } as PreprocessingSettings).removedRowIds,
    ).toEqual(["r1"]);
    expect(() =>
      run(t, outlier({ detection: "bounds", lower: 5, upper: 1 })),
    ).toThrow(/하한/);
    expect(() =>
      run(
        t,
        outlier({ detection: "bounds", lower: 5, upper: 6, action: "median" }),
      ),
    ).toThrow(/정상 범위/);
    expect(() => run(t, outlier({ multiplier: -1 }))).toThrow(/배수/);
  });
  it("matches minmax and population zscores, retains missing without rounding", () => {
    const t = table([[2], [4], [6], [null]], [column("x")]);
    expect(x(run(t, scale()).table)).toEqual([0, 0.5, 1, null]);
    // Mean=4, population variance=8/3; endpoints are +/- sqrt(3/2).
    const v = x(run(t, scale("zscore")).table);
    expect(Math.abs((v[0] as number) + Math.sqrt(1.5))).toBeLessThan(1e-10);
    expect(v[1]).toBe(0);
    expect(Math.abs((v[2] as number) - Math.sqrt(1.5))).toBeLessThan(1e-10);
    expect(v[3]).toBeNull();
    const p = previewPreprocessing(t, source, scale("zscore"));
    expect(p.beforeStatistics.x.numeric?.stddev).toBe(2);
    expect(p.fitted.columns.x.stddev).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(p.changedCells).toBe(3);
  });
  it("rejects empty, constant, insufficient, overflow and nonnumeric inputs", () => {
    for (const values of [[], [[null]], [[1]], [[1], [1]], [[1e308], [-1e308]]])
      expect(() => run(table(values, [column("x")]), scale())).toThrow();
    for (const semantics of ["identifier", "categorical", "date"] as const)
      expect(() =>
        run(table([[1], [2]], [column("x", "number", semantics)]), scale()),
      ).toThrow(/수치/);
    const t = table([
      [1, 2],
      [2, 3],
    ]);
    t.columns[1].useInAnalysis = false;
    expect(defaultPreprocessing("scale", t).attributeIds).toEqual(["x"]);
  });
  it("fits only training rows and never refits or clips evaluation data", () => {
    const t = table([[0], [10], [100]], [column("x")]),
      s = scale();
    const fit = fitPreprocessing(t, source, s, {
      kind: "training",
      rowIds: ["r0", "r1"],
    });
    const frozen = JSON.stringify(fit);
    expect(
      x(
        applyPreprocessing(table([[-10], [20], [null]], [column("x")]), fit)
          .table,
      ),
    ).toEqual([-1, 2, null]);
    expect(
      x(applyPreprocessing(table([[1000]], [column("x")]), fit).table),
    ).toEqual([100]);
    expect(JSON.stringify(fit)).toBe(frozen);
    expect(fit.fitRows).toEqual({
      kind: "training",
      count: 2,
      rowIds: ["r0", "r1"],
    });
    const meanFit = fitPreprocessing(t, source, missing("mean"), {
      kind: "training",
      rowIds: ["r0", "r1"],
    });
    expect(
      x(
        applyPreprocessing(table([[999], [null]], [column("x")]), meanFit)
          .table,
      ),
    ).toEqual([999, 5]);
    expect(() =>
      fitPreprocessing(t, source, s, { kind: "training", rowIds: ["missing"] }),
    ).toThrow();
  });
});
describe("preprocessing version history, snapshots and restoration", () => {
  it("restores each processing method with its required fitted criteria", () => {
    const cases: [TableData, PreprocessingSettings][] = [
      [table([[1], [2], [9], [null]], [column("x")]), missing("mean")],
      [table([[1], [2], [9], [null]], [column("x")]), missing("median")],
      [table([[1], [null]], [column("x")]), missing("remove")],
      [
        table([["a"], ["b"], [null]], [column("x", "string", "categorical")]),
        missing("mode"),
      ],
      [
        table([[null]], [column("x", "string", "date")]),
        {
          ...missing("fixed"),
          fixedValues: { x: "2026-10-12" },
        } as PreprocessingSettings,
      ],
      ...(["remove", "missing", "clip", "median"] as const).map(
        (action) =>
          [
            table([[1], [2], [3], [4], [100]], [column("x")]),
            outlier({ action }),
          ] as [TableData, PreprocessingSettings],
      ),
    ];
    for (const [t, s] of cases) {
      const now = "2026-10-12T00:00:00Z",
        operation = {
          id: "import",
          kind: "import" as const,
          datasetId: "d",
          inputVersionIds: [],
          outputVersionIds: ["v"],
          settings: {},
          executedAt: now,
        };
      const v = createVersion(t, {
        id: "v",
        datasetId: "d",
        parentVersionIds: [],
        createdAt: now,
        operation,
      });
      let state = workspaceReducer(createWorkspace(false), {
        type: "import",
        dataset: {
          id: "d",
          name: "검증",
          source: { kind: "manual", label: "검증", importedAt: now },
          original: preserveOriginal(t),
          versions: [v],
        },
      });
      const fitted = fitPreprocessing(v, source, s),
        next = commitPreprocessing(v, source, fitted, {
          origin: source,
          previousOperationIds: [],
        })!;
      expect(next).not.toBeNull();
      state = workspaceReducer(state, {
        type: "commit-version",
        datasetId: "d",
        baseVersionId: "v",
        version: next,
      });
      const restored = readBackup(JSON.stringify(makeBackup(state)));
      expect(getSelection(restored).version?.operation.preprocessing).toEqual(
        next.operation.preprocessing,
      );
    }
  });
  function prepared() {
    let state = createWorkspace();
    const { dataset, version } = getSelection(state);
    const s: PreprocessingSettings = {
      kind: "scale",
      method: "minmax",
      attributeIds: ["sleep"],
    };
    const fitted = fitPreprocessing(version!, state.project.selection!, s);
    const next = commitPreprocessing(
      version!,
      state.project.selection!,
      fitted,
      preprocessingLineage(dataset!, version!.id),
    )!;
    state = workspaceReducer(state, {
      type: "commit-version",
      datasetId: dataset!.id,
      baseVersionId: version!.id,
      version: next,
    });
    return state;
  }
  it("creates one undo unit, preserves originals/IDs, serializes criteria and stales old analysis", () => {
    const state = prepared(),
      dataset = state.project.datasets[0],
      version = getSelection(state).version!;
    expect(dataset.original.table.rows[0].values.sleep).toBe(7.5);
    expect(dataset.versions[0].rows[0].values.sleep).toBe(7.5);
    expect(version.rows[0].id).toBe(dataset.versions[0].rows[0].id);
    expect(version.columns).toEqual(dataset.versions[0].columns);
    expect(state.project.history.entries).toHaveLength(1);
    const undo = workspaceReducer(state, { type: "undo" }),
      redo = workspaceReducer(undo, { type: "redo" });
    expect(getSelection(undo).version?.id).toBe("sample-v1");
    expect(redo.project.selection).toEqual(state.project.selection);
    const restored = readBackup(JSON.stringify(makeBackup(redo)));
    expect(restored.project.datasets[0].versions).toEqual(dataset.versions);
    expect(
      Object.isFrozen(
        getSelection(restored).version!.operation.preprocessing!.fitted.columns
          .sleep,
      ),
    ).toBe(true);
    const a = createAnalysisRecord(config(), "a", "2026-01-01T00:00:00Z");
    a.status = "completed";
    expect(getResultFreshness(a, state.project.selection, config()).state).toBe(
      "stale",
    );
  });
  it("keeps ordered lineage, rejects stale commits, and prunes deleted row selections", () => {
    let state = prepared();
    let { dataset, version } = getSelection(state);
    const settings: PreprocessingSettings = {
      kind: "duplicates",
      attributeIds: ["grade"],
      keep: "first",
    };
    const fitted = fitPreprocessing(
        version!,
        state.project.selection!,
        settings,
      ),
      lineage = preprocessingLineage(dataset!, version!.id);
    expect(lineage.origin.versionId).toBe("sample-v1");
    expect(lineage.previousOperationIds).toEqual([version!.operation.id]);
    const next = commitPreprocessing(
      version!,
      state.project.selection!,
      fitted,
      lineage,
    )!;
    state = workspaceReducer(state, {
      type: "table-view",
      datasetId: dataset!.id,
      patch: { page: 40, selectedRowIds: ["sample-row-1", "sample-row-2"] },
    });
    const committed = workspaceReducer(state, {
      type: "commit-version",
      datasetId: dataset!.id,
      baseVersionId: version!.id,
      version: next,
    });
    expect(committed.view.tables[dataset!.id].selectedRowIds).toEqual([
      "sample-row-1",
    ]);
    expect(committed.view.tables[dataset!.id].page).toBe(0);
    const restoredSelection = workspaceReducer(
      workspaceReducer(committed, { type: "undo" }),
      {
        type: "table-view",
        datasetId: dataset!.id,
        patch: { selectedRowIds: ["sample-row-2"], page: 30 },
      },
    );
    const redone = workspaceReducer(restoredSelection, { type: "redo" });
    expect(redone.view.tables[dataset!.id].selectedRowIds).toEqual([]);
    expect(redone.view.tables[dataset!.id].page).toBe(0);
    expect(
      validateWorkspace(committed).project.operations.at(-1)?.preprocessing
        ?.previousOperationIds,
    ).toEqual(lineage.previousOperationIds);
    expect(
      workspaceReducer(committed, {
        type: "commit-version",
        datasetId: dataset!.id,
        baseVersionId: version!.id,
        version: next,
      }),
    ).toBe(committed);
    expect(() =>
      commitPreprocessing(
        version!,
        { ...state.project.selection!, versionId: "changed" },
        fitted,
        lineage,
      ),
    ).toThrow(/버전/);
  });
  it("does not create versions for mark-only or unchanged replacements", () => {
    const state = createWorkspace(),
      { version, dataset } = getSelection(state),
      source = state.project.selection!;
    for (const s of [
      outlier({ attributeIds: ["sleep"] }),
      missing("mean", ["sleep"]),
    ])
      expect(
        commitPreprocessing(
          version!,
          source,
          fitPreprocessing(version!, source, s),
          preprocessingLineage(dataset!, version!.id),
        ),
      ).toBeNull();
  });
  it("migrates schema 2 without inventing preprocessing and rejects corrupted fitted records", () => {
    const old = JSON.parse(JSON.stringify(createWorkspace()));
    old.project.schemaVersion = 2;
    expect(validateWorkspace(old).project.schemaVersion).toBe(6);
    expect(old.project.schemaVersion).toBe(2);
    for (const mutate of [
      (r: any) => (r.fitted.settings.method = "unknown"),
      (r: any) => (r.fitted.settings.attributeIds = ["unknown"]),
      (r: any) => delete r.fitted.columns.sleep.stddev,
      (r: any) => (r.fitted.columns.sleep.stddev = 0),
      (r: any) => (r.fitted.columns.sleep.min = Infinity),
      (r: any) => (r.fitted.fitRows.rowIds[0] = "missing"),
      (r: any) => (r.fitted.fitRows.count = 999),
      (r: any) => (r.origin.versionId = "missing"),
      (r: any) => (r.previousOperationIds = ["missing"]),
      (r: any) => (r.removedRowIds = ["missing"]),
      (r: any) => (r.changedCells = 999),
    ]) {
      const state = JSON.parse(JSON.stringify(prepared())),
        op = state.project.operations.at(-1);
      mutate(op.preprocessing);
      state.project.datasets[0].versions.at(-1).operation = structuredClone(op);
      expect(() => validateWorkspace(state)).toThrow();
    }
  });
});

it("blocks a version exceeding the cumulative budget before committing", () => {
  const state = createWorkspace(),
    d = state.project.datasets[0],
    v = d.versions[0];
  // Metadata-only budget fixture: each entry represents a preserved 500,000-cell table.
  const table = {
    ...v,
    columns: Array(10).fill(v.columns[0]),
    rows: Array(50000).fill(v.rows[0]),
  };
  d.original = { table };
  d.versions = Array(5).fill(table);
  expect(MAX_PRESERVED_CELLS).toBe(3000000);
  expect(canAppendTable(state.project, 0, 10)).toBe(true);
  expect(canAppendTable(state.project, 1, 10)).toBe(false);
  const action = {
    type: "commit-version" as const,
    datasetId: d.id,
    baseVersionId: v.id,
    version: { ...v, id: "new", parentVersionIds: [v.id] },
  };
  expect(workspaceReducer(state, action)).toBe(state);
  expect(d.versions).toHaveLength(5);
});
