import { expect, it, vi } from "vitest";
import { defaultImportOptions, parseBytes, registerImport } from "../data/import";
import { createWorkspace, getSelection, workspaceReducer } from "../state/workspace";
import { createAnalysisRecord } from "../domain/model";
import { buildRegressionPlan, defaultRegression, regressionConfig, runRegression } from "../domain/regression";
import * as models from "../domain/regression-models";
import { makeBackup, readBackup } from "./format";
import { restoreValueWork } from "./backup-limits";
import { restoreBudget, RESTORE_WORK_LIMIT } from "./backup-limits";
import { defaultClustering, clusteringConfig, buildClusteringPlan, runClustering } from "../domain/clustering";
import { defaultAssociation, associationConfig, associationInput, runAssociation } from "../domain/association";
import { associationValidationCost, validateAssociationRecord } from "../domain/association-validation";

function regressionProject(rows = 600, k = 200) {
  const values = Array.from({ length: rows }, (_, i) => `${i}.5,${2 * i + 1}.5`).join("\n");
  const parsed = parseBytes(new TextEncoder().encode("측정값,점수\n" + values).buffer, "가상.csv", defaultImportOptions);
  let state = workspaceReducer(createWorkspace(false), {
    type: "import", dataset: registerImport(parsed, parsed.proposed.columns, true),
  });
  const version = getSelection(state).version!;
  const config = regressionConfig(state.project.selection!, {
    ...defaultRegression(),
    target: version.columns[1].id,
    features: [version.columns[0].id],
    models: ["knn"],
    k,
  });
  const result = runRegression(buildRegressionPlan(state.project, config), config.regression);
  const record = {
    ...createAnalysisRecord(config, "analysis-0", "2026-11-10T00:00:00.000Z"),
    status: "completed" as const, regression: result, completedAt: result.completedAt,
  };
  state = workspaceReducer(state, { type: "analysis-record", record });
  return { state, record };
}

it("shares the model evaluation budget across repeated saved regression records", () => {
  const { state, record } = regressionProject();
  expect(readBackup(JSON.stringify(makeBackup(state))).project.datasets).toEqual(state.project.datasets);
  const repeated = structuredClone(state);
  repeated.project.analyses = Array.from({ length: 4 }, (_, i) => ({ ...record, id: `analysis-${i}` }));
  const predict = vi.spyOn(models, "predictModel");
  try {
    expect(() => readBackup(JSON.stringify(makeBackup(repeated)))).toThrow(/누적 복원 검증.*회귀 모델 평가/);
    expect(predict.mock.calls.length).toBeGreaterThan(0);
    expect(predict.mock.calls.length).toBeLessThan(4 * record.regression.evaluationRowIds.length);
  } finally {
    predict.mockRestore();
  }
});

it("accounts for descriptive metadata in repeated lineage validation", () => {
  const { state, record } = regressionProject(20, 2);
  const candidate = structuredClone(state);
  const dataset = candidate.project.datasets[0];
  const version = dataset.versions.at(-1)!;
  const metadata = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`note${i}`, "x".repeat(1024 * 1024)]));
  const operation = { ...version.operation, settings: metadata };
  dataset.versions[dataset.versions.length - 1] = { ...version, operation };
  const index = candidate.project.operations.findIndex((op) => op.id === operation.id);
  candidate.project.operations[index] = operation;
  candidate.project.analyses = Array.from({ length: 40 }, (_, i) => ({ ...record, id: `analysis-${i}` }));
  expect(restoreValueWork(metadata)).toBeGreaterThan(300_000);
  const validate = vi.spyOn(models, "predictModel");
  try {
    expect(() => readBackup(JSON.stringify(makeBackup(candidate)))).toThrow(/누적 복원 검증.*가공 계보/);
    expect(validate.mock.calls.length).toBeLessThan(40 * record.regression.evaluationRowIds.length);
  } finally {
    validate.mockRestore();
  }
}, 15_000);

it("shares silhouette validation work across saved cluster records", () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0 : 10) + i / 1000);
  const parsed = parseBytes(new TextEncoder().encode("측정값\n" + values.join("\n")).buffer, "가상.csv", defaultImportOptions);
  const dataset = registerImport(parsed, parsed.proposed.columns, true);
  let state = workspaceReducer(createWorkspace(false), { type: "import", dataset });
  const settings = {
    ...defaultClustering(), features: [getSelection(state).version!.columns[0].id], ks: [2], restarts: 1,
    scaling: "none" as const, initialization: "manual" as const,
    manualCenters: [[0], [10]],
  };
  const config = clusteringConfig(state.project.selection!, settings);
  const result = runClustering(buildClusteringPlan(state.project, config), settings);
  const record = {
    ...createAnalysisRecord(config, "cluster-0", "2026-11-10T00:00:00.000Z"),
    status: "completed" as const, clustering: result,
  };
  state = workspaceReducer(state, { type: "analysis-record", record });
  expect(() => readBackup(JSON.stringify(makeBackup(state)))).not.toThrow();
  state.project.analyses = Array.from({ length: 36 }, (_, i) => ({ ...record, id: `cluster-${i}` }));
  expect(() => readBackup(JSON.stringify(makeBackup(state)))).toThrow(/누적 복원 검증.*군집/);
}, 15_000);

it("charges association work against the same already-used budget", () => {
  const parsed = parseBytes(new TextEncoder().encode('항목\n"A,B"\n"A,B"\nA').buffer, "가상.csv", defaultImportOptions);
  const dataset = registerImport(parsed, parsed.proposed.columns, true);
  const state = workspaceReducer(createWorkspace(false), { type: "import", dataset });
  const config = associationConfig(state.project.selection!, {
    ...defaultAssociation(), columns: [getSelection(state).version!.columns[0].id],
  });
  const result = runAssociation(associationInput(state.project, config), config.association!);
  const record = {
    ...createAnalysisRecord(config, "association-0", "2026-11-10T00:00:00.000Z"),
    status: "completed" as const, association: result,
  };
  expect(() => validateAssociationRecord(record, state.project)).not.toThrow();
  const spend = restoreBudget();
  spend(RESTORE_WORK_LIMIT - associationValidationCost(result) + 1, "앞선 검증");
  expect(() => validateAssociationRecord(record, state.project, spend)).toThrow(/누적 복원 검증.*연관/);
});
