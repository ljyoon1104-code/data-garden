import type {
  Cell,
  ColumnStatistics,
  SemanticType,
  StorageType,
  VersionRef,
} from "./types";

export type RowRule = "any" | "all";
export type PreprocessingSettings =
  | {
      kind: "missing";
      attributeIds: string[];
      method: "remove" | "mean" | "median" | "mode" | "fixed";
      rowRule: RowRule;
      fixedValues: Record<string, string>;
    }
  | { kind: "duplicates"; attributeIds: string[]; keep: "first" | "last" }
  | {
      kind: "outliers";
      attributeIds: string[];
      detection: "iqr" | "bounds";
      multiplier: number;
      lower: number;
      upper: number;
      action: "mark" | "remove" | "missing" | "clip" | "median";
      rowRule: RowRule;
    }
  | { kind: "scale"; attributeIds: string[]; method: "minmax" | "zscore" };

export interface ColumnBasis {
  storageType: StorageType;
  semanticType: SemanticType;
  validCount: number;
  missingCount: number;
  replacement?: Cell;
  min?: number;
  max?: number;
  mean?: number;
  stddev?: number;
  q1?: number;
  q3?: number;
  lower?: number;
  upper?: number;
}
export interface FittedPreprocessing {
  formatVersion: 1;
  settings: PreprocessingSettings;
  source: VersionRef;
  fitRows: { kind: "all" | "training"; rowIds: string[]; count: number };
  columns: Record<string, ColumnBasis>;
  conventions: {
    missing: "null-or-empty";
    modeTie: "first-in-fit-order";
    quantile: "linear-n-minus-one";
    standardDeviation: "population-n";
    duplicateEquality: "typed-json";
  };
}
export interface PreprocessingLineage {
  origin: VersionRef;
  previousOperationIds: string[];
}
export interface PreprocessingRecord extends PreprocessingLineage {
  formatVersion: 1;
  input: VersionRef;
  fitted: FittedPreprocessing;
  changedCells: number;
  removedRowIds: string[];
}
export interface CellChange {
  rowId: string;
  attributeId: string;
  before: Cell;
  after: Cell;
}
export interface PreprocessingPreview {
  fitted: FittedPreprocessing;
  beforeRows: number;
  afterRows: number;
  columnCount: number;
  changedCells: number;
  changes: CellChange[];
  removedRowIds: string[];
  candidates: { rowId: string; attributeId: string; value: Cell }[];
  duplicateGroups: { rowIds: string[]; keptRowId: string }[];
  beforeStatistics: Record<string, ColumnStatistics>;
  afterStatistics: Record<string, ColumnStatistics>;
}
