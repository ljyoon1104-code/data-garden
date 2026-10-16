import { analysisConfigKey } from "../domain/clustering";
import { describe, it, expect } from "vitest";
import {
  createWorkspace,
  workspaceReducer,
  getSelection,
  activeDatasets,
} from "../state/workspace";
import { editVersion } from "../domain/table";
import {
  parseBytes,
  registerImport,
  defaultImportOptions,
} from "../data/import";
import { createAnalysisRecord, getResultFreshness } from "../domain/model";
import type { AnalysisConfig } from "../domain/types";
import {
  makeBackup,
  readBackup,
  validateWorkspace,
  restoreAsCopy,
} from "./format";
import type { WorkspaceState } from "../state/workspace";

function imported() {
  const parsed = parseBytes(
    new TextEncoder().encode("학생번호,점수\n00123,80\n00456,90").buffer,
    "학생.csv",
    defaultImportOptions,
  );
  return workspaceReducer(createWorkspace(), {
    type: "import",
    dataset: registerImport(parsed, parsed.proposed.columns, true),
  });
}
function edit(state: WorkspaceState, value: string) {
  const { dataset, version } = getSelection(state);
  const next = editVersion(dataset!, version!.id, {
    kind: "cell",
    rowId: version!.rows[0].id,
    attributeId: version!.columns[1].id,
    value,
    missing: false,
  })!;
  return workspaceReducer(state, {
    type: "commit-version",
    datasetId: dataset!.id,
    baseVersionId: version!.id,
    version: next,
  });
}
describe("history references and backup validation", () => {
  it("undoes attribute edits without changing stable column IDs or originals", () => {
    let state = createWorkspace();
    const { dataset, version } = getSelection(state);
    const column = version!.columns[0];
    const changed = editVersion(dataset!, version!.id, {
      kind: "attribute",
      attribute: {
        ...column,
        name: "학생 식별 코드",
        description: "수업용",
        useInAnalysis: false,
      },
      allowLoss: false,
    })!;
    state = workspaceReducer(state, {
      type: "commit-version",
      datasetId: dataset!.id,
      baseVersionId: version!.id,
      version: changed,
    });
    expect(state.project.history.entries[0].label).toBe("속성 수정");
    state = workspaceReducer(state, { type: "undo" });
    expect(getSelection(state).version!.columns[0]).toEqual(column);
    state = workspaceReducer(state, { type: "redo" });
    expect(getSelection(state).version!.columns[0].name).toBe("학생 식별 코드");
    expect(getSelection(state).version!.columns[0].id).toBe(column.id);
    expect(validateWorkspace(state).project.datasets[0].original).toEqual(
      dataset!.original,
    );
  });
  it("undoes a two-version import as one unit, redoes edits, and switches to the undone version", () => {
    const first = imported(),
      dataset = getSelection(first).dataset!,
      id = dataset.id,
      original = JSON.stringify(dataset.original);
    const one = edit(first, "85"),
      two = edit(one, "95");
    let state = workspaceReducer(two, { type: "undo" });
    const undone = getSelection(state).version!.id;
    state = workspaceReducer(state, {
      type: "dataset",
      datasetId: "sample-school-life",
    });
    state = workspaceReducer(state, { type: "dataset", datasetId: id });
    expect(getSelection(state).version!.id).toBe(undone);
    state = workspaceReducer(state, { type: "undo" });
    state = workspaceReducer(state, { type: "undo" });
    expect(activeDatasets(state.project)).toHaveLength(1);
    expect(
      state.project.datasets.find((d) => d.id === id)!.versions,
    ).toHaveLength(4);
    state = workspaceReducer(state, { type: "redo" });
    expect(getSelection(state).version!.id).toBe(dataset.versions[1].id);
    state = workspaceReducer(state, { type: "redo" });
    state = workspaceReducer(state, { type: "redo" });
    expect(getSelection(state).version).toEqual(getSelection(two).version);
    expect(
      JSON.stringify(state.project.datasets.find((d) => d.id === id)!.original),
    ).toBe(original);
    expect(() => validateWorkspace(state)).not.toThrow();
  });
  it("branches after undo without dropping old versions or recording table-only changes", () => {
    const initial = imported(),
      old = edit(initial, "88");
    let state = workspaceReducer(old, { type: "undo" });
    state = edit(state, "92");
    expect(state.project.history.cursor).toBe(
      state.project.history.entries.length,
    );
    expect(
      state.project.datasets
        .at(-1)!
        .versions.some((v) => v.id === getSelection(old).version!.id),
    ).toBe(true);
    const count = state.project.history.entries.length;
    state = workspaceReducer(state, {
      type: "table-view",
      datasetId: getSelection(state).dataset!.id,
      patch: {
        sort: {
          attributeId: getSelection(state).version!.columns[1].id,
          direction: "desc",
        },
      },
    });
    expect(state.project.history.entries).toHaveLength(count);
    expect(validateWorkspace(state).view).toEqual(state.view);
  });
  it("round-trips values, IDs, lineage, history and formats and creates a separate project", () => {
    let state = edit(imported(), "99");
    state = workspaceReducer(state, { type: "undo" });
    const d = state.project.datasets.at(-1)!;
    d.original = {
      ...d.original,
      cellMetadata: {
        [d.original.table.rows[0].id]: {
          [d.original.table.columns[0].id]: {
            display: "00123",
            format: "00000",
            type: "s",
          },
        },
      },
    };
    state.project.interpretations = [
      {
        id: "note",
        target: { kind: "project", id: state.project.id },
        text: "해석",
        createdAt: state.project.createdAt,
        updatedAt: state.project.updatedAt,
      },
    ];
    const restored = readBackup(JSON.stringify(makeBackup(state)));
    expect(restored).toEqual(state);
    expect(
      Object.isFrozen(
        restored.project.datasets[0].original.table.rows[0].values,
      ),
    ).toBe(true);
    expect(
      Object.isFrozen(
        restored.project.datasets.at(-1)!.versions.at(-1)!.columns,
      ),
    ).toBe(true);
    const copy = restoreAsCopy(restored);
    expect(copy.project.id).not.toBe(state.project.id);
    expect(copy.project.datasets).toEqual(state.project.datasets);
    expect(copy.project.interpretations[0].target.id).toBe(copy.project.id);
  });
  it("preserves analysis snapshots and detects freshness across edit, undo and restore", () => {
    let state = createWorkspace();
    const config: AnalysisConfig = {
      kind: "regression",
      source: state.project.selection!,
      attributeIds: ["sleep"],
      parameters: { nested: { value: 1 } },
      preprocessing: { steps: [] },
      calculation: { method: null, missingValuePolicy: null, settings: {} },
      split: { method: "none", settings: {} },
      randomness: { seed: 42, settings: {} },
    };
    const record = createAnalysisRecord(
      config,
      "analysis",
      state.project.createdAt,
    );
    record.status = "completed";
    record.result = { value: 1 };
    state.project.analysisConfigs[analysisConfigKey(config.source.datasetId,config.kind)] = config;
    state.project.analyses = [record];
    state = edit(state, "3");
    expect(
      getResultFreshness(record, state.project.selection, config).state,
    ).toBe("stale");
    state = workspaceReducer(state, { type: "undo" });
    const copy = readBackup(JSON.stringify(makeBackup(state)));
    expect(
      getResultFreshness(
        copy.project.analyses[0],
        copy.project.selection,
        copy.project.analysisConfigs[analysisConfigKey(config.source.datasetId,config.kind)],
      ).state,
    ).toBe("current");
    copy.project.analysisConfigs[analysisConfigKey(config.source.datasetId,config.kind)].randomness.seed = 7;
    expect(
      getResultFreshness(
        copy.project.analyses[0],
        copy.project.selection,
        copy.project.analysisConfigs[analysisConfigKey(config.source.datasetId,config.kind)],
      ).state,
    ).toBe("stale");
    expect(copy.project.analyses[0].configSnapshot.randomness.seed).toBe(42);
    expect(
      Object.isFrozen(copy.project.analyses[0].configSnapshot.parameters),
    ).toBe(true);
    record.status = "running";
    expect(validateWorkspace(state).project.analyses[0].status).toBe(
      "cancelled",
    );
  });
  it("migrates schema 1 explicitly and rejects future/corrupt/duplicate/missing/nonfinite refs", () => {
    const original = createWorkspace();
    const old = JSON.parse(JSON.stringify(original));
    old.project.schemaVersion = 1;
    delete old.project.history;
    delete old.project.activeVersions;
    expect(validateWorkspace(old)).toEqual(original);
    const invalid: Array<(s: any) => void> = [
      (s) => (s.project.schemaVersion = 99),
      (s) => delete s.project.datasets,
      (s) => s.project.datasets.push(s.project.datasets[0]),
      (s) =>
        (s.project.datasets[0].versions[0].rows[0].values.sleep = Infinity),
      (s) =>
        (s.project.datasets[0].versions[0].rows[0].values.sleep = undefined),
      (s) =>
        (s.project.datasets[0].versions[0].parentVersionIds = ["sample-v1"]),
      (s) => (s.project.activeVersions["sample-school-life"] = "missing"),
      (s) => (s.project.selection.versionId = "missing"),
      (s) => (s.project.history.cursor = 3),
      (s) => (s.project.operations[0].outputVersionIds = ["missing"]),
      (s) => (s.view.tables.bad = {}),
      (s) => (s.project.analyses = [{}]),
      (s) => (s.project.graphs = [{ id: "bad" }]),
      (s) =>
        s.project.datasets[0].versions[0].rows.push(
          s.project.datasets[0].versions[0].rows[0],
        ),
    ];
    for (const corrupt of invalid) {
      const value = structuredClone(original);
      corrupt(value);
      expect(() => validateWorkspace(value)).toThrow();
    }
    expect(() => readBackup('{"format":')).toThrow();
    const future = makeBackup(original);
    (future as any).formatVersion = 2;
    expect(() => readBackup(JSON.stringify(future))).toThrow();
    expect(original.project.schemaVersion).toBe(6);
  });
});
