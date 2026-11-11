import { expect, it, vi } from "vitest";
import { createWorkspace, getSelection, workspaceReducer } from "../state/workspace";
import { defaultImportOptions, parseBytes, registerImport } from "../data/import";
import * as graphs from "../domain/graphs";
import { checkBackupJson, backupJsonLimits } from "./backup-limits";
import { makeBackup, readBackup, readBackupBytes } from "./format";

it("counts keys, values, containers and decoded string units before parsing", () => {
  const limits = { depth: 2, tokens: 4, stringUnits: 3, literalUnits: 3 };
  expect(() => checkBackupJson('{"k":["\\uD83D\\uDE03\\\""]}', limits)).not.toThrow();
  expect(() => checkBackupJson('{"k":["\\uD83D\\uDE03\\\"x"]}', limits)).toThrow("문자열 길이");
  expect(() => checkBackupJson('{"k":[[]]}', limits)).toThrow("중첩 깊이");
  expect(() => checkBackupJson('{"k":[1,2]}', limits)).toThrow("토큰");
  expect(() => checkBackupJson('{"k":1234}', limits)).toThrow("리터럴 길이");
  expect(() => checkBackupJson('{"k":"\\u12xx"}', limits)).toThrow("이스케이프");
});

it("rejects deep or oversized fields outside workspace without calling JSON.parse", () => {
  const deep = '{"extra":' + '['.repeat(backupJsonLimits.depth) + '0' + ']'.repeat(backupJsonLimits.depth) + '}';
  const long = '{"extra":"' + 'x'.repeat(backupJsonLimits.stringUnits + 1) + '"}';
  const allowedDepth = '['.repeat(backupJsonLimits.depth) + '0' + ']'.repeat(backupJsonLimits.depth);
  const allowedString = '"' + 'x'.repeat(backupJsonLimits.stringUnits) + '"';
  expect(() => checkBackupJson(allowedDepth)).not.toThrow();
  expect(() => checkBackupJson(allowedString)).not.toThrow();
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(() => readBackup(deep)).toThrow("중첩 깊이");
    expect(() => readBackup(long)).toThrow("문자열 길이");
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it("restores valid BOM UTF-8 and refuses corrupted bytes and extra envelope fields", () => {
  const state = createWorkspace();
  const text = JSON.stringify(makeBackup(state));
  const bytes = new TextEncoder().encode('\uFEFF' + text);
  expect(readBackupBytes(bytes.buffer)).toEqual(state);
  const corrupted = bytes.slice();
  corrupted[3] = 0xff;
  expect(() => readBackupBytes(corrupted.buffer)).toThrow("UTF-8");
  expect(() => readBackup(JSON.stringify({ ...makeBackup(state), extra: 1 }))).toThrow("최상위 필드");
});

it("preserves an in-budget histogram project and stops before recalculating every repeated graph", () => {
  const values = Array.from({ length: 4000 }, (_, i) => `${i}.5`).join("\n");
  const parsed = parseBytes(new TextEncoder().encode(`측정값\n${values}`).buffer, "가상.csv", defaultImportOptions);
  const dataset = registerImport(parsed, parsed.proposed.columns, true);
  const state = workspaceReducer(createWorkspace(false), { type: "import", dataset });
  const { version } = getSelection(state);
  const graph = graphs.newGraph(version!, { datasetId: dataset.id, versionId: version!.id });
  graph.kind = "histogram";
  graph.visual!.x = version!.columns[0].id;
  graph.visual!.binCount = 100;
  graph.visual!.boundaries = graphs.calculateGraph(version!, graph).boundaries;
  const copies = (count: number) => Array.from({ length: count }, (_, i) => ({ ...graph, id: `histogram-${i}` }));
  state.project.graphs = copies(30);
  const near = readBackup(JSON.stringify(makeBackup(state)));
  expect(near.project.datasets).toEqual(state.project.datasets);
  expect(near.project.graphs).toEqual(state.project.graphs);

  const excessive = { ...state, project: { ...state.project, graphs: copies(48) } };
  const calculate = vi.spyOn(graphs, "calculateGraph");
  try {
    expect(() => readBackup(JSON.stringify(makeBackup(excessive)), true)).toThrow(/누적 복원 검증.*히스토그램/);
    expect(calculate.mock.calls.length).toBeGreaterThan(0);
    expect(calculate.mock.calls.length).toBeLessThan(48);
    expect(state.project.graphs).toHaveLength(30);
  } finally {
    calculate.mockRestore();
  }
}, 15_000);
