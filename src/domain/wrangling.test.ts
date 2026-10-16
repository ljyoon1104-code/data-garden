import { describe, it, expect } from "vitest";
import {
  fitWrangling,
  applyWrangling,
  commitWrangling,
  defaultWrangling,
  proposeStack,
  assertOutputSize,
} from "./wrangling";
import type { InputTable, WranglingSettings } from "./wrangling-types";
import type { Attribute, Cell, Dataset, TableData } from "./types";
import { createVersion, preserveOriginal } from "./model";
import {
  createWorkspace,
  workspaceReducer,
  getSelection,
  type WorkspaceState,
} from "../state/workspace";
import {
  validateWorkspace,
  makeBackup,
  readBackup,
} from "../persistence/format";
import { traceProcessing, attributeAncestors } from "./processing";
import {
  commitPreprocessing,
  fitPreprocessing,
  preprocessingLineage,
} from "./preprocessing";
import { MAX_PRESERVED_CELLS, preservedCellCount } from "./limits";
import { JobGate } from "../workers/protocol";

const col = (
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
function input(columns: Attribute[], values: Cell[][], id = "a"): InputTable {
  return {
    source: { datasetId: id, versionId: id + "-v" },
    name: id,
    table: {
      columns,
      rows: values.map((v, i) => ({
        id: id + "-r" + i,
        values: Object.fromEntries(columns.map((c, j) => [c.id, v[j]])),
      })),
    },
  };
}
const numeric = () =>
  input(
    [col("x"), col("y")],
    [
      [2, 4],
      [6, 0],
      [null, 8],
      [4, null],
    ],
  );
const config = <K extends WranglingSettings["kind"]>(
  kind: K,
  inputs: InputTable[],
) => defaultWrangling(kind, inputs) as Extract<WranglingSettings, { kind: K }>;
function output(i: InputTable[], s: WranglingSettings) {
  return applyWrangling(i, fitWrangling(i, s));
}
const added = (p: ReturnType<typeof output>, i = 0) =>
  p.table.rows.map((r) => r.values[p.fitted.columns[i].id]);
function dataset(i: InputTable): Dataset {
  const now = "2026-10-12T00:00:00.000Z",
    v = createVersion(i.table, {
      ...i.source,
      id: i.source.versionId,
      parentVersionIds: [],
      createdAt: now,
      operation: {
        id: i.source.datasetId + "-op",
        kind: "import",
        datasetId: i.source.datasetId,
        inputVersionIds: [],
        outputVersionIds: [i.source.versionId],
        settings: {},
        executedAt: now,
      },
    });
  return {
    id: i.source.datasetId,
    name: i.name,
    source: { kind: "manual", label: "검증", importedAt: now },
    original: preserveOriginal(structuredClone(i.table) as TableData),
    versions: [v],
  };
}
function workspace(inputs: InputTable[]) {
  let s = createWorkspace(false);
  for (const i of inputs)
    s = workspaceReducer(s, { type: "import", dataset: dataset(i) });
  return workspaceReducer(s, {
    type: "dataset",
    datasetId: inputs[0].source.datasetId,
  });
}
function applyState(
  state: WorkspaceState,
  inputs: InputTable[],
  s: WranglingSettings,
) {
  const r = commitWrangling(
    inputs,
    fitWrangling(inputs, s),
    MAX_PRESERVED_CELLS - preservedCellCount(state.project),
    true,
  );
  return workspaceReducer(
    state,
    r.dataset
      ? {
          type: "register-derived",
          dataset: r.dataset,
          expectedInputs: inputs.map((i) => i.source),
        }
      : {
          type: "commit-version",
          datasetId: inputs[0].source.datasetId,
          baseVersionId: inputs[0].source.versionId,
          version: r.version,
        },
  );
}
function selectedInput(s: WorkspaceState): InputTable {
  const { dataset: d, version: v } = getSelection(s);
  return {
    source: { datasetId: d!.id, versionId: v!.id },
    name: d!.name,
    table: v!,
  };
}

describe("structured calculations (independent answers, numeric tolerance 1e-12)", () => {
  it.each([
    ["add", 6],
    ["subtract", -2],
    ["multiply", 8],
    ["divide", 0.5],
    ["ratio", 0.5],
    ["percent", 50],
  ] as const)("%s", (operator, answer) => {
    const i = numeric(),
      s = config("calculate", [i]);
    s.operator = operator;
    s.operands = [
      { kind: "attribute", attributeId: "x" },
      { kind: "attribute", attributeId: "y" },
    ];
    const p = output([i], s);
    expect(added(p)[0]).toBeCloseTo(answer, 12);
    expect(added(p).slice(2)).toEqual([null, null]);
    if (["divide", "ratio", "percent"].includes(operator)) {
      expect(p.issues[0]).toMatchObject({ rowId: "a-r1", blocking: true });
      expect(() => commitWrangling([i], p.fitted, 3e6, false)).toThrow("오류");
    }
  });
  it("skip missing mean records valid counts; explicit invalid-to-null and overflow", () => {
    const i = numeric(),
      s = config("calculate", [i]);
    s.operator = "mean";
    s.operands = [
      { kind: "attribute", attributeId: "x" },
      { kind: "attribute", attributeId: "y" },
    ];
    s.missing = "skip";
    let p = output([i], s);
    expect(added(p)).toEqual([3, 3, 8, 4]);
    expect(p.summary.validOperandCounts).toEqual({
      "a-r0": 2,
      "a-r1": 2,
      "a-r2": 1,
      "a-r3": 1,
    });
    s.operator = "divide";
    s.missing = "propagate";
    s.invalid = "missing";
    p = output([i], s);
    expect(p.issues[0].blocking).toBe(false);
    expect(added(p)[1]).toBeNull();
    s.operator = "multiply";
    s.operands = [
      { kind: "constant", value: 1e308 },
      { kind: "constant", value: 1e308 },
    ];
    p = output([i], s);
    expect(added(p)).toEqual([null, null, null, null]);
    expect(p.issues.every((i) => i.message.includes("범위"))).toBe(true);
    s.operands[0] = { kind: "constant", value: Infinity };
    expect(() => fitWrangling([i], s)).toThrow();
  });
  it("all missing produces null, never 0; identifiers are not numeric operands", () => {
    const i = input([col("x")], [[null], [null]]),
      s = config("calculate", [i]);
    s.operator = "sum";
    s.operands = [{ kind: "attribute", attributeId: "x" }];
    s.missing = "skip";
    expect(added(output([i], s))).toEqual([null, null]);
    const id = input([col("x", "number", "identifier")], [[1]]);
    expect(() => fitWrangling([id], s)).toThrow("수치");
  });
});
describe("dates", () => {
  it("leap day, month end, quarter, weekday and missing time without local timezone conversion", () => {
    const i = input(
        [col("date", "string", "date")],
        [
          ["2024-02-29"],
          ["2024-03-31T23:59:58"],
          ["2025-01-01"],
          [null],
          ["2023-02-29"],
        ],
      ),
      s = config("date", [i]);
    s.parts = [
      "year",
      "month",
      "day",
      "quarter",
      "weekday",
      "hour",
      "minute",
      "second",
    ].map((part) => ({
      part: part as (typeof s.parts)[number]["part"],
      name: part,
      description: "",
      storageType: "number",
      semanticType: "categorical",
    }));
    s.invalid = "missing";
    const p = output([i], s);
    expect(p.fitted.columns.map((_, j) => added(p, j)[0])).toEqual([
      2024,
      2,
      29,
      1,
      4,
      null,
      null,
      null,
    ]);
    expect(p.fitted.columns.map((_, j) => added(p, j)[1])).toEqual([
      2024, 3, 31, 1, 7, 23, 59, 58,
    ]);
    expect(added(p, 4)[2]).toBe(3);
    expect(added(p).slice(3)).toEqual([null, null]);
    expect(p.issues.some((i) => i.rowId === "a-r4")).toBe(true);
  });
});
describe("fixed encoders and bin boundaries", () => {
  it("typed categories, manual order, missing and fixed unknown policy", () => {
    const i = input(
        [col("c", "mixed", "categorical")],
        [[1], ["1"], [" A"], ["a"], [null], [""]],
      ),
      s = config("encode", [i]);
    s.order = ["a", " A", "1", 1];
    s.unknown = "missing";
    const f = fitWrangling([i], s);
    expect(added(applyWrangling([i], f))).toEqual([3, 2, 1, 0, null, null]);
    expect(f.columns[0].semanticType).toBe("categorical");
    const other = input(i.table.columns as Attribute[], [["new"], [1]], "new");
    const p = applyWrangling([other], f);
    expect(added(p)).toEqual([null, 3]);
    expect(p.fitted).toEqual(f);
    expect(p.issues[0].message).toContain("미등록");
  });
  it("onehot baseline versus unknown, original preserved, collision names, fit training only", () => {
    const i = input(
        [col("c", "string", "categorical"), col("범주 코드 · string:A")],
        [
          ["A", 5],
          ["B", 6],
          ["C", 7],
          [null, 8],
        ],
      ),
      s = config("encode", [i]);
    s.method = "onehot";
    s.dropBaseline = true;
    s.baseline = "B";
    s.unknown = "missing";
    const f = fitWrangling([i], s, {
      kind: "training",
      rowIds: ["a-r0", "a-r1"],
    });
    expect(f.columns).toHaveLength(1);
    expect(f.columns[0].name).toBe("범주 코드 · string:A (2)");
    const p = applyWrangling([i], f);
    expect(added(p)).toEqual([1, 0, null, null]);
    expect(p.table.rows[0].values.c).toBe("A");
    expect(f.fitScopes[0].count).toBe(2);
  });
  it("cardinality/column limits checked before materializing rows", () => {
    const i = input(
      [col("c", "string", "categorical")],
      Array.from({ length: 200 }, (_, n) => ["c" + n]),
    );
    const s = config("encode", [i]);
    s.method = "onehot";
    expect(() => fitWrangling([i], s)).toThrow("한도");
  });
  it("equal width boundaries and max inclusion, names do not affect intervals", () => {
    const i = input([col("x")], [[0], [2], [4], [6], [8], [10], [null]]),
      s = config("bin", [i]);
    s.count = 2;
    s.labels = ["낮음", "높음"];
    const p = output([i], s);
    expect(p.fitted.basis).toMatchObject({
      boundaries: [0, 5, 10],
      counts: [3, 3],
    });
    expect(added(p)).toEqual([
      "낮음",
      "낮음",
      "낮음",
      "높음",
      "높음",
      "높음",
      null,
    ]);
    s.labels = ["L", "H"];
    expect(output([i], s).fitted.basis).toMatchObject({
      boundaries: [0, 5, 10],
    });
  });
  it("linear quantiles merge tied boundaries; identical values always same category", () => {
    const i = input([col("x")], [[0], [0], [0], [0], [0], [10], [10], [10]]),
      s = config("bin", [i]);
    s.count = 4;
    s.method = "frequency";
    s.labels = ["A", "B", "C", "D"];
    const p = output([i], s);
    expect(p.fitted.basis).toMatchObject({
      boundaries: [0, 10],
      labels: ["A"],
      counts: [8],
    });
    expect(new Set(added(p)).size).toBe(1);
    expect(p.warnings.join()).toContain("실제 1개");
  });
  it("fit/apply never widens boundaries, constants fail, schema mismatch fails", () => {
    const i = input([col("x")], [[0], [5], [10]]),
      s = config("bin", [i]);
    s.count = 2;
    s.labels = ["a", "b"];
    const f = fitWrangling([i], s, {
      kind: "training",
      rowIds: ["a-r0", "a-r1"],
    });
    const p = applyWrangling([i], f);
    expect(f.basis).toMatchObject({ boundaries: [0, 2.5, 5] });
    expect(added(p)).toEqual(["a", "b", null]);
    expect(p.fitted).toEqual(f);
    expect(() => fitWrangling([input([col("x")], [[1], [1]])], s)).toThrow(
      "상수",
    );
    expect(() =>
      applyWrangling([input([col("x", "number", "categorical")], [[1]])], f),
    ).toThrow("저장형");
  });
});
describe("joins, stacking, aggregation", () => {
  const pair = () => [
    input(
      [col("k", "string", "identifier"), col("x")],
      [
        ["01", 1],
        ["01", 2],
        ["2", 3],
        [null, 4],
        ["", 5],
      ],
    ),
    input(
      [col("k", "string", "identifier"), col("y")],
      [
        ["01", 10],
        ["01", 20],
        ["3", 30],
        [null, 40],
        ["", 50],
      ],
      "b",
    ),
  ];
  it.each([
    ["inner", 4],
    ["left", 7],
    ["full", 10],
  ] as const)(
    "%s preserves actual combinations and unmatched keys",
    (mode, count) => {
      const inputs = pair(),
        s = config("join", inputs);
      s.mode = mode;
      const p = output(inputs, s);
      expect(p.table.rows).toHaveLength(count);
      expect(p.summary).toMatchObject({
        manyToManyGroups: 1,
        matchedLeft: 2,
        matchedRight: 2,
        unmatchedLeft: 3,
        unmatchedRight: 3,
      });
      expect(() => commitWrangling(inputs, p.fitted, 3e6, false)).toThrow(
        "다대다",
      );
      if (mode === "full") {
        expect(p.table.rows[7].values[p.fitted.columns[2].id]).toBe("3");
        expect(p.rowSources[p.table.rows[7].id]).toEqual([
          { input: 1, rowIds: ["b-r2"] },
        ]);
      }
      expect(new Set(p.table.rows.map((r) => r.id)).size).toBe(count);
    },
  );
  it("composite keys distinguish type, zeros, whitespace and case", () => {
    const cols = [
        col("k", "mixed", "identifier"),
        col("group", "string", "categorical"),
      ],
      inputs = [
        input(cols, [
          [1, "a"],
          ["1", "a"],
          ["01", "a"],
          ["1", "A"],
          ["1 ", "a"],
          ["1", "b"],
        ]),
        input(
          cols,
          [
            ["1", "a"],
            ["01", "a"],
            ["1", "b"],
          ],
          "b",
        ),
      ],
      s = config("join", inputs);
    s.mode = "inner";
    s.keys = [
      { left: "k", right: "k" },
      { left: "group", right: "group" },
    ];
    expect(output(inputs, s).table.rows).toHaveLength(3);
  });
  it("many-to-many size is rejected before allocation and cell limit includes headers", () => {
    const a = input(
        [col("k")],
        Array.from({ length: 230 }, () => [1]),
      ),
      b = input(
        [col("k")],
        Array.from({ length: 230 }, () => [1]),
        "b",
      );
    expect(() => output([a, b], config("join", [a, b]))).toThrow(
      "예상 출력 52,900행",
    );
    expect(() => assertOutputSize(50000, 10)).toThrow("머리글");
    expect(() => assertOutputSize(49999, 10)).not.toThrow();
  });
  it("stack name-based proposal, input order, absent fields, duplicate rows and explicit mixed types", () => {
    const inputs = [
        input(
          [col("x"), col("code", "string", "identifier")],
          [
            [1, "001"],
            [1, "001"],
          ],
        ),
        input(
          [
            col("code", "number", "identifier"),
            col("extra", "boolean", "categorical"),
          ],
          [[2, true]],
          "b",
        ),
      ],
      s = proposeStack(inputs);
    expect(() => output(inputs, s)).toThrow("저장형");
    s.typeConflict = "mixed";
    const p = output(inputs, s);
    expect(
      p.table.rows.map((r) => p.table.columns.map((c) => r.values[c.id])),
    ).toEqual([
      [1, "001", null],
      [1, "001", null],
      [null, 2, true],
    ]);
    expect(p.table.columns[1]).toMatchObject({
      storageType: "mixed",
      semanticType: "text",
    });
    expect(p.rowSources[p.table.rows[2].id]).toEqual([
      { input: 1, rowIds: ["b-r0"] },
    ]);
  });
  it("group answers, row versus valid count, missing groups and all missing sum", () => {
    const i = input(
        [col("g", "string", "categorical"), col("x")],
        [
          ["a", 1],
          ["a", 2],
          ["a", null],
          ["b", null],
          [null, 5],
          ["", 7],
        ],
      ),
      s = config("aggregate", [i]);
    s.groupIds = ["g"];
    s.aggregates = (
      ["rows", "valid", "sum", "mean", "min", "max", "median"] as const
    ).map((method) => ({
      method,
      attributeId: method === "rows" ? null : "x",
      name: method,
      description: "",
    }));
    const p = output([i], s),
      rows = p.table.rows.map((r) =>
        p.table.columns.map((c) => r.values[c.id]),
      );
    expect(rows[0]).toEqual(["a", 3, 2, 3, 1.5, 1, 2, 1.5]);
    expect(rows[1]).toEqual(["b", 1, 0, null, null, null, null, null]);
    expect(rows).toHaveLength(4);
    expect(p.rowSources[p.table.rows[0].id][0].rowIds).toEqual([
      "a-r0",
      "a-r1",
      "a-r2",
    ]);
    s.includeMissing = false;
    expect(output([i], s).table.rows).toHaveLength(2);
  });
});
describe("versions, provenance, persistence and atomic registration", () => {
  it("branching after derived undo keeps historical records and cuts only redo", () => {
    const i = numeric(),
      before = workspace([i]),
      s = config("aggregate", [i]);
    s.groupIds = ["x"];
    const derived = applyState(before, [i], s),
      oldDataset = getSelection(derived).dataset!;
    const undone = workspaceReducer(derived, { type: "undo" }),
      branched = applyState(undone, [i], config("calculate", [i]));
    expect(branched.project.datasets.some((d) => d.id === oldDataset.id)).toBe(
      true,
    );
    expect(branched.project.activeVersions[oldDataset.id]).toBeNull();
    expect(workspaceReducer(branched, { type: "redo" })).toBe(branched);
    expect(() => validateWorkspace(branched)).not.toThrow();
  });
  it("wrong numeric values block; missing policy preserves input values", () => {
    const i = input([col("x")], [["wrong"], [4]]),
      s = config("calculate", [i]);
    expect(output([i], s).issues[0].blocking).toBe(true);
    s.invalid = "missing";
    const p = output([i], s);
    expect(p.table.rows[0].values.x).toBe("wrong");
    expect(added(p)).toEqual([null, 5]);
  });
  it("single edits preserve original/previous versions; undo redo and backup retain everything", () => {
    const i = numeric(),
      before = workspace([i]),
      s = config("calculate", [i]);
    const after = applyState(before, [i], s);
    expect(before.project.datasets[0].versions).toHaveLength(1);
    expect(after.project.datasets[0].original).toEqual(
      before.project.datasets[0].original,
    );
    expect(after.project.history.cursor).toBe(2);
    const undo = workspaceReducer(after, { type: "undo" });
    expect(undo.project.selection).toEqual(i.source);
    const redo = workspaceReducer(undo, { type: "redo" });
    expect(redo.project.selection).toEqual(after.project.selection);
    expect(readBackup(JSON.stringify(makeBackup(redo)))).toEqual(redo);
    expect(getSelection(redo).version!.rows.map((r) => r.id)).toEqual(
      i.table.rows.map((r) => r.id),
    );
  });
  it("derived dataset uses fresh IDs, preserves two copies, inactive sources remain valid on restore", () => {
    const inputs = [numeric(), input([col("x"), col("y")], [[9, 8]], "b")],
      before = workspace(inputs),
      after = applyState(before, inputs, proposeStack(inputs));
    const derived = getSelection(after).dataset!;
    expect(derived.source.kind).toBe("derived");
    expect(derived.original.table.rows).toEqual(derived.versions[0].rows);
    expect(
      preservedCellCount(after.project) - preservedCellCount(before.project),
    ).toBe(5 * 2 * 2);
    expect(derived.id).not.toBe("a");
    const archived = structuredClone(after);
    archived.project.activeVersions.a = null;
    archived.project.history = { cursor: 0, entries: [] };
    expect(() => validateWorkspace(archived)).not.toThrow();
    const undo = workspaceReducer(after, { type: "undo" });
    expect(undo.project.activeVersions[derived.id]).toBeNull();
    expect(readBackup(JSON.stringify(makeBackup(undo)))).toEqual(undo);
  });
  it("interleaved preprocessing/calculate/date lineage preserves all steps and dependencies", () => {
    const i = numeric();
    let state = workspace([i]);
    const preprocess = () => {
      const before = selectedInput(state),
        d = getSelection(state).dataset!,
        settings = {
          kind: "missing" as const,
          attributeIds: ["x"],
          method: "fixed" as const,
          fixedValues: { x: "2" },
          rowRule: "any" as const,
        },
        version = commitPreprocessing(
          before.table,
          before.source,
          fitPreprocessing(before.table, before.source, settings),
          preprocessingLineage(d, before.source.versionId),
        );
      if (version)
        state = workspaceReducer(state, {
          type: "commit-version",
          datasetId: d.id,
          baseVersionId: before.source.versionId,
          version,
        });
    };
    preprocess();
    let inp = selectedInput(state);
    state = applyState(state, [inp], config("calculate", [inp]));
    inp = selectedInput(state);
    const scale = {
        kind: "scale" as const,
        attributeIds: ["x"],
        method: "minmax" as const,
      },
      v = commitPreprocessing(
        inp.table,
        inp.source,
        fitPreprocessing(inp.table, inp.source, scale),
        preprocessingLineage(
          getSelection(state).dataset!,
          inp.source.versionId,
        ),
      )!;
    state = workspaceReducer(state, {
      type: "commit-version",
      datasetId: "a",
      baseVersionId: inp.source.versionId,
      version: v,
    });
    expect(
      traceProcessing(state.project, state.project.selection!).steps.map(
        (v) => v.operation.kind,
      ),
    ).toEqual(["import", "preprocess", "wrangle", "preprocess"]);
    const resultCol = getSelection(state).version!.columns.at(-1)!;
    expect(
      attributeAncestors(state.project, state.project.selection!, resultCol.id),
    ).toEqual([{ ...i.source, attributeId: "x" }]);
    expect(() => validateWorkspace(state)).not.toThrow();
  });
  it("aggregate joined back traces the statistic scope and target attribute", () => {
    const i = input(
      [col("g", "string", "categorical"), col("target")],
      [
        ["a", 2],
        ["a", 4],
      ],
    );
    let state = workspace([i]);
    const s = config("aggregate", [i]);
    s.groupIds = ["g"];
    s.aggregates = [
      {
        method: "mean",
        attributeId: "target",
        name: "group mean",
        description: "",
      },
    ];
    state = applyState(state, [i], s);
    const aggregate = selectedInput(state),
      j = config("join", [i, aggregate]);
    j.keys = [{ left: "g", right: aggregate.table.columns[0].id }];
    state = applyState(state, [i, aggregate], j);
    const outputCol = getSelection(state).version!.columns.at(-1)!;
    expect(
      attributeAncestors(
        state.project,
        state.project.selection!,
        outputCol.id,
      ).some((a) => a.attributeId === "target"),
    ).toBe(true);
    const steps = traceProcessing(
      state.project,
      state.project.selection!,
    ).steps;
    expect(steps.map((v) => v.operation.kind)).toEqual([
      "import",
      "wrangle",
      "wrangle",
    ]);
    expect(steps[1].operation.wrangling!.fitted.fitScopes[0].count).toBe(2);
    expect(() => validateWorkspace(state)).not.toThrow();
  });
  it.each([
    "input",
    "basis",
    "row",
    "column",
    "output",
    "cycle",
    "settings",
  ] as const)("rejects corrupt %s without weakening legacy checks", (what) => {
    const i = input([col("x")], [[0], [5], [10]]),
      after = applyState(workspace([i]), [i], config("bin", [i])),
      bad = structuredClone(after) as any,
      v = bad.project.datasets[0].versions.at(-1),
      r = v.operation.wrangling;
    if (what === "input") r.inputs[0].datasetId = "missing";
    if (what === "basis") r.fitted.basis.boundaries[1] = 123;
    if (what === "row") r.rowSources[v.rows[0].id][0].rowIds = ["absent"];
    if (what === "column")
      r.fitted.columnSources[r.fitted.columns[0].id] = [
        { input: 0, attributeId: "absent" },
      ];
    if (what === "output") r.output.versionId = "absent";
    if (what === "cycle") {
      r.inputs[0].versionId = v.id;
      r.fitted.inputs[0].versionId = v.id;
    }
    if (what === "settings") r.fitted.settings.method = "arbitrary";
    bad.project.operations[bad.project.operations.length - 1] = structuredClone(
      v.operation,
    );
    expect(() => validateWorkspace(bad)).toThrow();
  });
  it("stale secondary input, insufficient cumulative budget and cancelled response cannot commit", () => {
    const inputs = [numeric(), input([col("x"), col("y")], [[1, 2]], "b")],
      state = workspace(inputs),
      r = commitWrangling(
        inputs,
        fitWrangling(inputs, proposeStack(inputs)),
        3e6,
        true,
      );
    let stale = structuredClone(state);
    stale.project.activeVersions.b = null;
    expect(
      workspaceReducer(stale, {
        type: "register-derived",
        dataset: r.dataset!,
        expectedInputs: inputs.map((i) => i.source),
      }),
    ).toBe(stale);
    expect(() =>
      commitWrangling(inputs, r.version.operation.wrangling!.fitted, 19, true),
    ).toThrow("300만");
    const full = structuredClone(state);
    full.project.datasets[0].original = preserveOriginal({
      columns: Array.from({ length: 200 }, (_, i) => col("c" + i)),
      rows: Array.from({ length: 15000 }, (_, i) => ({
        id: "budget" + i,
        values: {},
      })),
    } as TableData);
    expect(
      workspaceReducer(full, {
        type: "register-derived",
        dataset: r.dataset!,
        expectedInputs: inputs.map((i) => i.source),
      }),
    ).toBe(full);
    const gate = new JobGate(),
      old = gate.startTask("wrangling", {
        kind: "wrangle-preview",
        inputs,
        settings: proposeStack(inputs),
        remaining: 3e6,
      });
    gate.invalidate("wrangling");
    let changed = false;
    expect(
      gate.receive(
        {
          type: "complete",
          jobId: old.jobId,
          scopeId: old.scopeId,
          result: null,
        },
        () => {
          changed = true;
        },
      ),
    ).toBe(false);
    expect(changed).toBe(false);
  });
  it.each([1, 2, 3])(
    "migrates schema %i to 4 without rewriting old operations",
    (schema) => {
      const old = structuredClone(createWorkspace()) as any;
      old.project.schemaVersion = schema;
      const records = JSON.stringify(old.project.operations);
      expect(validateWorkspace(old).project.schemaVersion).toBe(6);
      expect(JSON.stringify(old.project.operations)).toBe(records);
    },
  );
});
