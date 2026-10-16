import type {
  AnalysisConfig,
  Attribute,
  ColumnStatistics,
  TableData,
  VersionRef,
} from "./types";
import type { GraphScope } from "./graph-types";
export interface ClusteringSettings {
  formatVersion: 1;
  features: string[];
  scope: GraphScope;
  ks: number[];
  missing: "remove" | "mean" | "median";
  scaling: "none" | "minmax" | "zscore";
  seed: number;
  initialization: "kmeans++" | "random" | "manual";
  manualCenters: number[][];
  restarts: number;
  maxIterations: number;
  tolerance: number;
  silhouette: {
    mode: "exact" | "sample" | "none";
    sampleSize: number;
    seed: number;
  };
}
export type ClusteringConfig = AnalysisConfig & {
  clustering: ClusteringSettings;
};
export interface ClusteringPlan {
  source: VersionRef;
  table: TableData;
  scopeRowIds: string[];
}
export interface ClusterBasis {
  attributeId: string;
  fill: number | null;
  offset: number;
  divisor: number;
  valid: number;
  missing: number;
}
export interface ClusterIteration {
  before: number[][];
  after: number[][];
  counts: number[];
  assignmentSse: number;
  updatedSse: number;
  movement: number;
  changes: number;
  events: string[];
}
export interface ClusterRestart {
  initialCenters: number[][];
  seed: number;
  sse: number | null;
  iterations: number;
  converged: boolean;
  reason: string;
  history: ClusterIteration[];
  centers: number[][];
  finalReassignment: boolean;
}
export interface SilhouettePoint {
  rowId: string;
  value: number | null;
  reason: string | null;
  a: number | null;
  b: number | null;
  nearestCluster: number | null;
  sums: number[];
  denominators: number[];
}
export interface ClusterSilhouette {
  mode: "exact" | "sample" | "none";
  population: number;
  evaluationRowIds: string[];
  seed: number;
  mean: number | null;
  reason: string | null;
  clusters: {
    count: number;
    evaluated: number;
    mean: number | null;
    reason: string | null;
  }[];
}
export interface ClusterCandidate {
  k: number;
  bestRestart: number | null;
  restarts: ClusterRestart[];
  centers: number[][];
  labels: number[];
  squaredDistances: number[];
  counts: number[];
  clusterSse: number[];
  sse: number | null;
  silhouette: ClusterSilhouette | null;
  elapsedMs: number;
  error: string | null;
}
export interface ClusteringResult {
  formatVersion: 1;
  calculationVersion: "kmeans-1";
  source: VersionRef;
  features: Attribute[];
  scopeRowIds: string[];
  rowIds: string[];
  excluded: { rowId: string; attributes: string[]; reason: string }[];
  imputed: { rowId: string; attributes: string[] }[];
  basis: ClusterBasis[];
  evaluationRowIds: string[];
  candidates: ClusterCandidate[];
}
export interface ClusterQuery {
  candidate: number;
  restart: number | null;
  iteration: number | null;
  phase: "assignment" | "update" | "final";
  x: string;
  y: string;
  cluster: number | null;
  page: number;
  rowId: string | null;
  region: { x0: number; x1: number; y0: number; y1: number } | null;
}
export interface ClusterDetail {
  distributions: {
    attributeId: string;
    space: "observed" | "analysis";
    bins: { lower: number; upper: number; selected: number; all: number }[];
  }[];
  marks: { rowId: string; x: number; y: number; cluster: number }[];
  centers: { x: number; y: number; cluster: number }[];
  centersAreMeans: boolean;
  displayed: number;
  total: number;
  matched: number;
  rows: { rowId: string; cluster: number; distance: number; sse: number }[];
  statistics: Record<string, ColumnStatistics>;
  overall: Record<string, ColumnStatistics>;
  analysisStatistics: Record<string, ColumnStatistics>;
  point: {
    rowId: string;
    vector: number[];
    distances: number[];
    assignmentDistances: number[];
    cluster: number;
    silhouette: SilhouettePoint;
  } | null;
}
