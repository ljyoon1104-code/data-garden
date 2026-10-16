import type {
  AnalysisConfig,
  Attribute,
  Cell,
  DeepReadonly,
  TableData,
  TableEdit,
  VersionRef,
} from "./types";
import type { GraphScope } from "./graph-types";
import type {
  FittedPreprocessing,
  PreprocessingSettings,
} from "./preprocessing-types";
import type { FittedWrangling } from "./wrangling-types";

export type RegressionKind = "linear" | "tree" | "knn";
export interface RegressionSettings {
  formatVersion: 1;
  target: string;
  features: string[];
  scope: GraphScope;
  models: RegressionKind[];
  trainRatio: number;
  seed: number;
  missing: "remove" | "mean" | "median";
  scaling: "none" | "minmax" | "zscore";
  k: number;
  weights: "uniform" | "distance";
  maxDepth: number;
  minLeaf: number;
  reuseSplit: { train: string[]; evaluation: string[] } | null;
}
export type RegressionStep = {
  operationId: string;
  source: VersionRef;
} & (
  | { kind: "preprocess"; settings: PreprocessingSettings }
  | { kind: "wrangle"; fitted: FittedWrangling }
  | { kind: "edit"; edit: TableEdit }
);
export interface RegressionPlan {
  source: VersionRef;
  references: VersionRef[];
  root: DeepReadonly<TableData>;
  rootSource: VersionRef;
  steps: RegressionStep[];
  target: Attribute;
  features: Attribute[];
  scopeRowIds: string[];
  observationUnits: Record<string, string>;
  rawInputs: Attribute[];
  predictionBlock: string | null;
}
export type FittedRegressionStep = {
  operationId: string;
} & (
  | { kind: "preprocess"; fitted: DeepReadonly<FittedPreprocessing> }
  | { kind: "wrangle"; fitted: FittedWrangling }
  | { kind: "edit"; edit: TableEdit }
);
export interface RegressionPipeline {
  steps: FittedRegressionStep[];
  ranges: { attributeId: string; min: number; max: number }[];
  rawInputs: Attribute[];
}
export interface RegressionSplit {
  method: "seeded-observation-holdout-v1";
  train: string[];
  evaluation: string[];
  units: Record<string, string>;
  rounding: "floor-unit-count-times-train-ratio";
}
export interface TreeNode {
  id: number;
  depth: number;
  count: number;
  prediction: number;
  feature: number | null;
  threshold: number | null;
  left: number | null;
  right: number | null;
}
export type RegressionModel =
  | {
      kind: "linear";
      intercept: number;
      coefficients: number[];
      algorithm: "scaled-householder-qr-v1";
      tolerance: number;
    }
  | {
      kind: "tree";
      nodes: TreeNode[];
      maxDepth: number;
      minLeaf: number;
      work: number;
    }
  | {
      kind: "knn";
      k: number;
      weights: "uniform" | "distance";
      trainRowIds: string[];
    };
export interface EvaluationRow {
  rowId: string;
  actual: number;
  predicted: number;
  residual: number;
  absoluteError: number;
  squaredError: number;
}
export interface RegressionMetrics {
  n: number;
  absoluteSum: number;
  squaredSum: number;
  totalSumSquares: number;
  actualMean: number;
  mae: number;
  mse: number;
  rmse: number;
  r2: number | null;
  r2Reason: string | null;
}
export type ModelOutcome =
  | {
      kind: RegressionKind;
      status: "failed";
      reason: string;
      durationMs: number;
    }
  | {
      kind: RegressionKind;
      status: "completed";
      model: RegressionModel;
      metrics: RegressionMetrics;
      rows: EvaluationRow[];
      durationMs: number;
    };
export interface RegressionResult {
  formatVersion: 1;
  calculationVersion: "regression-1";
  source: VersionRef;
  references: VersionRef[];
  target: Attribute;
  features: Attribute[];
  scopeRowIds: string[];
  split: RegressionSplit;
  trainRowIds: string[];
  evaluationRowIds: string[];
  excluded: {
    rowId: string;
    phase: "target" | "training" | "evaluation";
    reason: string;
  }[];
  pipeline: RegressionPipeline;
  models: ModelOutcome[];
  unit: string;
  predictionBlock: string | null;
  sampling: { method: "reservoir"; seed: number; limit: 1000 };
  startedAt: string;
  completedAt: string;
}
export interface MatrixRow {
  id: string;
  x: number[];
  y: number;
}
export interface PredictionExplanation {
  kind: RegressionKind;
  predicted: number;
  terms?: {
    feature: number;
    input: number;
    coefficient: number;
    contribution: number;
  }[];
  intercept?: number;
  path?: TreeNode[];
  neighbors?: {
    rowId: string;
    distance: number;
    target: number;
    weight: number;
  }[];
}
export interface RegressionPrediction {
  values: Record<string, Cell>;
  transformed: number[];
  warnings: string[];
  models: PredictionExplanation[];
}
export type RegressionConfig = AnalysisConfig & {
  regression: RegressionSettings;
};
