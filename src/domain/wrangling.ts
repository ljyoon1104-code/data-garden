import type {
  Attribute,
  Cell,
  DataVersion,
  Dataset,
  DeepReadonly,
  VersionRef,
} from "./types";
import type {
  AggregateMethod,
  DatePart,
  FittedWrangling,
  InputAttribute,
  InputTable,
  JoinGroup,
  WranglingPreview,
  WranglingSettings,
} from "./wrangling-types";
import { isMissing, validDate } from "./table";
import { isNumeric, quantile } from "./preprocessing";
import { createVersion, preserveOriginal, snapshot } from "./model";
import { MAX_PRESERVED_CELLS } from "./limits";

export const wranglingLabels = {
  calculate: "계산 열",
  date: "날짜 분리",
  encode: "범주형 인코딩",
  bin: "구간화",
  join: "자료 결합",
  stack: "행 이어 붙이기",
  aggregate: "그룹별 집계",
};
export const operatorLabels = {
  add: "더하기",
  subtract: "빼기",
  multiply: "곱하기",
  divide: "나누기",
  sum: "합계",
  mean: "평균",
  ratio: "비율",
  percent: "백분율 (×100)",
};
export const datePartLabels: Record<DatePart, string> = {
  year: "연도",
  month: "월",
  day: "일",
  quarter: "분기",
  weekday: "요일",
  hour: "시",
  minute: "분",
  second: "초",
};
export const aggregateLabels: Record<AggregateMethod, string> = {
  rows: "행 수",
  valid: "유효값 수",
  sum: "합계",
  mean: "평균",
  min: "최솟값",
  max: "최댓값",
  median: "중앙값",
};
export const isDerived = (kind: WranglingSettings["kind"]) =>
  ["join", "stack", "aggregate"].includes(kind);
