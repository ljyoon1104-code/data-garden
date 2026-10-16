import type {
  Cell,
  DeepReadonly,
  Project,
  TableData,
  VersionRef,
} from "./types";
import type {
  AssociationSettings,
  AssociationConfig,
  AssociationInput,
  AssociationTransactions,
  AssociationItem,
  Transaction,
  AssociationLevel,
  AssociationCandidate,
  AssociationRule,
  AssociationResult,
  AssociationView,
  AssociationDetail,
} from "./association-types";
import { scopedRows } from "./graphs";
import { resolveVersion } from "./processing";

export const associationLimits = {
  rows: 20000,
  transactions: 20000,
  items: 128,
  perTransaction: 32,
  length: 6,
  candidates: 12000,
  rules: 30000,
  combinations: 100000,
  joins: 2000000,
  visits: 30000000,
  index: 640000,
  bytes: 12 * 1024 * 1024,
  restoreWork: 90000000,
};
export const associationFail = (message: string): never => {
  throw new Error("연관: " + message);
};
const limit = (ok: boolean, what: string) => {
  if (!ok)
    associationFail(
      what +
        " 한도를 넘었습니다. " + (/후보|규칙|결과/.test(what) ? "최소 지지도를 높이거나 항목·범위·최대 길이를 줄이세요." : "자료 범위·입력 열·목록의 항목 수를 줄이세요.") + " 부분 결과는 저장하지 않습니다.",
    );
};
export const itemsetKey = (items: readonly string[]) => JSON.stringify(items);
const typed = (value: Cell) => JSON.stringify([typeof value, value]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function defaultAssociation(): AssociationSettings {
  return {
    formatVersion: 1,
    format: "list",
    columns: [],
    transactionId: "",
    listMode: "delimited",
    delimiter: ",",
    quotes: true,
    trim: false,
    foldCase: false,
    empty: "include",
    unknown: "block",
    missingId: "block",
    presentValues: [true, 1, "1"],
    absentValues: [false, 0, "0"],
    scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
    supportPercent: "20",
    confidencePercent: "50",
    maxLength: 4,
  };
}
export function associationConfig(
  source: VersionRef,
  settings: AssociationSettings,
): AssociationConfig {
  return {
    kind: "association",
    source,
    attributeIds: [
      ...new Set([
        ...settings.columns,
        ...(settings.format === "vertical" && settings.transactionId
          ? [settings.transactionId]
          : []),
      ]),
    ],
    association: structuredClone(settings),
    parameters: {},
    preprocessing: { steps: [] },
    calculation: {
      method: "apriori-1",
      missingValuePolicy: settings.unknown,
      settings: {},
    },
    split: { method: "none", settings: {} },
    randomness: { seed: null, settings: {} },
  };
}
/** Decimal text is retained. Integer cross-products avoid ceil(7.000000000000001). */
export function percentFraction(value: string, positive = false) {
  if (typeof value !== "string" || !/^\d{1,3}(\.\d{1,8})?$/.test(value))
    associationFail(
      "백분율은 빈 값이 아닌 0~100의 십진수(소수 8자리 이하)로 입력하세요.",
    );
  const [whole, fraction = ""] = value.split(".");
  const numerator = BigInt(whole + fraction),
    denominator = 100n * 10n ** BigInt(fraction.length);
  if (numerator > denominator || (positive && numerator === 0n))
    associationFail(
      positive
        ? "최소 지지도는 0보다 크고 100% 이하여야 합니다."
        : "최소 신뢰도는 0~100%여야 합니다.",
    );
  return { numerator, denominator };
}
export function supportCount(n: number, percent: string) {
  const { numerator, denominator } = percentFraction(percent, true);
  return Number((BigInt(n) * numerator + denominator - 1n) / denominator);
}
export function confidencePass(
  union: number,
  antecedent: number,
  percent: string,
) {
  const { numerator, denominator } = percentFraction(percent);
  return BigInt(union) * denominator >= BigInt(antecedent) * numerator;
}
export function validateAssociationSettings(s: AssociationSettings) {
  if (
    !s ||
    s.formatVersion !== 1 ||
    !["list", "vertical", "binary", "category"].includes(s.format) ||
    !["slots", "delimited"].includes(s.listMode) ||
    !Array.isArray(s.columns) ||
    s.columns.some((x) => typeof x !== "string") ||
    new Set(s.columns).size !== s.columns.length ||
    s.columns.length > 32 ||
    typeof s.transactionId !== "string"
  )
    associationFail("거래 형식·열 설정이 잘못되었습니다.");
  if (
    typeof s.delimiter !== "string" ||
    s.delimiter.length !== 1 ||
    /["\r\n]/.test(s.delimiter) ||
    [s.quotes, s.trim, s.foldCase].some((x) => typeof x !== "boolean") ||
    !["include", "exclude"].includes(s.empty) ||
    !["block", "exclude", "absent"].includes(s.unknown) ||
    !["block", "exclude"].includes(s.missingId)
  )
    associationFail("구분 기호·정규화·결측 정책을 확인하세요.");
  const cell = (v: unknown) =>
    v !== null &&
    (typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)));
  for (const values of [s.presentValues, s.absentValues])
    if (
      !Array.isArray(values) ||
      values.length > 32 ||
      values.some((v) => !cell(v) || v === "") ||
      new Set(values.map(typed)).size !== values.length
    )
      associationFail(
        "선택/미선택 값은 실제 유형이 있는 중복 없는 값으로 지정하세요. 결측은 별도 정책을 사용합니다.",
      );
  if (
    s.presentValues.some((v) =>
      s.absentValues.some((w) => typed(v) === typed(w)),
    )
  )
    associationFail("선택/미선택 값이 겹칩니다.");
  if (
    !s.scope ||
    !["all", "filtered", "selected"].includes(s.scope.kind) ||
    typeof s.scope.duplicatesOnly !== "boolean" ||
    !Array.isArray(s.scope.rowIds) ||
    s.scope.rowIds.some((x) => typeof x !== "string") ||
    new Set(s.scope.rowIds).size !== s.scope.rowIds.length
  )
    associationFail("자료 범위 설정 오류입니다.");
  const f = s.scope.filter;
  if (
    f &&
    (typeof f.attributeId !== "string" ||
      typeof f.value !== "string" ||
      !["contains", "equals", "gt", "lt", "missing", "present"].includes(
        f.operator,
      ))
  )
    associationFail("필터 설정 오류입니다.");
  percentFraction(s.supportPercent, true);
  percentFraction(s.confidencePercent);
  if (
    !Number.isInteger(s.maxLength) ||
    s.maxLength < 1 ||
    s.maxLength > associationLimits.length
  )
    associationFail("최대 항목 집합 길이는 1~6입니다.");
}
/** Copy only the active table, retaining full columns only for duplicate-scope semantics. Scope/grouping itself happens in Worker. */
export function associationInput(
  project: Project,
  config: AssociationConfig,
): AssociationInput {
  const v = resolveVersion(project, config.source),
    s = config.association;
  limit(v.rows.length <= associationLimits.rows, "원자료 20,000행");
  const ids = new Set([
    ...s.columns,
    s.transactionId,
    s.scope.filter?.attributeId ?? "",
  ]);
  const columns = v.columns.filter(
    (c) => s.scope.duplicatesOnly || ids.has(c.id),
  );
  return {
    source: { ...config.source },
    table: {
      columns: structuredClone(columns),
      rows: v.rows.map((r) => ({
        id: r.id,
        values: Object.fromEntries(columns.map((c) => [c.id, r.values[c.id]])),
      })),
    },
  };
}
/** Strict list grammar: doubled quotes escape quotes, separators/newlines inside quotes are literal. */
export function parseItemList(
  text: string,
  delimiter: string,
  quotes: boolean,
): string[] {
  if (!quotes) return text.split(delimiter);
  const values: string[] = [];
  let value = "",
    quoted = false,
    closed = false,
    start = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
    } else if (c === delimiter) {
      values.push(value);
      value = "";
      closed = false;
      start = true;
    } else if (c === '"' && start) {
      quoted = true;
      start = false;
    } else if (c === '"' || closed)
      associationFail(
        "목록 따옴표 형식 오류: 항목 전체를 큰따옴표로 감싸고 내부 따옴표는 두 번 쓰세요. 닫는 따옴표 뒤에는 구분 기호만 허용합니다.",
      );
    else {
      value += c;
      start = false;
    }
  }
  if (quoted)
    associationFail("목록의 닫는 따옴표가 없습니다. 해당 셀을 수정하세요.");
  values.push(value);
  return values;
}
export function prepareTransactions(
  input: DeepReadonly<AssociationInput>,
  s: AssociationSettings,
  progress: (s: string) => void = () => {},
): AssociationTransactions {
  validateAssociationSettings(s);
  const table = input.table;
  limit(table.rows.length <= associationLimits.rows, "원자료 20,000행");
  if (!s.columns.length) associationFail("항목으로 사용할 열을 선택하세요.");
  if (
    s.format === "vertical" &&
    (s.columns.length !== 1 ||
      !s.transactionId ||
      s.columns.includes(s.transactionId))
  )
    associationFail(
      "세로 거래는 거래 ID 열과 서로 다른 항목 열 하나를 선택하세요.",
    );
  for (const id of [
    ...s.columns,
    ...(s.format === "vertical" ? [s.transactionId] : []),
    ...(s.scope.filter ? [s.scope.filter.attributeId] : []),
  ])
    if (!table.columns.some((c) => c.id === id))
      associationFail(
        "없는 속성 참조입니다. 현재 버전에 맞게 열을 다시 선택하세요.",
      );
  const rowIds = new Set(table.rows.map((r) => r.id));
  if (s.scope.rowIds.some((id) => !rowIds.has(id)))
    associationFail("선택 범위에 없는 행 참조가 있습니다.");
  if (
    s.format === "category" &&
    s.columns.some((id) =>
      ["numeric", "date"].includes(
        table.columns.find((c) => c.id === id)!.semanticType,
      ),
    )
  )
    associationFail(
      "연속 수치·날짜는 범주 항목으로 자동 변환하지 않습니다. 정리 메뉴에서 구간화·날짜 분리를 먼저 준비하세요.",
    );
  progress("범위 판정·완전한 거래 구성 중…");
  const scope = scopedRows(table, s.scope)
    .slice()
    .sort((a, b) => cmp(a.id, b.id));
  const prepared: AssociationTransactions = {
    source: { ...input.source },
    inputRows: table.rows.length,
    scopeRowIds: scope.map((r) => r.id),
    includedRows: 0,
    transactions: [],
    items: [],
    emptyCount: 0,
    duplicatesRemoved: 0,
    excluded: [],
    issues: [],
    merges: [],
    sizeDistribution: [],
  };
  const groups = new Map<string, { key: Cell; rows: typeof scope }>();
  if (s.format === "vertical") {
    const selectedKeys = new Set(
      scope
        .filter(
          (r) =>
            r.values[s.transactionId] !== null &&
            r.values[s.transactionId] !== "",
        )
        .map((r) => typed(r.values[s.transactionId])),
    );
    for (const row of scope)
      if (
        row.values[s.transactionId] === null ||
        row.values[s.transactionId] === ""
      ) {
        if (s.missingId === "block")
          associationFail(
            `행 ${row.id}: 거래 ID가 없습니다. ID를 수정하거나 결측 ID 행 제외를 선택하세요.`,
          );
        prepared.excluded.push({
          rowIds: [row.id],
          reason: "결측 거래 ID 행 제외",
        });
      }
    for (const row of table.rows) {
      const key = row.values[s.transactionId],
        id = typed(key);
      if (!selectedKeys.has(id)) continue;
      if (!groups.has(id)) groups.set(id, { key, rows: [] });
      groups.get(id)!.rows.push(row);
    }
  } else
    for (const row of scope) groups.set(row.id, { key: row.id, rows: [row] });
  const dictionary = new Map<string, AssociationItem>(),
    originals = new Map<string, Map<string, Cell>>();
  let entries = 0,
    approximateBytes = 0;
  for (const [groupId, group] of [...groups].sort(([a], [b]) => cmp(a, b))) {
    group.rows.sort((a, b) => cmp(a.id, b.id));
    const items: string[] = [];
    let excluded = false;
    const local = new Map<
      string,
      { item: AssociationItem; originals: Cell[] }
    >();
    function add(colId: string, raw: Exclude<Cell, null>) {
      let value = raw;
      if (typeof value === "string") {
        if (s.trim) value = value.trim();
        if (s.foldCase) value = value.toLowerCase();
      }
      if (value === "") return;
      if (
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "string" && value.length > 512)
      )
        associationFail(
          `행 ${group.rows[0].id}: 항목은 유한 값·512자 이하이어야 합니다.`,
        );
      const columns = s.format === "list" ? [...s.columns].sort() : [colId];
      const id = JSON.stringify([
        s.format,
        input.source.datasetId,
        columns,
        s.format === "binary" ? "present" : typed(value),
      ]);
      const column = table.columns.find((c) => c.id === colId)!;
      const label =
        s.format === "binary"
          ? column.name
          : s.format === "category"
            ? `${column.name}=${String(value)}`
            : String(value);
      const item: AssociationItem = {
        id,
        columns,
        label,
        value: s.format === "binary" ? true : value,
        valueType:
          s.format === "binary"
            ? "boolean"
            : (typeof value as AssociationItem["valueType"]),
        format: s.format,
      };
      if (!local.has(id)) local.set(id, { item, originals: [] });
      local.get(id)!.originals.push(raw);
      items.push(id);
      limit(local.size <= associationLimits.perTransaction, "거래당 항목 32개");
    }
    for (const row of group.rows)
      for (const id of s.columns) {
        const value = row.values[id];
        try {
          if (s.format === "list") {
            if (value === null || value === "") continue;
            if (typeof value === "string" && value.length > 65536) associationFail("목록 셀 65,536자 한도입니다. 목록 길이를 줄이거나 거래 ID·항목의 세로 자료로 준비하세요.");
            if (s.listMode === "delimited" && typeof value === "string")
              for (const token of parseItemList(value, s.delimiter, s.quotes))
                add(id, token);
            else add(id, value);
          } else {
            const missing = value === null || value === "";
            const yes =
              !missing &&
              s.presentValues.some((v) => typed(v) === typed(value));
            const no =
              !missing && s.absentValues.some((v) => typed(v) === typed(value));
            const unknown = missing || (s.format === "binary" && !yes && !no);
            if (unknown) {
              const reason = missing ? "결측 항목" : "선택 여부의 미등록 값";
              if (s.unknown === "block")
                associationFail(
                  reason +
                    ": 값을 수정하거나 명시적인 제외/미선택 정책을 선택하세요.",
                );
              prepared.issues.push({
                rowId: row.id,
                columnId: id,
                reason:
                  reason +
                  (s.unknown === "exclude"
                    ? " → 거래 전체 제외"
                    : " → 명시적 항목 없음"),
              });
              if (s.unknown === "exclude") excluded = true;
            } else if (s.format !== "binary" || yes) add(id, value!);
          }
        } catch (e) {
          associationFail(
            `행 ${row.id}, 열 ${table.columns.find((c) => c.id === id)!.name}: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    if (excluded) {
      prepared.excluded.push({
        rowIds: group.rows.map((r) => r.id),
        reason: "결측·미등록 값이 있는 거래 전체 제외",
      });
      continue;
    }
    const unique = [...new Set(items)].sort();
    prepared.duplicatesRemoved += items.length - unique.length;
    if (!unique.length && s.empty === "exclude") {
      prepared.excluded.push({
        rowIds: group.rows.map((r) => r.id),
        reason: "명시적 빈 거래 제외",
      });
      continue;
    }
    limit(
      unique.length <= associationLimits.perTransaction,
      "거래당 항목 32개",
    );
    for (const [id, entry] of local) {
      dictionary.set(id, entry.item);
      limit(dictionary.size <= associationLimits.items, "항목 종류 128개");
      if (!originals.has(id)) originals.set(id, new Map());
      for (const value of entry.originals)
        originals.get(id)!.set(typed(value), value);
    }
    const transaction: Transaction = {
      id: JSON.stringify([s.format, groupId]),
      key: group.key,
      rowIds: group.rows.map((r) => r.id),
      items: unique,
    };
    prepared.transactions.push(transaction);
    prepared.includedRows += group.rows.length;
    if (!unique.length) prepared.emptyCount++;
    entries += unique.length;
    approximateBytes += new TextEncoder().encode(
      JSON.stringify(transaction),
    ).byteLength;
    limit(
      entries <= associationLimits.index &&
        approximateBytes <= associationLimits.bytes,
      "거래 인덱스·거래 기록 크기",
    );
    limit(
      prepared.transactions.length <= associationLimits.transactions,
      "거래 20,000개",
    );
    if (prepared.transactions.length % 500 === 0)
      progress(`거래 변환 중 · ${prepared.transactions.length}개 구성`);
  }
  prepared.items = [...dictionary.values()].sort((a, b) => cmp(a.id, b.id));
  prepared.merges = [...originals]
    .filter(
      ([, values]) =>
        values.size > 1 && (s.trim || s.foldCase) && s.format !== "binary",
    )
    .map(([itemId, values]) => ({ itemId, originals: [...values.values()] }));
  const sizes = new Map<number, number>();
  for (const t of prepared.transactions)
    sizes.set(t.items.length, (sizes.get(t.items.length) ?? 0) + 1);
  prepared.sizeDistribution = [...sizes]
    .sort(([a], [b]) => a - b)
    .map(([size, count]) => ({ size, count }));
  limit(
    new TextEncoder().encode(JSON.stringify(prepared)).byteLength <=
      associationLimits.bytes,
    "거래 미리보기 UTF-8 12 MiB",
  );
  return prepared;
}

export function nextCandidates(
  previous: readonly AssociationCandidate[],
  visit: () => void,
): AssociationCandidate[] {
  const frequent = previous
    .filter((c) => c.frequent)
    .map((c) => c.items)
    .sort((a, b) => cmp(itemsetKey(a), itemsetKey(b)));
  const keys = new Set(frequent.map(itemsetKey)),
    output: AssociationCandidate[] = [];
  // Prefix buckets avoid a quadratic scan of unrelated prefixes.
  const groups = new Map<string, string[][]>();
  for (const f of frequent) {
    const p = itemsetKey(f.slice(0, -1));
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(f);
  }
  for (const members of groups.values())
    for (let i = 0; i < members.length; i++)
      for (let j = i + 1; j < members.length; j++) {
        visit();
        const items = [...members[i], members[j].at(-1)!].sort();
        const pruned = items.some(
          (_, k) => !keys.has(itemsetKey(items.filter((_, n) => n !== k))),
        );
        output.push({ items, count: null, pruned, frequent: false });
        limit(
          output.length <= associationLimits.candidates,
          "생성 후보 12,000개",
        );
      }
  return output.sort((a, b) => cmp(itemsetKey(a.items), itemsetKey(b.items)));
}
export function transactionIndex(
  prepared: DeepReadonly<AssociationTransactions>,
) {
  const index = new Map<string, Set<number>>(
    prepared.items.map((i) => [i.id, new Set<number>()]),
  );
  prepared.transactions.forEach((t, i) =>
    t.items.forEach((id) => index.get(id)!.add(i)),
  );
  return index;
}
export function countItems(
  items: readonly string[],
  index: Map<string, Set<number>>,
  visit: () => void,
): number {
  const sets = items
    .map((id) => index.get(id)!)
    .sort((a, b) => a.size - b.size);
  let count = 0;
  for (const n of sets[0]) {
    let included = true;
    for (const set of sets) {
      visit();
      if (!set.has(n)) {
        included = false;
        break;
      }
    }
    if (included) count++;
  }
  return count;
}
export function makeRules(
  levels: readonly AssociationLevel[],
  n: number,
  confidence: string,
  visit: () => void,
): AssociationRule[] {
  const frequent = levels.flatMap((l) =>
    l.candidates.filter((c) => c.frequent),
  );
  const counts = new Map(frequent.map((c) => [itemsetKey(c.items), c.count!]));
  const rules: AssociationRule[] = [];
  for (const f of frequent) {
    if (f.items.length < 2) continue;
    for (let mask = 1; mask < 2 ** f.items.length - 1; mask++) {
      visit();
      const antecedent = f.items.filter((_, i) => mask & (1 << i)),
        consequent = f.items.filter((_, i) => !(mask & (1 << i)));
      const countA = counts.get(itemsetKey(antecedent))!,
        countB = counts.get(itemsetKey(consequent))!,
        countUnion = f.count!;
      if (!countA || !countB || !n)
        associationFail("규칙의 빈도 분모가 유효하지 않습니다.");
      if (!confidencePass(countUnion, countA, confidence)) continue;
      rules.push({
        id: JSON.stringify([antecedent, consequent]),
        antecedent,
        consequent,
        n,
        countA,
        countB,
        countUnion,
        support: countUnion / n,
        confidence: countUnion / countA,
        lift: countUnion / countA / (countB / n),
      });
      limit(rules.length <= associationLimits.rules, "규칙 30,000개");
    }
  }
  return rules.sort((a, b) => cmp(a.id, b.id));
}
export function runAssociation(
  input: DeepReadonly<AssociationInput>,
  s: AssociationSettings,
  progress: (s: string) => void = () => {},
): AssociationResult {
  const prepared = prepareTransactions(input, s, progress),
    n = prepared.transactions.length;
  if (!n)
    associationFail(
      "실제 거래 수 N=0입니다. 범위·결측·빈 거래 정책을 확인하세요.",
    );
  const index = transactionIndex(prepared),
    minCount = supportCount(n, s.supportPercent);
  const work = {
    indexEntries: prepared.transactions.reduce((n, t) => n + t.items.length, 0),
    candidateJoins: 0,
    countedVisits: 0,
    ruleCombinations: 0,
  };
  let candidates: AssociationCandidate[] = prepared.items.map((i) => ({
    items: [i.id],
    count: null,
    pruned: false,
    frequent: false,
  }));
  const levels: AssociationLevel[] = [];
  let generated = 0;
  let termination: AssociationResult["termination"] = "no-candidates";
  for (let length = 1; length <= s.maxLength; length++) {
    progress(
      `길이 ${length} · 후보 생성·부분집합 가지치기 · ${candidates.length}개`,
    );
    generated += candidates.length;
    limit(generated <= associationLimits.candidates, "전체 생성 후보 12,000개");
    if (!candidates.length) {
      termination = "no-candidates";
      break;
    }
    let done = 0;
    for (const c of candidates)
      if (!c.pruned) {
        c.count = countItems(c.items, index, () => {
          limit(
            ++work.countedVisits <= associationLimits.visits,
            "후보 계수 3,000만 방문",
          );
        });
        c.frequent = c.count >= minCount;
        if (++done % 50 === 0)
          progress(
            `길이 ${length} · 거래 계수 ${done}/${candidates.length} 후보`,
          );
      }
    const level = {
      length,
      generated: candidates.length,
      pruned: candidates.filter((c) => c.pruned).length,
      counted: done,
      frequent: candidates.filter((c) => c.frequent).length,
      candidates,
    };
    levels.push(level);
    progress(`길이 ${length} · 빈발 집합 ${level.frequent}개 확정`);
    if (!level.frequent) {
      termination = "no-frequent";
      break;
    }
    if (length === s.maxLength) {
      termination = "max-length";
      break;
    }
    candidates = nextCandidates(candidates, () => {
      limit(
        ++work.candidateJoins <= associationLimits.joins,
        "후보 결합 200만 회",
      );
    });
  }
  progress("복합 선행·후행의 모든 방향 규칙 생성 중…");
  const rules = makeRules(levels, n, s.confidencePercent, () => {
    limit(
      ++work.ruleCombinations <= associationLimits.combinations,
      "규칙 조합 100,000개",
    );
    if (work.ruleCombinations % 1000 === 0)
      progress(`규칙 조합 검사 ${work.ruleCombinations}개`);
  });
  const result: AssociationResult = {
    formatVersion: 1,
    calculationVersion: "apriori-1",
    source: { ...input.source },
    prepared,
    minCount,
    maxLength: s.maxLength,
    levels,
    rules,
    termination,
    complete: true,
    work,
  };
  limit(
    new TextEncoder().encode(JSON.stringify(result)).byteLength <=
      associationLimits.bytes,
    "결과·과정 UTF-8 12 MiB",
  );
  return result;
}
export function defaultAssociationView(): AssociationView {
  return {
    antecedent: [],
    consequent: [],
    antecedentText: "",
    consequentText: "",
    match: "all",
    sort: "lift",
    direction: "desc",
    page: 0,
    ruleId: null,
    transactionGroup: "all",
    transactionPage: 0,
    transactionId: null,
    level: 1,
    candidatePage: 0,
  };
}
export function queryAssociationRules(
  result: DeepReadonly<AssociationResult>,
  query: AssociationView,
) {
  limit(result.rules.length * (2 + query.antecedent.length + query.consequent.length) * result.maxLength <= associationLimits.visits, "규칙 조회 3,000만 방문");
  const dictionary = new Map(result.prepared.items.map((i) => [i.id, i]));
  const side = (items: readonly string[], selected: string[], text: string) =>
    (!text || items.some((id) => dictionary.get(id)!.label.includes(text))) &&
    (!selected.length ||
      (query.match === "all"
        ? selected.every((id) => items.includes(id))
        : selected.some((id) => items.includes(id))));
  const rules = result.rules
    .filter(
      (r) =>
        side(r.antecedent, query.antecedent, query.antecedentText) &&
        side(r.consequent, query.consequent, query.consequentText),
    )
    .slice();
  const metric = (r: DeepReadonly<AssociationRule>) =>
    query.sort === "length"
      ? r.antecedent.length + r.consequent.length
      : r[query.sort];
  rules.sort(
    (a, b) =>
      (metric(a) - metric(b)) * (query.direction === "asc" ? 1 : -1) ||
      cmp(a.id, b.id),
  );
  return rules;
}
export function associationDetail(
  table: DeepReadonly<TableData>,
  result: DeepReadonly<AssociationResult>,
  query: AssociationView,
): AssociationDetail {
  limit(result.rules.length * (2 + query.antecedent.length + query.consequent.length) * result.maxLength + result.prepared.transactions.length * (2 * result.maxLength) + table.rows.length <= associationLimits.visits, "상세 조회 3,000만 방문");
  const rules = queryAssociationRules(result,query);
  const rule = result.rules.find((r) => r.id === query.ruleId);
  const counts = rule
    ? {
        both: rule.countUnion,
        aOnly: rule.countA - rule.countUnion,
        bOnly: rule.countB - rule.countUnion,
        neither: rule.n - rule.countA - rule.countB + rule.countUnion,
      }
    : null;
  const transactions = result.prepared.transactions.filter((t) => {
    if (query.transactionGroup === "empty") return !t.items.length;
    if (!rule || query.transactionGroup === "all") return true;
    const a = rule.antecedent.every((id) => t.items.includes(id)),
      b = rule.consequent.every((id) => t.items.includes(id));
    return query.transactionGroup === "both"
      ? a && b
      : query.transactionGroup === "a-only"
        ? a && !b
        : query.transactionGroup === "b-only"
          ? !a && b
          : !a && !b;
  });
  const selectedTransaction =
    result.prepared.transactions.find((t) => t.id === query.transactionId) ??
    null;
  const sourceIds = new Set(selectedTransaction?.rowIds ?? []);
  return structuredClone({
    matchedRules: rules.length,
    rules: rules.slice(query.page * 25, query.page * 25 + 25),
    counts,
    transactionCount: transactions.length,
    transactions: transactions.slice(
      query.transactionPage * 25,
      query.transactionPage * 25 + 25,
    ),
    selectedTransaction,
    sourceRows: table.rows.filter((r) => sourceIds.has(r.id)),
  }) as AssociationDetail;
}
export function compareAssociations(
  a: DeepReadonly<AssociationResult>,
  b: DeepReadonly<AssociationResult>,
  ac: DeepReadonly<AssociationSettings>,
  bc: DeepReadonly<AssociationSettings>,
) {
  const population = (r: DeepReadonly<AssociationResult>) =>
    JSON.stringify([
      r.source.datasetId,
      r.prepared.transactions.map((t) => [t.id, t.rowIds, t.items]),
    ]);
  const idsA = new Map(a.rules.map((r) => [r.id, r])),
    idsB = new Map(b.rules.map((r) => [r.id, r]));
  const {
    supportPercent: _a,
    confidencePercent: _b,
    maxLength: _c,
    ...policyA
  } = ac;
  const {
    supportPercent: _d,
    confidencePercent: _e,
    maxLength: _f,
    ...policyB
  } = bc;
  return {
    samePopulation: population(a) === population(b),
    samePolicy: JSON.stringify(policyA) === JSON.stringify(policyB),
    sameVersion: a.source.versionId === b.source.versionId,
    sameLength: ac.maxLength === bc.maxLength,
    retained: a.rules
      .filter((r) => idsB.has(r.id))
      .map((r) => ({ id: r.id, a: r, b: idsB.get(r.id)! })),
    added: b.rules.filter((r) => !idsA.has(r.id)),
    removed: a.rules.filter((r) => !idsB.has(r.id)),
  };
}
