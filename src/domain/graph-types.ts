import type { Cell, ID, Row, TableFilter } from "./types";
export type GraphKind =
  "scatter" | "histogram" | "box" | "bar" | "line" | "pie" | "area" | "heatmap";
export type Aggregate = "rows" | "valid" | "sum" | "mean" | "median";
export interface GraphScope {
  kind: "all" | "filtered" | "selected";
  filter: TableFilter | null;
  duplicatesOnly: boolean;
  rowIds: ID[];
}
export interface GraphSettings {
  formatVersion: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  scope: GraphScope;
  x: ID;
  y: ID;
  group: ID;
  value: ID;
  correlationIds: ID[];
  heatmap: "cross" | "correlation";
  aggregate: Aggregate;
  binMode: "count" | "width";
  binCount: number;
  binWidth: number;
  boundaries: number[];
  ratio: boolean;
  layout: "color" | "facets";
  stacked: boolean;
  order: "source" | "ascending" | "descending";
  categoricalOrderConfirmed: boolean;
  categoryStart: number;
  categoryLimit: number;
  categoryRangeConfirmed: boolean;
  fillAbsent: boolean;
  unit: string;
  xTitle: string;
  yTitle: string;
  xRange: [number, number] | null;
  yRange: [number, number] | null;
  sampling: { method: "reservoir"; seed: number; limit: number };
}
/** A compact predicate, not a duplicate row list per mark. */
export interface GraphQuery {
  equals?: { attributeId: ID; value: Cell }[];
  numeric?: ID[];
  interval?: { attributeId: ID; min: number; max: number; includeMax: boolean };
  region?: {
    x: ID;
    y: ID;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  };
}
export interface GraphMark {
  id: string;
  label: string;
  group: string;
  x: Cell;
  y: number | null;
  count: number;
  valid: number;
  query: GraphQuery;
  box?: [number, number, number, number, number];
  outlier?: boolean;
  ratio?: number;
  denominator?: number;
  absent?: boolean;
  detail: string;
}
export interface GraphResult {
  marks: GraphMark[];
  totals: { x: Cell; value: number | null }[];
  groups: string[];
  categories: string[];
  total: number;
  scoped: number;
  used: number;
  excluded: number;
  displayed: number;
  sampleCount: number;
  sampled: boolean;
  boundaries: number[];
  warnings: string[];
  xRange: [number, number];
  yRange: [number, number];
  summaries: {
    group: string;
    rows: number;
    valid: number;
    mean: number | null;
    median: number | null;
  }[];
  durationMs: number;
}
export interface GraphRows {
  rows: Row[];
  total: number;
  page: number;
}
