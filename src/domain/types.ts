import type {
  AssociationSettings,
  AssociationResult,
  AssociationView,
} from "./association-types";
import type { ClusteringSettings, ClusteringResult } from "./clustering-types";
import type { RegressionSettings, RegressionResult } from "./regression-types";
import type { GraphKind, GraphSettings } from "./graph-types";
import type { WranglingRecord } from "./wrangling-types";
import type { PreprocessingRecord } from "./preprocessing-types";
/** All persisted domain values are JSON serializable. Dates use ISO 8601 strings. */
export type ID = string;
export interface JsonObject {
  [key: string]: Json;
}
export interface JsonArray extends Array<Json> {}
export type Json = null | boolean | number | string | JsonArray | JsonObject;
export type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;
export type Cell = string | number | boolean | null;
export type StorageType = "number" | "string" | "boolean" | "mixed";
export type SemanticType =
  "numeric" | "categorical" | "date" | "identifier" | "text";
export interface Attribute {
  id: ID;
  name: string;
  storageType: StorageType;
  semanticType: SemanticType;
  description: string;
  useInAnalysis: boolean;
}
export interface Row {
  id: ID;
  values: Record<ID, Cell>;
}
export interface TableData {
  columns: Attribute[];
  rows: Row[];
}
export interface SourceInfo {
  kind: "sample" | "file" | "manual" | "derived";
  label: string;
  importedAt: string;
  fileName?: string;
  mimeType?: string;
  importOptions?: ImportOptions;
}
export interface OriginalData {
  table: TableData;
  cellMetadata?: Record<
    ID,
    Record<ID, { display: string; format: string; type: string }>
  >;
}
export type OperationKind =
  | "wrangle"
  | "preprocess"
  | "sample"
  | "import"
  | "clean"
  | "derive"
  | "join"
  | "transform"
  | "edit-cell"
  | "edit-attribute";
export interface OperationRecord {
  preprocessing?: PreprocessingRecord;
  wrangling?: WranglingRecord;
  id: ID;
  kind: OperationKind;
  datasetId: ID;
  inputVersionIds: ID[];
  outputVersionIds: ID[];
  settings: Json;
  executedAt: string;
}
export interface DataVersion extends TableData {
  id: ID;
  datasetId: ID;
  parentVersionIds: ID[];
  createdAt: string;
  operation: OperationRecord;
}
export interface Dataset {
  id: ID;
  name: string;
  source: SourceInfo;
  original: DeepReadonly<OriginalData>;
  versions: DeepReadonly<DataVersion>[];
}
export interface VersionRef {
  datasetId: ID;
  versionId: ID;
}
export type AnalysisKind = "regression" | "clustering" | "association";
export interface AnalysisConfig {
  association?: AssociationSettings;
  clustering?: ClusteringSettings;
  regression?: RegressionSettings;
  kind: AnalysisKind;
  source: VersionRef;
  attributeIds: ID[];
  parameters: Json;
  preprocessing: {
    steps: { method: string; attributeIds: ID[]; settings: Json }[];
  };
  calculation: {
    missingValuePolicy: string | null;
    method: string | null;
    settings: Json;
  };
  split: { method: "none" | "holdout" | "cross-validation"; settings: Json };
  randomness: { seed: number | null; settings: Json };
}
export interface WorkError {
  code: string;
  message: string;
  cause?: string;
  remedy?: string;
}
export interface Interpretation {
  origin?: "user" | "example";
  id: ID;
  target: { kind: "analysis" | "graph" | "project"; id: ID };
  text: string;
  createdAt: string;
  updatedAt: string;
}
export interface AnalysisRecord {
  association?: AssociationResult;
  clustering?: ClusteringResult;
  regression?: RegressionResult;
  id: ID;
  kind: AnalysisKind;
  configSnapshot: DeepReadonly<AnalysisConfig>;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: Json;
  error?: WorkError;
  interpretationIds: ID[];
  createdAt: string;
  completedAt?: string;
}
export interface GraphConfig {
  id: ID;
  source: VersionRef;
  kind: GraphKind;
  visual?: GraphSettings;
  axes: { x?: ID; y?: ID; settings: Json };
  grouping: { attributeIds: ID[]; settings: Json };
  bins: { method: string | null; settings: Json };
  aggregation: { method: string | null; attributeIds: ID[]; settings: Json };
}
export interface Project {
  id: ID;
  name: string;
  schemaVersion: 6;
  datasets: Dataset[];
  /** null keeps an undone import archived for historical references. */
  activeVersions: Record<ID, ID | null>;
  history: { entries: HistoryEntry[]; cursor: number };
  selection: VersionRef | null;
  operations: DeepReadonly<OperationRecord>[];
  graphs: GraphConfig[];
  analysisConfigs: Record<ID, AnalysisConfig>;
  analyses: AnalysisRecord[];
  interpretations: Interpretation[];
  createdAt: string;
  updatedAt: string;
}
export interface HistoryEntry {
  id: ID;
  label: string;
  datasetId: ID;
  beforeVersionId: ID | null;
  afterVersionId: ID | null;
  beforeSelection: VersionRef | null;
  afterSelection: VersionRef | null;
  operationIds: ID[];
  executedAt: string;
}
export type Menu = "data" | "prepare" | "visualize" | "analyze" | "results";
/** UI preferences stay separate from the serializable project document. */
export interface ViewState {
  resultDetail?: import('./results').ResultTarget | null;
  report?: import('./results').ReportSelection;
  menu: Menu;
  analysisFamily?: "regression" | "clustering" | "experiment" | "association";
  associationSelection?: { current: ID | null; comparison: ID | null };
  associationViews?: Record<ID, AssociationView>;
  clusterSelection?: { current: ID | null; comparison: ID | null };
  clusterAxes?: Record<ID, { x: ID; y: ID }>;
  currentGraphId?: ID | null;
  currentAnalysisId?: ID | null;
  comparisonAnalysisId?: ID | null;
  comparisonGraphId?: ID | null;
  selectedAttributeByDataset: Record<ID, ID | null>;
  density: "comfortable" | "compact";
  inspectorOpen: boolean;
  tables: Record<ID, TableView>;
}

