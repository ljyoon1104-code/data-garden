import type {
  Attribute,
  Cell,
  DeepReadonly,
  TableData,
  TableEdit,
  DataVersion,
  Dataset,
  TableView,
  TableInspection,
  ColumnStatistics,
} from "./types";
import { createVersion } from "./model";

export const semanticLabels = {
  numeric: "수치",
  categorical: "범주",
  date: "날짜",
  identifier: "식별자",
  text: "텍스트",
};
export const storageLabels = {
  string: "문자열",
  number: "숫자",
  boolean: "불리언",
  mixed: "혼합 · 원래 값 유지",
};
export const defaultTableView = (): TableView => ({
  sort: null,
  filter: null,
  selectedRowIds: [],
  selectedColumnIds: [],
  page: 0,
  pageSize: 25,
  duplicatesOnly: false,
  statisticsScope: "all",
});
export const isMissing = (value: Cell) => value === null || value === "";
export function validDate(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  if (!m) return false;
  const [y, month, day] = m.slice(1, 4).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, month - 1, day);
  return (
    y >= 1 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    (!m[4] || (+m[4] < 24 && +m[5] < 60 && +m[6] < 60))
  );
}
export function numericValue(value: Cell): number {
  if (
    typeof value === "boolean" ||
    value === null ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
      String(value).trim(),
    )
  )
    throw new Error("숫자 형식이 아닙니다.");
  const n = Number(value);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n)))
    throw new Error(
      "유한한 숫자 또는 정확히 표현 가능한 정수 범위를 벗어났습니다. 문자열을 사용하세요.",
    );
  return n;
}
export function convertCell(value: Cell, attribute: Attribute): Cell {
  if (isMissing(value))
    return value === "" && attribute.storageType === "string" ? "" : null;
  if (attribute.semanticType === "date" && attribute.storageType !== "string")
    throw new Error("날짜는 문자열 저장형을 사용하세요.");
  if (
    attribute.semanticType === "numeric" &&
    attribute.storageType !== "number"
  )
    throw new Error("수치 유형은 숫자 저장형을 사용하세요.");
  let result: Cell = value;
  if (attribute.storageType === "number") result = numericValue(value);
  if (attribute.storageType === "string") result = String(value);
  if (attribute.storageType === "boolean") {
    if (typeof value === "boolean") result = value;
    else if (String(value).toLowerCase() === "true") result = true;
    else if (String(value).toLowerCase() === "false") result = false;
    else throw new Error("불리언은 true 또는 false만 입력하세요.");
  }
  if (typeof result === "number" && !Number.isFinite(result))
    throw new Error("NaN과 Infinity는 저장할 수 없습니다.");
  if (attribute.semanticType === "date" && !validDate(String(result)))
    throw new Error(
      "유효한 날짜(YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm:ss)를 입력하세요.",
    );
  return result;
}
export function conversionWarnings(
  table: DeepReadonly<TableData>,
  columns: Attribute[],
): string[] {
  const warnings: string[] = [];
  for (const column of columns)
    if (column.storageType === "number") {
      const count = table.rows.filter(
        (row) =>
          typeof row.values[column.id] === "string" &&
          /^[+-]?0\d/.test(String(row.values[column.id]).trim()),
      ).length;
      if (count)
        warnings.push(
          `${column.name}: ${count}개 값의 앞자리 0이 숫자 변환으로 사라집니다. 예: 00123 → 123. 문자열·식별자를 선택하면 보존됩니다.`,
        );
    }
  return warnings;
}
export function applySchema(
  table: DeepReadonly<TableData>,
  columns: Attribute[],
): TableData {
  const ids = new Set(table.columns.map((c) => c.id));
  if (
    columns.length !== table.columns.length ||
    new Set(columns.map((c) => c.id)).size !== ids.size ||
    columns.some((c) => !ids.has(c.id))
  )
    throw new Error(
      "열 ID가 원본과 일치하지 않습니다. 미리보기를 다시 생성하세요.",
    );
  const names = new Set<string>();
  for (const column of columns) {
    if (!column.name.trim() || names.has(column.name.trim()))
      throw new Error(
        "열 이름은 비어 있거나 중복될 수 없습니다. 고유한 이름을 입력하세요.",
      );
    names.add(column.name.trim());
    if (column.semanticType === "date" && column.storageType !== "string")
      throw new Error(`${column.name}: 날짜는 문자열 저장형을 사용하세요.`);
    if (column.semanticType === "numeric" && column.storageType !== "number")
      throw new Error(`${column.name}: 수치 유형은 숫자 저장형을 사용하세요.`);
  }
  const failures: string[] = [];
  let failureCount = 0;
  const rows = table.rows.map((row, i) => ({
    id: row.id,
    values: Object.fromEntries(
      columns.map((column) => {
        try {
          return [column.id, convertCell(row.values[column.id], column)];
        } catch (error) {
          failureCount++;
          if (failures.length < 12)
            failures.push(
              `${i + 1}행 ${column.name} [${String(row.values[column.id])}]: ${(error as Error).message}`,
            );
          return [column.id, row.values[column.id]];
        }
      }),
    ),
  }));
  if (failureCount)
    throw new Error(
      `변환 실패 ${failureCount}개. 원본과 현재 버전은 변경되지 않았습니다. ${failures.join(" / ")}${failureCount > 12 ? " (앞 12개 표시)" : ""}`,
    );
  return {
    columns: structuredClone(columns).map((c) => ({
      ...c,
      name: c.name.trim(),
    })),
    rows,
  };
}
export function editVersion(
  dataset: Dataset,
  versionId: string,
  edit: TableEdit,
): DeepReadonly<DataVersion> | null {
  const previous = dataset.versions.find((v) => v.id === versionId);
  if (!previous) throw new Error("편집 대상 버전을 찾을 수 없습니다.");
  let table: TableData;
  if (edit.kind === "attribute") {
    if (!previous.columns.some((c) => c.id === edit.attribute.id))
      throw new Error("속성을 찾을 수 없습니다.");
    const columns: Attribute[] = previous.columns.map((c) => ({ ...c }));
    const index = columns.findIndex((c) => c.id === edit.attribute.id);
    columns[index] = edit.attribute;
    if (
      conversionWarnings(previous, [edit.attribute]).length &&
      !edit.allowLoss
    )
      throw new Error(
        "앞자리 0 손실 안내를 확인하거나 문자열 자료형을 선택하세요.",
      );
    table = applySchema(previous, columns);
  } else {
    const column = previous.columns.find((c) => c.id === edit.attributeId);
    if (!column || !previous.rows.some((r) => r.id === edit.rowId))
      throw new Error("편집할 행 또는 열을 찾을 수 없습니다.");
    const value = edit.missing ? null : convertCell(edit.value, column);
    table = {
      columns: previous.columns.map((c) => ({ ...c })),
      rows: previous.rows.map((r) => ({
        id: r.id,
        values: {
          ...r.values,
          ...(r.id === edit.rowId ? { [column.id]: value } : {}),
        },
      })),
    };
  }
  if (
    JSON.stringify(table.columns) === JSON.stringify(previous.columns) &&
    JSON.stringify(table.rows) === JSON.stringify(previous.rows)
  )
    return null;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return createVersion(table, {
    id,
    datasetId: dataset.id,
    parentVersionIds: [previous.id],
    createdAt: now,
    operation: {
      id: crypto.randomUUID(),
      kind: edit.kind === "cell" ? "edit-cell" : "edit-attribute",
      datasetId: dataset.id,
      inputVersionIds: [previous.id],
      outputVersionIds: [id],
      settings: JSON.parse(JSON.stringify(edit)),
      executedAt: now,
    },
  });
}

