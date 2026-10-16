import { describe, expect, it } from "vitest";
import { createWorkspace, getSelection, workspaceReducer } from "./workspace";
import type { Menu } from "../domain/types";

describe("workspace state", () => {
  it("preserves source, attribute, and display preferences through every menu", () => {
    let state = createWorkspace();
    state = workspaceReducer(state, {
      type: "attribute",
      attributeId: "student-id",
    });
    state = workspaceReducer(state, { type: "density", density: "compact" });
    state = workspaceReducer(state, { type: "inspector" });
    const project = state.project;
    for (const menu of [
      "prepare",
      "visualize",
      "analyze",
      "results",
      "data",
    ] as Menu[]) {
      state = workspaceReducer(state, { type: "menu", menu });
      expect(state.project).toBe(project);
      expect(getSelection(state).attribute?.id).toBe("student-id");
      expect(state.view.density).toBe("compact");
      expect(state.view.inspectorOpen).toBe(false);
    }
  });
  it("supports empty state and repeatable sample open/close without duplicates", () => {
    let state = createWorkspace(false);
    expect(getSelection(state).dataset).toBeUndefined();
    state = workspaceReducer(state, { type: "sample-add" });
    state = workspaceReducer(state, { type: "sample-add" });
    expect(state.project.datasets).toHaveLength(1);
    expect(state.project.operations).toHaveLength(1);
    state = workspaceReducer(state, {
      type: "attribute",
      attributeId: "sleep",
    });
    state = workspaceReducer(state, { type: "sample-remove" });
    expect(state.project.selection).toBeNull();
    expect(state.view.selectedAttributeByDataset).toEqual({});
    // Closing the sample is now undoable; its original operation remains archived.
    expect(state.project.operations).toHaveLength(1);
    state = workspaceReducer(state, { type: "sample-add" });
    expect(getSelection(state).version?.rows).toHaveLength(12);
  });
  it("rejects unknown IDs and round-trips a project as JSON", () => {
    const state = createWorkspace();
    expect(
      workspaceReducer(state, { type: "attribute", attributeId: "missing" }),
    ).toBe(state);
    expect(
      workspaceReducer(state, { type: "dataset", datasetId: "missing" }),
    ).toBe(state);
    expect(JSON.parse(JSON.stringify(state.project))).toEqual(state.project);
    const columns = getSelection(state).version!.columns;
    expect(columns.find((column) => column.id === "student-id")).toMatchObject({
      storageType: "number",
      semanticType: "identifier",
      useInAnalysis: false,
    });
    expect(columns.find((column) => column.id === "grade")).toMatchObject({
      storageType: "number",
      semanticType: "categorical",
    });
  });
});