export const typedKey = (values: readonly Cell[]) => JSON.stringify(values);
const attrKey = (a: InputAttribute) => `${a.input}:${a.attributeId}`;
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const finite = (value: number) => {
  assert(
    Number.isFinite(value),
    "수치 범위를 초과했습니다. 속성·상수·방법을 변경하세요.",
  );
  return value;
};
export function assertOutputSize(
  rows: number,
  columns: number,
  remaining = MAX_PRESERVED_CELLS,
  copies = 1,
) {
  assert(
    Number.isSafeInteger(rows) &&
      rows >= 0 &&
      Number.isSafeInteger(columns) &&
      columns > 0,
    "출력 크기가 올바르지 않습니다.",
  );
  assert(
    rows <= 50000 && columns <= 200 && (rows + 1) * columns <= 500000,
    `예상 출력 ${rows.toLocaleString()}행·${columns}열이 결과 한도(50,000행, 200열, 머리글 포함 500,000셀)를 넘습니다. 속성·입력 자료·작업을 줄이세요. 결과를 잘라내지 않습니다.`,
  );
  assert(
    Number.isFinite(remaining) && rows * columns * copies <= remaining,
    `출력의 보존본 ${copies}개를 포함하면 전체 보존 셀 300만 개를 초과합니다. 프로젝트를 나누세요. 과거 버전은 삭제하지 않습니다.`,
  );
}
export function proposeStack(
  inputs: readonly InputTable[],
): Extract<WranglingSettings, { kind: "stack" }> {
  const mappings: Extract<WranglingSettings, { kind: "stack" }>["mappings"] =
    [];
  inputs.forEach((input, i) =>
    input.table.columns.forEach((c) => {
      let m = mappings.find(
        (m) => m.name === c.name && !m.sources.some((s) => s.input === i),
      );
      if (!m) {
        m = { key: crypto.randomUUID(), name: c.name, sources: [] };
        mappings.push(m);
      }
      m.sources.push({ input: i, attributeId: c.id });
    }),
  );
  return {
    kind: "stack",
    mappings,
    excluded: [],
    typeConflict: "block",
    name: "이어 붙인 자료",
  };
}
export function defaultWrangling(
  kind: WranglingSettings["kind"],
  inputs: readonly InputTable[],
): WranglingSettings {
  const columns = inputs[0]?.table.columns ?? [],
    numeric = columns.filter(isNumeric);
  if (kind === "calculate")
    return {
      kind,
      operator: "add",
      operands: [
        numeric[0]
          ? { kind: "attribute", attributeId: numeric[0].id }
          : { kind: "constant", value: 0 },
        { kind: "constant", value: 1 },
      ],
      missing: "propagate",
      invalid: "block",
      output: { name: "계산 결과", description: "" },
    };
  if (kind === "date")
    return {
      kind,
      attributeId: columns.find((c) => c.semanticType === "date")?.id ?? "",
      parts: (["year", "month", "day"] as DatePart[]).map((part) => ({
        part,
        name: datePartLabels[part],
        description: "",
        storageType: "number",
        semanticType: part === "year" ? "numeric" : "categorical",
      })),
      invalid: "block",
    };
  if (kind === "encode")
    return {
      kind,
      attributeId:
        columns.find((c) => c.semanticType === "categorical")?.id ?? "",
      method: "code",
      output: { name: "범주 코드", description: "" },
      order: null,
      dropBaseline: false,
      baseline: null,
      unknown: "block",
    };
  if (kind === "bin")
    return {
      kind,
      attributeId: numeric[0]?.id ?? "",
      method: "width",
      count: 3,
      labels: ["구간 1", "구간 2", "구간 3"],
      outside: "missing",
      output: { name: "구간", description: "" },
    };
  if (kind === "join")
    return {
      kind,
      mode: "left",
      keys: [
        {
          left: columns[0]?.id ?? "",
          right: inputs[1]?.table.columns[0]?.id ?? "",
        },
      ],
      columnNames: {},
      name: "결합한 자료",
    };
  if (kind === "stack") return proposeStack(inputs);
  return {
    kind,
    groupIds: columns[0] ? [columns[0].id] : [],
    includeMissing: true,
    aggregates: [
      { method: "rows", attributeId: null, name: "행 수", description: "" },
    ],
    name: "집계한 자료",
  };
}
function getColumn(inputs: readonly InputTable[], a: InputAttribute) {
  const c = inputs[a.input]?.table.columns.find((c) => c.id === a.attributeId);
  assert(c, "입력 속성이 없습니다. 자료와 속성을 다시 선택하세요.");
  return c!;
}
function numericColumn(inputs: readonly InputTable[], id: string) {
  const c = getColumn(inputs, { input: 0, attributeId: id });
  assert(
    isNumeric(c),
    `${c.name}: 숫자 저장형·수치 의미 유형만 사용할 수 있습니다.`,
  );
  return c;
}
function uniqueAttributes(sources: readonly InputAttribute[]) {
  return [...new Map(sources.map((s) => [attrKey(s), { ...s }])).values()];
}
function validName(name: string) {
  assert(
    typeof name === "string" && !!name.trim(),
    "결과 열·자료 이름을 입력하세요.",
  );
  return name.trim();
}
function statistics(values: number[], method: AggregateMethod): Cell {
  if (!values.length) return null;
  if (method === "sum") return values.reduce((s, v) => finite(s + v), 0);
  if (method === "mean") {
    let mean = 0;
    values.forEach(
      (v, i) => (mean = finite(mean + finite(v - mean) / (i + 1))),
    );
    return mean;
  }
  if (method === "min") return values.reduce((a, b) => Math.min(a, b));
  if (method === "max") return values.reduce((a, b) => Math.max(a, b));
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}
/** Learns category dictionaries / interval boundaries only from the supplied fit scope. */
export function fitWrangling(
  inputs: readonly InputTable[],
  settings: WranglingSettings,
  scope?: { kind: "all" | "training"; rowIds: string[] },
): DeepReadonly<FittedWrangling> {
  const s = structuredClone(settings);
  assert(inputs.length > 0, "입력 자료가 없습니다.");
  assert(
    new Set(inputs.map((i) => i.source.versionId)).size === inputs.length,
    "같은 입력 버전을 두 번 선택할 수 없습니다. 서로 다른 자료를 선택하세요.",
  );
  assert(
    s.kind === "join"
      ? inputs.length === 2
      : s.kind === "stack"
        ? inputs.length >= 2
        : inputs.length === 1,
    "작업에 필요한 입력 자료 수를 확인하세요.",
  );
  assert(
    !scope || scope.kind === "all" || s.kind === "encode" || s.kind === "bin",
    "학습 행 기준은 인코딩·구간화에만 지정합니다.",
  );
  const first = inputs[0].table,
    derived = isDerived(s.kind),
    columns: Attribute[] = [],
    columnSources: Record<string, InputAttribute[]> = {};
  const names = new Set(derived ? [] : first.columns.map((c) => c.name));
  const add = (requested: Omit<Attribute, "id">, sources: InputAttribute[]) => {
    let name = validName(requested.name),
      base = name,
      n = 2;
    while (names.has(name)) name = `${base} (${n++})`;
    names.add(name);
    const column = { ...requested, name, id: crypto.randomUUID() };
    columns.push(column);
    columnSources[column.id] = uniqueAttributes(sources);
    return column;
  };
  const number = (
    name: string,
    description: string,
    sources: InputAttribute[],
    semanticType: Attribute["semanticType"] = "numeric",
  ) =>
    add(
      {
        name,
        description,
        storageType: "number",
        semanticType,
        useInAnalysis: true,
      },
      sources,
    );
  const fitScopes = inputs.map((input, i) => {
    const rowIds =
        i === 0 && scope ? scope.rowIds : input.table.rows.map((r) => r.id),
      ids = new Set(rowIds),
      available = new Set(input.table.rows.map((r) => r.id));
    assert(
      ids.size === rowIds.length && rowIds.every((id) => available.has(id)),
      "기준 계산 행 참조가 잘못되었습니다.",
    );
    const kind = i === 0 && scope ? scope.kind : "all";
    assert(
      kind !== "all" || rowIds.length === input.table.rows.length,
      "전체 기준은 모든 입력 행을 포함해야 합니다.",
    );
    return {
      kind,
      rowIds: input.table.rows.filter((r) => ids.has(r.id)).map((r) => r.id),
      count: rowIds.length,
    };
  });
  const fittedIds = new Set(fitScopes[0].rowIds),
    fitRows = first.rows.filter((r) => fittedIds.has(r.id));
  let basis: FittedWrangling["basis"] = null;
  if (s.kind === "calculate") {
    assert(
      s.operands.length >= 1 &&
        (["sum", "mean"].includes(s.operator) || s.operands.length === 2),
      "연산에 맞는 피연산자를 선택하세요.",
    );
    assert(
      ["sum", "mean"].includes(s.operator) || s.missing === "propagate",
      "결측 제외는 여러 속성 합계·평균에만 사용할 수 있습니다.",
    );
    const refs: InputAttribute[] = [];
    for (const operand of s.operands) {
      if (operand.kind === "attribute") {
        numericColumn(inputs, operand.attributeId);
        refs.push({ input: 0, attributeId: operand.attributeId });
      } else finite(operand.value);
    }
    number(s.output.name, s.output.description, refs);
  }
  if (s.kind === "date") {
    const c = getColumn(inputs, { input: 0, attributeId: s.attributeId });
    assert(
      c.storageType === "string" && c.semanticType === "date",
      "날짜 의미 유형의 문자열 속성을 선택하세요.",
    );
    assert(
      s.parts.length > 0 &&
        new Set(s.parts.map((p) => p.part)).size === s.parts.length,
      "중복 없이 날짜 부분을 선택하세요.",
    );
    s.parts.forEach((p) => {
      assert(
        p.semanticType !== "numeric" || p.storageType === "number",
        "수치 의미는 숫자 저장형을 사용하세요.",
      );
      add(
        {
          name: p.name,
          description: p.description,
          storageType: p.storageType,
          semanticType: p.semanticType,
          useInAnalysis: true,
        },
        [{ input: 0, attributeId: c.id }],
      );
    });
  }
  if (s.kind === "encode") {
    const c = getColumn(inputs, { input: 0, attributeId: s.attributeId });
    assert(
      c.semanticType === "categorical",
      "범주 의미 유형의 속성을 선택하세요.",
    );
    const counts = new Map<string, { value: Cell; count: number }>();
    for (const r of fitRows) {
      const value = r.values[c.id];
      if (isMissing(value)) continue;
      const key = typedKey([value]),
        b = counts.get(key);
      if (b) b.count++;
      else counts.set(key, { value, count: 1 });
    }
    assert(
      counts.size > 0,
      "기준 자료에 유효한 범주가 없습니다. 자료 또는 속성을 바꾸세요.",
    );
    let categories = [...counts.values()];
    if (s.order) {
      assert(
        s.order.length === categories.length &&
          new Set(s.order.map((v) => typedKey([v]))).size ===
            categories.length &&
          s.order.every((v) => counts.has(typedKey([v]))),
        "지정 순서에 모든 범주를 중복 없이 포함하세요.",
      );
      categories = s.order.map((v) => counts.get(typedKey([v]))!);
    }
    let baselineIndex: number | null = null;
    if (s.method === "onehot" && s.dropBaseline) {
      baselineIndex =
        s.baseline === null
          ? 0
          : categories.findIndex(
              (c) => typedKey([c.value]) === typedKey([s.baseline]),
            );
      assert(
        baselineIndex >= 0,
        "기준 범주가 기준 자료에 없습니다. 다시 선택하세요.",
      );
    }
    const count =
      s.method === "code"
        ? 1
        : categories.length - (baselineIndex === null ? 0 : 1);
    assert(
      count > 0,
      "제외 후 생성할 열이 없습니다. 기준 범주 제외를 해제하세요.",
    );
    assertOutputSize(first.rows.length, first.columns.length + count);
    const refs = [{ input: 0, attributeId: c.id }];
    const codeColumn =
      s.method === "code"
        ? number(s.output.name, s.output.description, refs, "categorical")
        : null;
    basis = {
      kind: "encode",
      baselineIndex,
      categories: categories.map((cat, code) => ({
        ...cat,
        code,
        columnId:
          codeColumn?.id ??
          (code === baselineIndex
            ? null
            : number(
                `${validName(s.output.name)} · ${typeof cat.value}:${String(cat.value)}`,
                s.output.description,
                refs,
              ).id),
      })),
    };
  }
  if (s.kind === "bin") {
    numericColumn(inputs, s.attributeId);
    assert(
      Number.isInteger(s.count) && s.count >= 2 && s.count <= 200,
      "구간 수는 2~200 사이 정수로 입력하세요.",
    );
    const values = fitRows
      .map((r) => r.values[s.attributeId])
      .filter((v) => !isMissing(v));
    assert(
      values.length > 0 &&
        values.every((v) => typeof v === "number" && Number.isFinite(v)),
      "구간 기준을 구할 유효한 수치가 없습니다.",
    );
    const sorted = (values as number[]).sort((a, b) => a - b),
      min = sorted[0],
      max = sorted.at(-1)!;
    assert(
      min < max,
      "상수 열은 여러 구간으로 나눌 수 없습니다. 다른 속성을 선택하세요.",
    );
    finite(max - min);
    const boundaries = [
      ...new Set(
        Array.from({ length: s.count + 1 }, (_, i) =>
          s.method === "width"
            ? i === 0
              ? min
              : i === s.count
                ? max
                : finite(min * (1 - i / s.count) + max * (i / s.count))
            : quantile(sorted, i / s.count),
        ),
      ),
    ];
    const count = boundaries.length - 1,
      labels = s.labels.slice(0, count).map(validName);
    assert(
      labels.length === count && new Set(labels).size === count,
      "실제 구간 수만큼 서로 다른 범주 이름을 입력하세요.",
    );
    basis = { kind: "bin", boundaries, labels, counts: Array(count).fill(0) };
    const counts = basis.counts;
    sorted.forEach((v) => counts[binIndex(v, boundaries)]++);
    add(
      {
        ...s.output,
        storageType: "string",
        semanticType: "categorical",
        useInAnalysis: true,
      },
      [{ input: 0, attributeId: s.attributeId }],
    );
  }
  if (s.kind === "join") {
    validName(s.name);
    assert(
      s.keys.length > 0 &&
        new Set(s.keys.map((k) => k.left)).size === s.keys.length &&
        new Set(s.keys.map((k) => k.right)).size === s.keys.length,
      "중복 없이 결합 키를 선택하세요.",
    );
    const keys = s.keys.flatMap((k) => [
      { input: 0, attributeId: k.left },
      { input: 1, attributeId: k.right },
    ]);
    keys.forEach((k) => getColumn(inputs, k));
    inputs.forEach((input, i) =>
      input.table.columns.forEach((c) => {
        const same = inputs[1 - i].table.columns.some(
          (other) => other.name === c.name,
        );
        add(
          {
            ...c,
            name:
              s.columnNames[`${i}:${c.id}`] ??
              `${c.name}${same ? (i === 0 ? " (왼쪽)" : " (오른쪽)") : ""}`,
          },
          [{ input: i, attributeId: c.id }, ...keys],
        );
      }),
    );
  }
  if (s.kind === "stack") {
    validName(s.name);
    assert(
      s.mappings.length > 0 &&
        new Set(s.mappings.map((m) => m.key)).size === s.mappings.length,
      "출력 열 대응을 확인하세요.",
    );
    const covered = [...s.mappings.flatMap((m) => m.sources), ...s.excluded];
    assert(
      new Set(covered.map(attrKey)).size === covered.length &&
        covered.length ===
          inputs.reduce((n, i) => n + i.table.columns.length, 0),
      "모든 입력 열을 한 번씩 대응하거나 명시적으로 제외하세요.",
    );
    covered.forEach((a) => getColumn(inputs, a));
    for (const m of s.mappings) {
      assert(
        m.sources.length > 0 &&
          new Set(m.sources.map((a) => a.input)).size === m.sources.length,
        "한 자료의 여러 열을 한 결과 열에 대응할 수 없습니다.",
      );
      const cols = m.sources.map((a) => getColumn(inputs, a)),
        first = cols[0],
        conflict = cols.some(
          (c) =>
            c.storageType !== first.storageType ||
            c.semanticType !== first.semanticType,
        );
      assert(
        !conflict || s.typeConflict === "mixed",
        `${m.name}: 저장형 또는 의미 유형이 다릅니다. 별도 열로 대응하거나 혼합 저장을 명시적으로 선택하세요.`,
      );
      add(
        {
          ...first,
          name: m.name,
          ...(conflict
            ? {
                storageType: "mixed" as const,
                semanticType: "text" as const,
                description: "유형 충돌: 변환 없이 혼합 값으로 보존",
              }
            : {}),
        },
        m.sources,
      );
    }
  }
  if (s.kind === "aggregate") {
    validName(s.name);
    assert(
      s.groupIds.length > 0 && new Set(s.groupIds).size === s.groupIds.length,
      "그룹 속성을 중복 없이 하나 이상 선택하세요.",
    );
    const groups = s.groupIds.map((attributeId) => ({ input: 0, attributeId }));
    groups.forEach((a) => add({ ...getColumn(inputs, a) }, [a]));
    assert(s.aggregates.length > 0, "집계 방법을 하나 이상 선택하세요.");
    for (const a of s.aggregates) {
      const refs = [...groups];
      if (a.method !== "rows") {
        assert(a.attributeId, "집계 속성을 선택하세요.");
        getColumn(inputs, { input: 0, attributeId: a.attributeId! });
        refs.push({ input: 0, attributeId: a.attributeId! });
        if (a.method !== "valid") numericColumn(inputs, a.attributeId!);
      }
      number(a.name, a.description, refs);
    }
  }
  assert(columns.length > 0, "생성할 결과 열이 없습니다.");
  return snapshot({
    formatVersion: 1,
    settings: s,
    inputs: inputs.map((i) => ({ ...i.source })),
    fitScopes,
    columns,
    columnSources,
    referencedAttributes: uniqueAttributes(Object.values(columnSources).flat()),
    inputSchema: uniqueAttributes(Object.values(columnSources).flat()).map(
      (a) => {
        const c = getColumn(inputs, a);
        return {
          ...a,
          storageType: c.storageType,
          semanticType: c.semanticType,
        };
      },
    ),
    basis,
    conventions: {
      missing: "null-or-empty",
      equality: "typed-json",
      weekday: "monday-1-sunday-7",
      quantile: "linear-n-minus-one",
      interval: "left-closed-last-both",
    },
  });
}
function binIndex(value: number, boundaries: readonly number[]) {
  let lo = 0,
    hi = boundaries.length - 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (value < boundaries[mid]) hi = mid;
    else lo = mid;
  }
  return Math.min(lo, boundaries.length - 2);
}
function dateNumber(value: string, part: DatePart): number | null {
  const y = Number(value.slice(0, 4)),
    m = Number(value.slice(5, 7)),
    d = Number(value.slice(8, 10));
  if (part === "year") return y;
  if (part === "month") return m;
  if (part === "day") return d;
  if (part === "quarter") return Math.ceil(m / 3);
  if (part === "weekday") {
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    return ((date.getUTCDay() + 6) % 7) + 1;
  }
  if (value.length === 10) return null;
  return Number(
    value.slice(
      part === "hour" ? 11 : part === "minute" ? 14 : 17,
      part === "hour" ? 13 : part === "minute" ? 16 : 19,
    ),
  );
}
/** Never fits, extends a dictionary, changes columns, or widens boundaries during application. */
export function applyWrangling(
  inputs: readonly InputTable[],
  fitted: DeepReadonly<FittedWrangling>,
  remaining = MAX_PRESERVED_CELLS,
): WranglingPreview {
  assert(inputs.length > 0, "적용할 입력 자료가 없습니다.");
  const s = fitted.settings,
    derived = isDerived(s.kind),
    first = inputs[0].table;
  assert(
    inputs.length === fitted.inputs.length,
    "기준의 입력 자료 수와 다릅니다.",
  );
  fitted.inputSchema.forEach((a) => {
    const c = getColumn(inputs, a);
    assert(
      c.storageType === a.storageType && c.semanticType === a.semanticType,
      `${c.name}: 기준 계산 당시 저장형·의미 유형과 다릅니다.`,
    );
  });
  assert(
    derived ||
      fitted.columns.every((c) => !first.columns.some((x) => x.id === c.id)),
    "같은 결과 열 ID를 다시 추가할 수 없습니다.",
  );
  const columns = derived
    ? (structuredClone(fitted.columns) as Attribute[])
    : [
        ...first.columns.map((c) => ({ ...c })),
        ...(structuredClone(fitted.columns) as Attribute[]),
      ];
  const output: WranglingPreview = {
    fitted: structuredClone(fitted) as FittedWrangling,
    table: { columns, rows: [] },
    rowSources: {},
    issues: [],
    joinGroups: [],
    warnings: [
      "이름이 겹치면 (2), (3) 등을 붙입니다. 실제 결과 열 이름과 의미 유형을 확인하세요.",
    ],
    summary: {
      inputRows: inputs.map((i) => i.table.rows.length),
      outputRows: 0,
      outputColumns: columns.length,
      addedColumns: fitted.columns.length,
      manyToManyGroups: 0,
      matchedLeft: 0,
      matchedRight: 0,
      unmatchedLeft: 0,
      unmatchedRight: 0,
      binCounts:
        fitted.basis?.kind === "bin"
          ? Array(fitted.basis.labels.length).fill(0)
          : [],
      validOperandCounts: {},
    },
  };
  const size = (rows: number) =>
    assertOutputSize(rows, columns.length, remaining, derived ? 2 : 1);
  const issue = (
    input: number,
    rowId: string,
    message: string,
    blocking: boolean,
  ) => output.issues.push({ input, rowId, message, blocking });
  const append = (
    values: Record<string, Cell>,
    sources: WranglingPreview["rowSources"][string],
    id: string = crypto.randomUUID(),
  ) => {
    output.table.rows.push({ id, values });
    output.rowSources[id] = sources;
  };
  if (!derived) {
    size(first.rows.length);
    const dictionary =
      fitted.basis?.kind === "encode"
        ? new Map(fitted.basis.categories.map((c) => [typedKey([c.value]), c]))
        : null;
    for (const row of first.rows) {
      const values = { ...row.values };
      fitted.columns.forEach((c) => (values[c.id] = null));
      try {
        if (s.kind === "calculate") {
          const operands = s.operands.map((o) =>
              o.kind === "constant" ? o.value : row.values[o.attributeId],
            ),
            valid = operands.filter((v) => !isMissing(v));
          output.summary.validOperandCounts[row.id] = valid.length;
          assert(
            valid.every((v) => typeof v === "number" && Number.isFinite(v)),
            "피연산자가 유한한 수치가 아닙니다.",
          );
          if (
            valid.length &&
            !(s.missing === "propagate" && valid.length !== operands.length)
          ) {
            const nums = valid as number[];
            let value: Cell = null;
            if (s.operator === "sum" || s.operator === "mean")
              value = statistics(nums, s.operator);
            else {
              const [a, b] = nums;
              if (["divide", "ratio", "percent"].includes(s.operator))
                assert(b !== 0, "0으로 나눌 수 없습니다.");
              value =
                s.operator === "add"
                  ? finite(a + b)
                  : s.operator === "subtract"
                    ? finite(a - b)
                    : s.operator === "multiply"
                      ? finite(a * b)
                      : finite(
                          finite(a / b) * (s.operator === "percent" ? 100 : 1),
                        );
            }
            values[fitted.columns[0].id] = value;
          }
        }
        if (s.kind === "date") {
          const value = row.values[s.attributeId];
          if (!isMissing(value)) {
            assert(
              typeof value === "string" && validDate(value),
              "날짜 형식 또는 실제 달력 날짜가 잘못되었습니다.",
            );
            s.parts.forEach((part, i) => {
              const n = dateNumber(value as string, part.part);
              if (n === null)
                issue(
                  0,
                  row.id,
                  `${datePartLabels[part.part]}: 시각 없는 날짜이므로 결측으로 유지합니다.`,
                  false,
                );
              values[fitted.columns[i].id] =
                n === null
                  ? null
                  : part.storageType === "string"
                    ? String(n)
                    : n;
            });
          }
        }
        if (s.kind === "encode") {
          const value = row.values[s.attributeId];
          if (!isMissing(value)) {
            const category = dictionary!.get(typedKey([value]));
            assert(
              category,
              `미등록 범주 (${typeof value}:${String(value)}): 기존 범주로 처리하지 않습니다.`,
            );
            if (s.method === "code")
              values[fitted.columns[0].id] = category!.code;
            else
              fitted.columns.forEach(
                (c) => (values[c.id] = c.id === category!.columnId ? 1 : 0),
              );
          }
        }
        if (s.kind === "bin") {
          const value = row.values[s.attributeId],
            basis = fitted.basis;
          assert(basis?.kind === "bin", "구간 기준이 없습니다.");
          if (!isMissing(value)) {
            assert(
              typeof value === "number" && Number.isFinite(value),
              "구간화할 값이 수치가 아닙니다.",
            );
            const b = basis as Extract<
                FittedWrangling["basis"],
                { kind: "bin" }
              >,
              outside =
                (value as number) < b.boundaries[0] ||
                (value as number) > b.boundaries.at(-1)!;
            if (outside && s.outside !== "edge")
              issue(
                0,
                row.id,
                "학습된 구간 범위 밖의 값입니다. 경계를 넓히지 않고 결측으로 유지합니다.",
                s.outside === "block",
              );
            else {
              const index = binIndex(value as number, b.boundaries);
              values[fitted.columns[0].id] = b.labels[index];
              output.summary.binCounts[index]++;
              if (outside)
                issue(
                  0,
                  row.id,
                  "범위 밖의 값을 미리 선택한 끝 구간으로 배정했습니다.",
                  false,
                );
            }
          }
        }
      } catch (error) {
        const blocking =
          s.kind === "encode"
            ? s.unknown === "block"
            : s.kind === "bin"
              ? true
              : (s.kind === "calculate" || s.kind === "date") &&
                s.invalid === "block";
        issue(
          0,
          row.id,
          error instanceof Error ? error.message : String(error),
          blocking,
        );
        fitted.columns.forEach((c) => (values[c.id] = null));
      }
      append(values, [{ input: 0, rowIds: [row.id] }], row.id);
    }
  }
  if (s.kind === "join") {
    const buckets = inputs.map((input, i) => {
      const map = new Map<
        string,
        { key: Cell[]; rows: (typeof input.table.rows)[number][] }
      >();
      for (const row of input.table.rows) {
        const key = s.keys.map((k) => row.values[i === 0 ? k.left : k.right]);
        if (key.some(isMissing)) continue;
        const id = typedKey(key),
          b = map.get(id);
        if (b) b.rows.push(row);
        else map.set(id, { key, rows: [row] });
      }
      return map;
    });
    const keys = new Set([...buckets[0].keys(), ...buckets[1].keys()]);
    let estimated = 0;
    for (const key of keys) {
      const left = buckets[0].get(key),
        right = buckets[1].get(key),
        l = left?.rows.length ?? 0,
        r = right?.rows.length ?? 0;
      let relation: JoinGroup["relation"] = "unmatched";
      if (l && r) {
        estimated += l * r;
        output.summary.matchedLeft += l;
        output.summary.matchedRight += r;
        relation = l > 1 ? (r > 1 ? "N:M" : "N:1") : r > 1 ? "1:N" : "1:1";
        if (l > 1 && r > 1) output.summary.manyToManyGroups++;
      }
      output.joinGroups.push({
        key: structuredClone(left?.key ?? right!.key),
        leftRowIds: left?.rows.map((r) => r.id) ?? [],
        rightRowIds: right?.rows.map((r) => r.id) ?? [],
        relation,
      });
    }
    output.summary.unmatchedLeft =
      first.rows.length - output.summary.matchedLeft;
    output.summary.unmatchedRight =
      inputs[1].table.rows.length - output.summary.matchedRight;
    if (s.mode !== "inner") estimated += output.summary.unmatchedLeft;
    if (s.mode === "full") estimated += output.summary.unmatchedRight;
    size(estimated); // Checked before allocating any joined result row, including many-to-many expansion.
    const rightMatched = new Set<string>();
    const emit = (
      left: (typeof first.rows)[number] | null,
      right: (typeof first.rows)[number] | null,
    ) => {
      const values: Record<string, Cell> = {};
      let col = 0;
      inputs.forEach((input, i) =>
        input.table.columns.forEach(
          (c) =>
            (values[fitted.columns[col++].id] =
              (i === 0 ? left : right)?.values[c.id] ?? null),
        ),
      );
      append(values, [
        ...(left ? [{ input: 0, rowIds: [left.id] }] : []),
        ...(right ? [{ input: 1, rowIds: [right.id] }] : []),
      ]);
    };
    for (const left of first.rows) {
      const key = s.keys.map((k) => left.values[k.left]),
        matches = key.some(isMissing)
          ? []
          : (buckets[1].get(typedKey(key))?.rows ?? []);
      if (matches.length)
        for (const right of matches) {
          emit(left, right);
          rightMatched.add(right.id);
        }
      else if (s.mode !== "inner") emit(left, null);
    }
    if (s.mode === "full")
      for (const right of inputs[1].table.rows)
        if (!rightMatched.has(right.id)) emit(null, right);
    output.warnings.push(
      "결측 키는 서로 연결하지 않습니다. 양쪽 키 열을 모두 보존하므로 연결되지 않은 오른쪽 행의 키도 유지됩니다.",
    );
  }
  if (s.kind === "stack") {
    size(inputs.reduce((n, i) => n + i.table.rows.length, 0));
    inputs.forEach((input, i) => {
      for (const row of input.table.rows) {
        const values: Record<string, Cell> = {};
        s.mappings.forEach((m, j) => {
          const source = m.sources.find((a) => a.input === i);
          values[fitted.columns[j].id] = source
            ? row.values[source.attributeId]
            : null;
        });
        append(values, [{ input: i, rowIds: [row.id] }]);
      }
    });
    output.warnings.push(
      "입력 순서대로 이어 붙입니다. 대응하지 않는 칸은 null이며 값을 변환하거나 중복 행을 제거하지 않습니다.",
    );
  }
  if (s.kind === "aggregate") {
    const groups = new Map<
      string,
      { key: Cell[]; rows: (typeof first.rows)[number][] }
    >();
    for (const row of first.rows) {
      const key = s.groupIds.map((id) => row.values[id]);
      if (!s.includeMissing && key.some(isMissing)) continue;
      const k = typedKey(key),
        group = groups.get(k);
      if (group) group.rows.push(row);
      else groups.set(k, { key, rows: [row] });
    }
    size(groups.size);
    for (const group of groups.values()) {
      const values: Record<string, Cell> = {};
      group.key.forEach((value, i) => (values[fitted.columns[i].id] = value));
      s.aggregates.forEach((a, i) => {
        const id = fitted.columns[s.groupIds.length + i].id,
          valid = group.rows
            .map((r) => (a.attributeId ? r.values[a.attributeId] : null))
            .filter((v) => !isMissing(v));
        try {
          if (a.method === "rows") values[id] = group.rows.length;
          else if (a.method === "valid") values[id] = valid.length;
          else {
            assert(
              valid.every((v) => typeof v === "number" && Number.isFinite(v)),
              "수치 집계에 잘못된 자료형이 있습니다.",
            );
            values[id] = statistics(valid as number[], a.method);
          }
        } catch (error) {
          values[id] = null;
          issue(
            0,
            group.rows[0].id,
            `${a.name}: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      });
      append(values, [{ input: 0, rowIds: group.rows.map((r) => r.id) }]);
    }
    output.warnings.push(
      "그룹 키는 자료형을 구분합니다. 결측 그룹 포함 시 null과 빈 문자열도 서로 다른 그룹입니다. 유효 수치가 없는 합계·평균 등은 null입니다.",
    );
  }
  output.summary.outputRows = output.table.rows.length;
  if (
    fitted.basis?.kind === "bin" &&
    s.kind === "bin" &&
    fitted.basis.labels.length !== s.count
  )
    output.warnings.push(
      `중복 경계를 통합했습니다. 요청 ${s.count}개 → 실제 ${fitted.basis.labels.length}개 구간이며 빈도는 같지 않을 수 있습니다.`,
    );
  return output;
}
export function previewWrangling(
  inputs: readonly InputTable[],
  settings: WranglingSettings,
  remaining: number,
) {
  return applyWrangling(inputs, fitWrangling(inputs, settings), remaining);
}
export function commitWrangling(
  inputs: readonly InputTable[],
  fitted: DeepReadonly<FittedWrangling>,
  remaining: number,
  acknowledgedMany: boolean,
): { version: DeepReadonly<DataVersion>; dataset: Dataset | null } {
  assert(
    JSON.stringify(inputs.map((i) => i.source)) ===
      JSON.stringify(fitted.inputs),
    "입력 버전이 미리보기와 다릅니다. 다시 미리보기 하세요.",
  );
  const result = applyWrangling(inputs, fitted, remaining);
  assert(
    !result.issues.some((i) => i.blocking),
    "적용을 막는 오류 행이 있습니다. 입력·설정 또는 명시적 결측 정책을 확인하세요.",
  );
  assert(
    !result.summary.manyToManyGroups || acknowledgedMany,
    "다대다 결합의 행 증가를 확인한 뒤 적용하세요.",
  );
  const now = new Date().toISOString(),
    derived = isDerived(fitted.settings.kind),
    datasetId = derived ? crypto.randomUUID() : inputs[0].source.datasetId,
    versionId = crypto.randomUUID(),
    source = { datasetId, versionId };
  const version = createVersion(result.table, {
    id: versionId,
    datasetId,
    parentVersionIds: derived ? [] : [inputs[0].source.versionId],
    createdAt: now,
    operation: {
      id: crypto.randomUUID(),
      kind: "wrangle",
      datasetId,
      inputVersionIds: fitted.inputs.map((i) => i.versionId),
      outputVersionIds: [versionId],
      settings: JSON.parse(JSON.stringify(fitted.settings)),
      executedAt: now,
      wrangling: {
        formatVersion: 1,
        inputs: structuredClone(fitted.inputs) as VersionRef[],
        output: source,
        fitted: structuredClone(fitted) as FittedWrangling,
        rowSources: result.rowSources,
      },
    },
  });
  const dataset: Dataset | null = derived
    ? {
        id: datasetId,
        name: (
          fitted.settings as Extract<WranglingSettings, { name: string }>
        ).name.trim(),
        source: {
          kind: "derived",
          label: `${wranglingLabels[fitted.settings.kind]}의 최초 결과 · 입력 파일 원본이 아닙니다.`,
          importedAt: now,
        },
        original: preserveOriginal(result.table),
        versions: [version],
      }
    : null;
  return { version, dataset };
}
