import { describe, expect, it } from "vitest";
import {
  parseBytes,
  registerImport,
  defaultImportOptions,
} from "../data/import";
import {
  convertCell,
  editVersion,
  inspectTable,
  defaultTableView,
  validDate,
} from "./table";
import { createWorkspace, workspaceReducer } from "../state/workspace";
const dataset = () => {
  const p = parseBytes(
    new TextEncoder().encode(
      "학생번호,점수,집단\n001,1,A\n002,2,A\n003,3,B\n004,4,B\n005,,NA",
    ).buffer as ArrayBuffer,
    "test.csv",
    defaultImportOptions,
  );
  return registerImport(p, p.proposed.columns, true);
};
describe("edits and typed values", () => {
  it("rejects invalid numbers, infinities, invalid dates and imprecise integers", () => {
    const column = dataset().versions[1].columns[1];
    for (const value of [
      "abc",
      "NaN",
      "Infinity",
      "1e999",
      "9007199254740993",
      " ",
    ])
      expect(() => convertCell(value, column)).toThrow();
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2025-02-29")).toBe(false);
    expect(validDate("2024-01-01T25:00:00")).toBe(false);
    expect(() =>
      convertCell("2024-02-30", {
        ...column,
        storageType: "string",
        semanticType: "date",
      }),
    ).toThrow();
    expect(convertCell("0", column)).toBe(0);
  });
  it("preserves original and old versions on commit, failure and no-op", () => {
    const data = dataset();
    const previous = data.versions[1];
    const column = previous.columns[1];
    const row = previous.rows[0];
    const edited = editVersion(data, previous.id, {
      kind: "cell",
      rowId: row.id,
      attributeId: column.id,
      value: "10",
      missing: false,
    })!;
    expect(edited.rows[0].values[column.id]).toBe(10);
    expect(edited.rows[0].id).toBe(row.id);
    expect(previous.rows[0].values[column.id]).toBe(1);
    expect(data.original.table.rows[0].values[column.id]).toBe("1");
    expect(() =>
      editVersion(data, previous.id, {
        kind: "cell",
        rowId: row.id,
        attributeId: column.id,
        value: "oops",
        missing: false,
      }),
    ).toThrow();
    expect(
      editVersion(data, previous.id, {
        kind: "cell",
        rowId: row.id,
        attributeId: column.id,
        value: "1",
        missing: false,
      }),
    ).toBeNull();
    expect(Object.isFrozen(edited.rows[0].values)).toBe(true);
  });
  it("converts a column atomically, preserves IDs and blocks unconfirmed zero loss", () => {
    const data = dataset();
    const previous = data.versions[1];
    const id = previous.columns[0];
    expect(() =>
      editVersion(data, previous.id, {
        kind: "attribute",
        attribute: { ...id, storageType: "number" },
        allowLoss: false,
      }),
    ).toThrow("앞자리");
    const next = editVersion(data, previous.id, {
      kind: "attribute",
      attribute: { ...id, name: "식별 번호", storageType: "number" },
      allowLoss: true,
    })!;
    expect(next.columns[0].id).toBe(id.id);
    expect(next.rows[0].values[id.id]).toBe(1);
    expect(previous.rows[0].values[id.id]).toBe("001");
    expect(() =>
      editVersion(data, previous.id, {
        kind: "attribute",
        attribute: {
          ...previous.columns[2],
          storageType: "number",
          semanticType: "numeric",
        },
        allowLoss: true,
      }),
    ).toThrow("변환 실패");
    expect(previous.rows[0].values[previous.columns[2].id]).toBe("A");
  });
});
describe("inspection and UI state", () => {
  it('sorts mixed values consistently without changing their storage types', () => {
    const table = { columns: [{ id: 'mixed', name: '혼합', storageType: 'mixed' as const, semanticType: 'categorical' as const, description: '', useInAnalysis: true }], rows: [10, '11', 2, false, null].map((value, i) => ({ id: String(i), values: { mixed: value } })) };
    const result = inspectTable(table, { ...defaultTableView(), sort: { attributeId: 'mixed', direction: 'asc' } });
    expect(result.rowIds).toEqual(['3', '2', '0', '1', '4']);
    expect(table.rows[1].values.mixed).toBe('11');
  });
  it("matches known sample statistics and excludes only null/empty strings", () => {
    const table = dataset().versions[1];
    const result = inspectTable(table, defaultTableView());
    const stat = result.statistics[table.columns[1].id];
    expect(stat).toMatchObject({ missing: 1, missingRatio: 0.2, unique: 4 });
    expect(stat.numeric).toMatchObject({
      valid: 4,
      min: 1,
      max: 4,
      mean: 2.5,
      median: 2.5,
    });
    expect(stat.numeric!.stddev).toBeCloseTo(Math.sqrt(5 / 3));
    expect(result.statistics[table.columns[0].id].numeric).toBeUndefined();
    expect(result.statistics[table.columns[2].id].frequencies).toContainEqual({
      value: "NA",
      count: 1,
    });
  });
  it("filters and sorts by IDs without changing original order or hidden selections", () => {
    const data = dataset();
    const table = data.versions[1];
    const ids = table.rows.map((r) => r.id);
    const view = {
      ...defaultTableView(),
      sort: { attributeId: table.columns[1].id, direction: "desc" as const },
      filter: {
        attributeId: table.columns[1].id,
        operator: "gt" as const,
        value: "2",
      },
      selectedRowIds: [ids[0]],
      statisticsScope: "filtered" as const,
    };
    const result = inspectTable(table, view);
    expect(result.rowIds).toEqual([ids[3], ids[2]]);
    expect(result.statisticsRows).toBe(2);
    expect(result.statistics[table.columns[1].id].numeric?.mean).toBe(3.5);
    expect(table.rows.map((r) => r.id)).toEqual(ids);
    let state = workspaceReducer(createWorkspace(false), {
      type: "import",
      dataset: data,
    });
    state = workspaceReducer(state, {
      type: "table-view",
      datasetId: data.id,
      patch: view,
    });
    state = workspaceReducer(state, { type: "menu", menu: "analyze" });
    expect(state.view.tables[data.id].selectedRowIds).toEqual([ids[0]]);
    expect(state.project.operations).toHaveLength(2);
    const edit = editVersion(data, table.id, {
      kind: "cell",
      rowId: ids[0],
      attributeId: table.columns[1].id,
      value: "5",
      missing: false,
    })!;
    state = workspaceReducer(state, {
      type: "commit-version",
      datasetId: data.id,
      baseVersionId: table.id,
      version: edit,
    });
    expect(state.project.selection?.versionId).toBe(edit.id);
    expect(state.project.datasets[0].versions).toHaveLength(3);
    expect(state.project.operations).toHaveLength(3);
    expect(state.view.tables[data.id].selectedRowIds).toEqual([ids[0]]);
    expect(
      workspaceReducer(state, {
        type: "commit-version",
        datasetId: data.id,
        baseVersionId: table.id,
        version: edit,
      }),
    ).toBe(state);
  });
  it("reports duplicate groups and all involved rows without deleting them", () => {
    const p = parseBytes(
      new TextEncoder().encode("분류,값\nA,1\nA,1\nA,1\nB,0")
        .buffer as ArrayBuffer,
      "d.csv",
      defaultImportOptions,
    );
    const data = registerImport(p, p.proposed.columns, true);
    const t = data.versions[1];
    const result = inspectTable(t, {
      ...defaultTableView(),
      duplicatesOnly: true,
    });
    expect(result.duplicateGroupCount).toBe(1);
    expect(result.duplicateExtraCount).toBe(2);
    expect(result.duplicateRowIds).toHaveLength(3);
    expect(result.rowIds).toHaveLength(3);
    expect(t.rows).toHaveLength(4);
  });
});
