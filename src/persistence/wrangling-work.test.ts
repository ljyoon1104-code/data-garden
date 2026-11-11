import { expect, it, vi } from "vitest";
import { estimateWranglingWork } from "./wrangling-work";
import { RESTORE_WORK_LIMIT, restoreBudget } from "./backup-limits";
import { createWorkspace, getSelection, workspaceReducer } from "../state/workspace";
import { defaultImportOptions, parseBytes, registerImport } from "../data/import";
import { defaultWrangling, fitWrangling, commitWrangling } from "../domain/wrangling";
import * as validation from "../domain/wrangling-validation";
import type { InputTable } from "../domain/wrangling-types";
import { makeBackup, readBackup } from "./format";

it("charges operand multiplicity before replay and preserves a normal calculated backup", () => {
  const parsed = parseBytes(
    new TextEncoder().encode("점수\n" + "1\n".repeat(2000)).buffer,
    "검증.csv",
    defaultImportOptions,
  );
  let state = workspaceReducer(createWorkspace(false), {
    type: "import",
    dataset: registerImport(parsed, parsed.proposed.columns, true),
  });
  const { dataset, version } = getSelection(state);
  const input: InputTable = { source: state.project.selection!, table: version!, name: dataset!.name };
  const settings = defaultWrangling("calculate", [input]);
  if (settings.kind !== "calculate") throw new Error("Expected calculation");
  settings.operator = "sum";
  settings.operands = [{ kind: "constant", value: 1 }];
  const result = commitWrangling([input], fitWrangling([input], settings), 3_000_000, true);
  state = workspaceReducer(state, {
    type: "commit-version",
    datasetId: dataset!.id,
    baseVersionId: version!.id,
    version: result.version,
  });
  expect(readBackup(JSON.stringify(makeBackup(state)))).toEqual(state);

  const excessive = structuredClone(state);
  const output = excessive.project.datasets[0].versions.at(-1)!;
  const fitted = output.operation.wrangling!.fitted;
  if (fitted.settings.kind !== "calculate") throw new Error("Expected calculation");
  const largeSettings = {
    ...fitted.settings,
    operands: Array.from({ length: 5000 }, () => ({ kind: "constant" as const, value: 1 })),
  };
  const largeOperation = {
    ...output.operation,
    settings: structuredClone(largeSettings),
    wrangling: {
      ...output.operation.wrangling!,
      fitted: { ...fitted, settings: largeSettings },
    },
  };
  const versions = excessive.project.datasets[0].versions;
  versions[versions.length - 1] = { ...output, operation: largeOperation };
  const operationIndex = excessive.project.operations.findIndex((op) => op.id === output.operation.id);
  excessive.project.operations[operationIndex] = structuredClone(largeOperation);
  const replay = vi.spyOn(validation, "validateWranglingRecord");
  try {
    expect(() => readBackup(JSON.stringify(makeBackup(excessive)))).toThrow(/누적 복원 검증.*가공 재계산/);
    expect(replay.mock.calls.some(([, candidate]) => candidate.id === output.id)).toBe(false);
  } finally {
    replay.mockRestore();
  }
});

it("accounts for aggregate median sorting and bin/key settings in the same budget", () => {
  const table = { rows: 50_000, columns: 2, textWork: 0 };
  const output = { rows: 1, columns: 61, textWork: 0 };
  const settings = {
    kind: "aggregate", name: "가상 집계", groupIds: ["group"], includeMissing: true,
    aggregates: Array.from({ length: 60 }, (_, index) => ({
      method: "median", attributeId: "score", name: String(index), description: "",
    })),
  };
  const median = estimateWranglingWork(settings, [table], output);
  expect(median).toBe(RESTORE_WORK_LIMIT + 1);
  const spend = restoreBudget();
  expect(() => spend(median, "가공 재계산")).toThrow("누적 복원 검증");
  const sum = estimateWranglingWork({
    ...settings,
    aggregates: settings.aggregates.map((aggregate) => ({ ...aggregate, method: "sum" })),
  }, [table], output);
  expect(sum).toBeLessThan(median);
  const bin = { kind: "bin", attributeId: "score", method: "width", labels: [], outside: "edge", output: { name: "구간", description: "" }, count: 2 };
  expect(estimateWranglingWork({ ...bin, count: 200 }, [table], table))
    .toBeGreaterThan(estimateWranglingWork(bin, [table], table));
  const join = { kind: "join", mode: "inner", name: "결합", columnNames: {}, keys: [{ left: "a", right: "b" }] };
  expect(estimateWranglingWork({ ...join, keys: [...join.keys, ...join.keys] }, [table, table], output))
    .toBeGreaterThan(estimateWranglingWork(join, [table, table], output));
});
