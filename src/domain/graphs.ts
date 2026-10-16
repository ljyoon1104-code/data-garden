import type {
  Cell,
  DeepReadonly,
  GraphConfig,
  Row,
  TableData,
  TableView,
  VersionRef,
} from "./types";
import type {
  Aggregate,
  GraphMark,
  GraphQuery,
  GraphResult,
  GraphRows,
  GraphScope,
} from "./graph-types";
import { convertCell, isMissing, numericValue, validDate } from "./table";

export const graphLabels = {
  scatter: "산점도",
  histogram: "히스토그램",
  box: "상자그림",
  bar: "막대그래프",
  line: "선그래프",
  pie: "파이그래프",
  area: "누적 영역",
  heatmap: "히트맵",
};
export const aggregateLabels: Record<Aggregate, string> = {
  rows: "행 수",
  valid: "유효값 수",
  sum: "합계",
  mean: "평균",
  median: "중앙값",
};
type Table = DeepReadonly<TableData>;
const key = (v: Cell) => JSON.stringify(v);
export const categoryLabel = (v: Cell) =>
  v === null
    ? "(null)"
    : v === ""
      ? "(빈 문자열)"
      : `${typeof v === "string" ? JSON.stringify(v) : String(v)}${typeof v === "number" ? " [숫자]" : typeof v === "boolean" ? " [불리언]" : ""}`;
const finite = (v: Cell): v is number =>
  typeof v === "number" && Number.isFinite(v);
