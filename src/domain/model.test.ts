import { describe, expect, it } from "vitest";
import {
  createAnalysisRecord,
  createVersion,
  getResultFreshness,
} from "./model";
import { createSample } from "../data/sample";
import type { AnalysisConfig, TableData } from "./types";

export function config(): AnalysisConfig {
  return {
    kind: "regression",
    source: { datasetId: "sample-school-life", versionId: "sample-v1" },
    attributeIds: ["sleep", "reading"],
    parameters: { intercept: true, nested: { values: [1, 2] } },
    preprocessing: { steps: [] },
    calculation: { method: null, missingValuePolicy: null, settings: {} },
    split: { method: "none", settings: {} },
    randomness: { seed: 42, settings: {} },
  };
}
describe("preserved data and historical conditions", () => {
  it("keeps originals and versions independent, including rows and metadata", () => {
    const sample = createSample("2026-10-07T00:00:00Z");
    const original = sample.original.table;
    const initial = sample.versions[0];
    expect(original.rows).not.toBe(initial.rows);
    expect(original.columns[0]).not.toBe(initial.columns[0]);
    const working = structuredClone({
      rows: initial.rows,
      columns: initial.columns,
    }) as TableData;
    working.rows[0].values.sleep = 99;
    working.columns[0].name = "바뀐 이름";
    const next = createVersion(working, {
      id: "sample-v2",
      datasetId: sample.id,
      createdAt: "now",
      operation: {
        id: "transform-2",
        kind: "transform",
        datasetId: sample.id,
        inputVersionIds: [initial.id],
        outputVersionIds: ["sample-v2"],
        settings: {},
        executedAt: "now",
      },
      parentVersionIds: [initial.id],
    });
    expect(original.rows[0].values.sleep).toBe(7.5);
    expect(initial.rows[0].values.sleep).toBe(7.5);
    expect(next.columns[0].id).toBe(original.columns[0].id);
    expect(next.columns[0].name).toBe("바뀐 이름");
    expect(Object.isFrozen(initial.rows[0].values)).toBe(true);
    expect(Object.isFrozen(original.columns[0])).toBe(true);
  });
  it("copies nested analysis settings and retains past conditions when stale", () => {
    const draft = config();
    const record = createAnalysisRecord(draft, "analysis-1", "now");
    record.status = "completed";
    expect(getResultFreshness(record, draft.source, draft).state).toBe(
      "current",
    );
    draft.preprocessing.steps.push({
      method: "scale",
      attributeIds: ["sleep"],
      settings: { center: true },
    });
    expect(record.configSnapshot.preprocessing.steps).toEqual([]);
    expect(getResultFreshness(record, draft.source, draft).state).toBe("stale");
    expect(
      getResultFreshness(record, { ...draft.source, versionId: "v2" }, config())
        .state,
    ).toBe("stale");
    expect(record.configSnapshot.source.versionId).toBe("sample-v1");
    expect(record.result).toBeNull();
  });
  it("compares settings independent of object key order and checks noncompleted results", () => {
    const draft = config();
    const record = createAnalysisRecord(draft, "a", "now");
    expect(getResultFreshness(record, draft.source, draft).state).toBe(
      "unavailable",
    );
    record.status = "completed";
    draft.parameters = { nested: { values: [1, 2] }, intercept: true };
    expect(getResultFreshness(record, draft.source, draft).state).toBe(
      "current",
    );
    expect(getResultFreshness(record, null, draft).state).toBe("stale");
    expect(getResultFreshness(record, draft.source, null).state).toBe("stale");
    draft.randomness.seed = 7;
    expect(getResultFreshness(record, draft.source, draft).state).toBe("stale");
  });
  it("detects kind, attributes, preprocessing, split and calculation changes", () => {
    const record = createAnalysisRecord(config(), "a", "now");
    record.status = "completed";
    const alternatives: AnalysisConfig[] = [
      { ...config(), kind: "clustering" },
      { ...config(), attributeIds: ["sleep"] },
      { ...config(), split: { method: "holdout", settings: { ratio: 0.2 } } },
      {
        ...config(),
        calculation: {
          method: "ols",
          missingValuePolicy: "drop",
          settings: {},
        },
      },
    ];
    for (const draft of alternatives)
      expect(getResultFreshness(record, draft.source, draft).state).toBe(
        "stale",
      );
  });
});
