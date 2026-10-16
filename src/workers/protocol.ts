import type {
  AssociationInput,
  AssociationSettings,
  AssociationTransactions,
  AssociationResult,
  AssociationView,
  AssociationDetail,
} from "../domain/association-types";
import type {
  ClusteringPlan,
  ClusteringSettings,
  ClusteringResult,
  ClusterQuery,
  ClusterDetail,
} from "../domain/clustering-types";
import type {
  RegressionPlan,
  RegressionSettings,
  RegressionResult,
  RegressionPrediction,
} from "../domain/regression-types";
import type { Cell } from "../domain/types";
import type { GraphConfig } from "../domain/types";
import type { GraphQuery, GraphResult, GraphRows } from "../domain/graph-types";
import type {
  InputTable,
  WranglingSettings,
  FittedWrangling,
  WranglingPreview,
} from "../domain/wrangling-types";
import type {
  FittedPreprocessing,
  PreprocessingSettings,
  PreprocessingPreview,
  PreprocessingLineage,
} from "../domain/preprocessing-types";
import type { VersionRef } from "../domain/types";
import type {
  AnalysisConfig,
  Json,
  WorkError,
  ImportOptions,
  ParsedImport,
  Attribute,
  Dataset,
  DeepReadonly,
  DataVersion,
  TableEdit,
  TableData,
  TableView,
  TableInspection,
} from "../domain/types";
import type { WorkspaceState } from "../state/workspace";

export type DataTask =
  | {
      kind: "association-preview" | "association-run";
      input: AssociationInput;
      settings: AssociationSettings;
    }
  | {
      kind: "association-detail";
      table: DeepReadonly<TableData>;
      result: AssociationResult;
      query: AssociationView;
    }
  | {
      kind: "clustering-run";
      plan: ClusteringPlan;
      settings: ClusteringSettings;
    }
  | {
      kind: "clustering-detail";
      table: DeepReadonly<TableData>;
      result: ClusteringResult;
      query: ClusterQuery;
    }
  | {
      kind: "regression-run";
      plan: RegressionPlan;
      settings: RegressionSettings;
    }
  | {
      kind: "regression-predict";
      plan: RegressionPlan;
      result: RegressionResult;
      values: Record<string, Cell>;
      rowId?: string;
    }
  | {
      kind: "graph-calculate";
      table: DeepReadonly<TableData>;
      graph: GraphConfig;
    }
  | {
      kind: "graph-rows";
      table: DeepReadonly<TableData>;
      graph: GraphConfig;
      query: GraphQuery;
      page: number;
    }
  | { kind: "validate-workspace"; workspace: unknown }
  | {
      kind: "wrangle-preview";
      inputs: InputTable[];
      settings: WranglingSettings;
      remaining: number;
    }
  | {
      kind: "wrangle-commit";
      inputs: InputTable[];
      fitted: DeepReadonly<FittedWrangling>;
      remaining: number;
      acknowledgedMany: boolean;
    }
  | {
      kind: "preprocess-preview";
      table: DeepReadonly<TableData>;
      source: VersionRef;
      settings: PreprocessingSettings;
    }
  | {
      kind: "preprocess-commit";
      table: DeepReadonly<TableData>;
      source: VersionRef;
      fitted: DeepReadonly<FittedPreprocessing>;
      lineage: PreprocessingLineage;
    }
  | { kind: "restore"; file: File }
  | { kind: "parse"; file: File; options: ImportOptions }
  | {
      kind: "register";
      parsed: ParsedImport;
      columns: Attribute[];
      acknowledged: boolean;
    }
  | { kind: "edit"; dataset: Dataset; versionId: string; edit: TableEdit }
  | { kind: "inspect"; table: DeepReadonly<TableData>; view: TableView };
export type DataTaskResult =
  | { kind: "association-preview"; result: AssociationTransactions }
  | { kind: "association-run"; result: AssociationResult }
  | { kind: "association-detail"; result: AssociationDetail }
  | { kind: "clustering-run"; result: ClusteringResult }
  | { kind: "clustering-detail"; result: ClusterDetail }
  | { kind: "regression-run"; result: RegressionResult }
  | { kind: "regression-predict"; result: RegressionPrediction }
  | { kind: "graph-calculate"; result: GraphResult }
  | { kind: "graph-rows"; result: GraphRows }
  | { kind: "wrangle-preview"; preview: WranglingPreview }
  | {
      kind: "wrangle-commit";
      version: DeepReadonly<DataVersion>;
      dataset: Dataset | null;
    }
  | { kind: "preprocess-preview"; preview: PreprocessingPreview }
  | { kind: "preprocess-commit"; version: DeepReadonly<DataVersion> | null }
  | { kind: "restore"; workspace: WorkspaceState }
  | { kind: "parse"; parsed: ParsedImport }
  | { kind: "register"; dataset: Dataset }
  | { kind: "edit"; version: DeepReadonly<DataVersion> | null }
  | { kind: "inspect"; inspection: TableInspection };

export type WorkerRequest =
  | { type: "run"; jobId: string; scopeId: string; config: AnalysisConfig }
  | { type: "run-task"; jobId: string; scopeId: string; task: DataTask }
  | { type: "cancel"; jobId: string; scopeId: string };
export type WorkerResponse<T = Json> =
  | {
      type: "progress";
      jobId: string;
      scopeId: string;
      completed: number;
      total: number | null;
      message: string;
    }
  | { type: "complete"; jobId: string; scopeId: string; result: T }
  | { type: "error"; jobId: string; scopeId: string; error: WorkError }
  | { type: "cancelled"; jobId: string; scopeId: string };

/** One latest job per result panel (scope). IDs must be unique for each run.
 * Call invalidate on source/config changes, even before another run starts.
 * Cancel invalidates synchronously, before the worker acknowledges cancellation.
 * A future worker should check cancellation between computation chunks.
 */
export class JobGate {
  private active = new Map<string, string>();
  startTask(
    scopeId: string,
    task: DataTask,
  ): Extract<WorkerRequest, { type: "run-task" }> {
    const jobId = crypto.randomUUID();
    this.active.set(scopeId, jobId);
    return { type: "run-task", scopeId, jobId, task };
  }
  start(scopeId: string, config: AnalysisConfig): WorkerRequest {
    const jobId = crypto.randomUUID();
    this.active.set(scopeId, jobId);
    return { type: "run", scopeId, jobId, config: structuredClone(config) };
  }
  invalidate(scopeId: string): WorkerRequest | null {
    const jobId = this.active.get(scopeId);
    this.active.delete(scopeId);
    return jobId ? { type: "cancel", scopeId, jobId } : null;
  }
  receive<T>(
    message: WorkerResponse<T>,
    commit: (message: WorkerResponse<T>) => void,
  ): boolean {
    if (this.active.get(message.scopeId) !== message.jobId) return false;
    if (message.type !== "progress") this.active.delete(message.scopeId);
    commit(message);
    return true;
  }
}
