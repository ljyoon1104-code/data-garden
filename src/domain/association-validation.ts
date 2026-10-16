import type {
  AnalysisConfig,
  AnalysisRecord,
  Project,
  ViewState,
} from "./types";
import type {
  AssociationConfig,
  AssociationResult,
  AssociationLevel,
} from "./association-types";
import {
  associationFail as fail,
  associationLimits as limits,
  validateAssociationSettings,
  associationConfig,
  associationInput,
  prepareTransactions,
  transactionIndex,
  countItems,
  nextCandidates,
  makeRules,
  supportCount,
  defaultAssociationView,
} from "./association";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
      .join(",") +
    "}"
  );
}
const equal = (a: unknown, b: unknown, label: string) => {
  if (canonical(a) !== canonical(b))
    fail(
      "복원 검증: " +
        label +
        "이 실제 자료·계산 규칙과 다릅니다. 올바른 백업을 사용하세요.",
    );
};
const nat = (n: unknown) =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function associationValidationCost(r: AssociationResult) {
  if (
    !r ||
    !r.prepared ||
    !Array.isArray(r.prepared.transactions) ||
    !Array.isArray(r.prepared.items) ||
    !Array.isArray(r.levels) ||
    !Array.isArray(r.rules) ||
    !nat(r.prepared.inputRows) ||
    r.prepared.inputRows > limits.rows ||
    r.prepared.transactions.length > limits.transactions ||
    r.prepared.items.length > limits.items ||
    r.levels.length > limits.length ||
    r.rules.length > limits.rules ||
    new TextEncoder().encode(JSON.stringify(r)).byteLength > limits.bytes
  )
    fail("복원 결과 구조·크기 한도 오류");
  let candidates = 0,
    worst = r.prepared.inputRows * 32;
  for (const level of r.levels) {
    if (
      !level ||
      !Array.isArray(level.candidates) ||
      !Number.isInteger(level.length) ||
      level.length < 1 ||
      level.length > limits.length
    )
      fail("복원 후보 구조 오류");
    candidates += level.candidates.length;
    worst +=
      level.candidates.length * r.prepared.transactions.length * level.length;
  }
  if (candidates > limits.candidates) fail("복원 후보 수 한도 오류");
  return worst + r.rules.length * limits.length;
}
export function associationValidationBudget(
  records: readonly AnalysisRecord[],
  extra = 0,
) {
  const cost = records.reduce(
    (n, a) =>
      n + (a.association ? associationValidationCost(a.association) : 0),
    extra,
  );
  if (cost > limits.restoreWork)
    fail(
      "프로젝트 누적 복원 검증 9,000만 방문 한도를 넘습니다. 파일을 백업한 뒤 불필요한 연관 기록을 삭제하거나 거래·항목·탐색 길이를 줄이세요.",
    );
}
export function validateAssociationConfig(
  config: AnalysisConfig,
  project: Project,
) {
  if (!config.association) return;
  if (config.kind !== "association" || config.regression || config.clustering)
    fail("분석 종류와 연관 설정이 다릅니다.");
  validateAssociationSettings(config.association);
  equal(
    config,
    associationConfig(config.source, config.association),
    "분석 설정",
  );
  const input = associationInput(project, config as AssociationConfig),
    s = config.association!;
  for (const id of [
    ...s.columns,
    ...(s.format === "vertical" && s.transactionId ? [s.transactionId] : []),
    ...(s.scope.filter ? [s.scope.filter.attributeId] : []),
  ])
    if (!input.table.columns.some((c) => c.id === id))
      fail("없는 연관 속성 참조");
  const rows = new Set(input.table.rows.map((r) => r.id));
  if (s.scope.rowIds.some((id) => !rows.has(id)))
    fail("없는 연관 범위 행 참조");
}
/** Verify recorded candidates against adjacent recorded frequent sets. This does not run a new Apriori search or invent results. */
export function validateAssociationRecord(
  record: AnalysisRecord,
  project: Project,
) {
  const config = record.configSnapshot as AnalysisConfig;
  validateAssociationConfig(config, project);
  if (!record.association) {
    if (config.association && record.status === "completed")
      fail("완료 기록의 연관 결과가 없습니다.");
    return;
  }
  if (
    record.kind !== "association" ||
    !config.association ||
    record.status !== "completed" ||
    record.regression ||
    record.clustering
  )
    fail("연관 결과 종류·완료 상태 오류");
  const r = record.association,
    s = config.association!;
  associationValidationBudget([record]);
  if (
    r.formatVersion !== 1 ||
    r.calculationVersion !== "apriori-1" ||
    r.complete !== true
  )
    fail("지원하지 않는 연관 계산 규칙·미완료 결과");
  equal(r.source, config.source, "자료 참조");
  const prepared = prepareTransactions(
    associationInput(project, config as AssociationConfig),
    s,
  );
  equal(r.prepared, prepared, "거래·항목 사전·원자료 출처·제외·병합");
  const n = prepared.transactions.length;
  if (!n) fail("N=0인 완료 결과");
  equal(r.minCount, supportCount(n, s.supportPercent), "최소 거래 수");
  equal(r.maxLength, s.maxLength, "탐색 길이");
  const index = transactionIndex(prepared),
    work = {
      indexEntries: prepared.transactions.reduce(
        (n, t) => n + t.items.length,
        0,
      ),
      candidateJoins: 0,
      countedVisits: 0,
      ruleCombinations: 0,
    };
  let expected = prepared.items.map((i) => ({
    items: [i.id],
    count: null as number | null,
    pruned: false,
    frequent: false,
  }));
  const verified: AssociationLevel[] = [];
  let termination: AssociationResult["termination"] = "no-candidates",
    generated = 0;
  for (let length = 1; length <= s.maxLength; length++) {
    if (!expected.length) {
      termination = "no-candidates";
      break;
    }
    const level = r.levels[length - 1];
    if (!level) fail("복원 검증: 탐색 과정이 누락되었습니다.");
    // Expected candidate identities and pruning are derived only from the stored preceding level.
    equal(
      level.candidates.map((c) => ({ items: c.items, pruned: c.pruned })),
      expected.map((c) => ({ items: c.items, pruned: c.pruned })),
      "후보 목록·중복·정렬·부분집합",
    );
    generated += expected.length;
    if (generated > limits.candidates) fail("누적 후보 한도");
    for (const c of expected)
      if (!c.pruned) {
        c.count = countItems(c.items, index, () => {
          if (++work.countedVisits > limits.visits)
            fail("복원 계수 작업량 한도");
        });
        c.frequent = c.count >= r.minCount;
      }
    const v: AssociationLevel = {
      length,
      generated: expected.length,
      pruned: expected.filter((c) => c.pruned).length,
      counted: expected.filter((c) => !c.pruned).length,
      frequent: expected.filter((c) => c.frequent).length,
      candidates: expected,
    };
    equal(level, v, "후보 거래 계수·빈발 집합·단계 개수");
    verified.push(v);
    if (!v.frequent) {
      termination = "no-frequent";
      break;
    }
    if (length === s.maxLength) {
      termination = "max-length";
      break;
    }
    expected = nextCandidates(level.candidates, () => {
      if (++work.candidateJoins > limits.joins) fail("복원 후보 결합 한도");
    });
  }
  equal(r.levels.length, verified.length, "과정 길이");
  equal(r.termination, termination, "탐색 종료 사유");
  const rules = makeRules(verified, n, s.confidencePercent, () => {
    if (++work.ruleCombinations > limits.combinations)
      fail("복원 규칙 조합 한도");
  });
  equal(r.rules, rules, "규칙 방향·완전성·지표 분자·분모");
  equal(r.work, work, "계산량");
}
export function validateAssociationView(
  view: ViewState,
  records: AnalysisRecord[],
) {
  const selection = view.associationSelection;
  if (selection)
    for (const key of ["current", "comparison"] as const)
      if (
        selection[key] !== null &&
        (typeof selection[key] !== "string" ||
          !records.some(
            (a) => a.kind === "association" && a.id === selection[key],
          ))
      )
        fail("없는 연관 선택·비교 참조");
  for (const [id, q] of Object.entries(view.associationViews ?? {})) {
    const r = records.find(
      (a) => a.id === id && a.kind === "association",
    )?.association;
    if (
      !r ||
      !q ||
      Object.keys(q).sort().join() !==
        Object.keys(defaultAssociationView()).sort().join()
    )
      fail("연관 표시 상태 구조·기록 참조 오류");
    for (const key of ["page", "transactionPage", "candidatePage"] as const)
      if (!nat(q[key])) fail("연관 페이지 오류");
    if (
      !Number.isInteger(q.level) ||
      q.level < 1 ||
      q.level > 6 ||
      typeof q.antecedentText !== "string" ||
      typeof q.consequentText !== "string" ||
      !["all", "any"].includes(q.match) ||
      !["asc", "desc"].includes(q.direction) ||
      !["support", "confidence", "lift", "countUnion", "length"].includes(
        q.sort,
      ) ||
      !["all", "both", "a-only", "b-only", "neither", "empty"].includes(
        q.transactionGroup,
      )
    )
      fail("연관 탐색 설정 오류");
    for (const ids of [q.antecedent, q.consequent])
      if (
        !Array.isArray(ids) ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !r!.prepared.items.some((i) => i.id === id))
      )
        fail("없는 연관 검색 항목");
    if (q.ruleId !== null && !r!.rules.some((rule) => rule.id === q.ruleId))
      fail("없는 규칙 상세 참조");
    if (
      q.transactionId !== null &&
      !r!.prepared.transactions.some((t) => t.id === q.transactionId)
    )
      fail("없는 거래 상세 참조");
  }
}
