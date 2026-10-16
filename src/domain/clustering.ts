import type {
  AnalysisConfig,
  DeepReadonly,
  Project,
  TableData,
  VersionRef,
  Dataset,
} from "./types";
import type {
  ClusteringSettings,
  ClusteringConfig,
  ClusteringPlan,
  ClusteringResult,
  ClusterBasis,
  ClusterRestart,
  ClusterCandidate,
  SilhouettePoint,
  ClusterSilhouette,
  ClusterQuery,
  ClusterDetail,
} from "./clustering-types";
import { scopedRows } from "./graphs";
import { resolveVersion } from "./processing";
import { defaultTableView, inspectTable, isMissing } from "./table";
import { createVersion, preserveOriginal } from "./model";

export const clusterLimits = {
  rows: 20000,
  features: 20,
  k: 20,
  comparisons: 8,
  restarts: 10,
  iterations: 100,
  work: 120000000,
  silhouetteWork: 20000000,
  history: 160000,
  bytes: 12 * 1024 * 1024,
};
export const analysisConfigKey = (
  datasetId: string,
  kind: AnalysisConfig["kind"],
) => JSON.stringify([datasetId, kind]);
export function defaultClustering(): ClusteringSettings {
  return {
    formatVersion: 1,
    features: [],
    scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
    ks: [2],
    missing: "remove",
    scaling: "zscore",
    seed: 42,
    initialization: "kmeans++",
    manualCenters: [],
    restarts: 3,
    maxIterations: 50,
    tolerance: 0.000001,
    silhouette: { mode: "exact", sampleSize: 200, seed: 23 },
  };
}
export function clusteringConfig(
  source: VersionRef,
  s: ClusteringSettings,
): ClusteringConfig {
  return {
    kind: "clustering",
    source,
    attributeIds: [...s.features],
    clustering: structuredClone(s),
    parameters: {},
    preprocessing: { steps: [] },
    calculation: {
      missingValuePolicy: s.missing,
      method: "kmeans-1",
      settings: {},
    },
    split: { method: "none", settings: {} },
    randomness: { seed: s.seed, settings: {} },
  };
}
const fail = (s: string): never => {
  throw new Error("군집: " + s);
};
function finite(n: number) {
  if (!Number.isFinite(n))
    fail("수치 범위를 넘었습니다. 값의 단위·범위를 줄이세요.");
  return n;
}
const mean = (a: number[]) => finite(a.reduce((s, x) => s + x / a.length, 0));
const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y),
    n = b.length;
  return n % 2 ? b[n >> 1] : b[n / 2 - 1] / 2 + b[n / 2] / 2;
};
export function validateClusteringSettings(s: ClusteringSettings) {
  const integer = (x: number, lo: number, hi: number) =>
    Number.isInteger(x) && x >= lo && x <= hi;
  if (
    !s ||
    s.formatVersion !== 1 ||
    !Array.isArray(s.features) ||
    s.features.length > 20 ||
    s.features.some((x) => typeof x !== "string") ||
    new Set(s.features).size !== s.features.length
  )
    fail("계산 속성 설정 오류");
  if (
    !Array.isArray(s.ks) ||
    !s.ks.length ||
    s.ks.length > 8 ||
    new Set(s.ks).size !== s.ks.length ||
    s.ks.some((k) => !integer(k, 1, 20))
  )
    fail("k는 중복 없이 1~20, 비교는 최대 8개입니다.");
  if (
    !["remove", "mean", "median"].includes(s.missing) ||
    !["none", "minmax", "zscore"].includes(s.scaling) ||
    !["kmeans++", "random", "manual"].includes(s.initialization)
  )
    fail("결측·스케일·초기화 설정 오류");
  if (
    !integer(s.seed, 0, 4294967295) ||
    !integer(s.restarts, 1, 10) ||
    !integer(s.maxIterations, 1, 100) ||
    !Number.isFinite(s.tolerance) ||
    s.tolerance < 0 ||
    s.tolerance > 1
  )
    fail(
      "seed 0~4294967295, 재시작 1~10, 반복 1~100, 허용 이동 0~1을 사용하세요.",
    );
  if (
    !s.silhouette ||
    !["exact", "sample", "none"].includes(s.silhouette.mode) ||
    !integer(s.silhouette.sampleSize, 1, 1000) ||
    !integer(s.silhouette.seed, 0, 4294967295)
  )
    fail("실루엣 평가 설정 오류");
  if (
    !s.scope ||
    !["all", "filtered", "selected"].includes(s.scope.kind) ||
    !Array.isArray(s.scope.rowIds) ||
    new Set(s.scope.rowIds).size !== s.scope.rowIds.length ||
    s.scope.rowIds.some((x) => typeof x !== "string") ||
    typeof s.scope.duplicatesOnly !== "boolean"
  )
    fail("범위 설정 오류");
  if (
    s.scope.filter &&
    (!["contains", "equals", "gt", "lt", "missing", "present"].includes(
      s.scope.filter.operator,
    ) ||
      typeof s.scope.filter.value !== "string")
  )
    fail("필터 설정 오류");
  if (
    !Array.isArray(s.manualCenters) ||
    s.manualCenters.length > 20 ||
    s.manualCenters.some(
      (c) =>
        !Array.isArray(c) ||
        c.length > 20 ||
        c.some((x) => typeof x !== "number" || !Number.isFinite(x)),
    )
  )
    fail("직접 중심 좌표 오류");
  if (
    s.initialization === "manual" &&
    (s.ks.length !== 1 ||
      s.restarts !== 1 ||
      s.manualCenters.length !== s.ks[0] ||
      s.manualCenters.some((c) => c.length !== s.features.length) ||
      new Set(s.manualCenters.map((c) => JSON.stringify(c))).size !== s.ks[0])
  )
    fail(
      "직접 중심은 단일 k·재시작 1회, 속성 수와 같은 차원, 서로 다른 k개 좌표가 필요합니다.",
    );
}
export function checkClusterBudget(n: number, s: ClusteringSettings) {
  validateClusteringSettings(s);
  const d = s.features.length,
    sum = s.ks.reduce((a, b) => a + b, 0);
  if (!d || !n) fail("수치 속성과 입력 행을 하나 이상 선택하세요.");
  if (n > clusterLimits.rows)
    fail("전체 입력은 20,000행 한도입니다. 명시적으로 범위를 줄이세요.");
  if (n * d * sum * s.restarts * (s.maxIterations * 3 + 3) > clusterLimits.work)
    fail(
      "거리 계산 1.2억 좌표 연산 한도입니다. k·반복·재시작·속성·입력 범위를 줄이세요.",
    );
  if (d * sum * s.restarts * (s.maxIterations + 1) * 2 > clusterLimits.history)
    fail("중심 이력 160,000좌표 한도입니다. 반복·재시작·k를 줄이세요.");
  const m =
    s.silhouette.mode === "none"
      ? 0
      : s.silhouette.mode === "exact"
        ? n
        : Math.min(n, s.silhouette.sampleSize);
  if (n * m * d * s.ks.length > clusterLimits.silhouetteWork)
    fail(
      "실루엣 2,000만 좌표 거리 한도입니다. 평가 표본 수·비교 k·속성 수를 줄이거나 평가를 끄세요.",
    );
}
export function buildClusteringPlan(
  project: Project,
  config: ClusteringConfig,
): ClusteringPlan {
  const s = config.clustering;
  validateClusteringSettings(s);
  const v = resolveVersion(project, config.source);
  if (
    s.scope.filter &&
    !v.columns.some((c) => c.id === s.scope.filter!.attributeId)
  )
    fail("필터 속성이 없습니다. 범위를 다시 선택하세요.");
  if (s.scope.rowIds.some((id) => !v.rows.some((r) => r.id === id)))
    fail("선택한 행이 당시 버전에 없습니다.");
  const rows = [...scopedRows(v, s.scope)].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const columns = s.features.map((id) => {
    const c = v.columns.find((c) => c.id === id);
    if (
      !c ||
      c.storageType !== "number" ||
      c.semanticType !== "numeric" ||
      !c.useInAnalysis
    )
      fail("수치 저장·수치 의미·분석 사용 속성만 선택하세요.");
    return { ...c! };
  });
  checkClusterBudget(rows.length, s);
  return {
    source: { ...config.source },
    scopeRowIds: rows.map((r) => r.id),
    table: {
      columns,
      rows: rows.map((r) => ({
        id: r.id,
        values: Object.fromEntries(columns.map((c) => [c.id, r.values[c.id]])),
      })),
    },
  };
}
export function prepareClusters(plan: ClusteringPlan, s: ClusteringSettings) {
  checkClusterBudget(plan.table.rows.length, s);
  const rows = [...plan.table.rows].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    ids = s.features;
  if (
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    JSON.stringify(plan.scopeRowIds) !==
      JSON.stringify(rows.map((r) => r.id)) ||
    ids.some(
      (id, j) =>
        plan.table.columns[j]?.id !== id ||
        plan.table.columns[j].semanticType !== "numeric" ||
        plan.table.columns[j].storageType !== "number",
    )
  )
    fail("입력 행·속성 순서 오류");
  rows.forEach((r) =>
    ids.forEach((id) => {
      const v = r.values[id];
      if (!isMissing(v) && (typeof v !== "number" || !Number.isFinite(v)))
        fail(`${r.id} / ${id}: 유한한 수가 아닙니다. 값을 수정하세요.`);
    }),
  );
  const excluded: ClusteringResult["excluded"] = [],
    imputed: ClusteringResult["imputed"] = [];
  const kept = rows.filter((r) => {
    const missing = ids.filter((id) => isMissing(r.values[id]));
    if (missing.length) {
      if (s.missing === "remove") {
        excluded.push({
          rowId: r.id,
          attributes: missing,
          reason: "선택 속성 결측(null 또는 빈 문자열)",
        });
        return false;
      }
      imputed.push({ rowId: r.id, attributes: missing });
    }
    return true;
  });
  if (!kept.length)
    fail("결측 행 제외 후 입력이 없습니다. 결측 처리 또는 범위를 바꾸세요.");
  const basis: ClusterBasis[] = ids.map((id) => {
    const valid = kept
      .map((r) => r.values[id])
      .filter((v) => !isMissing(v)) as number[];
    if (!valid.length)
      fail(`${id}: 전부 결측입니다. 속성을 제외하거나 원자료를 수정하세요.`);
    const fill =
      s.missing === "mean"
        ? mean(valid)
        : s.missing === "median"
          ? median(valid)
          : null;
    const values = kept.map((r) =>
      isMissing(r.values[id]) ? fill! : (r.values[id] as number),
    );
    const avg = mean(values),
      min = Math.min(...values),
      max = Math.max(...values);
    const offset =
      s.scaling === "none" ? 0 : s.scaling === "minmax" ? min : avg;
    const divisor =
      s.scaling === "none"
        ? 1
        : s.scaling === "minmax"
          ? finite(max - min)
          : finite(Math.sqrt(mean(values.map((v) => finite((v - avg) ** 2)))));
    if (!divisor)
      fail(
        `${id}: 상수 열의 ${s.scaling} 변환은 불가능합니다. 정규화를 끄거나 속성을 제외하세요.`,
      );
    return {
      attributeId: id,
      fill,
      offset,
      divisor,
      valid: valid.length,
      missing: kept.length - valid.length,
    };
  });
  const matrix = kept.map((r) =>
    basis.map((b) =>
      finite(
        ((isMissing(r.values[b.attributeId])
          ? b.fill!
          : (r.values[b.attributeId] as number)) -
          b.offset) /
          b.divisor,
      ),
    ),
  );
  return { matrix, basis, rowIds: kept.map((r) => r.id), excluded, imputed };
}
export function squaredDistance(a: number[], b: number[]) {
  return finite(a.reduce((s, x, j) => finite(s + finite((x - b[j]) ** 2)), 0));
}
export function assignClusters(x: number[][], centers: number[][]) {
  return x.map((row) => {
    let label = 0,
      distance = squaredDistance(row, centers[0]);
    for (let c = 1; c < centers.length; c++) {
      const d = squaredDistance(row, centers[c]);
      if (d < distance) {
        label = c;
        distance = d;
      }
    }
    return { label, distance };
  });
}
function rng(seed: number) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
export function sampleIndices(n: number, size: number, seed: number) {
  const a = Array.from({ length: n }, (_, i) => i),
    r = rng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, size).sort((a, b) => a - b);
}
function initialize(
  x: number[][],
  k: number,
  seed: number,
  s: ClusteringSettings,
  basis: ClusterBasis[],
) {
  if (s.initialization === "manual")
    return s.manualCenters.map((c) =>
      c.map((v, j) => finite((v - basis[j].offset) / basis[j].divisor)),
    );
  const random = rng(seed),
    centers = [x[Math.floor(random() * x.length)].slice()];
  while (centers.length < k) {
    const distances = assignClusters(x, centers).map((v) => v.distance),
      eligible = distances
        .map((d, i) => (d > 0 ? i : -1))
        .filter((i) => i >= 0);
    if (!eligible.length) fail("서로 다른 벡터보다 k가 큽니다. k를 줄이세요.");
    let index = eligible[0];
    if (s.initialization === "random")
      index = eligible[Math.floor(random() * eligible.length)];
    else {
      const max = Math.max(...distances),
        weights = distances.map((d) => d / max),
        total = weights.reduce((a, b) => a + b, 0);
      let draw = random() * total;
      index = eligible.at(-1)!;
      for (const i of eligible) {
        draw -= weights[i];
        if (draw < 0) {
          index = i;
          break;
        }
      }
    }
    centers.push(x[index].slice());
  }
  return centers;
}
function clusterMeans(x: number[][], labels: number[], k: number) {
  const counts = Array(k).fill(0) as number[];
  labels.forEach((c) => counts[c]++);
  const means = Array.from(
    { length: k },
    () => Array(x[0].length).fill(0) as number[],
  );
  x.forEach((v, i) =>
    v.forEach(
      (n, j) =>
        (means[labels[i]][j] = finite(
          means[labels[i]][j] + n / counts[labels[i]],
        )),
    ),
  );
  return { means, counts };
}
function runRestart(
  x: number[][],
  k: number,
  seed: number,
  s: ClusteringSettings,
  basis: ClusterBasis[],
  progress: (s: string) => void,
): ClusterRestart {
  let centers = initialize(x, k, seed, s, basis),
    previous: number[] | null = null,
    converged = false,
    reason = "최대 반복 종료 (미수렴)";
  const initialCenters = centers.map((c) => c.slice());
  const history: ClusterRestart["history"] = [];
  for (let it = 0; it < s.maxIterations; it++) {
    progress(
      `k=${k} · seed=${seed} · ${it + 1}/${s.maxIterations}회 할당·평균 갱신 중…`,
    );
    let assigned = assignClusters(x, centers);
    const events: string[] = [];
    // Re-seed empty centers to the farthest represented vector; stable row-ID order breaks ties.
    for (let tries = 0; tries < k; tries++) {
      const counts = clusterMeans(
          x,
          assigned.map((a) => a.label),
          k,
        ).counts,
        empty = counts.indexOf(0);
      if (empty < 0) break;
      let far = -1,
        best = -1;
      assigned.forEach((a, i) => {
        if (
          counts[a.label] > 1 &&
          a.distance > best &&
          !centers.some((c) => squaredDistance(c, x[i]) === 0)
        ) {
          best = a.distance;
          far = i;
        }
      });
      if (far < 0)
        fail(
          "빈 군집을 해소할 서로 다른 점이 없습니다. k 또는 초기 중심을 바꾸세요.",
        );
      centers = centers.map((c, i) => (i === empty ? x[far].slice() : c));
      events.push(
        `빈 군집 ${empty + 1}: 입력 순번 ${far + 1}의 가장 먼 점으로 재초기화`,
      );
      assigned = assignClusters(x, centers);
    }
    const labels = assigned.map((a) => a.label),
      { means: after, counts } = clusterMeans(x, labels, k);
    if (counts.includes(0)) fail("빈 군집 재초기화 한도 초과");
    const movement = Math.sqrt(
      finite(
        centers.reduce((sum, c, j) => sum + squaredDistance(c, after[j]), 0),
      ),
    );
    const next = assignClusters(x, after),
      fixed = next.every((a, i) => a.label === labels[i]);
    const changes = previous
      ? labels.filter((c, i) => c !== previous![i]).length
      : x.length;
    history.push({
      before: centers.map((c) => c.slice()),
      after,
      counts,
      assignmentSse: finite(assigned.reduce((sum, a) => sum + a.distance, 0)),
      updatedSse: finite(
        x.reduce(
          (sum, row, i) => sum + squaredDistance(row, after[labels[i]]),
          0,
        ),
      ),
      movement,
      changes,
      events,
    });
    centers = after;
    previous = labels;
    if (fixed) {
      converged = true;
      reason = "최근접 할당·평균 고정점 수렴";
      break;
    }
    if (movement <= s.tolerance) {
      reason = "이동 허용값 종료 (고정점 미확인·미수렴)";
      break;
    }
  }
  const final = assignClusters(x, centers),
    counts = clusterMeans(
      x,
      final.map((a) => a.label),
      k,
    ).counts;
  if (counts.includes(0))
    fail(
      "최종 최근접 재할당에 빈 군집이 생겼습니다. 초기화·반복 조건을 바꾸세요.",
    );
  return {
    seed,
    sse: finite(final.reduce((sum, a) => sum + a.distance, 0)),
    initialCenters,
    iterations: history.length,
    converged,
    reason,
    history,
    centers,
    finalReassignment: !final.every((a, i) => a.label === previous?.[i]),
  };
}
export function silhouettePoint(
  x: number[][],
  labels: number[],
  index: number,
  rowId: string,
): SilhouettePoint {
  const k = Math.max(...labels) + 1,
    counts = Array(k).fill(0) as number[],
    sums = Array(k).fill(0) as number[];
  labels.forEach((c) => counts[c]++);
  counts[labels[index]]--;
  const base = {
    rowId,
    value: null,
    a: null,
    b: null,
    nearestCluster: null,
    sums,
    denominators: counts,
    reason: null,
  } as SilhouettePoint;
  if (k < 2 || k >= x.length)
    return {
      ...base,
      reason: "실루엣은 실제 군집 수 2 이상, 입력 행 수 미만에서 정의됩니다.",
    };
  x.forEach((row, i) => {
    if (i !== index)
      sums[labels[i]] = finite(
        sums[labels[i]] + Math.sqrt(squaredDistance(x[index], row)),
      );
  });
  let nearest = -1,
    b = Infinity;
  counts.forEach((n, c) => {
    if (c !== labels[index] && n && sums[c] / n < b) {
      b = sums[c] / n;
      nearest = c;
    }
  });
  const a = counts[labels[index]]
    ? sums[labels[index]] / counts[labels[index]]
    : 0;
  return {
    ...base,
    a,
    b,
    nearestCluster: nearest,
    value:
      counts[labels[index]] === 0
        ? 0
        : Math.max(a, b) === 0
          ? 0
          : (b - a) / Math.max(a, b),
    reason:
      counts[labels[index]] === 0
        ? "단독 구성원은 0으로 정의"
        : a === 0 && b === 0
          ? "a=b=0은 0으로 정의"
          : null,
  };
}
function silhouette(
  x: number[][],
  rowIds: string[],
  labels: number[],
  evalIds: string[],
  s: ClusteringSettings,
  progress: (s: string) => void,
): ClusterSilhouette {
  const k = Math.max(...labels) + 1,
    clusters = Array.from({ length: k }, (_, c) => ({
      count: labels.filter((v) => v === c).length,
      evaluated: 0,
      mean: null as number | null,
      reason: null as string | null,
    }));
  const mode =
    s.silhouette.mode === "sample" && evalIds.length === rowIds.length
      ? "exact"
      : s.silhouette.mode;
  const result: ClusterSilhouette = {
    mode,
    population: x.length,
    evaluationRowIds: [],
    seed: s.silhouette.seed,
    mean: null,
    reason: null,
    clusters,
  };
  if (mode === "none" || k < 2 || k >= x.length) {
    result.reason =
      mode === "none" ? "평가하지 않음" : "실루엣 정의 범위: 2 ≤ 실제 k ≤ N−1";
    clusters.forEach((c) => (c.reason = result.reason));
    return result;
  }
  const byId = new Map(rowIds.map((id, i) => [id, i])),
    values: number[] = [],
    sums = Array(k).fill(0) as number[];
  evalIds.forEach((id, j) => {
    if (j % 25 === 0)
      progress(
        `실루엣 ${j + 1}/${evalIds.length}개 평가점 · 전체 ${x.length}개 구성원 거리 계산 중…`,
      );
    const i = byId.get(id)!,
      p = silhouettePoint(x, labels, i, id);
    values.push(p.value!);
    clusters[labels[i]].evaluated++;
    sums[labels[i]] += p.value!;
  });
  clusters.forEach((c, i) => {
    c.mean = c.evaluated ? sums[i] / c.evaluated : null;
    c.reason = c.evaluated ? null : "평가 표본에 이 군집의 점이 없습니다.";
  });
  return { ...result, mean: mean(values), evaluationRowIds: evalIds, clusters };
}
export function runClustering(
  plan: ClusteringPlan,
  s: ClusteringSettings,
  progress: (s: string) => void = () => {},
): ClusteringResult {
  progress("선택 범위의 결측·스케일 기준과 공통 입력 행렬을 준비하는 중…");
  const p = prepareClusters(plan, s),
    { matrix: x, rowIds, basis } = p,
    distinct = new Set(x.map((v) => JSON.stringify(v))).size;
  const evaluationRowIds =
    s.silhouette.mode === "none"
      ? []
      : sampleIndices(
          x.length,
          s.silhouette.mode === "exact"
            ? x.length
            : Math.min(x.length, s.silhouette.sampleSize),
          s.silhouette.seed,
        ).map((i) => rowIds[i]);
  const candidates: ClusterCandidate[] = s.ks.map((k) => {
    const start = performance.now(),
      restarts: ClusterRestart[] = [];
    const out: ClusterCandidate = {
      k,
      bestRestart: null,
      restarts,
      centers: [],
      labels: [],
      squaredDistances: [],
      counts: [],
      clusterSse: [],
      sse: null,
      silhouette: null,
      elapsedMs: 0,
      error: null,
    };
    if (k > x.length || k > distinct) {
      out.error = `k=${k}는 유효 ${x.length}행 또는 서로 다른 ${distinct}개 벡터보다 큽니다. k를 줄이세요.`;
      return out;
    }
    for (let i = 0; i < s.restarts; i++) {
      const seed = (s.seed + Math.imul(i, 2654435761)) >>> 0;
      try {
        restarts.push(runRestart(x, k, seed, s, basis, progress));
      } catch (e) {
        restarts.push({
          seed,
          sse: null,
          iterations: 0,
          converged: false,
          reason: String(e),
          history: [],
          initialCenters: [],
          centers: [],
          finalReassignment: false,
        });
      }
    }
    let best = -1;
    restarts.forEach((r, i) => {
      if (r.sse !== null && (best < 0 || r.sse < restarts[best].sse!)) best = i;
    });
    if (best < 0) {
      out.error =
        "모든 재시작 실패: " + restarts.map((r) => r.reason).join(" / ");
      return out;
    }
    const centers = restarts[best].centers,
      assigned = assignClusters(x, centers),
      labels = assigned.map((a) => a.label),
      counts = Array(k).fill(0) as number[],
      clusterSse = Array(k).fill(0) as number[];
    assigned.forEach((a) => {
      counts[a.label]++;
      clusterSse[a.label] += a.distance;
    });
    Object.assign(out, {
      bestRestart: best,
      centers,
      labels,
      squaredDistances: assigned.map((a) => a.distance),
      counts,
      clusterSse,
      sse: restarts[best].sse,
      silhouette: silhouette(x, rowIds, labels, evaluationRowIds, s, progress),
      elapsedMs: performance.now() - start,
    });
    return out;
  });
  const result: ClusteringResult = {
    formatVersion: 1,
    calculationVersion: "kmeans-1",
    source: plan.source,
    features: plan.table.columns,
    scopeRowIds: plan.scopeRowIds,
    rowIds,
    basis,
    excluded: p.excluded,
    imputed: p.imputed,
    evaluationRowIds,
    candidates,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > clusterLimits.bytes)
    fail("결과 12 MiB 한도입니다. k·재시작·반복·범위를 줄이세요.");
  return result;
}
export function reconstructClusters(
  table: DeepReadonly<TableData>,
  r: ClusteringResult,
) {
  const rows = new Map(table.rows.map((row) => [row.id, row]));
  return r.rowIds.map((id) => {
    const row = rows.get(id);
    if (!row) fail("당시 입력 행이 없습니다.");
    return r.basis.map((b) =>
      finite(
        ((isMissing(row!.values[b.attributeId])
          ? b.fill!
          : (row!.values[b.attributeId] as number)) -
          b.offset) /
          b.divisor,
      ),
    );
  });
}
export function clusterDetail(
  table: DeepReadonly<TableData>,
  r: ClusteringResult,
  q: ClusterQuery,
): ClusterDetail {
  const x = reconstructClusters(table, r),
    candidate = r.candidates[q.candidate];
  if (!candidate || candidate.bestRestart === null)
    fail("완료 결과가 없습니다.");
  const restart = candidate.restarts[q.restart ?? candidate.bestRestart!],
    stage = q.iteration === null ? null : restart.history[q.iteration];
  if (q.iteration !== null && !stage) fail("없는 반복 단계");
  const centers = stage
    ? q.phase === "assignment"
      ? stage.before
      : stage.after
    : restart.centers;
  // Update phase keeps the assignment made with BEFORE centers; final uses final nearest centers.
  const assignment = assignClusters(x, stage ? stage.before : centers),
    labels = assignment.map((a) => a.label),
    distances = x.map((v, i) => squaredDistance(v, centers[labels[i]]));
  const rowMap = new Map(table.rows.map((row) => [row.id, row])),
    ix = r.features.findIndex((c) => c.id === q.x),
    iy = r.features.findIndex((c) => c.id === q.y);
  const coord = (i: number, id: string, j: number) =>
    !id
      ? 0
      : j >= 0
        ? x[i][j] * r.basis[j].divisor + r.basis[j].offset
        : rowMap.get(r.rowIds[i])!.values[id];
  const all = r.rowIds.map((id, i) => ({
    rowId: id,
    x: coord(i, q.x, ix),
    y: coord(i, q.y, iy),
    cluster: labels[i],
  }));
  const indices = all
    .map((_, i) => i)
    .filter(
      (i) =>
        (q.cluster === null || labels[i] === q.cluster) &&
        (!q.region ||
          (typeof all[i].x === "number" &&
            typeof all[i].y === "number" &&
            all[i].x! >= q.region.x0 &&
            all[i].x! <= q.region.x1 &&
            all[i].y! >= q.region.y0 &&
            all[i].y! <= q.region.y1)),
    );
  const matches = indices.map((i) => ({
    rowId: r.rowIds[i],
    cluster: labels[i],
    distance: Math.sqrt(distances[i]),
    sse: distances[i],
  }));
  const valid = all.filter(
    (p): p is ClusterDetail["marks"][number] =>
      typeof p.x === "number" &&
      Number.isFinite(p.x) &&
      typeof p.y === "number" &&
      Number.isFinite(p.y),
  );
  const marks = sampleIndices(
    valid.length,
    Math.min(valid.length, 1000),
    2718,
  ).map((i) => valid[i]);
  const centerCoord = (c: number, id: string, j: number) => {
    if (!id) return 0;
    if (j >= 0) return centers[c][j] * r.basis[j].divisor + r.basis[j].offset;
    const nums = all
      .filter((p) => p.cluster === c)
      .map((p) => (id === q.x ? p.x : p.y))
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return nums.length ? mean(nums) : null;
  };
  const statistics = inspectTable(
    {
      columns: table.columns,
      rows: indices.map((i) => rowMap.get(r.rowIds[i])!),
    },
    defaultTableView(),
  ).statistics;
  const overall = inspectTable(
    { columns: table.columns, rows: r.rowIds.map((id) => rowMap.get(id)!) },
    defaultTableView(),
  ).statistics;
  const analysisStatistics = inspectTable(
    {
      columns: r.features,
      rows: indices.map((i) => ({
        id: r.rowIds[i],
        values: Object.fromEntries(r.features.map((c, j) => [c.id, x[i][j]])),
      })),
    },
    defaultTableView(),
  ).statistics;
  const distributions: ClusterDetail["distributions"] = [];
  const chosen = new Set(indices);
  for (const column of table.columns.filter(
    (c) => c.storageType === "number" && c.semanticType === "numeric",
  )) {
    for (const space of ["observed", "analysis"] as const) {
      const j = r.features.findIndex((c) => c.id === column.id);
      if (space === "analysis" && j < 0) continue;
      const values = r.rowIds.map((id, i) =>
        space === "analysis" ? x[i][j] : rowMap.get(id)!.values[column.id],
      );
      const nums = values.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v),
      );
      const min = Math.min(...nums),
        max = Math.max(...nums),
        range = max - min;
      const bins: ClusterDetail["distributions"][number]["bins"] = [];
      if (nums.length && Number.isFinite(range)) {
        const count = range === 0 ? 1 : 10;
        for (let b = 0; b < count; b++)
          bins.push({
            lower: min + range * (b / count),
            upper: b === count - 1 ? max : min + range * ((b + 1) / count),
            selected: 0,
            all: 0,
          });
        values.forEach((v, i) => {
          if (typeof v !== "number" || !Number.isFinite(v)) return;
          const b =
            range === 0
              ? 0
              : Math.min(count - 1, Math.floor(((v - min) / range) * count));
          bins[b].all++;
          if (chosen.has(i)) bins[b].selected++;
        });
      }
      distributions.push({ attributeId: column.id, space, bins });
    }
  }
  const index = q.rowId ? r.rowIds.indexOf(q.rowId) : -1;
  return {
    distributions,
    marks,
    centers: centers
      .map((_, c) => ({
        cluster: c,
        x: centerCoord(c, q.x, ix),
        y: centerCoord(c, q.y, iy),
      }))
      .filter(
        (p): p is ClusterDetail["centers"][number] =>
          p.x !== null &&
          p.y !== null &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y),
      ),
    centersAreMeans: ix < 0 || (!!q.y && iy < 0),
    displayed: marks.length,
    total: r.rowIds.length,
    matched: matches.length,
    rows: matches.slice(q.page * 25, q.page * 25 + 25),
    statistics,
    overall,
    analysisStatistics,
    point:
      index < 0
        ? null
        : {
            rowId: r.rowIds[index],
            vector: x[index],
            distances: centers.map((c) =>
              Math.sqrt(squaredDistance(x[index], c)),
            ),
            assignmentDistances: (stage ? stage.before : centers).map((c) =>
              Math.sqrt(squaredDistance(x[index], c)),
            ),
            cluster: labels[index],
            silhouette: silhouettePoint(x, labels, index, r.rowIds[index]),
          },
  };
}
export function compareClusters(
  a: ClusteringResult,
  b: ClusteringResult,
  ac = 0,
  bc = 0,
) {
  const sameRows =
    a.source.datasetId === b.source.datasetId &&
    JSON.stringify(a.rowIds) === JSON.stringify(b.rowIds);
  const reasons: string[] = [];
  if (!sameRows) reasons.push("실제 입력 행 집합이 다릅니다.");
  if (a.source.versionId !== b.source.versionId)
    reasons.push("자료 버전이 다릅니다.");
  if (
    JSON.stringify(a.features.map((c) => c.id)) !==
    JSON.stringify(b.features.map((c) => c.id))
  )
    reasons.push("계산 속성·순서가 다릅니다.");
  if (JSON.stringify(a.basis) !== JSON.stringify(b.basis))
    reasons.push("결측·스케일 거리 공간이 다릅니다.");
  const ca = a.candidates[ac],
    cb = b.candidates[bc];
  const overlap =
    sameRows && ca?.labels.length && cb?.labels.length
      ? Array.from({ length: ca.k }, (_, i) =>
          Array.from(
            { length: cb.k },
            (_, j) =>
              ca.labels.filter((v, n) => v === i && cb.labels[n] === j).length,
          ),
        )
      : null;
  return { comparable: !reasons.length, reasons, overlap };
}
export function experimentDataset(
  points: { id: string; x: number; y: number }[],
  now = new Date().toISOString(),
): Dataset {
  if (
    !points.length ||
    points.length > 300 ||
    new Set(points.map((p) => p.id)).size !== points.length ||
    points.some((p) => !p.id || !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    fail("실험은 유한한 좌표 1~300개와 고유 행 ID가 필요합니다.");
  const id = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    columns = ["x", "y"].map((name) => ({
      id: name,
      name: name.toUpperCase(),
      storageType: "number" as const,
      semanticType: "numeric" as const,
      description: "직접 입력한 실험 좌표",
      useInAnalysis: true,
    }));
  const table = {
    columns,
    rows: points.map((p) => ({ id: p.id, values: { x: p.x, y: p.y } })),
  };
  const operation = {
    id: crypto.randomUUID(),
    kind: "import" as const,
    datasetId: id,
    inputVersionIds: [],
    outputVersionIds: [versionId],
    settings: { manualExperiment: 1 },
    executedAt: now,
  };
  return {
    id,
    name: "직접 만든 점 실험",
    source: {
      kind: "manual",
      label: "좌표 표에서 직접 입력한 2차원 점",
      importedAt: now,
    },
    original: preserveOriginal(table),
    versions: [
      createVersion(table, {
        id: versionId,
        datasetId: id,
        parentVersionIds: [],
        createdAt: now,
        operation,
      }),
    ],
  };
}