const q = (a: number[], p: number) => {
  const i = (a.length - 1) * p,
    l = Math.floor(i);
  const fraction = i - l;
  return a[l] * (1 - fraction) + a[Math.ceil(i)] * fraction;
};
function mean(a: number[]) {
  return a.length ? a.reduce((s, v) => s + v / a.length, 0) : null;
}
function aggregate(
  rows: readonly DeepReadonly<Row>[],
  id: string,
  method: Aggregate,
): number | null {
  if (method === "rows") return rows.length;
  const values = rows.map((r) => r.values[id]).filter(finite);
  if (method === "valid") return values.length;
  if (!values.length) return null;
  const n =
    method === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : method === "mean"
        ? mean(values)
        : q(
            values.sort((a, b) => a - b),
            0.5,
          );
  if (n !== null && !Number.isFinite(n))
    throw new Error(
      "집계값이 유한한 수 범위를 넘었습니다. 자료 단위 또는 범위를 조정하세요.",
    );
  return n;
}
export function graphScope(
  view: TableView,
  kind: GraphScope["kind"],
): GraphScope {
  return structuredClone({
    kind,
    filter: kind === "filtered" ? view.filter : null,
    duplicatesOnly: kind === "filtered" && view.duplicatesOnly,
    rowIds: kind === "selected" ? [...view.selectedRowIds] : [],
  });
}
export function newGraph(table: Table, source: VersionRef): GraphConfig {
  const numeric = table.columns.filter(
    (c) => c.storageType === "number" && c.semanticType === "numeric",
  );
  const x = numeric[0]?.id || table.columns[0]?.id || "",
    y = numeric[1]?.id || x;
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    source: { ...source },
    kind: "scatter",
    axes: { x, y, settings: {} },
    grouping: { attributeIds: [], settings: {} },
    bins: { method: null, settings: {} },
    aggregation: { method: null, attributeIds: [], settings: {} },
    visual: {
      formatVersion: 1,
      name: "새 그래프",
      createdAt: now,
      updatedAt: now,
      scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
      x,
      y,
      group: "",
      value: y,
      correlationIds: numeric.slice(0, 5).map((c) => c.id),
      heatmap: "cross",
      aggregate: "rows",
      binMode: "count",
      binCount: 10,
      binWidth: 1,
      boundaries: [],
      ratio: false,
      layout: "color",
      stacked: false,
      order: "ascending",
      categoricalOrderConfirmed: false,
      categoryStart: 0,
      categoryLimit: 30,
      categoryRangeConfirmed: false,
      fillAbsent: false,
      unit: "",
      xTitle: "",
      yTitle: "",
      xRange: null,
      yRange: null,
      sampling: { method: "reservoir", seed: 42, limit: 3000 },
    },
  };
}
export function normalizedGraph(graph: GraphConfig): GraphConfig {
  const g = structuredClone(graph),
    s = g.visual!;
  g.axes = {
    x: s.x || undefined,
    y: s.y || undefined,
    settings: { xRange: s.xRange, yRange: s.yRange },
  };
  g.grouping = {
    attributeIds: s.group ? [s.group] : [],
    settings: { layout: s.layout },
  };
  g.bins = { method: s.binMode, settings: { boundaries: s.boundaries } };
  g.aggregation = {
    method: s.aggregate,
    attributeIds: s.value ? [s.value] : [],
    settings: {},
  };
  return g;
}
/** Validate persisted settings before using them. Missing legacy visual settings are intentionally retained. */
export function validateGraph(g: GraphConfig, table: Table) {
  if (!Object.hasOwn(graphLabels, g.kind))
    throw new Error("지원하지 않는 그래프 종류입니다.");
  if (g.visual === undefined) return;
  const s = g.visual;
  const fail = (message: string): never => {
    throw new Error(`그래프 설정: ${message}`);
  };
  if (!s || s.formatVersion !== 1) fail("지원하지 않는 설정 버전");
  for (const k of [
    "name",
    "x",
    "y",
    "group",
    "value",
    "unit",
    "xTitle",
    "yTitle",
    "createdAt",
    "updatedAt",
  ] as const)
    if (typeof s[k] !== "string") fail(`${k} 문자열 필요`);
  if (
    !s.name.trim() ||
    !Number.isFinite(Date.parse(s.createdAt)) ||
    !Number.isFinite(Date.parse(s.updatedAt))
  )
    fail("이름·시각 오류");
  const choices: { value: unknown; list: unknown[] }[] = [
    { value: s.heatmap, list: ["cross", "correlation"] },
    { value: s.aggregate, list: Object.keys(aggregateLabels) },
    { value: s.binMode, list: ["count", "width"] },
    { value: s.layout, list: ["color", "facets"] },
    { value: s.order, list: ["source", "ascending", "descending"] },
  ];
  if (choices.some((c) => !c.list.includes(c.value)))
    fail("지원하지 않는 방법");
  for (const k of [
    "ratio",
    "stacked",
    "categoricalOrderConfirmed",
    "categoryRangeConfirmed",
    "fillAbsent",
  ] as const)
    if (typeof s[k] !== "boolean") fail(`${k} 불리언 필요`);
  for (const [n, min, max] of [
    [s.binCount, 1, 100],
    [s.categoryStart, 0, 50000],
    [s.categoryLimit, 1, 100],
    [s.sampling?.limit, 1, 5000],
    [s.sampling?.seed, 0, 4294967295],
  ])
    if (!Number.isInteger(n) || n < min || n > max)
      fail("구간 수·표시 범위·표본 조건 오류");
  if (
    s.sampling?.method !== "reservoir" ||
    !Number.isFinite(s.binWidth) ||
    s.binWidth <= 0
  )
    fail("구간 폭 또는 표본 방법 오류");
  for (const range of [s.xRange, s.yRange])
    if (
      range !== null &&
      (!Array.isArray(range) ||
        range.length !== 2 ||
        !range.every(Number.isFinite) ||
        range[0] >= range[1])
    )
      fail("축 범위는 유한한 최솟값 < 최댓값이어야 합니다.");
  if (
    !Array.isArray(s.boundaries) ||
    s.boundaries.length > 101 ||
    s.boundaries.some(
      (n, i) => !Number.isFinite(n) || (i > 0 && n < s.boundaries[i - 1]),
    ) ||
    s.boundaries.length === 1
  )
    fail("구간 경계 오류");
  if (
    s.boundaries.length > 2 &&
    s.boundaries.some((v, i) => i > 0 && v <= s.boundaries[i - 1])
  )
    fail("구간 경계 중복");
  if (
    !Array.isArray(s.correlationIds) ||
    s.correlationIds.length > 20 ||
    new Set(s.correlationIds).size !== s.correlationIds.length
  )
    fail("상관 속성은 중복 없이 20개 이하");
  const ids = new Set(table.columns.map((c) => c.id));
  for (const id of [s.x, s.y, s.group, s.value, ...s.correlationIds])
    if (id && !ids.has(id)) fail("없는 속성 참조");
  if (s.xRange && !["scatter", "line", "area"].includes(g.kind))
    fail("이 그래프는 수치 X축 범위 설정을 사용하지 않습니다.");
  if (s.yRange && ["pie", "heatmap"].includes(g.kind))
    fail("파이·히트맵은 Y축 수치 범위 설정을 사용하지 않습니다.");
  const scope = s.scope;
  if (
    !scope ||
    !["all", "filtered", "selected"].includes(scope.kind) ||
    typeof scope.duplicatesOnly !== "boolean" ||
    !Array.isArray(scope.rowIds) ||
    new Set(scope.rowIds).size !== scope.rowIds.length
  )
    fail("자료 범위 오류");
  const rowIds = new Set(table.rows.map((r) => r.id));
  if (scope.rowIds.some((id) => !rowIds.has(id))) fail("선택 행 참조 오류");
  if (
    scope.filter !== null &&
    (!scope.filter ||
      !ids.has(scope.filter.attributeId) ||
      !["contains", "equals", "gt", "lt", "missing", "present"].includes(
        scope.filter.operator,
      ) ||
      typeof scope.filter.value !== "string")
  )
    fail("필터 조건 오류");
  if (
    (scope.kind !== "selected" && scope.rowIds.length) ||
    (scope.kind !== "filtered" &&
      (scope.filter !== null || scope.duplicatesOnly))
  )
    fail("범위와 조건 불일치");
  const col = (id: string) =>
    table.columns.find((c) => c.id === id) || fail("필수 속성을 선택하세요.");
  const numeric = (id: string) => {
    const c = col(id);
    if (c.storageType !== "number" || c.semanticType !== "numeric")
      fail(
        `${c.name}: 숫자 저장형·수치 의미가 필요합니다. 데이터 메뉴에서 유형을 확인하세요.`,
      );
  };
  if (["scatter", "histogram", "box"].includes(g.kind)) numeric(s.x);
  if (g.kind === "scatter") numeric(s.y);
  if (
    ["bar", "line", "pie", "area"].includes(g.kind) ||
    (g.kind === "heatmap" && s.heatmap === "cross")
  ) {
    col(s.x);
    if (s.aggregate !== "rows") numeric(s.value);
  }
  if (g.kind === "heatmap") {
    if (s.heatmap === "cross") col(s.y);
    else {
      if (s.correlationIds.length < 2) fail("수치 속성 2개 이상을 선택하세요.");
      s.correlationIds.forEach(numeric);
    }
  }
  if (g.kind === "area" || g.kind === "line") {
    const c = col(s.x);
    if (
      c.semanticType !== "date" &&
      !(c.semanticType === "numeric" && c.storageType === "number")
    ) {
      if (s.xRange) fail("범주형 X축에 수치 범위를 지정할 수 없습니다.");
      if (g.kind === "area")
        fail("누적 영역의 X축은 날짜 또는 수치 의미여야 합니다.");
      if (!s.categoricalOrderConfirmed)
        fail("범주형 X축의 연결 순서를 고급 설정에서 확인하세요.");
    }
    if (g.kind === "area" && !s.group)
      fail("누적 영역의 집단 속성을 선택하세요.");
  }
}
export function scopedRows(
  table: Table,
  scope: GraphScope,
): readonly DeepReadonly<Row>[] {
  if (scope.kind === "all") return table.rows;
  if (scope.kind === "selected") {
    const ids = new Set(scope.rowIds);
    return table.rows.filter((r) => ids.has(r.id));
  }
  let rows = table.rows;
  if (scope.duplicatesOnly) {
    const counts = new Map<string, number>(),
      rk = (r: DeepReadonly<Row>) =>
        JSON.stringify(table.columns.map((c) => r.values[c.id]));
    for (const r of rows) counts.set(rk(r), (counts.get(rk(r)) || 0) + 1);
    rows = rows.filter((r) => counts.get(rk(r))! > 1);
  }
  const f = scope.filter;
  if (!f) return rows;
  const c = table.columns.find((c) => c.id === f.attributeId)!;
  const n = c.storageType === "number";
  const rhs = ["missing", "present"].includes(f.operator)
    ? null
    : n
      ? numericValue(f.value)
      : c.semanticType === "date"
        ? convertCell(f.value, c)
        : f.value;
  return rows.filter((r) => {
    const v = r.values[c.id];
    if (f.operator === "missing") return isMissing(v);
    if (f.operator === "present") return !isMissing(v);
    if (isMissing(v)) return false;
    if (f.operator === "contains") return String(v).includes(f.value);
    if (f.operator === "equals")
      return n ? v === rhs : String(v) === String(rhs);
    return f.operator === "gt"
      ? n
        ? Number(v) > Number(rhs)
        : String(v) > String(rhs)
      : n
        ? Number(v) < Number(rhs)
        : String(v) < String(rhs);
  });
}
function matches(r: DeepReadonly<Row>, query: GraphQuery) {
  if (query.equals?.some((e) => r.values[e.attributeId] !== e.value))
    return false;
  if (query.numeric?.some((id) => !finite(r.values[id]))) return false;
  if (query.interval) {
    const b = query.interval,
      v = r.values[b.attributeId];
    if (!finite(v) || v < b.min || (b.includeMax ? v > b.max : v >= b.max))
      return false;
  }
  if (query.region) {
    const b = query.region,
      x = r.values[b.x],
      y = r.values[b.y];
    if (
      !finite(x) ||
      !finite(y) ||
      x < b.xMin ||
      x > b.xMax ||
      y < b.yMin ||
      y > b.yMax
    )
      return false;
  }
  return true;
}
export function graphRows(
  table: Table,
  g: GraphConfig,
  query: GraphQuery,
  page: number,
): GraphRows {
  validateGraph(g, table);
  if (!g.visual) throw new Error("설정 보완이 필요합니다.");
  const rows = scopedRows(table, g.visual.scope).filter((r) =>
    matches(r, query),
  );
  return {
    rows: structuredClone(rows.slice(page * 25, page * 25 + 25)) as Row[],
    total: rows.length,
    page,
  };
}
function range(values: number[], zero = false): [number, number] {
  if (!values.length) return [0, 1];
  let lo = zero ? 0 : Infinity,
    hi = zero ? 0 : -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return lo === hi
    ? [
        lo === 0 ? -1 : lo - Math.abs(lo) * 0.05,
        hi === 0 ? 1 : hi + Math.abs(hi) * 0.05,
      ]
    : [lo, hi];
}
/** Exact aggregates use all scoped rows. Only scatter/outlier rendering uses a reproducible reservoir. */
function sample<T>(rows: T[], limit: number, seed: number): T[] {
  if (rows.length <= limit) return rows;
  let state = seed >>> 0;
  const out = rows.slice(0, limit);
  for (let i = limit; i < rows.length; i++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    if (j < limit) out[j] = rows[i];
  }
  return out;
}
export function calculateGraph(table: Table, g: GraphConfig): GraphResult {
  const start = performance.now();
  validateGraph(g, table);
  if (!g.visual)
    throw new Error("과거 그래프입니다. 설정 보완 후 새 그래프로 저장하세요.");
  const s = g.visual,
    rows = scopedRows(table, s.scope),
    warnings: string[] = [],
    marks: GraphMark[] = [];
  if (rows.length > 50000)
    throw new Error("그래프 계산은 50,000행 이하입니다. 자료 범위를 줄이세요.");
  const groupValue = (r: DeepReadonly<Row>) =>
    s.group ? r.values[s.group] : null;
  const groups = new Map<
    string,
    { value: Cell; label: string; rows: DeepReadonly<Row>[] }
  >();
  for (const r of rows) {
    const v = groupValue(r),
      k = key(v);
    if (!groups.has(k))
      groups.set(k, {
        value: v,
        label: s.group ? categoryLabel(v) : "전체",
        rows: [],
      });
    groups.get(k)!.rows.push(r);
  }
  if (groups.size > 20 && s.group)
    throw new Error(
      "집단은 20개 이하로 비교합니다. 표 필터 또는 다른 집단 속성을 선택하세요.",
    );
  const groupQuery = (v: Cell): GraphQuery => ({
    equals: s.group ? [{ attributeId: s.group, value: v }] : [],
  });
  const numericTarget = ["scatter", "histogram", "box"].includes(g.kind)
    ? s.x
    : s.value;
  const summaries = [...groups.values()].map((gr) => {
    const target = table.columns.find((c) => c.id === numericTarget);
    const a =
      target?.storageType === "number" && target.semanticType === "numeric"
        ? gr.rows
            .map((r) => r.values[numericTarget])
            .filter(finite)
            .sort((a, b) => a - b)
        : [];
    return {
      group: gr.label,
      rows: gr.rows.length,
      valid: a.length,
      mean: mean(a),
      median: a.length ? q(a, 0.5) : null,
    };
  });
  let used = 0,
    displayed = 0,
    sampled = false,
    sampleCount = 0,
    boundaries: number[] = [],
    categories: string[] = [];
  const add = (m: Omit<GraphMark, "id">) =>
    marks.push({ id: String(marks.length), ...m });
  if (g.kind === "scatter") {
    const valid = rows.filter(
      (r) => finite(r.values[s.x]) && finite(r.values[s.y]),
    );
    used = valid.length;
    const shown = sample([...valid], s.sampling.limit, s.sampling.seed);
    sampleCount = shown.length;
    sampled = shown.length < valid.length;
    displayed = shown.length;
    const distinct = new Map<string, DeepReadonly<Row>>();
    for (const r of shown)
      distinct.set(
        JSON.stringify([r.values[s.x], r.values[s.y], groupValue(r)]),
        r,
      );
    const counts = new Map<string, number>();
    for (const r of valid) {
      const k = JSON.stringify([r.values[s.x], r.values[s.y], groupValue(r)]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const [k, r] of distinct) {
      const v = groupValue(r);
      add({
        label: `(${r.values[s.x]}, ${r.values[s.y]})`,
        group: groups.get(key(v))!.label,
        x: r.values[s.x],
        y: r.values[s.y] as number,
        count: counts.get(k)!,
        valid: counts.get(k)!,
        query: {
          equals: [
            ...(groupQuery(v).equals || []),
            { attributeId: s.x, value: r.values[s.x] },
            { attributeId: s.y, value: r.values[s.y] },
          ],
        },
        detail: "실제 X·Y 값 · 같은 좌표와 집단의 모든 행",
      });
    }
  } else if (g.kind === "histogram" || g.kind === "box") {
    const all = rows
      .map((r) => r.values[s.x])
      .filter(finite)
      .sort((a, b) => a - b);
    used = all.length;
    displayed = used;
    if (all.length && g.kind === "histogram") {
      const lo = all[0],
        hi = all.at(-1)!;
      if (lo === hi) {
        boundaries = [lo, hi];
        warnings.push("상수 열은 하나의 구간으로 표시합니다.");
      } else {
        const n =
          s.binMode === "count"
            ? s.binCount
            : Math.ceil((hi - lo) / s.binWidth);
        if (n > 100 || !Number.isFinite(n))
          throw new Error("구간은 100개 이하입니다. 구간 폭을 늘리세요.");
        boundaries = Array.from({ length: n + 1 }, (_, i) =>
          i === n
            ? hi
            : s.binMode === "count"
              ? lo + ((hi - lo) * i) / n
              : lo + s.binWidth * i,
        );
      }
      if (lo !== hi) {
        const unique = [...new Set(boundaries)];
        if (unique.length !== boundaries.length)
          warnings.push("수치 정밀도에서 구분할 수 없는 경계를 통합했습니다.");
        boundaries = unique;
      }
      if (
        s.boundaries.length &&
        JSON.stringify(s.boundaries) !== JSON.stringify(boundaries)
      )
        throw new Error(
          "저장된 구간 경계가 구간 방법·범위와 일치하지 않습니다.",
        );
      if (boundaries[0] !== lo || boundaries.at(-1) !== hi)
        throw new Error(
          "저장된 경계와 자료 범위가 다릅니다. 새 그래프로 다시 계산하세요.",
        );
      for (const gr of groups.values())
        for (let i = 0; i < boundaries.length - 1; i++) {
          const min = boundaries[i],
            max = boundaries[i + 1],
            includeMax = i === boundaries.length - 2,
            query = {
              ...groupQuery(gr.value),
              interval: { attributeId: s.x, min, max, includeMax },
            };
          const count = gr.rows.filter((r) => matches(r, query)).length,
            denominator = gr.rows.filter((r) => finite(r.values[s.x])).length;
          const label = `[${min}, ${max}${includeMax ? "]" : ")"}`;
          add({
            label,
            group: gr.label,
            x: label,
            y: s.ratio ? (denominator ? count / denominator : null) : count,
            count,
            valid: count,
            query,
            denominator,
            ratio: denominator ? count / denominator : undefined,
            detail: `${s.ratio ? "집단 내 유효값 대비 비율" : "빈도"} · 분모 ${denominator} · 왼쪽 포함, 마지막만 오른쪽 포함`,
          });
        }
    } else if (g.kind === "box") {
      const outliers: Omit<GraphMark, "id">[] = [];
      for (const gr of groups.values()) {
        const a = gr.rows
          .map((r) => r.values[s.x])
          .filter(finite)
          .sort((a, b) => a - b);
        if (!a.length) continue;
        const q1 = q(a, 0.25),
          median = q(a, 0.5),
          q3 = q(a, 0.75),
          iqr = q3 - q1,
          inside = a.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
        if (
          !Number.isFinite(iqr) ||
          !Number.isFinite(q1 - 1.5 * iqr) ||
          !Number.isFinite(q3 + 1.5 * iqr)
        )
          throw new Error(
            "IQR 범위가 계산 가능한 수를 넘었습니다. 단위를 조정하세요.",
          );
        add({
          label: gr.label,
          group: gr.label,
          x: gr.label,
          y: median,
          count: gr.rows.length,
          valid: a.length,
          box: [inside[0], q1, median, q3, inside.at(-1)!],
          query: groupQuery(gr.value),
          detail: `Q1 ${q1} · 중앙값 ${median} · Q3 ${q3} · IQR ${iqr} · (n−1)p 선형 보간 · 수염 ${inside[0]}~${inside.at(-1)} · 이상값을 제거하지 않음`,
        });
        const outlierCounts = new Map<number, number>();
        for (const v of a)
          if (v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr)
            outlierCounts.set(v, (outlierCounts.get(v) || 0) + 1);
        for (const [value, count] of outlierCounts)
          outliers.push({
            label: `${gr.label} 이상값 ${value}`,
            group: gr.label,
            x: gr.label,
            y: value,
            count: count,
            valid: count,
            outlier: true,
            query: {
              equals: [
                ...(groupQuery(gr.value).equals || []),
                { attributeId: s.x, value },
              ],
            },
            detail: "1.5×IQR 밖 실제 값 · 자료 제거 없음",
          });
      }
      const shown = sample(outliers, s.sampling.limit, s.sampling.seed);
      sampled = shown.length < outliers.length;
      sampleCount = shown.length;
      shown.forEach(add);
    }
  } else if (g.kind === "heatmap" && s.heatmap === "correlation") {
    used = rows.filter(
      (r) => s.correlationIds.filter((id) => finite(r.values[id])).length >= 2,
    ).length;
    displayed = used;
    for (const x of s.correlationIds)
      for (const y of s.correlationIds) {
        const pairs = rows.filter(
            (r) => finite(r.values[x]) && finite(r.values[y]),
          ),
          n = pairs.length;
        // Scale first to avoid intermediate overflow, then center for Pearson.
        let sx = 0,
          sy = 0;
        for (const r of pairs) {
          sx = Math.max(sx, Math.abs(r.values[x] as number));
          sy = Math.max(sy, Math.abs(r.values[y] as number));
        }
        const ax = pairs.map((r) => (r.values[x] as number) / (sx || 1)),
          ay = pairs.map((r) => (r.values[y] as number) / (sy || 1)),
          mx = mean(ax) || 0,
          my = mean(ay) || 0;
        let xx = 0,
          yy = 0,
          xy = 0;
        for (let i = 0; i < n; i++) {
          const dx = ax[i] - mx,
            dy = ay[i] - my;
          xx += dx * dx;
          yy += dy * dy;
          xy += dx * dy;
        }
        const corr =
          n < 2 || xx === 0 || yy === 0
            ? null
            : Math.max(-1, Math.min(1, xy / Math.sqrt(xx) / Math.sqrt(yy)));
        const xn = table.columns.find((c) => c.id === x)!.name,
          yn = table.columns.find((c) => c.id === y)!.name;
        add({
          label: `${xn} × ${yn}`,
          group: yn,
          x: xn,
          y: corr,
          count: n,
          valid: n,
          query: { numeric: [x, y] },
          detail: `Pearson · 쌍별 결측 제외 · 유효 ${n}행${corr === null ? " · 상수 또는 유효값 부족으로 계산 불가" : ""} · 인과관계를 뜻하지 않음`,
        });
      }
  } else {
    const cross = g.kind === "heatmap",
      xcol = table.columns.find((c) => c.id === s.x)!;
    const validX = (r: DeepReadonly<Row>) =>
      !isMissing(r.values[s.x]) &&
      (!["line", "area"].includes(g.kind) ||
        xcol.semanticType !== "date" ||
        (typeof r.values[s.x] === "string" &&
          validDate(r.values[s.x] as string)));
    const eligible = rows.filter(
      (r) => validX(r) && (!cross || !isMissing(r.values[s.y])),
    );
    let xs = [
      ...new Map(
        eligible.map((r) => [key(r.values[s.x]), r.values[s.x]]),
      ).values(),
    ];
    if (
      s.order !== "source" ||
      (["line", "area"].includes(g.kind) &&
        ["numeric", "date"].includes(xcol.semanticType))
    )
      xs.sort((a, b) =>
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), "ko"),
      );
    if (s.order === "descending" && !["line", "area"].includes(g.kind))
      xs.reverse();
    if (xs.length > s.categoryLimit && !s.categoryRangeConfirmed)
      throw new Error(
        `범주가 ${xs.length}개입니다. 고급 설정에서 표시 시작·개수를 정하고 범위 제외를 확인하세요.`,
      );
    const fullCategories = xs.length;
    xs = xs.slice(s.categoryStart, s.categoryStart + s.categoryLimit);
    if (xs.length < fullCategories)
      warnings.push(
        `전체 ${fullCategories}범주 중 ${s.categoryStart + 1}번째부터 ${xs.length}개 표시. 나머지는 제외하며 ‘기타’로 합치지 않습니다.`,
      );
    categories = xs.map(categoryLabel);
    const shownKeys = new Set(xs.map(key));
    const ys = cross
      ? [
          ...new Map(
            eligible.map((r) => [key(r.values[s.y]), r.values[s.y]]),
          ).values(),
        ]
      : [...groups.values()].map((gr) => gr.value);
    if (ys.length > 100 || xs.length * ys.length > 2000)
      throw new Error(
        "교차 칸/계열 조합은 2,000개, Y범주는 100개 이하입니다. 필터로 범위를 줄이세요.",
      );
    const buckets = new Map<string, DeepReadonly<Row>[]>();
    for (const r of eligible) {
      const k = JSON.stringify([
        r.values[s.x],
        cross ? r.values[s.y] : groupValue(r),
      ]);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(r);
    }
    used =
      s.aggregate === "rows"
        ? eligible.length
        : eligible.filter((r) => finite(r.values[s.value])).length;
    displayed = eligible.filter(
      (r) =>
        shownKeys.has(key(r.values[s.x])) &&
        (s.aggregate === "rows" || finite(r.values[s.value])),
    ).length;
    for (const x of xs)
      for (const y of ys) {
        const bucket = buckets.get(JSON.stringify([x, y])) || [],
          absent = bucket.length === 0;
        let value = aggregate(bucket, s.value, s.aggregate);
        if (absent && ["line", "area"].includes(g.kind))
          value = s.fillAbsent ? 0 : null;
        if (g.kind === "area" && value !== null && value < 0)
          throw new Error(
            "누적 영역은 음수 집계를 지원하지 않습니다. 막대·선 그래프로 확인하세요.",
          );
        const group = cross ? categoryLabel(y) : groups.get(key(y))!.label;
        const label = categoryLabel(x);
        add({
          label: `${label} · ${group}`,
          group,
          x,
          y: value,
          count: bucket.length,
          valid: bucket.filter((r) => finite(r.values[s.value])).length,
          query: {
            equals: [
              { attributeId: s.x, value: x },
              ...(cross
                ? [{ attributeId: s.y, value: y }]
                : groupQuery(y).equals || []),
            ],
          },
          absent,
          detail: `${aggregateLabels[s.aggregate]} · ${absent ? "없는 조합" + (s.fillAbsent ? " (명시적 0 채움)" : "") : bucket.length + "행"}${value === null ? " · 계산할 값 없음" : ""}`,
        });
      }
    if (g.kind === "pie") {
      if (marks.some((m) => m.y !== null && m.y < 0))
        throw new Error(
          "파이 구성비에 음수 집계값을 사용할 수 없습니다. 막대그래프를 선택하세요.",
        );
      const total = marks.reduce((a, m) => a + (m.y || 0), 0);
      if (!Number.isFinite(total) || total <= 0)
        throw new Error(
          "파이의 비음수 집계 합계가 0이거나 계산 범위를 넘었습니다. 범위·집계 방법을 확인하세요.",
        );
      marks.forEach((m) => {
        m.denominator = total;
        m.ratio = m.y === null ? undefined : m.y / total;
        m.detail += ` · 표시 범주 집계 합계 ${total} 대비 구성비`;
      });
    }
    if (g.kind === "area")
      warnings.push(
        "없는 조합은 기본적으로 공백입니다. 실제 행의 전부 결측 집계는 0 채움 선택과 무관하게 공백으로 유지합니다.",
      );
  }
  if (!rows.length)
    warnings.push(
      "이 범위에 해당하는 행이 없습니다. 전체 자료로 자동 전환하지 않았습니다.",
    );
  const totalMap = new Map<string, { x: Cell; value: number | null }>();
  if (g.kind === "area")
    for (const m of marks) {
      const k = key(m.x),
        prev = totalMap.get(k);
      totalMap.set(k, {
        x: m.x,
        value:
          m.y === null || prev?.value === null
            ? null
            : (prev?.value || 0) + m.y,
      });
    }
  const totals = [...totalMap.values()];
  const values = marks.flatMap((m) =>
    m.box ? [...m.box] : m.y === null ? [] : [m.y],
  );
  if ((s.stacked || g.kind === "area") && g.kind !== "box") {
    const sums = new Map<string, number>();
    for (const m of marks) {
      const k = key(m.x) + ((m.y || 0) < 0 ? "-" : "+");
      sums.set(k, (sums.get(k) || 0) + (m.y || 0));
    }
    values.push(...sums.values());
  }
  if (g.kind === "scatter")
    values.push(
      ...rows
        .filter((r) => finite(r.values[s.x]) && finite(r.values[s.y]))
        .map((r) => r.values[s.y] as number),
    );
  if (g.kind === "box")
    values.push(...rows.map((r) => r.values[s.x]).filter(finite));
  const xr =
      s.xRange ||
      range(
        g.kind === "scatter"
          ? rows.map((r) => r.values[s.x]).filter(finite)
          : [],
      ),
    yr =
      s.yRange || range(values, ["bar", "histogram", "area"].includes(g.kind));
  if (s.xRange || s.yRange)
    warnings.push(
      "고급 설정의 축 범위 밖 값은 화면에서 잘릴 수 있습니다. 집계표·원자료 목록에는 유지됩니다.",
    );
  if (sampled)
    warnings.push(
      `점 표시만 reservoir 표본 ${sampleCount}개 · seed ${s.sampling.seed}. 통계와 선택 영역 조회는 전체 범위에서 정확 계산합니다.`,
    );
  if (
    summaries.some(
      (s) =>
        (s.mean !== null && !Number.isFinite(s.mean)) ||
        (s.median !== null && !Number.isFinite(s.median)),
    ) ||
    totals.some((t) => t.value !== null && !Number.isFinite(t.value)) ||
    values.some((v) => !Number.isFinite(v)) ||
    !xr.every(Number.isFinite) ||
    !yr.every(Number.isFinite)
  )
    throw new Error(
      "계산 또는 축 범위가 유한한 수를 넘었습니다. 단위·범위를 조정하세요.",
    );
  return {
    marks,
    totals,
    groups: [...new Set(marks.map((m) => m.group))],
    categories,
    total: table.rows.length,
    scoped: rows.length,
    used,
    excluded: rows.length - used,
    displayed,
    sampled,
    sampleCount,
    boundaries,
    warnings,
    xRange: xr,
    yRange: yr,
    summaries,
    durationMs: performance.now() - start,
  };
}
