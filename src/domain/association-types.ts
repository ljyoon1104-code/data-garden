import type { AnalysisConfig, Cell, TableData, VersionRef, Row } from "./types";
import type { GraphScope } from "./graph-types";

export interface AssociationSettings {
  formatVersion: 1;
  format: "list" | "vertical" | "binary" | "category";
  columns: string[];
  transactionId: string;
  listMode: "delimited" | "slots";
  delimiter: string;
  quotes: boolean;
  trim: boolean;
  foldCase: boolean;
  empty: "include" | "exclude";
  unknown: "block" | "exclude" | "absent";
  missingId: "block" | "exclude";
  presentValues: Cell[];
  absentValues: Cell[];
  scope: GraphScope;
  supportPercent: string;
  confidencePercent: string;
  maxLength: number;
}
export type AssociationConfig = AnalysisConfig & {
  association: AssociationSettings;
};
export interface AssociationInput {
  source: VersionRef;
  table: TableData;
}
export interface AssociationItem {
  id: string;
  label: string;
  columns: string[];
  value: Exclude<Cell, null>;
  valueType: "string" | "number" | "boolean";
  format: AssociationSettings["format"];
}
export interface Transaction {
  id: string;
  key: Cell;
  rowIds: string[];
  items: string[];
}
export interface AssociationTransactions {
  source: VersionRef;
  inputRows: number;
  scopeRowIds: string[];
  includedRows: number;
  transactions: Transaction[];
  items: AssociationItem[];
  emptyCount: number;
  duplicatesRemoved: number;
  excluded: { rowIds: string[]; reason: string }[];
  issues: { rowId: string; columnId: string; reason: string }[];
  merges: { itemId: string; originals: Cell[] }[];
  sizeDistribution: { size: number; count: number }[];
}
export interface AssociationCandidate {
  items: string[];
  count: number | null;
  pruned: boolean;
  frequent: boolean;
}
export interface AssociationLevel {
  length: number;
  generated: number;
  pruned: number;
  counted: number;
  frequent: number;
  candidates: AssociationCandidate[];
}
export interface AssociationRule {
  id: string;
  antecedent: string[];
  consequent: string[];
  n: number;
  countA: number;
  countB: number;
  countUnion: number;
  support: number;
  confidence: number;
  lift: number;
}
export interface AssociationResult {
  formatVersion: 1;
  calculationVersion: "apriori-1";
  source: VersionRef;
  prepared: AssociationTransactions;
  minCount: number;
  maxLength: number;
  levels: AssociationLevel[];
  rules: AssociationRule[];
  termination: "max-length" | "no-frequent" | "no-candidates";
  complete: true;
  work: {
    indexEntries: number;
    candidateJoins: number;
    countedVisits: number;
    ruleCombinations: number;
  };
}
export interface AssociationView {
  antecedent: string[];
  consequent: string[];
  antecedentText: string;
  consequentText: string;
  match: "all" | "any";
  sort: "support" | "confidence" | "lift" | "countUnion" | "length";
  direction: "asc" | "desc";
  page: number;
  ruleId: string | null;
  transactionGroup: "all" | "both" | "a-only" | "b-only" | "neither" | "empty";
  transactionPage: number;
  transactionId: string | null;
  level: number;
  candidatePage: number;
}
export interface AssociationDetail {
  matchedRules: number;
  rules: AssociationRule[];
  counts: {
    both: number;
    aOnly: number;
    bOnly: number;
    neither: number;
  } | null;
  transactionCount: number;
  transactions: Transaction[];
  selectedTransaction: Transaction | null;
  sourceRows: Row[];
}
