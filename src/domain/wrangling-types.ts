import type {
  Attribute,
  Cell,
  DeepReadonly,
  TableData,
  VersionRef,
} from "./types";

export interface InputTable {
  source: VersionRef;
  name: string;
  table: DeepReadonly<TableData>;
}
export interface InputAttribute {
  input: number;
  attributeId: string;
}
export interface InputRows {
  input: number;
  rowIds: string[];
}
export type Operand =
  | { kind: "attribute"; attributeId: string }
  | { kind: "constant"; value: number };
export type DatePart =
  | "year"
  | "month"
  | "day"
  | "quarter"
  | "weekday"
  | "hour"
  | "minute"
  | "second";
export type AggregateMethod =
  "rows" | "valid" | "sum" | "mean" | "min" | "max" | "median";
export interface OutputField {
  name: string;
  description: string;
}
export type WranglingSettings =
  | {
      kind: "calculate";
      operator:
        | "add"
        | "subtract"
        | "multiply"
        | "divide"
        | "sum"
        | "mean"
        | "ratio"
        | "percent";
      operands: Operand[];
      missing: "propagate" | "skip";
      invalid: "block" | "missing";
      output: OutputField;
    }
  | {
      kind: "date";
      attributeId: string;
      parts: {
        part: DatePart;
        name: string;
        description: string;
        storageType: "number" | "string";
        semanticType: "numeric" | "categorical" | "identifier" | "text";
      }[];
      invalid: "block" | "missing";
    }
  | {
      kind: "encode";
      attributeId: string;
      method: "code" | "onehot";
      output: OutputField;
      order: Cell[] | null;
      dropBaseline: boolean;
      baseline: Cell;
      unknown: "block" | "missing";
    }
  | {
      kind: "bin";
      attributeId: string;
      method: "width" | "frequency";
      count: number;
      labels: string[];
      outside: "block" | "missing" | "edge";
      output: OutputField;
    }
  | {
      kind: "join";
      mode: "inner" | "left" | "full";
      keys: { left: string; right: string }[];
      columnNames: Record<string, string>;
      name: string;
    }
  | {
      kind: "stack";
      mappings: { key: string; name: string; sources: InputAttribute[] }[];
      excluded: InputAttribute[];
      typeConflict: "block" | "mixed";
      name: string;
    }
  | {
      kind: "aggregate";
      groupIds: string[];
      includeMissing: boolean;
      aggregates: {
        method: AggregateMethod;
        attributeId: string | null;
        name: string;
        description: string;
      }[];
      name: string;
    };
export interface EncodingBasis {
  kind: "encode";
  categories: {
    value: Cell;
    count: number;
    code: number;
    columnId: string | null;
  }[];
  baselineIndex: number | null;
}
export interface BinningBasis {
  kind: "bin";
  boundaries: number[];
  labels: string[];
  counts: number[];
}
export interface FittedWrangling {
  formatVersion: 1;
  settings: WranglingSettings;
  inputs: VersionRef[];
  fitScopes: { kind: "all" | "training"; rowIds: string[]; count: number }[];
  /** Added columns for single-table work; all columns for derived work. IDs stay fixed during apply. */
  columns: Attribute[];
  columnSources: Record<string, InputAttribute[]>;
  referencedAttributes: InputAttribute[];
  inputSchema: (InputAttribute &
    Pick<Attribute, "storageType" | "semanticType">)[];
  basis: EncodingBasis | BinningBasis | null;
  conventions: {
    missing: "null-or-empty";
    equality: "typed-json";
    weekday: "monday-1-sunday-7";
    quantile: "linear-n-minus-one";
    interval: "left-closed-last-both";
  };
}
export interface WranglingRecord {
  formatVersion: 1;
  inputs: VersionRef[];
  output: VersionRef;
  fitted: FittedWrangling;
  rowSources: Record<string, InputRows[]>;
}
export interface WranglingIssue {
  input: number;
  rowId: string;
  message: string;
  blocking: boolean;
}
export interface JoinGroup {
  key: Cell[];
  leftRowIds: string[];
  rightRowIds: string[];
  relation: "1:1" | "1:N" | "N:1" | "N:M" | "unmatched";
}
export interface WranglingPreview {
  fitted: FittedWrangling;
  table: TableData;
  rowSources: Record<string, InputRows[]>;
  issues: WranglingIssue[];
  summary: {
    inputRows: number[];
    outputRows: number;
    outputColumns: number;
    addedColumns: number;
    manyToManyGroups: number;
    matchedLeft: number;
    matchedRight: number;
    unmatchedLeft: number;
    unmatchedRight: number;
    binCounts: number[];
    validOperandCounts: Record<string, number>;
  };
  joinGroups: JoinGroup[];
  warnings: string[];
}
