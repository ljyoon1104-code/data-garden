import type {
  Attribute,
  Cell,
  DataVersion,
  Dataset,
  DeepReadonly,
  TableData,
  VersionRef,
} from "./types";
import type {
  ColumnBasis,
  FittedPreprocessing,
  PreprocessingSettings,
  PreprocessingPreview,
  PreprocessingLineage,
  CellChange,
} from "./preprocessing-types";
import {
  convertCell,
  defaultTableView,
  inspectTable,
  isMissing,
} from "./table";
import { createVersion, snapshot } from "./model";

export const preprocessingLabels = {
  missing: "결측값 처리",
  duplicates: "중복 처리",
  outliers: "이상값 후보 탐색·처리",
  scale: "정규화·표준화",
};
export const methodLabels: Record<string, string> = {
  remove: "행 제거",
  mean: "평균값 대체",
  median: "중앙값 대체",
  mode: "최빈값 대체",
  fixed: "고정값 대체",
  first: "첫 행 보존",
  last: "마지막 행 보존",
  mark: "표시만 하고 유지",
  missing: "결측값으로 변경",
  clip: "경계값으로 제한",
  minmax: "최소·최대 정규화",
  zscore: "표준화 (모집단 n)",
};
export const isNumeric = (c: DeepReadonly<Attribute>) =>
  c.storageType === "number" && c.semanticType === "numeric";