export function inspectTable(
  table: DeepReadonly<TableData>,
  view: TableView,
): TableInspection {
  const groups = new Map<string, string[]>();
  for (const row of table.rows) {
    const key = JSON.stringify(table.columns.map((c) => row.values[c.id]));
    const group = groups.get(key);
    if (group) group.push(row.id);
    else groups.set(key, [row.id]);
  }
  const duplicates = [...groups.values()].filter((ids) => ids.length > 1);
  const duplicateRowIds = duplicates.flat();
  const duplicateSet = new Set(duplicateRowIds);
  let rows = table.rows.filter(
    (row) => !view.duplicatesOnly || duplicateSet.has(row.id),
  );
  const filter = view.filter;
  if (filter) {
    const column = table.columns.find((c) => c.id === filter.attributeId);
    if (!column) throw new Error("필터 속성이 없습니다.");
    const numeric = column.storageType === "number";
    const rhs = ["missing", "present"].includes(filter.operator)
      ? null
      : numeric
        ? numericValue(filter.value)
        : column.semanticType === "date"
          ? convertCell(filter.value, column)
          : filter.value;
    rows = rows.filter((row) => {
      const value = row.values[column.id];
      if (filter.operator === "missing") return isMissing(value);
      if (filter.operator === "present") return !isMissing(value);
      if (isMissing(value)) return false;
      if (filter.operator === "contains")
        return String(value).includes(filter.value);
      if (filter.operator === "equals")
        return numeric ? value === rhs : String(value) === String(rhs);
      if (filter.operator === "gt")
        return numeric
          ? Number(value) > Number(rhs)
          : String(value) > String(rhs);
      return numeric
        ? Number(value) < Number(rhs)
        : String(value) < String(rhs);
    });
  }
  const statisticsRows = view.statisticsScope === "all" ? table.rows : rows;
  const statistics: Record<string, ColumnStatistics> = {};
  for (const column of table.columns) {
    const values = statisticsRows.map((row) => row.values[column.id]);
    const valid = values.filter((v) => !isMissing(v));
    const counts = new Map<string, { value: Cell; count: number }>();
    for (const value of valid) {
      const key = JSON.stringify(value);
      const bucket = counts.get(key);
      if (bucket) bucket.count++;
      else counts.set(key, { value, count: 1 });
    }
    const stat: ColumnStatistics = {
      missing: values.length - valid.length,
      missingRatio: values.length
        ? (values.length - valid.length) / values.length
        : 0,
      unique: counts.size,
    };
    if (column.semanticType === "numeric" && column.storageType === "number") {
      const numbers = valid
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
      const n = numbers.length;
      let mean = 0;
      let m2 = 0;
      numbers.forEach((value, i) => {
        const delta = value - mean;
        mean += delta / (i + 1);
        m2 += delta * (value - mean);
      });
      const median = n
        ? n % 2
          ? numbers[Math.floor(n / 2)]
          : numbers[n / 2 - 1] / 2 + numbers[n / 2] / 2
        : null;
      const stddev = n > 1 ? Math.sqrt(Math.max(0, m2 / (n - 1))) : null;
      stat.numeric = {
        valid: n,
        min: n ? numbers[0] : null,
        max: n ? numbers[n - 1] : null,
        mean: n && Number.isFinite(mean) ? mean : null,
        median,
        stddev: stddev !== null && Number.isFinite(stddev) ? stddev : null,
        overflow:
          n > 0 &&
          (!Number.isFinite(mean) ||
            (stddev !== null && !Number.isFinite(stddev))),
      };
    }
    if (column.semanticType === "categorical")
      stat.frequencies = [...counts.values()].sort(
        (a, b) =>
          b.count - a.count ||
          String(a.value).localeCompare(String(b.value), "ko"),
      );
    statistics[column.id] = stat;
  }
  if (view.sort) {
    const { attributeId, direction } = view.sort;
    rows = [...rows].sort((a, b) => {
      const x = a.values[attributeId];
      const y = b.values[attributeId];
      if (isMissing(x)) return isMissing(y) ? 0 : 1;
      if (isMissing(y)) return -1;
      // Mixed columns need a total order; comparing some pairs numerically and
      // others lexically can create cycles (2 < 10 < "11" < 2).
      const rank = (value: Cell) => typeof value === 'boolean' ? 0 : typeof value === 'number' ? 1 : 2;
      const typeOrder = rank(x) - rank(y);
      const cmp = typeOrder || (
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "ko"));
      return direction === "asc" ? cmp : -cmp;
    });
  }
  return {
    rowIds: rows.map((row) => row.id),
    statisticsRows: statisticsRows.length,
    statistics,
    duplicateRowIds,
    duplicateExtraCount: duplicateRowIds.length - duplicates.length,
    duplicateGroupCount: duplicates.length,
  };
}
