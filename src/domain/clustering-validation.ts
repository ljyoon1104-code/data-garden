import type { AnalysisConfig, AnalysisRecord, Project } from "./types";
import type { ClusteringConfig } from "./clustering-types";
import {
  buildClusteringPlan,
  checkClusterBudget,
  clusteringConfig,
  clusterLimits,
  prepareClusters,
  assignClusters,
  squaredDistance,
  silhouettePoint,
  sampleIndices,
  validateClusteringSettings,
} from "./clustering";
import { resolveVersion } from "./processing";
const bad = (m: string): never => {
  throw new Error("군집 복원 검증: " + m);
};
function same(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) bad(label + " 불일치");
}
function close(a: number, b: number, label: string) {
  if (!Number.isFinite(a) || Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b)))
    bad(label + " 불일치");
}
export function validateClusteringConfig(c: AnalysisConfig, p: Project) {
  if (!c.clustering) return;
  if (c.kind !== "clustering" || c.regression) bad("분석 종류");
  const s = c.clustering;
  validateClusteringSettings(s);
  const expected = clusteringConfig(c.source, s);
  same(c.attributeIds, expected.attributeIds, "속성 순서");
  same(c.split, expected.split, "분할 없음");
  same(c.calculation, expected.calculation, "계산 기준");
  same(c.randomness, expected.randomness, "무작위 기준");
  const v = resolveVersion(p, c.source);
  for (const id of s.features) {
    const col = v.columns.find((c) => c.id === id);
    if (
      !col ||
      col.storageType !== "number" ||
      col.semanticType !== "numeric" ||
      !col.useInAnalysis
    )
      bad("계산 속성 의미");
  }
  if (
    s.scope.filter &&
    !v.columns.some((c) => c.id === s.scope.filter!.attributeId)
  )
    bad("필터 속성");
  const ids = new Set(v.rows.map((r) => r.id));
  if (s.scope.rowIds.some((id) => !ids.has(id))) bad("범위 행 참조");
}
/** Checks stored assignments/means/metrics against fixed recorded centers. Never initializes or re-runs K-means. */
export function validateClusteringRecord(record: AnalysisRecord, p: Project) {
  if (!record.clustering) {
    if (record.status === "completed" && record.configSnapshot.clustering)
      bad("완료 결과 없음");
    return;
  }
  if (
    record.kind !== "clustering" ||
    !record.configSnapshot.clustering ||
    record.status !== "completed" ||
    record.regression
  )
    bad("완료 종류");
  const c = record.configSnapshot as ClusteringConfig,
    s = c.clustering,
    r = record.clustering;
  validateClusteringConfig(c, p);
  if (
    r.formatVersion !== 1 ||
    r.calculationVersion !== "kmeans-1" ||
    new TextEncoder().encode(JSON.stringify(r)).byteLength > clusterLimits.bytes
  )
    bad("계산 규칙·결과 한도");
  const plan = buildClusteringPlan(p, c),
    prepared = prepareClusters(plan, s),
    x = prepared.matrix;
  same(r.source, c.source, "자료");
  same(r.features, plan.table.columns, "속성");
  same(r.scopeRowIds, plan.scopeRowIds, "범위");
  same(r.rowIds, prepared.rowIds, "유효 행");
  same(r.basis, prepared.basis, "전처리 기준");
  same(r.excluded, prepared.excluded, "제외");
  same(r.imputed, prepared.imputed, "대체");
  const expectedEval =
    s.silhouette.mode === "none"
      ? []
      : sampleIndices(
          x.length,
          s.silhouette.mode === "exact"
            ? x.length
            : Math.min(x.length, s.silhouette.sampleSize),
          s.silhouette.seed,
        ).map((i) => r.rowIds[i]);
  same(r.evaluationRowIds, expectedEval, "공통 평가 표본");
  if (!Array.isArray(r.candidates) || r.candidates.length !== s.ks.length)
    bad("k 목록");
  const distinct = new Set(x.map((v) => JSON.stringify(v))).size;
  r.candidates.forEach((candidate, ci) => {
    const k = s.ks[ci];
    if (
      candidate.k !== k ||
      !Number.isFinite(candidate.elapsedMs) ||
      candidate.elapsedMs < 0
    )
      bad("k·시간");
    if (candidate.bestRestart === null) {
      if (
        !candidate.error ||
        candidate.sse !== null ||
        candidate.labels.length ||
        candidate.centers.length ||
        candidate.squaredDistances.length ||
        candidate.counts.length ||
        candidate.clusterSse.length ||
        candidate.silhouette !== null
      )
        bad("실패 결과");
      if (
        k <= x.length &&
        k <= distinct &&
        (candidate.restarts.length !== s.restarts ||
          candidate.restarts.some((a) => a.sse !== null))
      )
        bad("실패 재시작");
      return;
    }
    if (
      k > x.length ||
      k > distinct ||
      candidate.error !== null ||
      candidate.restarts.length !== s.restarts ||
      !Number.isInteger(candidate.bestRestart) ||
      candidate.bestRestart < 0 ||
      candidate.bestRestart >= s.restarts
    )
      bad("재시작 선택");
    const dim = (centers: number[][]) => {
      if (
        !Array.isArray(centers) ||
        centers.length !== k ||
        centers.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== s.features.length ||
            row.some((v) => typeof v !== "number" || !Number.isFinite(v)),
        )
      )
        bad("중심 차원");
    };
    let best = -1;
    candidate.restarts.forEach((run, ri) => {
      if (
        run.seed !== (s.seed + Math.imul(ri, 2654435761)) >>> 0 ||
        typeof run.reason !== "string" ||
        typeof run.converged !== "boolean" ||
        typeof run.finalReassignment !== "boolean"
      )
        bad("seed·종료");
      if (run.sse === null) {
        if (
          !run.reason ||
          run.history.length ||
          run.centers.length ||
          run.converged ||
          run.iterations !== 0
        )
          bad("실패 재시작 이력");
        return;
      }
      if (best < 0 || run.sse < candidate.restarts[best].sse!) best = ri;
      dim(run.centers);
      if (
        !run.initialCenters &&
        run.history[0] &&
        !run.history[0].events.length
      )
        run.initialCenters = run.history[0].before.map((c) => c.slice());
      dim(run.initialCenters);
      if (new Set(run.initialCenters.map((c) => JSON.stringify(c))).size !== k)
        bad("중복 초기 중심");
      if (s.initialization === "manual")
        same(
          run.initialCenters,
          s.manualCenters.map((c) =>
            c.map((v, j) => (v - r.basis[j].offset) / r.basis[j].divisor),
          ),
          "직접 초기 중심 단위",
        );
      else if (
        run.initialCenters.some(
          (c) => !x.some((v) => JSON.stringify(c) === JSON.stringify(v)),
        )
      )
        bad("입력 점이 아닌 초기 중심");
      if (!run.history[0]?.events.length)
        same(run.initialCenters, run.history[0]?.before, "최초 할당 중심");
      if (
        !Array.isArray(run.history) ||
        run.history.length < 1 ||
        run.history.length > s.maxIterations ||
        run.iterations !== run.history.length
      )
        bad("반복 한도");
      let prevLabels: number[] | null = null;
      run.history.forEach((h, hi) => {
        dim(h.before);
        dim(h.after);
        if (
          !Array.isArray(h.events) ||
          h.events.length > k ||
          h.events.some(
            (e) => typeof e !== "string" || !e.startsWith("빈 군집 "),
          )
        )
          bad("빈 군집 이벤트");
        if (hi && !h.events.length)
          same(h.before, run.history[hi - 1].after, "단계 연결");
        const assigned = assignClusters(x, h.before),
          labels = assigned.map((a) => a.label),
          counts = Array(k).fill(0) as number[];
        labels.forEach((c) => counts[c]++);
        if (counts.includes(0)) bad("빈 군집");
        same(h.counts, counts, "반복 구성원 수");
        const means = Array.from(
          { length: k },
          () => Array(s.features.length).fill(0) as number[],
        );
        x.forEach((row, i) =>
          row.forEach((v, j) => (means[labels[i]][j] += v / counts[labels[i]])),
        );
        h.after.forEach((row, c) =>
          row.forEach((v, j) => close(v, means[c][j], "평균 갱신")),
        );
        close(
          h.assignmentSse,
          assigned.reduce((a, b) => a + b.distance, 0),
          "할당 SSE",
        );
        close(
          h.updatedSse,
          x.reduce(
            (sum, row, i) => sum + squaredDistance(row, h.after[labels[i]]),
            0,
          ),
          "갱신 SSE",
        );
        close(
          h.movement,
          Math.sqrt(
            h.before.reduce(
              (sum, row, c) => sum + squaredDistance(row, h.after[c]),
              0,
            ),
          ),
          "중심 이동",
        );
        if (
          h.changes !==
          (prevLabels
            ? labels.filter((l, i) => l !== prevLabels![i]).length
            : x.length)
        )
          bad("할당 변경 수");
        prevLabels = labels;
      });
      same(run.centers, run.history.at(-1)!.after, "최종 중심");
      const final = assignClusters(x, run.centers),
        fixed = final.every((a, i) => a.label === prevLabels![i]);
      if (run.converged !== fixed || run.finalReassignment === fixed)
        bad("수렴·최종 재할당");
      const expectedReason = fixed
        ? "최근접 할당·평균 고정점 수렴"
        : run.history.at(-1)!.movement <= s.tolerance
          ? "이동 허용값 종료 (고정점 미확인·미수렴)"
          : "최대 반복 종료 (미수렴)";
      same(run.reason, expectedReason, "종료 이유");
      if (
        !fixed &&
        run.history.at(-1)!.movement > s.tolerance &&
        run.iterations !== s.maxIterations
      )
        bad("조기 종료");
      close(
        run.sse,
        final.reduce((sum, a) => sum + a.distance, 0),
        "재시작 SSE",
      );
    });
    if (best !== candidate.bestRestart) bad("최소 SSE 재시작·동률 순서");
    same(candidate.centers, candidate.restarts[best].centers, "대표 중심");
    const assigned = assignClusters(x, candidate.centers),
      counts = Array(k).fill(0) as number[],
      sums = Array(k).fill(0) as number[];
    same(
      candidate.labels,
      assigned.map((a) => a.label),
      "최종 라벨",
    );
    if (candidate.squaredDistances.length !== x.length) bad("거리 수");
    assigned.forEach((a, i) => {
      counts[a.label]++;
      sums[a.label] += a.distance;
      close(candidate.squaredDistances[i], a.distance, "행 거리");
    });
    if (counts.includes(0)) bad("최종 빈 군집");
    same(candidate.counts, counts, "군집 수");
    if (candidate.clusterSse.length !== k) bad("군집 SSE 수");
    sums.forEach((v, i) => close(candidate.clusterSse[i], v, "군집 SSE"));
    close(
      candidate.sse!,
      assigned.reduce((a, b) => a + b.distance, 0),
      "전체 SSE",
    );
    const sil = candidate.silhouette;
    if (
      !sil ||
      sil.seed !== s.silhouette.seed ||
      sil.population !== x.length ||
      sil.clusters.length !== k
    )
      bad("실루엣 정보");
    const mode =
      s.silhouette.mode === "sample" && expectedEval.length === x.length
        ? "exact"
        : s.silhouette.mode;
    same(sil!.mode, mode, "실루엣 방식");
    if (mode === "none" || k < 2 || k >= x.length) {
      if (
        sil!.mean !== null ||
        !sil!.reason ||
        sil!.evaluationRowIds.length ||
        sil!.clusters.some(
          (a, i) =>
            a.count !== counts[i] ||
            a.mean !== null ||
            a.evaluated !== 0 ||
            !a.reason,
        )
      )
        bad("계산 불가 실루엣");
      return;
    }
    same(sil!.evaluationRowIds, expectedEval, "실루엣 표본");
    if (sil!.reason !== null) bad("평가 이유");
    const indices = new Map(r.rowIds.map((id, i) => [id, i])),
      values = expectedEval.map(
        (id) =>
          silhouettePoint(x, candidate.labels, indices.get(id)!, id).value!,
      );
    close(
      sil!.mean!,
      values.reduce((sum, v) => sum + v / values.length, 0),
      "실루엣 평균",
    );
    sil!.clusters.forEach((a, c) => {
      const vals = values.filter(
        (_, i) => candidate.labels[indices.get(expectedEval[i])!] === c,
      );
      if (a.count !== counts[c] || a.evaluated !== vals.length)
        bad("실루엣 표본 군집 수");
      if (vals.length)
        close(
          a.mean!,
          vals.reduce((sum, v) => sum + v / vals.length, 0),
          "군집 실루엣",
        );
      else if (a.mean !== null || !a.reason) bad("미평가 군집");
    });
  });
}
export function clusteringValidationBudget(
  records: AnalysisRecord[],
  extraWork = 0,
) {
  let work = extraWork;
  for (const a of records) {
    const r = a.clustering,
      s = a.configSnapshot.clustering;
    if (!r || !s) continue;
    checkClusterBudget(
      r.rowIds.length,
      s as import("./clustering-types").ClusteringSettings,
    );
    work +=
      r.rowIds.length *
      s.features.length *
      (s.ks.reduce((a, b) => a + b, 0) * s.restarts * s.maxIterations * 3 +
        r.evaluationRowIds.length * s.ks.length);
  }
  if (work > 240000000)
    bad(
      "프로젝트 검증 2.4억 좌표 연산 한도입니다. 별도 프로젝트에 결과를 보관하세요.",
    );
}