export function defaultPreprocessing(
  kind: PreprocessingSettings["kind"],
  table: DeepReadonly<TableData>,
): PreprocessingSettings {
  const attributeIds = table.columns
    .filter(
      (c) =>
        kind === "duplicates" ||
        (c.useInAnalysis && (kind === "missing" || isNumeric(c))),
    )
    .map((c) => c.id);
  if (kind === "missing")
    return {
      kind,
      attributeIds,
      method: "remove",
      rowRule: "any",
      fixedValues: {},
    };
  if (kind === "duplicates") return { kind, attributeIds, keep: "first" };
  if (kind === "scale") return { kind, attributeIds, method: "minmax" };
  return {
    kind,
    attributeIds,
    detection: "iqr",
    multiplier: 1.5,
    lower: 0,
    upper: 100,
    action: "mark",
    rowRule: "any",
  };
}
function finite(value: number, detail: string) {
  if (!Number.isFinite(value))
    throw new Error(
      `${detail}: 수치 범위를 초과했습니다. 대상 속성 또는 방법을 바꾸세요.`,
    );
  return value;
}
export function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length || p < 0 || p > 1)
    throw new Error("사분위수를 계산할 유효값이 없습니다.");
  const position = (sorted.length - 1) * p,
    i = Math.floor(position),
    weight = position - i;
  return finite(
    weight === 0
      ? sorted[i]
      : sorted[i] * (1 - weight) + sorted[i + 1] * weight,
    "분위수",
  );
}
function numeric(values: readonly Cell[], name: string) {
  const numbers = values.filter((v) => !isMissing(v));
  if (!numbers.length)
    throw new Error(
      `${name}: 유효값이 없습니다. 속성을 제외하거나 고정값 등 다른 방법을 선택하세요.`,
    );
  if (numbers.some((v) => typeof v !== "number" || !Number.isFinite(v)))
    throw new Error(`${name}: 유한한 숫자만 사용할 수 있습니다.`);
  return (numbers as number[]).sort((a, b) => a - b);
}
function moments(values: readonly number[]) {
  let mean = 0,
    m2 = 0;
  values.forEach((value, i) => {
    const delta = finite(value - mean, "평균 차이");
    mean = finite(mean + delta / (i + 1), "평균");
    m2 = finite(m2 + delta * (value - mean), "분산");
  });
  return {
    mean,
    stddev: finite(
      Math.sqrt(Math.max(0, m2 / values.length)),
      "모집단 표준편차",
    ),
  };
}
function meanOnly(values: readonly number[]) {
  let mean = 0;
  values.forEach((v, i) => {
    mean = finite(mean + finite(v - mean, "평균 차이") / (i + 1), "평균");
  });
  return mean;
}
function selected(
  table: DeepReadonly<TableData>,
  settings: DeepReadonly<PreprocessingSettings>,
) {
  if (
    !settings.attributeIds.length ||
    new Set(settings.attributeIds).size !== settings.attributeIds.length
  )
    throw new Error("중복 없이 하나 이상의 대상 속성을 선택하세요.");
  return settings.attributeIds.map((id) => {
    const c = table.columns.find((c) => c.id === id);
    if (!c) throw new Error("대상 속성이 없습니다. 자료를 다시 선택하세요.");
    const needNumeric =
      settings.kind === "scale" ||
      settings.kind === "outliers" ||
      (settings.kind === "missing" &&
        ["mean", "median"].includes(settings.method));
    if (needNumeric && !isNumeric(c))
      throw new Error(`${c.name}: 숫자 저장형·수치 의미 유형만 선택하세요.`);
    if (
      settings.kind === "missing" &&
      settings.method === "mode" &&
      c.semanticType !== "categorical"
    )
      throw new Error(`${c.name}: 최빈값 대체에는 범주 속성을 선택하세요.`);
    return c;
  });
}
/** Fits exclusively on the supplied row scope. Evaluation never calls this function implicitly. */
export function fitPreprocessing(
  table: DeepReadonly<TableData>,
  source: VersionRef,
  settings: PreprocessingSettings,
  scope?: { kind: "all" | "training"; rowIds: string[] },
): DeepReadonly<FittedPreprocessing> {
  const columns = selected(table, settings);
  const fitIds = scope?.rowIds ?? table.rows.map((r) => r.id),
    ids = new Set(fitIds);
  const available = new Set(table.rows.map((r) => r.id));
  if (ids.size !== fitIds.length || fitIds.some((id) => !available.has(id)))
    throw new Error("기준 계산 행 참조가 잘못되었습니다.");
  const rows = table.rows.filter((r) => ids.has(r.id));
  if (!rows.length)
    throw new Error(
      "빈 자료에서는 기준을 계산할 수 없습니다. 자료를 확인하세요.",
    );
  if ((scope?.kind ?? "all") === "all" && rows.length !== table.rows.length)
    throw new Error("전체 행 기준은 모든 행을 포함해야 합니다.");
  if (settings.kind === "outliers") {
    if (!Number.isFinite(settings.multiplier) || settings.multiplier < 0)
      throw new Error("IQR 배수는 0 이상의 유한한 수를 입력하세요.");
    if (
      !Number.isFinite(settings.lower) ||
      !Number.isFinite(settings.upper) ||
      settings.lower > settings.upper
    )
      throw new Error("하한·상한은 유한한 수이며 하한이 상한 이하여야 합니다.");
  }
  const bases: Record<string, ColumnBasis> = {};
  for (const c of columns) {
    const values = rows.map((r) => r.values[c.id]),
      valid = values.filter((v) => !isMissing(v));
    const basis: ColumnBasis = {
      storageType: c.storageType,
      semanticType: c.semanticType,
      validCount: valid.length,
      missingCount: values.length - valid.length,
    };
    if (settings.kind === "missing" && settings.method !== "remove") {
      if (settings.method === "fixed") {
        if (!(c.id in settings.fixedValues))
          throw new Error(`${c.name}: 고정 대체값을 입력하세요.`);
        basis.replacement = convertCell(
          settings.fixedValues[c.id],
          c as Attribute,
        );
        if (isMissing(basis.replacement))
          throw new Error(
            `${c.name}: 고정 대체값이 결측값입니다. 유효한 값을 입력하세요.`,
          );
      } else if (settings.method === "mode") {
        if (!valid.length)
          throw new Error(
            `${c.name}: 최빈값을 구할 유효값이 없습니다. 고정값 등 다른 방법을 선택하세요.`,
          );
        const counts = new Map<string, { value: Cell; count: number }>();
        for (const v of valid) {
          const key = JSON.stringify(v);
          const b = counts.get(key);
          if (b) b.count++;
          else counts.set(key, { value: v, count: 1 });
        }
        let best = { value: valid[0], count: 0 };
        for (const b of counts.values()) if (b.count > best.count) best = b;
        basis.replacement = best.value;
      } else {
        const numbers = numeric(values, c.name);
        basis.replacement =
          settings.method === "mean"
            ? meanOnly(numbers)
            : quantile(numbers, 0.5);
      }
    }
    if (settings.kind === "scale") {
      const numbers = numeric(values, c.name),
        stats = moments(numbers);
      Object.assign(basis, { min: numbers[0], max: numbers.at(-1), ...stats });
      if (numbers.length < 2)
        throw new Error(
          `${c.name}: 유효값이 2개 이상 필요합니다. 속성을 제외하세요.`,
        );
      const range = finite(basis.max! - basis.min!, `${c.name} 범위`);
      if (range === 0 || stats.stddev === 0)
        throw new Error(
          `${c.name}: 상수 열은 변환할 수 없습니다. 해당 속성을 제외하세요.`,
        );
    }
    if (settings.kind === "outliers") {
      if (settings.detection === "iqr") {
        const numbers = numeric(values, c.name);
        basis.q1 = quantile(numbers, 0.25);
        basis.q3 = quantile(numbers, 0.75);
        const iqr = finite(basis.q3 - basis.q1, `${c.name} IQR`);
        const spread = finite(settings.multiplier * iqr, `${c.name} IQR 경계`);
        basis.lower = finite(basis.q1 - spread, `${c.name} 하한`);
        basis.upper = finite(basis.q3 + spread, `${c.name} 상한`);
      } else {
        basis.lower = settings.lower;
        basis.upper = settings.upper;
      }
      if (settings.action === "median") {
        const normal = valid
          .filter(
            (v): v is number =>
              typeof v === "number" && v >= basis.lower! && v <= basis.upper!,
          )
          .sort((a, b) => a - b);
        if (!normal.length)
          throw new Error(
            `${c.name}: 정상 범위의 유효값이 없어 중앙값 대체를 할 수 없습니다. 경계나 방법을 변경하세요.`,
          );
        basis.replacement = quantile(normal, 0.5);
      }
    }
    bases[c.id] = basis;
  }
  return snapshot({
    formatVersion: 1,
    settings,
    source,
    fitRows: {
      kind: scope?.kind ?? "all",
      rowIds: rows.map((r) => r.id),
      count: rows.length,
    },
    columns: bases,
    conventions: {
      missing: "null-or-empty",
      modeTie: "first-in-fit-order",
      quantile: "linear-n-minus-one",
      standardDeviation: "population-n",
      duplicateEquality: "typed-json",
    },
  } as FittedPreprocessing);
}
/** Applies the frozen fitted basis unchanged, including values outside the fitted range. */
export function applyPreprocessing(
  table: DeepReadonly<TableData>,
  fitted: DeepReadonly<FittedPreprocessing>,
) {
  const settings = fitted.settings,
    columns = selected(table, settings);
  for (const c of columns) {
    const b = fitted.columns[c.id];
    if (
      !b ||
      b.storageType !== c.storageType ||
      b.semanticType !== c.semanticType
    )
      throw new Error(
        `${c.name}: 기준 계산 당시의 자료형·의미 유형과 다릅니다.`,
      );
  }
  const removed = new Set<string>(),
    changes: CellChange[] = [],
    candidates: PreprocessingPreview["candidates"] = [],
    duplicateGroups: PreprocessingPreview["duplicateGroups"] = [];
  if (settings.kind === "duplicates") {
    const groups = new Map<string, string[]>();
    for (const r of table.rows) {
      const key = JSON.stringify(columns.map((c) => r.values[c.id]));
      const group = groups.get(key);
      if (group) group.push(r.id);
      else groups.set(key, [r.id]);
    }
    for (const rowIds of groups.values())
      if (rowIds.length > 1) {
        const keptRowId =
          settings.keep === "first" ? rowIds[0] : rowIds.at(-1)!;
        duplicateGroups.push({ rowIds, keptRowId });
        rowIds.forEach((id) => {
          if (id !== keptRowId) removed.add(id);
        });
      }
  }
  const rows: TableData["rows"] = [];
  for (const row of table.rows) {
    const flags = columns.map((c) => {
      const v = row.values[c.id],
        b = fitted.columns[c.id];
      return settings.kind === "missing"
        ? isMissing(v)
        : settings.kind === "outliers" &&
            !isMissing(v) &&
            typeof v === "number" &&
            (v < b.lower! || v > b.upper!);
    });
    if (settings.kind === "outliers")
      columns.forEach((c, i) => {
        if (flags[i])
          candidates.push({
            rowId: row.id,
            attributeId: c.id,
            value: row.values[c.id],
          });
      });
    if (
      (settings.kind === "missing" && settings.method === "remove") ||
      (settings.kind === "outliers" && settings.action === "remove")
    ) {
      if (
        settings.rowRule === "any" ? flags.some(Boolean) : flags.every(Boolean)
      )
        removed.add(row.id);
    }
    if (removed.has(row.id)) continue;
    const values = { ...row.values };
    columns.forEach((c, i) => {
      const before = values[c.id],
        b = fitted.columns[c.id];
      let after = before;
      if (
        settings.kind === "missing" &&
        settings.method !== "remove" &&
        flags[i]
      )
        after = b.replacement!;
      if (settings.kind === "outliers" && flags[i]) {
        if (settings.action === "missing") after = null;
        if (settings.action === "clip")
          after = Math.max(b.lower!, Math.min(b.upper!, before as number));
        if (settings.action === "median") after = b.replacement!;
      }
      if (settings.kind === "scale" && !isMissing(before)) {
        if (typeof before !== "number")
          throw new Error("변환 대상이 숫자가 아닙니다.");
        after =
          settings.method === "minmax"
            ? (before - b.min!) / (b.max! - b.min!)
            : (before - b.mean!) / b.stddev!;
      }
      if (
        after === undefined ||
        (typeof after === "number" && !Number.isFinite(after))
      )
        throw new Error(
          `${c.name}: 적용 결과가 유효하지 않습니다. 기준이나 입력 범위를 확인하세요.`,
        );
      if (after !== before) {
        values[c.id] = after;
        changes.push({ rowId: row.id, attributeId: c.id, before, after });
      }
    });
    rows.push({ id: row.id, values });
  }
  return {
    table: { columns: table.columns.map((c) => ({ ...c })), rows },
    changes,
    removedRowIds: table.rows.filter((r) => removed.has(r.id)).map((r) => r.id),
    candidates,
    duplicateGroups,
  };
}
export function previewPreprocessing(
  table: DeepReadonly<TableData>,
  source: VersionRef,
  settings: PreprocessingSettings,
): PreprocessingPreview {
  const fitted = fitPreprocessing(table, source, settings),
    result = applyPreprocessing(table, fitted);
  return {
    fitted: structuredClone(fitted) as FittedPreprocessing,
    beforeRows: table.rows.length,
    afterRows: result.table.rows.length,
    columnCount: table.columns.length,
    changedCells: result.changes.length,
    changes: result.changes,
    removedRowIds: result.removedRowIds,
    candidates: result.candidates,
    duplicateGroups: result.duplicateGroups,
    beforeStatistics: inspectTable(table, defaultTableView()).statistics,
    afterStatistics: inspectTable(result.table, defaultTableView()).statistics,
  };
}
export function preprocessingLineage(
  dataset: Dataset,
  versionId: string,
): PreprocessingLineage {
  const current = dataset.versions.find((v) => v.id === versionId)!;
  const chain: string[] = [];
  let origin = { datasetId: dataset.id, versionId },
    v: DeepReadonly<DataVersion> | undefined = current;
  while (v) {
    if (v.operation.preprocessing) {
      chain.unshift(v.operation.id);
      origin = { ...v.operation.preprocessing.input };
    }
    v = dataset.versions.find(
      (previous) => previous.id === v!.parentVersionIds[0],
    );
  }
  return { origin, previousOperationIds: chain };
}
export function commitPreprocessing(
  table: DeepReadonly<TableData>,
  source: VersionRef,
  fitted: DeepReadonly<FittedPreprocessing>,
  lineage: PreprocessingLineage,
): DeepReadonly<DataVersion> | null {
  if (
    fitted.source.datasetId !== source.datasetId ||
    fitted.source.versionId !== source.versionId
  )
    throw new Error("미리보기의 입력 버전이 달라졌습니다. 다시 실행하세요.");
  const result = applyPreprocessing(table, fitted);
  if (!result.changes.length && !result.removedRowIds.length) return null;
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return createVersion(result.table, {
    id,
    datasetId: source.datasetId,
    parentVersionIds: [source.versionId],
    createdAt: now,
    operation: {
      id: crypto.randomUUID(),
      kind: "preprocess",
      datasetId: source.datasetId,
      inputVersionIds: [source.versionId],
      outputVersionIds: [id],
      settings: JSON.parse(JSON.stringify(fitted.settings)),
      executedAt: now,
      preprocessing: {
        formatVersion: 1,
        input: source,
        ...lineage,
        fitted: structuredClone(fitted) as FittedPreprocessing,
        changedCells: result.changes.length,
        removedRowIds: result.removedRowIds,
      },
    },
  });
}
