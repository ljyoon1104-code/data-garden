import { defaultAssociationView } from "../domain/association";
import { cleanResultReferences, targetExists, validateResultState } from '../domain/results';
import type { Interpretation } from '../domain/types';
import { clusteringValidationBudget } from "../domain/clustering-validation";
import { analysisConfigKey } from "../domain/clustering";
import type { AnalysisConfig, AnalysisRecord } from "../domain/types";
import { validateGraph, normalizedGraph } from "../domain/graphs";
import type { GraphConfig } from "../domain/types";
import { assertOutputSize } from "../domain/wrangling";
import {
  canAppendTable,
  preservedCellCount,
  MAX_PRESERVED_CELLS,
} from "../domain/limits";
import { createSample, SAMPLE_ID } from "../data/sample";
import type {
  Menu,
  Project,
  ViewState,
  Dataset,
  DeepReadonly,
  DataVersion,
  TableView,
  VersionRef,
} from "../domain/types";
import { snapshot } from "../domain/model";
import { defaultTableView } from "../domain/table";

export interface WorkspaceState {
  project: Project;
  view: ViewState;
}
export function createWorkspace(withSample = true): WorkspaceState {
  const now = new Date().toISOString();
  const sample = createSample(now);
  return {
    project: {
      id: crypto.randomUUID(),
      name: "나의 첫 데이터 탐구",
      schemaVersion: 6,
      activeVersions: withSample ? { [sample.id]: sample.versions[0].id } : {},
      history: { entries: [], cursor: 0 },
      datasets: withSample ? [sample] : [],
      selection: withSample
        ? { datasetId: sample.id, versionId: sample.versions[0].id }
        : null,
      operations: withSample ? [sample.versions[0].operation] : [],
      graphs: [],
      analysisConfigs: {},
      analyses: [],
      interpretations: [],
      createdAt: now,
      updatedAt: now,
    },
    view: {
      menu: "data",
      selectedAttributeByDataset: {},
      density: "comfortable",
      inspectorOpen: true,
      tables: {},
    },
  };
}
export type WorkspaceAction =
  | { type: 'interpretation-save'; interpretation: Interpretation }
  | { type: 'interpretation-delete'; id: string }
  | { type: 'report-selection'; report: NonNullable<ViewState['report']> }
  | { type: 'result-detail'; target: ViewState['resultDetail'] }
  | {
      type: "analysis-family";
      family: NonNullable<ViewState["analysisFamily"]>;
    }
  | { type: "association-select"; id: string | null; comparison?: boolean }
  | {
      type: "association-view";
      id: string;
      patch: Partial<import("../domain/association-types").AssociationView>;
    }
  | { type: "cluster-select"; id: string | null; comparison?: boolean }
  | { type: "cluster-axes"; id: string; x: string; y: string }
  | { type: "analysis-config"; config: AnalysisConfig }
  | { type: "analysis-record"; record: AnalysisRecord }
  | { type: "analysis-delete"; id: string }
  | { type: "analysis-select"; id: string | null; comparison?: boolean }
  | { type: "graph-save"; graph: GraphConfig }
  | { type: "graph-delete"; id: string }
  | { type: "graph-select"; id: string | null; comparison?: boolean }
  | { type: "replace"; state: WorkspaceState }
  | { type: "rename"; name: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "menu"; menu: Menu }
  | { type: "attribute"; attributeId: string | null }
  | { type: "dataset"; datasetId: string }
  | { type: "density"; density: ViewState["density"] }
  | { type: "inspector" }
  | { type: "sample-add" }
  | { type: "import"; dataset: Dataset }
  | { type: "register-derived"; dataset: Dataset; expectedInputs: VersionRef[] }
  | {
      type: "commit-version";
      datasetId: string;
      baseVersionId: string;
      version: DeepReadonly<DataVersion>;
    }
  | { type: "table-view"; datasetId: string; patch: Partial<TableView> }
  | { type: "sample-remove" };
