import type {
  EvaluationRow,
  MatrixRow,
  PredictionExplanation,
  RegressionMetrics,
  RegressionModel,
  RegressionSettings,
  TreeNode,
} from "./regression-types";

export const REGRESSION_LIMITS = {
  rows: 20000,
  features: 40,
  nodes: 1023,
  treeWork: 8_000_000,
  distances: 40_000_000,
  resultRows: 30000,
  replayCells: 1_000_000,
  records: 50,
};
export const modelLabels = {
  linear: "선형회귀",
  tree: "의사결정트리",
  knn: "최근접 이웃",
};
export function requireRegression(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function finiteRegression(n: number, label = "계산"): number {
  requireRegression(
    Number.isFinite(n),
    `${label}: 표현 가능한 수치 범위를 넘었습니다. 값의 단위·범위를 조정하세요.`,
  );
  return n;
}
const mean = (xs: number[]) =>
  finiteRegression(xs.reduce((s, v) => s + v / xs.length, 0));
export function fitLinear(
  rows: MatrixRow[],
): Extract<RegressionModel, { kind: "linear" }> {
  const n = rows.length,
    p = rows[0]?.x.length ?? 0,
    m = p + 1;
  requireRegression(
    p > 0 && n >= m + 1,
    "선형회귀: 입력 수 + 2 이상의 학습 행이 필요합니다. 입력을 줄이거나 자료를 늘리세요.",
  );
  // Column scaling is numerical equilibration, undone in coefficients; no ridge penalty.
  const centers = Array.from({ length: p }, (_, j) =>
    mean(rows.map((r) => r.x[j])),
  );
  const scales = centers.map((c, j) =>
    Math.max(...rows.map((r) => Math.abs(finiteRegression(r.x[j] - c)))),
  );
  requireRegression(
    scales.every((s) => s > 0),
    "선형회귀: 상수 입력 열이 있습니다. 상수 열을 제외하세요.",
  );
  const a = rows.map((r) => [
    1,
    ...r.x.map((v, j) => (v - centers[j]) / scales[j]),
  ]);
  const yScale = Math.max(1, ...rows.map((r) => Math.abs(r.y)));
  const b = rows.map((r) => r.y / yScale),
    tolerance = 1e-10 * Math.sqrt(n);
  for (let j = 0; j < m; j++) {
    let norm = 0;
    for (let i = j; i < n; i++) norm = Math.hypot(norm, a[i][j]);
    requireRegression(
      norm > tolerance,
      "선형회귀: 선형 종속 또는 수치적으로 불안정한 입력입니다. 중복 특성·전체 원핫 열 중 기준 열을 제외하세요.",
    );
    const alpha = a[j][j] >= 0 ? -norm : norm;
    const v = Array.from({ length: n - j }, (_, k) => a[k + j][j]);
    v[0] -= alpha;
    const vn = Math.hypot(...v);
    for (let k = 0; k < v.length; k++) v[k] /= vn;
    for (let col = j; col < m; col++) {
      let dot = 0;
      for (let k = 0; k < v.length; k++) dot += v[k] * a[k + j][col];
      for (let k = 0; k < v.length; k++) a[k + j][col] -= 2 * v[k] * dot;
    }
    let dot = 0;
    for (let k = 0; k < v.length; k++) dot += v[k] * b[k + j];
    for (let k = 0; k < v.length; k++) b[k + j] -= 2 * v[k] * dot;
  }
  const beta = Array(m).fill(0) as number[];
  for (let j = m - 1; j >= 0; j--) {
    let rhs = b[j];
    for (let k = j + 1; k < m; k++) rhs -= a[j][k] * beta[k];
    beta[j] = finiteRegression(rhs / a[j][j]);
  }
  const coefficients = beta
    .slice(1)
    .map((v, j) => finiteRegression((v * yScale) / scales[j]));
  const intercept = finiteRegression(
    beta[0] * yScale - coefficients.reduce((s, v, j) => s + v * centers[j], 0),
  );
  return {
    kind: "linear",
    intercept,
    coefficients,
    algorithm: "scaled-householder-qr-v1",
    tolerance,
  };
}
export function fitTree(
  rows: MatrixRow[],
  maxDepth: number,
  minLeaf: number,
): Extract<RegressionModel, { kind: "tree" }> {
  requireRegression(rows.length >= 2, "트리: 학습 행이 2개 이상 필요합니다.");
  const nodes: TreeNode[] = [];
  let work = 0;
  function build(indices: number[], depth: number): number {
    requireRegression(
      nodes.length < REGRESSION_LIMITS.nodes,
      "트리 노드 한도 1,023개를 넘습니다. 최대 깊이를 줄이거나 최소 리프 행 수를 늘리세요.",
    );
    const prediction = mean(indices.map((i) => rows[i].y));
    const id = nodes.length,
      node: TreeNode = {
        id,
        depth,
        count: indices.length,
        prediction,
        feature: null,
        threshold: null,
        left: null,
        right: null,
      };
    nodes.push(node);
    if (depth >= maxDepth || indices.length < 2 * minLeaf) return id;
    const scale = Math.max(
      ...indices.map((i) => Math.abs(rows[i].y - prediction)),
    );
    if (scale === 0) return id;
    const ys = new Map(
      indices.map((i) => [i, (rows[i].y - prediction) / scale]),
    );
    const total = indices.reduce((s, i) => s + ys.get(i)!, 0);
    let best = 0,
      feature = -1,
      threshold = 0;
    for (let j = 0; j < rows[0].x.length; j++) {
      work += indices.length;
      requireRegression(
        work <= REGRESSION_LIMITS.treeWork,
        "트리 분할 탐색 한도를 넘었습니다. 행·입력 수 또는 깊이를 줄이세요.",
      );
      const sorted = [...indices].sort(
        (a, b) =>
          rows[a].x[j] - rows[b].x[j] || rows[a].id.localeCompare(rows[b].id),
      );
      let leftSum = 0;
      for (let k = 1; k < sorted.length; k++) {
        leftSum += ys.get(sorted[k - 1])!;
        if (
          k < minLeaf ||
          sorted.length - k < minLeaf ||
          rows[sorted[k - 1]].x[j] === rows[sorted[k]].x[j]
        )
          continue;
        const gain =
          (leftSum * leftSum) / k +
          (total - leftSum) ** 2 / (sorted.length - k) -
          (total * total) / sorted.length;
        // First feature, then lower threshold wins ties at 1e-12 normalized gain.
        if (gain > best + 1e-12) {
          best = gain;
          feature = j;
          const lo = rows[sorted[k - 1]].x[j],
            hi = rows[sorted[k]].x[j];
          threshold = lo / 2 + hi / 2;
          if (threshold >= hi) threshold = lo;
        }
      }
    }
    if (feature < 0) return id;
    node.feature = feature;
    node.threshold = finiteRegression(threshold);
    node.left = build(
      indices.filter((i) => rows[i].x[feature] <= threshold),
      depth + 1,
    );
    node.right = build(
      indices.filter((i) => rows[i].x[feature] > threshold),
      depth + 1,
    );
    return id;
  }
  build(
    rows.map((_, i) => i),
    0,
  );
  return { kind: "tree", nodes, maxDepth, minLeaf, work };
}
export function predictModel(
  model: RegressionModel,
  x: number[],
  train: MatrixRow[],
): PredictionExplanation {
  if (model.kind === "linear") {
    requireRegression(
      x.length === model.coefficients.length,
      "모델 특성 수가 다릅니다.",
    );
    const terms = x.map((input, feature) => ({
      feature,
      input,
      coefficient: model.coefficients[feature],
      contribution: finiteRegression(input * model.coefficients[feature]),
    }));
    return {
      kind: model.kind,
      intercept: model.intercept,
      terms,
      predicted: finiteRegression(
        terms.reduce((s, t) => s + t.contribution, model.intercept),
      ),
    };
  }
  if (model.kind === "tree") {
    const path: TreeNode[] = [];
    let node = model.nodes[0];
    while (node) {
      requireRegression(
        path.length <= model.nodes.length,
        "트리 순환 참조입니다.",
      );
      path.push(node);
      if (node.feature === null) break;
      node =
        model.nodes[
          x[node.feature] <= node.threshold! ? node.left! : node.right!
        ];
    }
    requireRegression(node && node.feature === null, "트리 리프가 없습니다.");
    return { kind: model.kind, path, predicted: node.prediction };
  }
  requireRegression(
    model.k >= 1 && model.k <= train.length,
    "k는 유효 학습 행 수 이하의 양의 정수여야 합니다.",
  );
  const best: {
    rowId: string;
    distance: number;
    target: number;
    weight: number;
  }[] = [];
  for (const r of train) {
    let distance = 0;
    for (let j = 0; j < x.length; j++)
      distance = Math.hypot(distance, finiteRegression(x[j] - r.x[j], "거리"));
    const neighbor = {
      rowId: r.id,
      distance: finiteRegression(distance),
      target: r.y,
      weight: 0,
    };
    let lo = 0,
      hi = best.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const v = best[mid];
      if (
        v.distance < distance ||
        (v.distance === distance && v.rowId.localeCompare(r.id) < 0)
      )
        lo = mid + 1;
      else hi = mid;
    }
    if (lo < model.k) {
      best.splice(lo, 0, neighbor);
      if (best.length > model.k) best.pop();
    }
  }
  const zeros = best.filter((n) => n.distance === 0).length;
  // Normalize reciprocal distance by the minimum positive distance to avoid overflow.
  const weights = best.map((n) =>
      model.weights === "uniform"
        ? 1
        : zeros
          ? n.distance === 0
            ? 1
            : 0
          : best[0].distance / n.distance,
    ),
    sum = weights.reduce((a, b) => a + b, 0);
  best.forEach((n, i) => (n.weight = weights[i] / sum));
  return {
    kind: model.kind,
    neighbors: best,
    predicted: finiteRegression(
      best.reduce((s, n) => s + n.target * n.weight, 0),
    ),
  };
}
export function fitModel(
  kind: RegressionModel["kind"],
  rows: MatrixRow[],
  s: RegressionSettings,
): RegressionModel {
  if (kind === "linear") return fitLinear(rows);
  if (kind === "tree") return fitTree(rows, s.maxDepth, s.minLeaf);
  requireRegression(
    s.k <= rows.length,
    "최근접 이웃: k가 유효 학습 행 수보다 큽니다. k를 줄이세요.",
  );
  return {
    kind: "knn",
    k: s.k,
    weights: s.weights,
    trainRowIds: rows.map((r) => r.id),
  };
}
export function evaluationRow(
  rowId: string,
  actual: number,
  predicted: number,
): EvaluationRow {
  const residual = finiteRegression(actual - predicted),
    absoluteError = Math.abs(residual),
    squaredError = finiteRegression(residual * residual, "제곱 오차");
  return { rowId, actual, predicted, residual, absoluteError, squaredError };
}
export function regressionMetrics(rows: EvaluationRow[]): RegressionMetrics {
  requireRegression(
    rows.length > 0,
    "평가할 행이 없습니다. 결측 처리·분할 조건을 확인하세요.",
  );
  const n = rows.length,
    actualMean = mean(rows.map((r) => r.actual));
  const absoluteSum = finiteRegression(
      rows.reduce((s, r) => s + r.absoluteError, 0),
    ),
    squaredSum = finiteRegression(rows.reduce((s, r) => s + r.squaredError, 0));
  const totalSumSquares = finiteRegression(
    rows.reduce((s, r) => s + (r.actual - actualMean) ** 2, 0),
  );
  const r2Reason =
    n < 2
      ? "평가 행이 2개 미만입니다."
      : totalSumSquares === 0
        ? "실제값의 분산이 0입니다."
        : null;
  return {
    n,
    absoluteSum,
    squaredSum,
    totalSumSquares,
    actualMean,
    mae: absoluteSum / n,
    mse: squaredSum / n,
    rmse: Math.sqrt(squaredSum / n),
    r2: r2Reason ? null : finiteRegression(1 - squaredSum / totalSumSquares),
    r2Reason,
  };
}