export interface ImportOptions {
  encoding: "utf-8" | "euc-kr";
  delimiter: "," | ";" | "\t" | "|";
  header: boolean;
  sheet: string;
  xlsxValues: "smart" | "raw" | "display";
}
export interface ImportIssue {
  message: string;
  remedy: string;
}
export interface ParsedImport {
  fileName: string;
  mimeType: string;
  sheets: string[];
  options: ImportOptions;
  original: TableData;
  proposed: TableData;
  cellMetadata: NonNullable<OriginalData["cellMetadata"]>;
  issues: ImportIssue[];
  empty: boolean;
}
export type FilterOperator =
  "contains" | "equals" | "gt" | "lt" | "missing" | "present";
export interface TableFilter {
  attributeId: ID;
  operator: FilterOperator;
  value: string;
}
export interface TableView {
  sort: { attributeId: ID; direction: "asc" | "desc" } | null;
  filter: TableFilter | null;
  selectedRowIds: ID[];
  selectedColumnIds: ID[];
  page: number;
  pageSize: number;
  duplicatesOnly: boolean;
  statisticsScope: "all" | "filtered";
}
export interface ColumnStatistics {
  missing: number;
  missingRatio: number;
  unique: number;
  numeric?: {
    valid: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    median: number | null;
    stddev: number | null;
    overflow: boolean;
  };
  frequencies?: { value: Cell; count: number }[];
}
export interface TableInspection {
  rowIds: ID[];
  statisticsRows: number;
  statistics: Record<ID, ColumnStatistics>;
  duplicateRowIds: ID[];
  duplicateExtraCount: number;
  duplicateGroupCount: number;
}
export type TableEdit =
  | {
      kind: "cell";
      rowId: ID;
      attributeId: ID;
      value: string;
      missing: boolean;
    }
  | { kind: "attribute"; attribute: Attribute; allowLoss: boolean };
