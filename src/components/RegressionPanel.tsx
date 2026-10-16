import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import type { RegressionControl } from "./useRegression";
import type {
  AnalysisConfig,
  AnalysisRecord,
  Cell,
  Project,
} from "../domain/types";
import type {
  ModelOutcome,
  PredictionExplanation,
  RegressionKind,
  RegressionPrediction,
  RegressionResult,
  RegressionSettings,
} from "../domain/regression-types";
import {
  buildRegressionPlan,
  comparableRegression,
} from "../domain/regression";
import { getResultFreshness } from "../domain/model";
import { modelLabels } from "../domain/regression-models";
import { resolveVersion } from "../domain/processing";
import { useTask } from "../workers/useTask";
import { ErrorNotice, TaskStatus } from "./DataControls";
const RegressionCanvas = lazy(() =>
  import("./GraphCanvas").then((m) => ({ default: m.RegressionCanvas })),
);
const n = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "계산 불가"
    : Number(v.toPrecision(7)).toLocaleString("ko-KR", {
        maximumSignificantDigits: 7,
      });
const statusLabels = {
  pending: "대기",
  running: "계산 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};

export function RegressionSettingsPanel({
  control: c,
}: {
  control: RegressionControl;
}) {
  const s = c.config?.regression;
  const preview = useMemo(() => {
    try {
      return c.config
        ? { plan: buildRegressionPlan(c.state.project, c.config), error: "" }
        : { plan: null, error: "" };
    } catch (e) {
      return { plan: null, error: String(e instanceof Error ? e.message : e) };
    }
  }, [c.config, c.state.project.datasets]);
  if (!s || !c.version) return <p>회귀 설정을 시작하려면 자료를 선택하세요.</p>;
  const numeric = c.version.columns.filter(
    (a) =>
      a.storageType === "number" &&
      a.semanticType === "numeric" &&
      a.useInAnalysis,
  );
  const changeNumber = (
    key: "trainRatio" | "seed" | "k" | "maxDepth" | "minLeaf",
    value: string,
  ) => {
    if (value.trim() && Number.isFinite(Number(value)))
      c.patch({ [key]: Number(value) });
  };
  return (
    <section
      className="regression-settings"
      id="regression-settings"
      tabIndex={-1}
    >
      <div className="eyebrow">같은 평가 자료로 비교</div>
      <h2>회귀 분석 설정</h2>
      <label>
        예측 대상
        <select
          aria-label="예측 대상"
          value={s.target}
          onChange={(e) =>
            c.patch({
              target: e.target.value,
              features: s.features.filter((id) => id !== e.target.value),
              reuseSplit: null,
            })
          }
        >
          <option value="">수치 속성 선택</option>
          {numeric.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="regression-features">
        <legend>입력 속성 · 직접 선택</legend>
        {c.version.columns.map((a) => {
          const allowed =
            numeric.some((x) => x.id === a.id) && a.id !== s.target;
          return (
            <label key={a.id}>
              <input
                type="checkbox"
                aria-label={`입력 ${a.name}`}
                disabled={!allowed}
                checked={s.features.includes(a.id)}
                onChange={(e) =>
                  c.patch({
                    features: e.target.checked
                      ? [...s.features, a.id]
                      : s.features.filter((id) => id !== a.id),
                  })
                }
              />
              <span>
                {a.name}
                {!allowed && (
                  <small>
                    {!a.useInAnalysis
                      ? "분석 제외"
                      : a.id === s.target
                        ? "예측 대상"
                        : "수치 입력 아님"}
                  </small>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="muted">
        분석 제외는 데이터 → 속성 편집에서 변경합니다. 범주에는 정리 → 원핫
        인코딩을 사용하세요. 숫자 ID·범주 코드를 연속형으로 사용하지 않습니다.
      </p>
      <label>
        분석 범위
        <select
          aria-label="분석 범위"
          value={s.scope.kind}
          onChange={(e) =>
            c.scope(e.target.value as RegressionSettings["scope"]["kind"])
          }
        >
          <option value="all">전체 행</option>
          <option value="filtered">현재 필터의 모든 행</option>
          <option value="selected">현재 선택 행</option>
        </select>
      </label>
      {s.scope.kind !== "all" && (
        <button onClick={() => c.scope(s.scope.kind)}>
          표의 현재 범위 다시 가져오기
        </button>
      )}
      <fieldset className="regression-features">
        <legend>실행할 모델</legend>
        {(["linear", "tree", "knn"] as RegressionKind[]).map((kind) => (
          <label key={kind}>
            <input
              type="checkbox"
              checked={s.models.includes(kind)}
              onChange={(e) =>
                c.patch({
                  models: e.target.checked
                    ? [...s.models, kind]
                    : s.models.filter((x) => x !== kind),
                })
              }
            />
            {modelLabels[kind]}
          </label>
        ))}
      </fieldset>
      <div className="regression-pair">
        <label>
          학습 비율
          <select
            aria-label="학습 비율"
            value={s.trainRatio}
            onChange={(e) => changeNumber("trainRatio", e.target.value)}
          >
            {[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)} : {Math.round(100 - v * 100)}
              </option>
            ))}
          </select>
        </label>
        <label>
          무작위 seed
          <input
            aria-label="무작위 seed"
            type="number"
            min="0"
            max="4294967295"
            value={s.seed}
            onChange={(e) => changeNumber("seed", e.target.value)}
          />
        </label>
      </div>
      <label>
        입력 결측값
        <select
          aria-label="입력 결측값"
          value={s.missing}
          onChange={(e) =>
            c.patch({
              missing: e.target.value as RegressionSettings["missing"],
            })
          }
        >
          <option value="remove">공통으로 행 제외</option>
          <option value="mean">학습 평균 대체</option>
          <option value="median">학습 중앙값 대체</option>
        </select>
      </label>
      <label>
        정규화
        <select
          aria-label="회귀 정규화"
          value={s.scaling}
          onChange={(e) =>
            c.patch({
              scaling: e.target.value as RegressionSettings["scaling"],
            })
          }
        >
          <option value="none">추가 정규화 없음</option>
          <option value="minmax">학습 최솟값·최댓값</option>
          <option value="zscore">학습 평균·표준편차 (분모 n)</option>
        </select>
      </label>
      <label>
        최근접 이웃 수 k
        <input
          aria-label="최근접 이웃 수 k"
          type="number"
          min="1"
          max="200"
          value={s.k}
          onChange={(e) => changeNumber("k", e.target.value)}
        />
      </label>
      <details>
        <summary>고급 설정 · 트리와 이웃</summary>
        <label>
          트리 최대 깊이
          <input
            aria-label="트리 최대 깊이"
            type="number"
            min="1"
            max="10"
            value={s.maxDepth}
            onChange={(e) => changeNumber("maxDepth", e.target.value)}
          />
        </label>
        <label>
          최소 리프 행 수
          <input
            aria-label="최소 리프 행 수"
            type="number"
            min="1"
            value={s.minLeaf}
            onChange={(e) => changeNumber("minLeaf", e.target.value)}
          />
        </label>
        <label>
          이웃 가중 방식
          <select
            aria-label="이웃 가중 방식"
            value={s.weights}
            onChange={(e) =>
              c.patch({
                weights: e.target.value as RegressionSettings["weights"],
              })
            }
          >
            <option value="uniform">동일 가중 평균</option>
            <option value="distance">거리 역수 가중</option>
          </select>
        </label>
        <p>
          거리 0 이웃이 있으면 선택한 k개 중 거리 0만 같은 가중치로 평균냅니다.
          동일 거리에서는 행 ID 순입니다.
        </p>
      </details>
      {c.selected?.regression && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={!!s.reuseSplit}
            disabled={
              c.selected.regression.source.datasetId !==
              c.config?.source.datasetId
            }
            onChange={(e) =>
              c.patch({
                reuseSplit: e.target.checked
                  ? {
                      train: c.selected!.regression!.split.train.filter((id) =>
                        c.version!.rows.some((r) => r.id === id),
                      ),
                      evaluation:
                        c.selected!.regression!.split.evaluation.filter((id) =>
                          c.version!.rows.some((r) => r.id === id),
                        ),
                    }
                  : null,
              })
            }
          />
          선택한 기록의 분할 재사용
        </label>
      )}
      {s.reuseSplit && (
        <p className="muted">
          분할 재사용 중에는 위 비율·seed로 다시 섞지 않고 저장한 행 배치를
          유지합니다. 새로운 분할에는 체크를 해제하세요.
        </p>
      )}
      <div className="regression-preview">
        <strong>실행 전 확인</strong>
        <p>
          자료 버전: <code>{c.config?.source.versionId}</code>
        </p>
        {preview.plan ? (
          <>
            <p>
              {preview.plan.scopeRowIds.length.toLocaleString()}행 · 정답 출처
              기준{" "}
              {new Set(
                Object.values(preview.plan.observationUnits),
              ).size.toLocaleString()}
              개 관측
              <br />
              입력: {preview.plan.features.map((a) => a.name).join(", ")}
            </p>
            <p>
              관측 단위 분할 →{" "}
              {preview.plan.steps
                .map((s) =>
                  s.kind === "preprocess"
                    ? s.settings.kind
                    : s.kind === "wrangle"
                      ? s.fitted.settings.kind
                      : "편집",
                )
                .join(" → ")}
              {preview.plan.steps.length ? " → " : ""}입력 결측 처리 →{" "}
              {s.scaling === "none" ? "정규화 추가 안 함" : s.scaling} → 공통
              학습·평가
            </p>
          </>
        ) : (
          <p>{preview.error}</p>
        )}
        <p>
          학습 관측 수 = floor(유효 관측 수 × {s.trainRatio}). 정답 결측은
          제외하며, 복제 관측은 한쪽에 함께 배치합니다. 기존 정리 이력의 통계
          기준도 학습 행에서 재계산합니다.
        </p>
      </div>
      <button
        className="primary-button"
        disabled={!preview.plan || c.busy}
        onClick={() => c.run()}
      >
        회귀 실행 · 새 기록
      </button>
      {c.busy && (
        <div role="status">
          <p>{c.message}</p>
          <button onClick={() => c.cancel()}>회귀 계산 취소</button>
        </div>
      )}
      {c.error && (
        <p role="alert" className="regression-error">
          {c.error}
        </p>
      )}
      <p className="muted">군집과 연관 규칙은 위의 분석 영역에서 선택하세요.</p>
    </section>
  );
}

export function RegressionPanel({
  control: c,
}: {
  control: RegressionControl;
}) {
  const record = c.selected,
    result = record?.regression;
  const freshness = record
    ? getResultFreshness(record, c.config?.source ?? null, c.config)
    : null;
  return (
    <section className="regression-panel">
      <div className="regression-intro">
        <div>
          <div className="eyebrow">질문에서 예측으로</div>
          <h2>같은 자료, 세 가지 예측 방법</h2>
          <p>오차를 비교하고 각 예측이 만들어진 이유를 살펴보세요.</p>
        </div>
        <button
          onClick={() => {
            if (!c.state.view.inspectorOpen) c.dispatch({ type: "inspector" });
            setTimeout(
              () => document.getElementById("regression-settings")?.focus(),
              0,
            );
          }}
        >
          회귀 설정으로 이동
        </button>
      </div>
      {c.busy && (
        <div className="regression-running" role="status">
          <strong>{c.message}</strong>
          <p>
            메뉴를 이동해도 계산이 이어집니다. 조건 변경 시 이전 작업을
            취소합니다.
          </p>
          <button onClick={() => c.cancel()}>회귀 계산 취소</button>
        </div>
      )}
      {c.error && (
        <p className="regression-error" role="alert">
          {c.error}
        </p>
      )}
      <div className="regression-records">
        <label>
          분석 기록
          <select
            aria-label="회귀 분석 기록"
            value={record?.id ?? ""}
            onChange={(e) =>
              c.dispatch({
                type: "analysis-select",
                id: e.target.value || null,
              })
            }
          >
            <option value="">기록 선택</option>
            {c.state.project.analyses
              .filter((a) => a.kind === "regression")
              .slice()
              .reverse()
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.regression?.target.name || "회귀"} ·{" "}
                  {new Date(a.createdAt).toLocaleTimeString("ko-KR")} ·{" "}
                  {statusLabels[a.status]}
                </option>
              ))}
          </select>
        </label>
        <label>
          비교할 기록
          <select
            aria-label="비교할 회귀 기록"
            value={c.comparison?.id ?? ""}
            onChange={(e) =>
              c.dispatch({
                type: "analysis-select",
                id: e.target.value || null,
                comparison: true,
              })
            }
          >
            <option value="">비교 안 함</option>
            {c.state.project.analyses
              .filter((a) => a.id !== record?.id && a.regression)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.regression!.target.name} ·{" "}
                  {new Date(a.createdAt).toLocaleTimeString("ko-KR")}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!record ? (
        <div className="regression-empty">
          <h3>예측 대상을 정해 보세요</h3>
          <p>
            오른쪽에서 대상과 입력 속성을 선택하고 실행하면 세 모델의 평가와
            계산 근거가 여기에 나타납니다.
          </p>
        </div>
      ) : (
        <>
          <div className="regression-record-heading">
            <h3>
              {record.regression?.target.name || "회귀 기록"} ·{" "}
              {statusLabels[record.status]}
            </h3>
            <span
              className={
                freshness?.state === "stale"
                  ? "regression-stale"
                  : "sample-badge"
              }
            >
              {freshness?.state === "stale"
                ? "재분석 필요"
                : freshness?.state === "current"
                  ? "현재 조건과 일치"
                  : statusLabels[record.status]}
            </span>
          </div>
          {freshness?.reasons.length !== 0 && (
            <p>{freshness?.reasons.join(" ")} 당시 결과는 보존됩니다.</p>
          )}
          <div className="data-actions">
            <button
              disabled={!record.configSnapshot.regression || c.busy}
              onClick={() =>
                c.run(structuredClone(record.configSnapshot) as AnalysisConfig)
              }
            >
              당시 조건으로 다시 실행
            </button>
            <button
              disabled={!c.config || !record.configSnapshot.regression}
              onClick={() => c.cloneCurrent(record)}
            >
              현재 버전으로 조건 복제
            </button>
            <button onClick={() => c.remove(record.id)}>이 기록 삭제</button>
          </div>
          {record.error && <ErrorNotice error={record.error} />}
          {!record.configSnapshot.regression && (
            <p>
              이전 단계의 기록에는 학습 모델·분할 정보가 없습니다. 상세
              예측·점수 비교를 지원하지 않습니다.
            </p>
          )}
          {result && (
            <>
              <p className="scope-notice">
                {result.unit} · 공통 학습 {result.trainRowIds.length}행 / 평가{" "}
                {result.evaluationRowIds.length}행 · 제외{" "}
                {result.excluded.length}행. 성공한 모든 모델이 정확히 같은 평가
                행을 사용합니다.
              </p>
              <MetricsTable result={result} />
              {c.comparison?.regression && (
                <div className="regression-comparison">
                  <h3>두 실행 비교</h3>
                  <strong>
                    {comparableRegression(result, c.comparison.regression)
                      ? "동일 평가 자료 · 행 ID·실제값·단위 일치"
                      : "직접 비교 조건이 다름 · 평가 행·실제값·관측 또는 단위가 다릅니다"}
                  </strong>
                  <p>
                    비교 기록:{" "}
                    {new Date(c.comparison.createdAt).toLocaleString("ko-KR")}
                  </p>
                  <MetricsTable result={c.comparison.regression} />
                </div>
              )}
              <RegressionDetails
                key={record.id}
                record={record}
                project={c.state.project}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
function MetricsTable({ result: r }: { result: RegressionResult }) {
  return (
    <div className="table-scroll">
      <table className="regression-table">
        <caption>
          전체 유효 평가 행의 정확한 점수 · 잔차 = 실제값 − 예측값
        </caption>
        <thead>
          <tr>
            <th>모델</th>
            <th>학습 / 평가</th>
            <th>MAE</th>
            <th>MSE</th>
            <th>RMSE</th>
            <th>R²</th>
            <th>계산 시간</th>
          </tr>
        </thead>
        <tbody>
          {r.models.map((m) => (
            <tr key={m.kind}>
              <th>{modelLabels[m.kind]}</th>
              {m.status === "completed" ? (
                <>
                  <td>
                    {r.trainRowIds.length} / {m.metrics.n}
                  </td>
                  <td>{n(m.metrics.mae)}</td>
                  <td>{n(m.metrics.mse)}</td>
                  <td>{n(m.metrics.rmse)}</td>
                  <td title={m.metrics.r2Reason ?? undefined}>
                    {n(m.metrics.r2)}
                    {m.metrics.r2Reason && <small>{m.metrics.r2Reason}</small>}
                  </td>
                </>
              ) : (
                <td colSpan={5}>모델 실패: {m.reason}</td>
              )}
              <td>{n(m.durationMs)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegressionDetails({
  record,
  project,
}: {
  record: AnalysisRecord;
  project: Project;
}) {
  const r = record.regression!,
    [kind, setKind] = useState<RegressionKind>(
      r.models.find((m) => m.status === "completed")?.kind ?? "linear",
    );
  const [page, setPage] = useState(0),
    [selected, setSelected] = useState<string | null>(null),
    [prediction, setPrediction] = useState<RegressionPrediction | null>(null),
    [newValues, setNewValues] = useState<Record<string, string>>({}),
    [error, setError] = useState("");
  const task = useTask("regression-detail-" + record.id),
    m = r.models.find((m) => m.kind === kind),
    source = resolveVersion(project, r.source);
  const chosen = source.rows.find((row) => row.id === selected);
  const predict = (rowId?: string) => {
    setError("");
    setPrediction(null);
    try {
      const plan = buildRegressionPlan(
        project,
        record.configSnapshot as AnalysisConfig,
      );
      const values: Record<string, Cell> = rowId
        ? { ...source.rows.find((row) => row.id === rowId)!.values }
        : Object.fromEntries(
            Object.entries(newValues).map(([id, value]) => [
              id,
              value === "" ? null : value,
            ]),
          );
      task.run(
        {
          kind: "regression-predict",
          plan,
          result: r,
          values,
          ...(rowId ? { rowId } : {}),
        },
        (out) => {
          if (out.kind === "regression-predict") setPrediction(out.result);
        },
      );
    } catch (e) {
      setError(String(e));
    }
  };
  const select = useCallback(
    (id: string) => {
      setSelected(id);
      if (m?.status === "completed")
        setPage(Math.floor(m.rows.findIndex((row) => row.rowId === id) / 25));
    },
    [m],
  );
  return (
    <div className="regression-details">
      <details>
        <summary>당시 조건·분할·고정 학습 기준</summary>
        <p>
          자료:{" "}
          <code>
            {r.source.datasetId} / {r.source.versionId}
          </code>
          <br />
          입력: {r.features.map((c) => c.name).join(", ")}
          <br />
          관측 단위 수: {new Set(Object.values(r.split.units)).size} · 계산 규칙{" "}
          {r.calculationVersion}
        </p>
        <pre>{JSON.stringify(record.configSnapshot.regression, null, 2)}</pre>
        <details>
          <summary>학습·평가 행 ID와 전처리 순서·기준</summary>
          <pre>
            {JSON.stringify({ split: r.split, pipeline: r.pipeline }, null, 2)}
          </pre>
        </details>
        <details>
          <summary>제외된 행과 이유 ({r.excluded.length})</summary>
          <pre>{JSON.stringify(r.excluded, null, 2)}</pre>
        </details>
      </details>
      <label>
        자세히 볼 모델
        <select
          aria-label="자세히 볼 모델"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as RegressionKind);
            setPage(0);
          }}
        >
          {r.models.map((m) => (
            <option key={m.kind} value={m.kind}>
              {modelLabels[m.kind]}
            </option>
          ))}
        </select>
      </label>
      {m?.status === "completed" ? (
        <>
          <ModelStructure model={m} result={r} />
          <details>
            <summary>평가값 계산식과 실제 분자·분모</summary>
            <p>
              MAE = Σ|잔차| / n = {n(m.metrics.absoluteSum)} / {m.metrics.n}
              <br />
              MSE = Σ잔차² / n = {n(m.metrics.squaredSum)} / {m.metrics.n}
              <br />
              RMSE = √MSE = {n(m.metrics.rmse)}
              <br />
              R² = 1 − Σ잔차² / Σ(실제값 − 실제 평균)² = 1 −{" "}
              {n(m.metrics.squaredSum)} / {n(m.metrics.totalSumSquares)}
              <br />
              실제 평균 {n(m.metrics.actualMean)}.{" "}
              {m.metrics.r2Reason ?? "음수 R²도 그대로 표시합니다."}
            </p>
          </details>
          <Suspense fallback={<p>오차 그래프를 여는 중…</p>}>
            <RegressionCanvas
              rows={m.rows}
              seed={r.sampling.seed}
              select={select}
            />
          </Suspense>
          <p>
            점 표시는 최대 1,000행의 고정 seed 표본입니다. 점수는 전체{" "}
            {m.rows.length}개 유효 평가 행 기준입니다. 점을 선택하면 해당 표
            페이지로 이동합니다.
          </p>
          <div className="table-scroll">
            <table className="regression-table">
              <caption>
                평가 행 {page * 25 + 1}–
                {Math.min((page + 1) * 25, m.rows.length)} / {m.rows.length}
              </caption>
              <thead>
                <tr>
                  <th>행 · 당시 자료</th>
                  <th>실제값</th>
                  <th>예측값</th>
                  <th>잔차</th>
                  <th>절대 오차</th>
                  <th>제곱 오차</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.slice(page * 25, (page + 1) * 25).map((row) => (
                  <tr
                    key={row.rowId}
                    className={selected === row.rowId ? "selected" : ""}
                  >
                    <th>
                      <button
                        onClick={() => {
                          setSelected(row.rowId);
                          predict(row.rowId);
                        }}
                      >
                        {row.rowId} · 근거 보기
                      </button>
                    </th>
                    <td>{n(row.actual)}</td>
                    <td>{n(row.predicted)}</td>
                    <td>{n(row.residual)}</td>
                    <td>{n(row.absoluteError)}</td>
                    <td>{n(row.squaredError)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="data-actions">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              평가 이전 페이지
            </button>
            <span>
              {page + 1} / {Math.ceil(m.rows.length / 25)}
            </span>
            <button
              disabled={(page + 1) * 25 >= m.rows.length}
              onClick={() => setPage(page + 1)}
            >
              평가 다음 페이지
            </button>
          </div>
        </>
      ) : (
        <p>{m?.status === "failed" ? m.reason : "완료된 모델이 없습니다."}</p>
      )}
      {chosen && (
        <section className="regression-source">
          <h3>당시 자료 · {chosen.id}</h3>
          <p>
            저장한 버전을 조회합니다. 현재 자료의 활성 버전은 바뀌지 않습니다.
          </p>
          <dl>
            {source.columns.map((c) => (
              <div key={c.id}>
                <dt>{c.name}</dt>
                <dd>
                  {chosen.values[c.id] === null
                    ? "결측"
                    : String(chosen.values[c.id])}
                </dd>
              </div>
            ))}
          </dl>
          <button onClick={() => predict(chosen.id)}>이 행의 계산 근거</button>
        </section>
      )}
      <section className="regression-new">
        <h3>새 입력값 예측</h3>
        <p>
          평가에 사용한 학습 모델과 고정 전처리 기준을 재사용합니다. 새 입력은
          정답 평가에 포함하지 않습니다.
        </p>
        {r.predictionBlock ? (
          <p>{r.predictionBlock}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSelected(null);
              predict();
            }}
          >
            <div className="regression-input-grid">
              {r.pipeline.rawInputs.map((a) => (
                <label key={a.id}>
                  {a.name}
                  <small>
                    {a.semanticType === "date"
                      ? "날짜 YYYY-MM-DD 또는 ISO 시각"
                      : a.storageType === "number"
                        ? "수치"
                        : a.semanticType === "categorical"
                          ? "원래 범주 · 학습 사전 고정"
                          : "원래 값"}
                  </small>
                  <input
                    aria-label={`새 입력 ${a.name}`}
                    value={newValues[a.id] ?? ""}
                    placeholder="빈칸은 결측"
                    onChange={(e) => {
                      task.cancel();
                      setPrediction(null);
                      setNewValues({ ...newValues, [a.id]: e.target.value });
                    }}
                  />
                </label>
              ))}
            </div>
            <button
              className="primary-button"
              disabled={
                task.busy || !r.models.some((m) => m.status === "completed")
              }
            >
              저장된 모델로 예측
            </button>
          </form>
        )}
      </section>
      <TaskStatus {...task} />
      <ErrorNotice error={task.error} />
      {error && <p role="alert">{error}</p>}
      {prediction && (
        <section className="regression-explanation">
          <h3>
            {selected ? "평가 행의 계산 근거" : "새 관측의 예측 · 정답 없음"}
          </h3>
          {prediction.warnings.map((w) => (
            <p key={w} className="regression-stale">
              {w}
            </p>
          ))}
          <p>
            실제 모델 입력:{" "}
            {r.features
              .map((c, i) => `${c.name} = ${n(prediction.transformed[i])}`)
              .join(", ")}
          </p>
          {prediction.models.map((model) => (
            <Explanation key={model.kind} model={model} result={r} />
          ))}
        </section>
      )}
      <p className="scope-notice">
        예측 오차와 패턴을 탐구하는 결과입니다. 계수나 높은 점수만으로 원인 또는
        정책 효과를 단정할 수 없습니다.
      </p>
    </div>
  );
}
function ModelStructure({
  model: m,
  result: r,
}: {
  model: Extract<ModelOutcome, { status: "completed" }>;
  result: RegressionResult;
}) {
  const model = m.model,
    [page, setPage] = useState(0);
  if (model.kind === "linear")
    return (
      <section>
        <h3>절편과 계수 · 실제 변환된 입력 기준</h3>
        <p>
          예측 = {n(model.intercept)}{" "}
          {model.coefficients
            .map((v, i) => `+ (${n(v)} × ${r.features[i].name})`)
            .join(" ")}
        </p>
        <p>
          수치 균형 조정 후 Householder QR. 계수는 실제 모델 입력 단위로
          되돌렸습니다. 정규화가 있으면 원래 단위의 계수가 아닙니다.
        </p>
        <div className="table-scroll">
          <table className="regression-table regression-coefficients">
            <thead>
              <tr>
                <th>이름</th>
                <th>계수</th>
              </tr>
            </thead>
            <tbody>
              {r.features.map((c, i) => (
                <tr key={c.id}>
                  <th>
                    {c.name}
                    <small>{c.id}</small>
                  </th>
                  <td>{n(model.coefficients[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  if (model.kind === "knn")
    return (
      <section>
        <h3>
          이웃 {model.k}개 ·{" "}
          {model.weights === "uniform" ? "동일 가중 평균" : "거리 역수 가중"}
        </h3>
        <p>
          유클리드 거리 · 동일 거리는 행 ID 순. 후보는 학습{" "}
          {model.trainRowIds.length}행뿐입니다. 평가 행의 ‘근거 보기’에서 실제
          이웃과 거리를 확인하세요.
        </p>
      </section>
    );
  return (
    <details open>
      <summary>트리 구조 · {model.nodes.length}개 노드</summary>
      <p>
        제곱 오차 감소 최대 분할, 리프는 학습 정답 평균. 깊이 {model.maxDepth},
        최소 리프 {model.minLeaf}행. 동률은 입력 순서 → 낮은 경계. 탐색량{" "}
        {model.work.toLocaleString()}.
      </p>
      <div className="table-scroll">
        <table className="regression-table">
          <thead>
            <tr>
              <th>노드 / 깊이</th>
              <th>조건 (≤ 왼쪽)</th>
              <th>왼쪽 / 오른쪽</th>
              <th>학습 행</th>
              <th>예측 평균</th>
            </tr>
          </thead>
          <tbody>
            {model.nodes.slice(page * 25, (page + 1) * 25).map((node) => (
              <tr key={node.id}>
                <th>
                  {node.id} / {node.depth}
                </th>
                <td>
                  {node.feature === null
                    ? "리프"
                    : `${r.features[node.feature].name} ≤ ${n(node.threshold)}`}
                </td>
                <td>
                  {node.left ?? "–"} / {node.right ?? "–"}
                </td>
                <td>{node.count}</td>
                <td>{n(node.prediction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="data-actions">
        <button disabled={!page} onClick={() => setPage(page - 1)}>
          노드 이전
        </button>
        <button
          disabled={(page + 1) * 25 >= model.nodes.length}
          onClick={() => setPage(page + 1)}
        >
          노드 다음
        </button>
      </div>
    </details>
  );
}
function Explanation({
  model: m,
  result: r,
}: {
  model: PredictionExplanation;
  result: RegressionResult;
}) {
  return (
    <details open>
      <summary>
        {modelLabels[m.kind]} · 예측 {n(m.predicted)}
      </summary>
      {m.terms && (
        <p>
          절편 {n(m.intercept)} +{" "}
          {m.terms
            .map(
              (t) =>
                `(${r.features[t.feature].name}: ${n(t.input)} × ${n(t.coefficient)} = ${n(t.contribution)})`,
            )
            .join(" + ")}{" "}
          = {n(m.predicted)}
        </p>
      )}
      {m.path && (
        <ol>
          {m.path.map((node) => (
            <li key={node.id}>
              노드 {node.id}:{" "}
              {node.feature === null
                ? `리프 평균 ${n(node.prediction)} (학습 ${node.count}행)`
                : `${r.features[node.feature].name} ≤ ${n(node.threshold)} → 다음 노드 ${m.path![m.path!.indexOf(node) + 1]?.id}`}
            </li>
          ))}
        </ol>
      )}
      {m.neighbors && (
        <>
          <p>예측 = Σ(이웃 정답 × 정규화 가중치), 가중치 합 1.</p>
          <div className="table-scroll">
            <table className="regression-table">
              <thead>
                <tr>
                  <th>학습 행 ID</th>
                  <th>거리</th>
                  <th>정답</th>
                  <th>가중치</th>
                </tr>
              </thead>
              <tbody>
                {m.neighbors.map((v) => (
                  <tr key={v.rowId}>
                    <th>{v.rowId}</th>
                    <td>{n(v.distance)}</td>
                    <td>{n(v.target)}</td>
                    <td>{n(v.weight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
