import { describe, it, expect } from "vitest";
import {
  defaultAssociation,
  associationConfig,
  associationInput,
  prepareTransactions,
  runAssociation,
  parseItemList,
  supportCount,
  confidencePass,
  defaultAssociationView,
  associationDetail,
  compareAssociations,
  nextCandidates,
  associationLimits,
} from "./association";
import type {
  AssociationSettings,
  AssociationInput,
} from "./association-types";
import type { Cell, Dataset, TableData, AnalysisRecord } from "./types";
import {
  preserveOriginal,
  createVersion,
  createAnalysisRecord,
  snapshot,
  getResultFreshness,
} from "./model";
import { createWorkspace, workspaceReducer } from "../state/workspace";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
} from "../persistence/format";
import {
  validateAssociationRecord,
  associationValidationBudget,
} from "./association-validation";
import { JobGate } from "../workers/protocol";
import { analysisConfigKey } from "./clustering";

function fixture(
  values: Cell[][] = [["A,B,C,D"], ["A,B,C,D"], ["A,B,C"], ["A"], [""], [null]],
  patch: Partial<AssociationSettings> = {},
) {
  const now = "2026-10-16T00:00:00.000Z";
  const table: TableData = {
    columns: Array.from({ length: values[0]?.length ?? 1 }, (_, i) => ({
      id: "c" + i,
      name: "열" + i,
      storageType: "mixed",
      semanticType: "categorical",
      description: "",
      useInAnalysis: true,
    })),
    rows: values.map((row, i) => ({
      id: "r" + String(i + 1).padStart(4, "0"),
      values: Object.fromEntries(row.map((v, j) => ["c" + j, v])),
    })),
  };
  const source = { datasetId: "association-fixture", versionId: "v1" };
  const version = createVersion(table, {
    id: "v1",
    datasetId: source.datasetId,
    parentVersionIds: [],
    createdAt: now,
    operation: {
      id: "o1",
      kind: "import",
      datasetId: source.datasetId,
      inputVersionIds: [],
      outputVersionIds: ["v1"],
      settings: {},
      executedAt: now,
    },
  });
  const dataset: Dataset = {
    id: source.datasetId,
    name: "연관 검증",
    source: { kind: "manual", label: "손계산", importedAt: now },
    original: preserveOriginal(table),
    versions: [version],
  };
  let state = workspaceReducer(createWorkspace(false), {
    type: "import",
    dataset,
  });
  const settings = {
    ...defaultAssociation(),
    columns: ["c0"],
    supportPercent: "30",
    confidencePercent: "0",
    ...patch,
  };
  const config = associationConfig(source, settings);
  state = workspaceReducer(state, { type: "analysis-config", config });
  return {
    table,
    source,
    dataset,
    settings,
    config,
    state,
    input: { source, table } as AssociationInput,
  };
}
function record(f = fixture()) {
  const result = runAssociation(f.input, f.settings);
  const record: AnalysisRecord = {
    ...createAnalysisRecord(f.config, "a1", "2026-10-16T00:00:00.000Z"),
    status: "completed",
    completedAt: "2026-10-16T00:00:01.000Z",
    association: result,
  };
  const state = workspaceReducer(f.state, { type: "analysis-record", record });
  return { ...f, result, record, state };
}
const findRule = (
  r: ReturnType<typeof runAssociation>,
  a: string[],
  b: string[],
) => {
  const ids = (labels: string[]) =>
    labels
      .map((label) => r.prepared.items.find((i) => i.label === label)!.id)
      .sort();
  return r.rules.find(
    (rule) =>
      JSON.stringify(rule.antecedent) === JSON.stringify(ids(a)) &&
      JSON.stringify(rule.consequent) === JSON.stringify(ids(b)),
  )!;
};
describe("association transaction definitions", () => {
  it("six independent transactions preserve duplicate baskets and two known empty transactions", () => {
    const f = fixture(),
      p = prepareTransactions(f.input, f.settings);
    expect(p.transactions).toHaveLength(6);
    expect(p.emptyCount).toBe(2);
    expect(p.sizeDistribution).toEqual([
      { size: 0, count: 2 },
      { size: 1, count: 1 },
      { size: 3, count: 1 },
      { size: 4, count: 2 },
    ]);
  });
  it("strict quoted separators, Korean, escaped quotes, newline and disabled quotes", () => {
    expect(
      parseItemList('"사과,배","줄\n바꿈","따""옴", 공백 ', ",", true),
    ).toEqual(["사과,배", "줄\n바꿈", '따"옴', " 공백 "]);
    expect(parseItemList('"A,B"', ",", false)).toEqual(['"A', 'B"']);
    for (const bad of ['"A', 'A"B', '"A" B'])
      expect(() => parseItemList(bad, ",", true)).toThrow(/따옴표/);
  });
  it("malformed list identifies the original row and remedy", () => {
    const f = fixture([['"A']]);
    expect(() => prepareTransactions(f.input, f.settings)).toThrow(
      /r0001.*열0.*수정/,
    );
  });
  it("normalization is opt-in, merged values and within-basket duplicates are disclosed", () => {
    const f = fixture([["A, a ,a,A"]]);
    expect(prepareTransactions(f.input, f.settings).items).toHaveLength(3);
    const p = prepareTransactions(f.input, {
      ...f.settings,
      trim: true,
      foldCase: true,
    });
    expect(p.items).toHaveLength(1);
    expect(p.duplicatesRemoved).toBe(3);
    expect(p.merges[0].originals).toEqual(["A", " a ", "a"]);
  });
  it("slots retain numeric/string/boolean and leading zeros", () => {
    const f = fixture([[1, "1", true, "001"]], {
      columns: ["c0", "c1", "c2", "c3"],
      listMode: "slots",
    });
    const p = prepareTransactions(f.input, f.settings);
    expect(p.items).toHaveLength(4);
    expect(new Set(p.items.map((i) => i.id)).size).toBe(4);
  });
  it("vertical grouping keeps typed IDs distinct and extends selected IDs to full transactions", () => {
    const f = fixture(
      [
        ["001", "A"],
        ["001", "B"],
        [1, "C"],
        ["1", "D"],
      ],
      {
        format: "vertical",
        columns: ["c1"],
        transactionId: "c0",
        scope: {
          kind: "selected",
          rowIds: ["r0001"],
          filter: null,
          duplicatesOnly: false,
        },
      },
    );
    const p = prepareTransactions(f.input, f.settings);
    expect(p.scopeRowIds).toEqual(["r0001"]);
    expect(p.includedRows).toBe(2);
    expect(p.transactions[0].rowIds).toEqual(["r0001", "r0002"]);
    expect(p.items.map((i) => i.label)).toEqual(["A", "B"]);
    expect(
      prepareTransactions(f.input, {
        ...f.settings,
        scope: { ...f.settings.scope, kind: "all" },
      }).transactions,
    ).toHaveLength(3);
  });
  it("vertical filter expands complete transactions with partial item matches", () => {
    const f = fixture(
      [
        ["x", "A"],
        ["x", "B"],
        ["y", "C"],
      ],
      {
        format: "vertical",
        columns: ["c1"],
        transactionId: "c0",
        scope: {
          kind: "filtered",
          filter: { attributeId: "c1", operator: "equals", value: "A" },
          rowIds: [],
          duplicatesOnly: false,
        },
      },
    );
    f.table.columns[1].storageType = "string";
    const p = prepareTransactions(f.input, f.settings);
    expect(p.scopeRowIds).toHaveLength(1);
    expect(p.transactions[0].items).toHaveLength(2);
  });
  it("missing transaction IDs block or explicitly exclude only those rows", () => {
    const f = fixture(
      [
        [null, "A"],
        ["x", "B"],
      ],
      { format: "vertical", columns: ["c1"], transactionId: "c0" },
    );
    expect(() => prepareTransactions(f.input, f.settings)).toThrow(/거래 ID/);
    const p = prepareTransactions(f.input, {
      ...f.settings,
      missingId: "exclude",
    });
    expect(p.transactions).toHaveLength(1);
    expect(p.excluded[0].rowIds).toEqual(["r0001"]);
  });
  it("binary uses actual value types, not truthiness", () => {
    const f = fixture(
      [
        [true, 1, "예"],
        [false, 0, "아니오"],
      ],
      {
        format: "binary",
        columns: ["c0", "c1", "c2"],
        presentValues: [true, 1, "예"],
        absentValues: [false, 0, "아니오"],
      },
    );
    const p = prepareTransactions(f.input, f.settings);
    expect(p.transactions.map((t) => t.items.length)).toEqual([3, 0]);
    expect(p.items).toHaveLength(3);
    const bad = fixture([["false"]], { format: "binary" });
    expect(() => prepareTransactions(bad.input, bad.settings)).toThrow(
      /미등록/,
    );
  });
  it("unknowns are not silent absences; all policies preserve their reasons", () => {
    const f = fixture([[true], [null], ["?"]], { format: "binary" });
    expect(() => prepareTransactions(f.input, f.settings)).toThrow(/결측/);
    const excluded = prepareTransactions(f.input, {
      ...f.settings,
      unknown: "exclude",
    });
    expect(excluded.transactions).toHaveLength(1);
    expect(excluded.excluded).toHaveLength(2);
    const absent = prepareTransactions(f.input, {
      ...f.settings,
      unknown: "absent",
    });
    expect(absent.transactions).toHaveLength(3);
    expect(absent.emptyCount).toBe(2);
    expect(absent.issues).toHaveLength(2);
  });
  it("category same displayed values and duplicate names stay column-specific", () => {
    const f = fixture([[1, 1]], { format: "category", columns: ["c0", "c1"] });
    f.table.columns.forEach((c) => (c.name = "같은 이름"));
    const p = prepareTransactions(f.input, f.settings);
    expect(p.items[0].label).toBe(p.items[1].label);
    expect(p.items[0].id).not.toBe(p.items[1].id);
  });
  it.each(["numeric", "date"] as const)(
    "continuous/date %s are rejected without hidden transformations",
    (semantic) => {
      const f = fixture([[1]], { format: "category" });
      f.table.columns[0].semanticType = semantic;
      expect(() => prepareTransactions(f.input, f.settings)).toThrow(/구간화/);
    },
  );
  it("empty selected range is N=0; known empty baskets can be valid results without items", () => {
    const f = fixture();
    expect(() =>
      runAssociation(f.input, {
        ...f.settings,
        scope: { ...f.settings.scope, kind: "selected" },
      }),
    ).toThrow(/N=0/);
    const empty = fixture([[""], [null]]);
    const result = runAssociation(empty.input, empty.settings);
    expect(result.prepared.transactions).toHaveLength(2);
    expect(result.rules).toEqual([]);
    expect(result.complete).toBe(true);
    expect(() =>
      runAssociation(empty.input, { ...empty.settings, empty: "exclude" }),
    ).toThrow(/N=0/);
  });
  it("NA, zero and false are values, with explicit empty exclusion changing N", () => {
    const f = fixture([["NA"], [0], [false], [""]]);
    const p = prepareTransactions(f.input, f.settings);
    expect(p.items).toHaveLength(3);
    expect(p.emptyCount).toBe(1);
    expect(
      prepareTransactions(f.input, { ...f.settings, empty: "exclude" })
        .transactions,
    ).toHaveLength(3);
  });
});
describe("exact Apriori and composite rules", () => {
  it("independent six-transaction hand answer in both directions and 2x2 cells", () => {
    const f = record(),
      r = findRule(f.result, ["A", "B"], ["C", "D"]),
      reverse = findRule(f.result, ["C", "D"], ["A", "B"]);
    expect([r.n, r.countA, r.countB, r.countUnion]).toEqual([6, 3, 2, 2]);
    expect(r.support).toBe(2 / 6);
    expect(r.confidence).toBe(2 / 3);
    expect(r.lift).toBe(2);
    expect(reverse.confidence).toBe(1);
    expect(reverse.lift).toBe(2);
    const q = {
      ...defaultAssociationView(),
      ruleId: r.id,
      transactionGroup: "both" as const,
    };
    const d = associationDetail(f.table, f.result, q);
    expect(d.counts).toEqual({ both: 2, aOnly: 1, bOnly: 0, neither: 3 });
    expect(d.transactionCount).toBe(2);
    expect(findRule(f.result, ["A"], ["B", "C"])).toBeDefined();
    expect(findRule(f.result, ["A", "B"], ["C"])).toBeDefined();
    expect(new Set(f.result.rules.map((r) => r.id)).size).toBe(
      f.result.rules.length,
    );
    expect(f.result.levels.map((l) => [l.generated, l.frequent])).toEqual([
      [4, 4],
      [6, 6],
      [4, 4],
      [1, 1],
    ]);
  });
  it("candidate subsets prune AC/BC without AB and record the actual pruned candidate", () => {
    const c = (items: string[]) => ({
      items,
      count: 2,
      pruned: false,
      frequent: true,
    });
    const candidates = nextCandidates([c(["A", "B"]), c(["A", "C"])], () => {});
    expect(candidates).toEqual([
      { items: ["A", "B", "C"], count: null, pruned: true, frequent: false },
    ]);
    const f = fixture([["A,B"], ["A,C"]], { supportPercent: "50" });
    const r = runAssociation(f.input, f.settings);
    expect(r.levels[2].candidates[0].pruned).toBe(true); // BC is generated but not frequent; ABC is pruned in next join
  });
  it("decimal threshold boundaries do not use floating point ceiling or displayed rounding", () => {
    expect(supportCount(100, "7")).toBe(7);
    expect(supportCount(100, "7.00000001")).toBe(8);
    expect(supportCount(6, "33.33333333")).toBe(2);
    expect(confidencePass(2, 3, "66.66666666")).toBe(true);
    expect(confidencePass(2, 3, "66.66666667")).toBe(false);
  });
  it.each(["", "NaN", "Infinity", "-1", "101", "0.000000001"])(
    "invalid decimal %s is never clamped",
    (p) => {
      expect(() => supportCount(10, p)).toThrow();
    },
  );
  it("zero support rejected but zero confidence and 100 percent accepted", () => {
    expect(() => supportCount(10, "0")).toThrow();
    expect(confidencePass(1, 10, "0")).toBe(true);
    expect(supportCount(6, "100")).toBe(6);
  });
  it("length cap is recorded, rule discovery changes only with explicit thresholds", () => {
    const f = fixture(),
      r = runAssociation(f.input, f.settings),
      short = runAssociation(f.input, { ...f.settings, maxLength: 2 }),
      high = runAssociation(f.input, { ...f.settings, supportPercent: "100" });
    expect(short.termination).toBe("max-length");
    expect(
      short.rules.every((r) => r.antecedent.length + r.consequent.length <= 2),
    ).toBe(true);
    expect(r.rules.length).toBeGreaterThan(short.rules.length);
    expect(high.rules).toEqual([]);
  });
  it("search all/any, stable metric sorting, pagination and source rows use stored transactions", () => {
    const f = record(),
      r = findRule(f.result, ["A", "B"], ["C", "D"]);
    const q = {
      ...defaultAssociationView(),
      antecedent: r.antecedent,
      consequent: r.consequent,
      ruleId: r.id,
      transactionGroup: "neither" as const,
    };
    const d = associationDetail(f.table, f.result, q);
    expect(d.matchedRules).toBe(1);
    expect(d.transactionCount).toBe(3);
    const any = associationDetail(f.table, f.result, { ...q, match: "any" });
    const expectedAny = f.result.rules.filter(
      (rule) => rule.antecedent.some((id) => r.antecedent.includes(id)) &&
        rule.consequent.some((id) => r.consequent.includes(id)),
    );
    expect(any.matchedRules).toBe(expectedAny.length);
    expect(any.matchedRules).toBeGreaterThan(d.matchedRules);
    expect(new Set(any.rules.map((rule) => rule.id))).toEqual(
      new Set(expectedAny.map((rule) => rule.id)),
    );
    const blank = associationDetail(f.table, f.result, {
      ...q,
      transactionGroup: "empty",
      transactionId: f.result.prepared.transactions[4].id,
    });
    expect(blank.transactionCount).toBe(2);
    expect(blank.sourceRows[0].id).toBe("r0005");
    const all = associationDetail(f.table, f.result, {
      ...defaultAssociationView(),
      sort: "confidence",
    });
    const next = associationDetail(f.table, f.result, {
      ...defaultAssociationView(),
      sort: "confidence",
      page: 1,
    });
    expect(new Set([...all.rules, ...next.rules].map((r) => r.id)).size).toBe(
      all.rules.length + next.rules.length,
    );
  });
  it("row presentation order does not change transaction identities or rules", () => {
    const f = fixture();
    const normal = runAssociation(f.input, f.settings);
    const reversed = runAssociation({ ...f.input, table: {
      ...f.input.table, rows: [...f.input.table.rows].reverse(),
    } }, f.settings);
    expect(reversed.prepared).toEqual(normal.prepared);
    expect(reversed.levels).toEqual(normal.levels);
    expect(reversed.rules).toEqual(normal.rules);
  });
  it("limits reject exact full work, never return sampled/truncated complete rules", () => {
    const f = fixture([
      [Array.from({ length: 33 }, (_, i) => "item" + i).join(",")],
    ]);
    expect(() => runAssociation(f.input, f.settings)).toThrow(/32개/);
    const g = fixture(
      [[Array.from({ length: 20 }, (_, i) => "item" + i).join(",")]],
      { maxLength: 6 },
    );
    expect(() => runAssociation(g.input, g.settings)).toThrow(/한도/);
    expect(() =>
      runAssociation(f.input, { ...f.settings, maxLength: 7 }),
    ).toThrow(/1~6/);
  });
});
describe("persistence, immutable history and job isolation", () => {
  it("versions and originals stay immutable; displayed search is not a freshness condition", () => {
    const f = record();
    expect(f.state.project.datasets[0]).toEqual(f.dataset);
    expect(Object.isFrozen(f.state.project.analyses[0].association)).toBe(true);
    expect(getResultFreshness(f.record, f.source, f.config).state).toBe(
      "current",
    );
    expect(
      getResultFreshness(
        f.record,
        f.source,
        associationConfig(f.source, { ...f.settings, supportPercent: "40" }),
      ).state,
    ).toBe("stale");
    const viewed = workspaceReducer(f.state, {
      type: "association-view",
      id: "a1",
      patch: { page: 1, sort: "confidence" },
    });
    expect(
      getResultFreshness(viewed.project.analyses[0], f.source, f.config).state,
    ).toBe("current");
    expect(f.state.project.history).toEqual(f.state.project.history);
  });
  it("threshold comparisons retain/add/remove directed IDs, population changes are disclosed", () => {
    const f = record(),
      s = { ...f.settings, confidencePercent: "100" },
      b = runAssociation(f.input, s);
    const compared = compareAssociations(f.result, b, f.settings, s);
    expect(compared.samePopulation).toBe(true);
    expect(compared.removed.length).toBeGreaterThan(0);
    expect(compared.added).toHaveLength(0);
    const empty = { ...f.settings, empty: "exclude" as const };
    expect(
      compareAssociations(
        f.result,
        runAssociation(f.input, empty),
        f.settings,
        empty,
      ).samePopulation,
    ).toBe(false);
  });
  it("schema 6 backup roundtrip and copy keep settings, rule/detail selection and counts", () => {
    const f = record();
    const q = {
      ...defaultAssociationView(),
      ruleId: f.result.rules[0].id,
      transactionId: f.result.prepared.transactions[0].id,
    };
    const state = workspaceReducer(f.state, {
      type: "association-view",
      id: "a1",
      patch: q,
    });
    const backup = JSON.stringify(makeBackup(state));
    const restored = readBackup(backup);
    expect(restored.project.analyses[0].association).toEqual(f.result);
    expect(restored.view.associationViews?.a1).toEqual(q);
    expect(readBackup(backup, true).project.id).not.toBe(state.project.id);
  });
  it.each([
    "support",
    "confidence",
    "lift",
    "countA",
    "countB",
    "countUnion",
    "n",
  ] as const)("tampered rule %s rejected", (field) => {
    const f = record(),
      a = structuredClone(f.record);
    a.association!.rules[0][field] += 1;
    expect(() => validateAssociationRecord(a, f.state.project)).toThrow();
  });
  it.each([
    "transaction",
    "dictionary",
    "candidate",
    "ruleMissing",
    "ruleExtra",
    "minCount",
    "version",
    "termination",
    "work",
    "view",
  ] as const)("tampered %s rejected before project replacement", (mutation) => {
    const f = record(),
      state = structuredClone(f.state),
      r = state.project.analyses[0].association!;
    if (mutation === "transaction") r.prepared.transactions[0].rowIds = ["bad"];
    if (mutation === "dictionary") r.prepared.items[0].valueType = "boolean";
    if (mutation === "candidate") r.levels[0].candidates[0].count = 0;
    if (mutation === "ruleMissing") r.rules.pop();
    if (mutation === "ruleExtra") r.rules.push(structuredClone(r.rules[0]));
    if (mutation === "minCount") r.minCount++;
    if (mutation === "version") r.source.versionId = "missing";
    if (mutation === "termination") r.termination = "no-candidates";
    if (mutation === "work") r.work.countedVisits++;
    if (mutation === "view")
      state.view.associationViews = {
        a1: { ...defaultAssociationView(), ruleId: "missing" },
      };
    expect(() => validateWorkspace(state)).toThrow();
    expect(f.state.project.analyses[0].association).toEqual(f.result);
  });
  it("all three families delete current/comparison/detail references before refresh and backup restore", () => {
    let { state } = record();
    const base = state.project.analyses[0];
    for (const kind of ["regression", "clustering"] as const) {
      const c = { ...structuredClone(base.configSnapshot), kind };
      delete c.association;
      state = workspaceReducer(state, {
        type: "analysis-record",
        record: {
          ...createAnalysisRecord(
            c as import("./types").AnalysisConfig,
            kind,
            base.createdAt,
          ),
          status: "cancelled",
        },
      });
    }
    state = {
      ...state,
      view: {
        ...state.view,
        currentAnalysisId: "regression",
        comparisonAnalysisId: "regression",
        clusterSelection: { current: "clustering", comparison: "clustering" },
        clusterAxes: { clustering: { x: "c0", y: "" } },
        associationSelection: { current: "a1", comparison: "a1" },
        associationViews: { a1: defaultAssociationView() },
      },
    };
    for (const id of ["regression", "clustering", "a1"])
      state = workspaceReducer(state, { type: "analysis-delete", id });
    expect(state.view.currentAnalysisId).toBeNull();
    expect(state.view.clusterSelection).toEqual({
      current: null,
      comparison: null,
    });
    expect(state.view.clusterAxes).toEqual({});
    expect(state.view.associationViews).toEqual({});
    expect(state.view.associationSelection).toEqual({
      current: null,
      comparison: null,
    });
    expect(() => readBackup(JSON.stringify(makeBackup(state)))).not.toThrow();
  });
  it("kind-specific configs remain independent and unfinished work restores as cancelled", () => {
    const f = fixture();
    let state = f.state;
    for (const kind of ["regression", "clustering"] as const) {
      const config = { ...f.config, kind };
      delete (config as Partial<typeof config>).association;
      state = workspaceReducer(state, { type: "analysis-config", config });
    }
    expect(Object.keys(state.project.analysisConfigs)).toHaveLength(3);
    expect(
      state.project.analysisConfigs[
        analysisConfigKey(f.source.datasetId, "association")
      ],
    ).toEqual(f.config);
    state = workspaceReducer(state, {
      type: "analysis-record",
      record: {
        ...createAnalysisRecord(
          f.config,
          "pending",
          "2026-10-16T00:00:00.000Z",
        ),
        status: "running",
      },
    });
    expect(
      readBackup(JSON.stringify(makeBackup(state))).project.analyses[0].status,
    ).toBe("cancelled");
  });
  it("gate invalidation on cancellation, changed conditions and new scope generations rejects late complete", () => {
    const f = fixture(),
      gate = new JobGate(),
      task = {
        kind: "association-run" as const,
        input: f.input,
        settings: f.settings,
      };
    const old = gate.startTask("association", task);
    gate.invalidate("association");
    let commits = 0;
    expect(
      gate.receive({ ...old, type: "complete", result: null }, () => commits++),
    ).toBe(false);
    const next = gate.startTask("association", task);
    expect(
      gate.receive({ ...old, type: "complete", result: null }, () => commits++),
    ).toBe(false);
    expect(
      gate.receive(
        { ...next, type: "complete", result: null },
        () => commits++,
      ),
    ).toBe(true);
    expect(commits).toBe(1);
  });
  it("restoration cost is bounded cumulatively and snapshots cannot be mutated by callers", () => {
    const f = record();
    expect(() =>
      associationValidationBudget([f.record], associationLimits.restoreWork),
    ).toThrow(/누적/);
    const copy = snapshot(f.result);
    f.result.rules[0].countA++;
    expect(copy.rules[0].countA).not.toBe(f.result.rules[0].countA);
  });
  it("input copies only relevant active columns and retains all columns for duplicate filters", () => {
    const f = fixture([["A", 1, 2]]);
    expect(
      associationInput(f.state.project, f.config).table.columns.map(
        (c) => c.id,
      ),
    ).toEqual(["c0"]);
    const c = associationConfig(f.source, {
      ...f.settings,
      scope: {
        kind: "filtered",
        duplicatesOnly: true,
        filter: null,
        rowIds: [],
      },
    });
    expect(associationInput(f.state.project, c).table.columns).toHaveLength(3);
  });
});