export function getSelection(state: WorkspaceState) {
  const dataset = state.project.datasets.find(
    (item) => item.id === state.project.selection?.datasetId,
  );
  const version = dataset?.versions.find(
    (item) => item.id === state.project.selection?.versionId,
  );
  const attribute = version?.columns.find(
    (item) => item.id === state.view.selectedAttributeByDataset[dataset!.id],
  );
  return { dataset, version, attribute };
}
function reduceWorkspace(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  const { project, view } = state;
  switch (action.type) {
    case 'result-detail':
      return !action.target || targetExists(project, action.target) ? {...state,view:{...view,resultDetail:action.target}} : state;
    case 'report-selection': {
      const next = {...view,report:structuredClone(action.report)};
      validateResultState(project,next);
      return {...state,view:next};
    }
    case 'interpretation-save': {
      const i = action.interpretation;
      if (!targetExists(project,i.target) || !i.text.trim()) return state;
      const old = project.interpretations.find(x=>x.id===i.id);
      if (old && JSON.stringify(old.target)!==JSON.stringify(i.target)) return state;
      const saved = {...i, createdAt:old?.createdAt ?? i.createdAt, origin: 'user' as const};
      const p = {...project, updatedAt:i.updatedAt,
        interpretations: old ? project.interpretations.map(x=>x.id===i.id?saved:x) : [...project.interpretations,saved],
        analyses: project.analyses.map(a=>a.id===i.target.id && i.target.kind==='analysis'
          ? {...a,interpretationIds:[...new Set([...a.interpretationIds,i.id])]} : a)};
      validateResultState(p,view);
      return {...state,project:p};
    }
    case 'interpretation-delete': {
      const p = {...project,updatedAt:new Date().toISOString(),
        interpretations:project.interpretations.filter(i=>i.id!==action.id),
        analyses:project.analyses.map(a=>a.interpretationIds.includes(action.id)
          ? {...a,interpretationIds:a.interpretationIds.filter(id=>id!==action.id)} : a)};
      return {...state,project:p};
    }
    case "analysis-family":
      return { ...state, view: { ...view, analysisFamily: action.family } };
    case "association-view":
      if (!project.analyses.some((a) => a.id === action.id && a.association))
        return state;
      return {
        ...state,
        view: {
          ...view,
          associationViews: {
            ...view.associationViews,
            [action.id]: {
              ...defaultAssociationView(),
              ...view.associationViews?.[action.id],
              ...action.patch,
            },
          },
        },
      };
    case "association-select":
      if (
        action.id &&
        !project.analyses.some(
          (a) => a.id === action.id && a.kind === "association",
        )
      )
        return state;
      return {
        ...state,
        view: {
          ...view,
          associationSelection: {
            current: view.associationSelection?.current ?? null,
            comparison: view.associationSelection?.comparison ?? null,
            [action.comparison ? "comparison" : "current"]: action.id,
          },
        },
      };
    case "cluster-axes":
      return {
        ...state,
        view: {
          ...view,
          clusterAxes: {
            ...view.clusterAxes,
            [action.id]: { x: action.x, y: action.y },
          },
        },
      };
    case "cluster-select":
      if (
        action.id &&
        !project.analyses.some(
          (a) => a.id === action.id && a.kind === "clustering",
        )
      )
        return state;
      return {
        ...state,
        view: {
          ...view,
          clusterSelection: {
            current: view.clusterSelection?.current ?? null,
            comparison: view.clusterSelection?.comparison ?? null,
            [action.comparison ? "comparison" : "current"]: action.id,
          },
        },
      };
    case "analysis-config":
      return {
        ...state,
        project: {
          ...project,
          analysisConfigs: {
            ...project.analysisConfigs,
            [analysisConfigKey(
              action.config.source.datasetId,
              action.config.kind,
            )]: structuredClone(action.config),
          },
          updatedAt: new Date().toISOString(),
        },
      };
    case "analysis-select":
      if (
        action.id &&
        !project.analyses.some(
          (a) => a.id === action.id && a.kind === "regression",
        )
      )
        return state;
      return {
        ...state,
        view: {
          ...view,
          [action.comparison ? "comparisonAnalysisId" : "currentAnalysisId"]:
            action.id,
        },
      };
    case "analysis-delete":
      return {
        view: {
          ...view,
          associationSelection: {
            current:
              view.associationSelection?.current === action.id
                ? null
                : (view.associationSelection?.current ?? null),
            comparison:
              view.associationSelection?.comparison === action.id
                ? null
                : (view.associationSelection?.comparison ?? null),
          },
          associationViews: Object.fromEntries(
            Object.entries(view.associationViews ?? {}).filter(
              ([id]) => id !== action.id,
            ),
          ),
          clusterSelection: {
            current:
              view.clusterSelection?.current === action.id
                ? null
                : (view.clusterSelection?.current ?? null),
            comparison:
              view.clusterSelection?.comparison === action.id
                ? null
                : (view.clusterSelection?.comparison ?? null),
          },
          clusterAxes: Object.fromEntries(
            Object.entries(view.clusterAxes ?? {}).filter(
              ([id]) => id !== action.id,
            ),
          ),
          currentAnalysisId:
            view.currentAnalysisId === action.id
              ? null
              : view.currentAnalysisId,
          comparisonAnalysisId:
            view.comparisonAnalysisId === action.id
              ? null
              : view.comparisonAnalysisId,
        },
        project: {
          ...project,
          analyses: project.analyses.filter((a) => a.id !== action.id),
          interpretations: project.interpretations.filter(
            (i) => i.target.kind !== "analysis" || i.target.id !== action.id,
          ),
          updatedAt: new Date().toISOString(),
        },
      };
    case "analysis-record": {
      const old = project.analyses.find((a) => a.id === action.record.id);
      if (old && ["completed", "failed", "cancelled"].includes(old.status))
        return state;
      if (!old && project.analyses.length >= 50) return state;
      if (action.record.clustering) {
        try {
          clusteringValidationBudget([
            ...project.analyses.filter((a) => a.id !== action.record.id),
            action.record,
          ]);
        } catch {
          return state;
        }
      }
      const record = snapshot(action.record) as AnalysisRecord;
      return {
        view:
          record.kind === "clustering"
            ? {
                ...view,
                clusterSelection: {
                  current: record.id,
                  comparison: view.clusterSelection?.comparison ?? null,
                },
              }
            : record.kind === "association"
              ? {
                  ...view,
                  associationSelection: {
                    current: record.id,
                    comparison: view.associationSelection?.comparison ?? null,
                  },
                }
              : { ...view, currentAnalysisId: record.id },
        project: {
          ...project,
          analyses: old
            ? project.analyses.map((a) => (a.id === record.id ? record : a))
            : [...project.analyses, record],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    case "graph-select":
      if (action.id && !project.graphs.some((g) => g.id === action.id))
        return state;
      return {
        ...state,
        view: {
          ...view,
          [action.comparison ? "comparisonGraphId" : "currentGraphId"]:
            action.id,
        },
      };
    case "graph-delete":
      return {
        view: {
          ...view,
          currentGraphId:
            view.currentGraphId === action.id ? null : view.currentGraphId,
          comparisonGraphId:
            view.comparisonGraphId === action.id
              ? null
              : view.comparisonGraphId,
        },
        project: {
          ...project,
          graphs: project.graphs.filter((g) => g.id !== action.id),
          interpretations: project.interpretations.filter(
            (i) => i.target.kind !== "graph" || i.target.id !== action.id,
          ),
          updatedAt: new Date().toISOString(),
        },
      };
    case "graph-save": {
      const g = action.graph,
        v = project.datasets
          .find((d) => d.id === g.source.datasetId)
          ?.versions.find((v) => v.id === g.source.versionId);
      if (!v || !g.visual) return state;
      try {
        validateGraph(g, v);
      } catch {
        return state;
      }
      const saved = structuredClone(normalizedGraph(g));
      return {
        view: { ...view, currentGraphId: g.id },
        project: {
          ...project,
          graphs: project.graphs.some((x) => x.id === g.id)
            ? project.graphs.map((x) => (x.id === g.id ? saved : x))
            : [...project.graphs, saved],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    case "replace":
      return action.state;
    case "rename":
      return action.name.trim() && action.name.trim() !== project.name
        ? {
            ...state,
            project: {
              ...project,
              name: action.name.trim(),
              updatedAt: new Date().toISOString(),
            },
          }
        : state;
    case "undo":
    case "redo":
      return state;
    case "register-derived": {
      const v = action.dataset.versions[0];
      if (
        action.dataset.source.kind !== "derived" ||
        !v?.operation.wrangling ||
        JSON.stringify(action.expectedInputs) !==
          JSON.stringify(v.operation.wrangling.inputs) ||
        action.expectedInputs.some(
          (r) => project.activeVersions[r.datasetId] !== r.versionId,
        )
      )
        return state;
      try {
        assertOutputSize(
          v.rows.length,
          v.columns.length,
          MAX_PRESERVED_CELLS - preservedCellCount(project),
          2,
        );
      } catch {
        return state;
      }
      return reduceWorkspace(state, {
        type: "import",
        dataset: action.dataset,
      });
    }
    case "import": {
      const newCells = [
        action.dataset.original.table,
        ...action.dataset.versions,
      ].reduce((sum, t) => sum + t.rows.length * t.columns.length, 0);
      if (preservedCellCount(project) + newCells > MAX_PRESERVED_CELLS)
        return state;
      if (project.datasets.some((d) => d.id === action.dataset.id))
        return state;
      const incoming = action.dataset;
      const dataset: Dataset = {
        ...incoming,
        source: structuredClone(incoming.source),
        original: snapshot(incoming.original),
        versions: incoming.versions.map((v) => snapshot(v)),
      };
      return {
        view,
        project: {
          ...project,
          datasets: [...project.datasets, dataset],
          selection: {
            datasetId: dataset.id,
            versionId: dataset.versions.at(-1)!.id,
          },
          operations: [
            ...project.operations,
            ...dataset.versions.map((v) => v.operation),
          ],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    case "commit-version": {
      const dataset = project.datasets.find((d) => d.id === action.datasetId);
      if (
        !canAppendTable(
          project,
          action.version.rows.length,
          action.version.columns.length,
        ) ||
        !dataset ||
        project.selection?.datasetId !== dataset.id ||
        project.selection.versionId !== action.baseVersionId ||
        action.version.datasetId !== dataset.id ||
        !action.version.parentVersionIds.includes(action.baseVersionId) ||
        dataset.versions.some((v) => v.id === action.version.id)
      )
        return state;
      if (action.version.operation.wrangling) {
        if (
          action.version.operation.wrangling.inputs.some(
            (r) => project.activeVersions[r.datasetId] !== r.versionId,
          )
        )
          return state;
        try {
          assertOutputSize(
            action.version.rows.length,
            action.version.columns.length,
            MAX_PRESERVED_CELLS - preservedCellCount(project),
          );
        } catch {
          return state;
        }
      }
      const version = snapshot(action.version);
      const previousView = view.tables[dataset.id] || defaultTableView();
      const remainingRows = new Set(version.rows.map((r) => r.id));
      return {
        view: {
          ...view,
          tables: {
            ...view.tables,
            [dataset.id]: {
              ...previousView,
              page:
                version.operation.kind === "preprocess" ? 0 : previousView.page,
              selectedRowIds: previousView.selectedRowIds.filter((id) =>
                remainingRows.has(id),
              ),
            },
          },
        },
        project: {
          ...project,
          datasets: project.datasets.map((d) =>
            d.id === dataset.id
              ? { ...d, versions: [...d.versions, version] }
              : d,
          ),
          selection: { datasetId: dataset.id, versionId: version.id },
          operations: [...project.operations, version.operation],
          updatedAt: new Date().toISOString(),
        },
      };
    }
    case "table-view": {
      if (!project.datasets.some((d) => d.id === action.datasetId))
        return state;
      return {
        project,
        view: {
          ...view,
          tables: {
            ...view.tables,
            [action.datasetId]: {
              ...(view.tables[action.datasetId] || defaultTableView()),
              ...action.patch,
            },
          },
        },
      };
    }
    case "menu":
      return { project, view: { ...view, menu: action.menu } };
    case "density":
      return { project, view: { ...view, density: action.density } };
    case "inspector":
      return { project, view: { ...view, inspectorOpen: !view.inspectorOpen } };
    case "attribute": {
      const { dataset, version } = getSelection(state);
      if (
        !dataset ||
        (action.attributeId !== null &&
          !version?.columns.some((column) => column.id === action.attributeId))
      )
        return state;
      return {
        project,
        view: {
          ...view,
          selectedAttributeByDataset: {
            ...view.selectedAttributeByDataset,
            [dataset.id]: action.attributeId,
          },
        },
      };
    }
    case "dataset": {
      const dataset = project.datasets.find(
        (item) => item.id === action.datasetId,
      );
      const version = dataset?.versions.find(
        (v) => v.id === project.activeVersions[dataset.id],
      );
      if (!dataset || !version || dataset.id === project.selection?.datasetId)
        return state;
      return {
        view,
        project: {
          ...project,
          selection: { datasetId: dataset.id, versionId: version.id },
          updatedAt: new Date().toISOString(),
        },
      };
    }
    case "sample-add": {
      const existing = project.datasets.find((d) => d.id === SAMPLE_ID);
      if (existing && project.activeVersions[SAMPLE_ID]) return state;
      if (existing)
        return {
          ...state,
          project: {
            ...project,
            selection: {
              datasetId: existing.id,
              versionId: existing.versions.at(-1)!.id,
            },
          },
        };
      return reduceWorkspace(state, {
        type: "import",
        dataset: createSample(new Date().toISOString()),
      });
    }
    case "sample-remove": {
      if (!project.activeVersions[SAMPLE_ID]) return state;
      const next = project.datasets.find(
        (d) => d.id !== SAMPLE_ID && project.activeVersions[d.id],
      );
      const selectedAttributeByDataset = { ...view.selectedAttributeByDataset };
      delete selectedAttributeByDataset[SAMPLE_ID];
      return {
        view: { ...view, selectedAttributeByDataset },
        project: {
          ...project,
          selection: next
            ? {
                datasetId: next.id,
                versionId: project.activeVersions[next.id]!,
              }
            : null,
        },
      };
    }
  }
}

export function activeDatasets(project: Project) {
  return project.datasets.filter((d) => project.activeVersions[d.id] != null);
}

/** Only references are journalled. Preserved versions never leave the project on undo/branch. */
export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  const { project } = state;
  if (action.type === "undo" || action.type === "redo") {
    const undo = action.type === "undo";
    const index = undo ? project.history.cursor - 1 : project.history.cursor;
    const entry = project.history.entries[index];
    if (!entry) return state;
    const targetVersionId = undo ? entry.beforeVersionId : entry.afterVersionId;
    const targetVersion = project.datasets
      .find((d) => d.id === entry.datasetId)
      ?.versions.find((v) => v.id === targetVersionId);
    const oldView = state.view.tables[entry.datasetId];
    const remainingRows = new Set(targetVersion?.rows.map((r) => r.id));
    return {
      ...state,
      view:
        targetVersion && oldView
          ? {
              ...state.view,
              tables: {
                ...state.view.tables,
                [entry.datasetId]: {
                  ...oldView,
                  page: 0,
                  selectedRowIds: oldView.selectedRowIds.filter((id) =>
                    remainingRows.has(id),
                  ),
                },
              },
            }
          : state.view,
      project: {
        ...project,
        activeVersions: {
          ...project.activeVersions,
          [entry.datasetId]: undo
            ? entry.beforeVersionId
            : entry.afterVersionId,
        },
        selection: undo ? entry.beforeSelection : entry.afterSelection,
        history: {
          ...project.history,
          cursor: project.history.cursor + (undo ? -1 : 1),
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  let next = reduceWorkspace(state, action);
  if (action.type === 'analysis-delete' || action.type === 'graph-delete')
    next = {...next, view:cleanResultReferences(next.project,next.view)};
  if (
    next === state ||
    ![
      "import",
      "register-derived",
      "commit-version",
      "sample-add",
      "sample-remove",
    ].includes(action.type)
  )
    return next;
  const datasetId =
    action.type === "sample-remove"
      ? SAMPLE_ID
      : next.project.selection!.datasetId;
  const afterVersionId =
    action.type === "sample-remove" ? null : next.project.selection!.versionId;
  const entry = {
    id: crypto.randomUUID(),
    label:
      action.type === "register-derived"
        ? "파생 자료 만들기"
        : action.type === "commit-version" &&
            action.version.operation.kind === "wrangle"
          ? "자료 가공"
          : action.type === "import"
            ? "자료 불러오기"
            : action.type === "sample-add"
              ? "샘플 열기"
              : action.type === "sample-remove"
                ? "샘플 닫기"
                : action.type === "commit-version" &&
                    action.version.operation.kind === "edit-cell"
                  ? "셀 값 수정"
                  : action.type === "commit-version" &&
                      action.version.operation.kind === "preprocess"
                    ? "자료 전처리"
                    : "속성 수정",
    datasetId,
    beforeVersionId: project.activeVersions[datasetId] ?? null,
    afterVersionId,
    beforeSelection: project.selection,
    afterSelection: next.project.selection,
    operationIds: next.project.operations
      .slice(project.operations.length)
      .map((op) => op.id),
    executedAt: new Date().toISOString(),
  };
  const entries = [
    ...project.history.entries.slice(0, project.history.cursor),
    entry,
  ];
  return {
    ...next,
    project: {
      ...next.project,
      activeVersions: {
        ...project.activeVersions,
        [datasetId]: afterVersionId,
      },
      history: { entries, cursor: entries.length },
      updatedAt: entry.executedAt,
    },
  };
}
