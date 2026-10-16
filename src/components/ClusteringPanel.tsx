import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ClusteringControl } from "./useClustering";
import type {
  ClusteringSettings,
  ClusterDetail,
  ClusterQuery,
} from "../domain/clustering-types";
import type { AnalysisRecord, ColumnStatistics } from "../domain/types";
import {
  buildClusteringPlan,
  compareClusters,
  experimentDataset,
  clusteringConfig,
  defaultClustering,
} from "../domain/clustering";
import { analysisFreshness } from "../domain/results";
import { resolveVersion } from "../domain/processing";
import { useTask } from "../workers/useTask";
import { TaskStatus, ErrorNotice } from "./DataControls";
import { ProcessingHistory } from "./WranglingPanel";
const Plot = lazy(() =>
  import("./GraphCanvas").then((m) => ({ default: m.ClusteringCanvas })),
);
const n = (v: number | null | undefined) =>
  v == null
    ? "계산 불가"
    : v.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
const status = {
  pending: "준비",
  running: "계산 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};
function NumberField({
  label,
  value,
  set,
  min = 0,
  max = 4294967295,
  step = 1,
}: {
  label: string;
  value: number;
  set: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          if (e.target.value !== "" && Number.isFinite(e.target.valueAsNumber))
            set(e.target.valueAsNumber);
        }}
      />
    </label>
  );
}
export function ClusteringSettingsPanel({
  control: c,
}: {
  control: ClusteringControl;
}) {
  const s = c.config?.clustering;
  const [kText, setKText] = useState("2"),
    [centers, setCenters] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    setKText(s?.ks.join(", ") ?? "2");
    setCenters(s?.manualCenters.map((row) => row.join(", ")).join("\n") ?? "");
  }, [JSON.stringify(s?.ks), JSON.stringify(s?.manualCenters)]);
  const plan = useMemo(() => {
    try {
      return c.config
        ? { value: buildClusteringPlan(c.state.project, c.config), error: "" }
        : { value: null, error: "" };
    } catch (e) {
      return { value: null, error: String(e instanceof Error ? e.message : e) };
    }
  }, [c.config, c.state.project]);
  if (!s || !c.version)
    return <p>자료를 선택하거나 직접 점 실험에서 좌표를 저장하세요.</p>;
  const patch = c.patch;
  return (
    <section className="cluster-settings" id="cluster-settings" tabIndex={-1}>
      <h3>K-means 설정</h3>
      <p>
        선택 버전의 현재 값에 아래 처리를 추가합니다. 목표값·학습 분할 없이 전체
        입력을 군집화합니다.
      </p>
      <fieldset>
        <legend>계산 속성 (거리 차원)</legend>
        {c.version.columns
          .filter(
            (a) =>
              a.storageType === "number" &&
              a.semanticType === "numeric" &&
              a.useInAnalysis,
          )
          .map((a) => (
            <label className="check-row" key={a.id}>
              <input
                type="checkbox"
                checked={s.features.includes(a.id)}
                onChange={(e) =>
                  patch({
                    features: e.target.checked
                      ? [...s.features, a.id]
                      : s.features.filter((id) => id !== a.id),
                  })
                }
              />
              {a.name}
            </label>
          ))}
      </fieldset>
      <small>
        식별자·범주·코드는 자동 선택하지 않습니다. 원핫 열을 포함하면 각 열이
        거리의 한 차원이 됩니다.
      </small>
      <label>
        입력 범위
        <select
          aria-label="군집 입력 범위"
          value={s.scope.kind}
          onChange={(e) =>
            c.scope(e.target.value as ClusteringSettings["scope"]["kind"])
          }
        >
          <option value="all">전체 자료</option>
          <option value="filtered">현재 필터 전체</option>
          <option value="selected">선택한 행</option>
        </select>
      </label>
      <button onClick={() => c.scope(s.scope.kind)}>
        현재 표의 범위 다시 가져오기
      </button>
      <small>페이지·정렬과 독립. 선택한 행 0개는 전체로 바꾸지 않습니다.</small>
      <label>
        군집 수 k 목록
        <input
          aria-label="군집 수 k 목록"
          value={kText}
          onChange={(e) => setKText(e.target.value)}
        />
      </label>
      <button
        onClick={() => {
          const ks = kText
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
            .map(Number);
          patch({ ks });
        }}
      >
        k 목록 적용
      </button>
      <label>
        결측 처리
        <select
          aria-label="군집 결측 처리"
          value={s.missing}
          onChange={(e) =>
            patch({ missing: e.target.value as ClusteringSettings["missing"] })
          }
        >
          <option value="remove">결측 행 제외</option>
          <option value="mean">선택 범위 평균으로 대체</option>
          <option value="median">선택 범위 중앙값으로 대체</option>
        </select>
      </label>
      <label>
        추가 정규화
        <select
          aria-label="군집 정규화"
          value={s.scaling}
          onChange={(e) =>
            patch({ scaling: e.target.value as ClusteringSettings["scaling"] })
          }
        >
          <option value="none">없음 (현재 단위)</option>
          <option value="minmax">최소·최대 0~1</option>
          <option value="zscore">Z점수 (모집단 표준편차)</option>
        </select>
      </label>
      <NumberField
        label="군집 seed"
        value={s.seed}
        set={(seed) => patch({ seed })}
      />
      <details>
        <summary>초기화·반복·실루엣 고급 설정</summary>
        <label>
          초기화
          <select
            aria-label="군집 초기화"
            value={s.initialization}
            onChange={(e) => {
              if (e.target.value === "manual") {
                setError(
                  "아래에 서로 다른 중심 좌표를 입력한 뒤 직접 중심 적용을 누르세요.",
                );
              } else
                patch({
                  initialization: e.target
                    .value as ClusteringSettings["initialization"],
                });
            }}
          >
            <option value="kmeans++">k-means++</option>
            <option value="random">서로 다른 점 무작위</option>
            <option value="manual">직접 중심 좌표</option>
          </select>
        </label>
        <NumberField
          label="재시작 횟수"
          value={s.restarts}
          min={1}
          max={10}
          set={(restarts) => patch({ restarts })}
        />
        <NumberField
          label="최대 반복"
          value={s.maxIterations}
          min={1}
          max={100}
          set={(maxIterations) => patch({ maxIterations })}
        />
        <NumberField
          label="중심 이동 허용값"
          value={s.tolerance}
          max={1}
          step={0.000001}
          set={(tolerance) => patch({ tolerance })}
        />
        <p>
          직접 중심: 한 줄에 한 중심, 쉼표로 좌표 구분. 순서:{" "}
          {s.features
            .map((id) => c.version!.columns.find((a) => a.id === id)?.name)
            .join(" → ")}
          . 선택 버전의 단위로 입력하며 데이터와 같은 정규화를 적용합니다. 일반
          점과 별도입니다.
        </p>
        <textarea
          aria-label="직접 초기 중심"
          value={centers}
          onChange={(e) => setCenters(e.target.value)}
        />
        <button
          onClick={() => {
            try {
              const rows = centers
                .trim()
                .split("\n")
                .map((line) =>
                  line.split(",").map((v) => {
                    if (!v.trim()) throw new Error("빈 좌표");
                    return Number(v);
                  }),
                );
              patch({
                initialization: "manual",
                manualCenters: rows,
                ks: [rows.length],
                restarts: 1,
              });
              setError("");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          직접 중심 적용
        </button>
        <label>
          실루엣 평가
          <select
            aria-label="실루엣 평가"
            value={s.silhouette.mode}
            onChange={(e) =>
              patch({
                silhouette: {
                  ...s.silhouette,
                  mode: e.target
                    .value as ClusteringSettings["silhouette"]["mode"],
                },
              })
            }
          >
            <option value="exact">전체 점 정확 계산</option>
            <option value="sample">평가점 균등 표본 추정</option>
            <option value="none">평가하지 않음</option>
          </select>
        </label>
        {s.silhouette.mode === "sample" && (
          <NumberField
            label="실루엣 평가 표본 수"
            value={s.silhouette.sampleSize}
            min={1}
            max={1000}
            set={(sampleSize) =>
              patch({ silhouette: { ...s.silhouette, sampleSize } })
            }
          />
        )}
        <NumberField
          label="평가 표본 seed"
          value={s.silhouette.seed}
          set={(seed) => patch({ silhouette: { ...s.silhouette, seed } })}
        />
        <p>
          모든 k에 같은 평가점을 사용합니다. 표본점의 거리는 전체 군집 구성원에
          대해 계산합니다.
        </p>
      </details>
      <div className="scope-notice">
        {plan.value
          ? `입력 ${plan.value.scopeRowIds.length}행 · ${s.features.length}차원 · k ${s.ks.join(", ")}`
          : plan.error}
      </div>
      <p>
        결측은 null·빈 문자열입니다. 중복 점도 각 행을 유지합니다. 모든 k는 같은
        행렬·전처리·표본을 공유합니다.
      </p>
      <button
        className="primary-button"
        disabled={c.busy || !plan.value}
        onClick={() => c.run()}
      >
        군집 실행 · k 비교
      </button>
      {c.busy && <button onClick={() => c.cancel()}>군집 계산 취소</button>}
      {(error || c.error) && <p role="alert">{error || c.error}</p>}
    </section>
  );
}
export function ClusteringPanel({
  control: c,
}: {
  control: ClusteringControl;
}) {
  const record = c.selected,
    records = c.state.project.analyses.filter((a) => a.kind === "clustering");
  const freshness = record
    ? analysisFreshness(c.state.project, record)
    : null;
  return (
    <section className="cluster-panel">
      <div className="regression-intro">
        <h2>가까운 점들은 어떤 무리를 이룰까요?</h2>
        <p>
          K-means로 특징이 비슷한 행을 묶고, 군집 수와 중심의 이동을 비교하세요.
          군집은 정답·인과관계·실제 집단의 증명이 아닙니다.
        </p>
        <button
          onClick={() => {
            if (!c.state.view.inspectorOpen) c.dispatch({ type: "inspector" });
            setTimeout(
              () => document.getElementById("cluster-settings")?.focus(),
              0,
            );
          }}
        >
          군집 설정으로 이동
        </button>
      </div>
      {c.busy && (
        <div role="status" className="scope-notice">
          {c.message}
          <button onClick={() => c.cancel()}>군집 계산 취소</button>
        </div>
      )}
      {c.error && <p role="alert">{c.error}</p>}
      <div className="cluster-grid">
        <label>
          군집 기록
          <select
            aria-label="군집 분석 기록"
            value={record?.id ?? ""}
            onChange={(e) =>
              c.dispatch({ type: "cluster-select", id: e.target.value || null })
            }
          >
            <option value="">기록 선택</option>
            {[...records].reverse().map((a) => (
              <option key={a.id} value={a.id}>
                {new Date(a.createdAt).toLocaleTimeString("ko-KR")} · k{" "}
                {a.configSnapshot.clustering?.ks.join(", ") ?? "이전 기록"} ·{" "}
                {status[a.status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          비교할 군집 기록
          <select
            aria-label="비교할 군집 기록"
            value={c.comparison?.id ?? ""}
            onChange={(e) =>
              c.dispatch({
                type: "cluster-select",
                id: e.target.value || null,
                comparison: true,
              })
            }
          >
            <option value="">비교 안 함</option>
            {records
              .filter((a) => a.id !== record?.id && a.clustering)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {new Date(a.createdAt).toLocaleTimeString("ko-KR")} · k{" "}
                  {a.configSnapshot.clustering?.ks.join(", ")}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!record ? (
        <p className="empty-state">
          오른쪽에서 속성과 조건을 확인하고 실행하세요. 결과 열은 원자료에
          추가되지 않습니다.
        </p>
      ) : (
        <>
          <div className="cluster-heading">
            <strong>
              {status[record.status]} ·{" "}
              {freshness?.state === "current"
                ? "현재 조건과 일치"
                : freshness?.state === "stale"
                  ? "재분석 필요"
                  : "완료 결과 없음"}
            </strong>
            <button disabled={!c.writable} onClick={() => c.remove(record.id)}>
              이 군집 기록 삭제
            </button>
            <button
              disabled={!c.writable || !record.configSnapshot.clustering}
              onClick={() => c.cloneCurrent(record)}
            >
              현재 자료로 조건 복사
            </button>
          </div>
          {freshness?.reasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          {record.error && (
            <p role="alert">
              {record.error.message} {record.error.cause} {record.error.remedy}
            </p>
          )}
          {!record.configSnapshot.clustering && (
            <p>
              이전 군집 기록에는 중심·라벨·계산 규칙이 없습니다. 당시 설정만
              확인할 수 있습니다. 현재 조건으로 새 분석을 실행하세요.
            </p>
          )}
          <details>
            <summary>당시 조건·범위·전처리 기준</summary>
            <pre>
              {JSON.stringify(
                record.configSnapshot.clustering ?? record.configSnapshot,
                null,
                2,
              )}
            </pre>
            {record.clustering && (
              <>
                <p>
                  제외 {record.clustering.excluded.length}행 · 대체{" "}
                  {record.clustering.imputed.length}행. 현재 자료 버전의 값에
                  추가 적용한 기준:
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      basis: record.clustering.basis,
                      excluded: record.clustering.excluded,
                      imputed: record.clustering.imputed,
                    },
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
          </details>
          <ProcessingHistory
            project={c.state.project}
            source={{ ...record.configSnapshot.source }}
          />
          {record.clustering && (
            <ClusterResultView key={record.id} record={record} control={c} />
          )}
        </>
      )}
    </section>
  );
}
function ClusterResultView({
  record,
  control: c,
}: {
  record: AnalysisRecord;
  control: ClusteringControl;
}) {
  const r = record.clustering!,
    table = resolveVersion(c.state.project, r.source);
  const detailInput=useMemo(()=>{const ids=new Set(r.rowIds);return {columns:table.columns,rows:table.rows.filter(row=>ids.has(row.id))};},[table,r]);
  const axes = c.state.view.clusterAxes?.[record.id] ?? {
    x: r.features[0].id,
    y: r.features[1]?.id ?? "",
  };
  const [candidate, setCandidate] = useState(0),
    [restart, setRestart] = useState<number | null>(null),
    [iteration, setIteration] = useState<number | null>(null),
    [phase, setPhase] = useState<ClusterQuery["phase"]>("final"),
    [cluster, setCluster] = useState<number | null>(null),
    [page, setPage] = useState(0),
    [rowId, setRowId] = useState<string | null>(null),
    [region, setRegion] = useState<ClusterQuery["region"]>(null),
    [bounds, setBounds] = useState(["", "", "", ""]),
    [compareK, setCompareK] = useState(0);
  const [detail, setDetail] = useState<ClusterDetail | null>(null),
    task = useTask("cluster-detail-" + record.id);
  const query: ClusterQuery = {
    candidate,
    restart,
    iteration,
    phase,
    ...axes,
    cluster,
    page,
    rowId,
    region,
  };
  const key = JSON.stringify(query);
  useEffect(() => {
    setDetail(null);
    if (r.candidates[candidate]?.bestRestart !== null)
      task.run(
        { kind: "clustering-detail", table: detailInput, result: r, query },
        (out) => {
          if (out.kind === "clustering-detail") setDetail(out.result);
        },
      );
    else task.cancel();
  }, [key, r, table, task.run, task.cancel]);
  const select = useCallback((id: string) => setRowId(id), []),
    cand = r.candidates[candidate],
    run = cand.restarts[restart ?? cand.bestRestart ?? 0],
    hist = iteration === null ? null : run?.history[iteration];
  const comparison = c.comparison?.clustering,
    comparisonResult = comparison
      ? compareClusters(r, comparison, candidate, compareK)
      : null;
  const setAxis = (axis: "x" | "y", value: string) =>
    c.dispatch({ type: "cluster-axes", id: record.id, ...axes, [axis]: value });
  const forward = (i: number | null) => {
    setIteration(i);
    setPhase(i === null ? "final" : "assignment");
    setPage(0);
  };
  return (
    <div>
      <h3>군집 수 비교 · 같은 입력 {r.rowIds.length}행</h3>
      <p>
        SSE는 작을수록 중심에 가깝습니다. 실루엣은 −1~1 범위이며 분류 정확도가
        아닙니다. 최적 k를 자동 확정하지 않습니다.
      </p>
      <div className="table-scroll">
        <table className="cluster-table">
          <thead>
            <tr>
              <th>k / 보기</th>
              <th>실제 k · 크기</th>
              <th>SSE</th>
              <th>실루엣</th>
              <th>수렴·반복·시간</th>
            </tr>
          </thead>
          <tbody>
            {r.candidates.map((a, i) => (
              <tr key={a.k}>
                <td>
                  <button
                    aria-pressed={candidate === i}
                    onClick={() => {
                      setCandidate(i);
                      setRestart(null);
                      forward(null);
                      setCluster(null);
                      setRowId(null);
                    }}
                  >
                    {a.k}개 군집
                  </button>
                </td>
                <td>
                  {a.counts.length} · {a.counts.join(", ")}
                </td>
                <td>{n(a.sse)}</td>
                <td>
                  {n(a.silhouette?.mean)}
                  <small>
                    {a.silhouette?.mode === "exact"
                      ? "전체 정확 계산"
                      : a.silhouette?.mode === "sample"
                        ? "균등 표본 추정"
                        : "미평가"}{" "}
                    · {a.silhouette?.evaluationRowIds.length ?? 0}/
                    {r.rowIds.length}행 {a.silhouette?.reason}
                  </small>
                </td>
                <td>
                  {a.bestRestart === null ? (
                    a.error
                  ) : (
                    <>
                      {a.restarts[a.bestRestart].reason}
                      <small>
                        {a.restarts[a.bestRestart].iterations}회 ·{" "}
                        {n(a.elapsedMs)}ms
                      </small>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Suspense fallback={<p>그래프를 여는 중…</p>}>
        <Plot mode="metrics" result={r} />
      </Suspense>
      {comparison && (
        <section className="scope-notice">
          <h3>두 저장 실행 비교</h3>
          <label>
            상대 기록의 k
            <select
              aria-label="비교 기록의 k"
              value={compareK}
              onChange={(e) => setCompareK(Number(e.target.value))}
            >
              {comparison.candidates.map((a, i) => (
                <option key={a.k} value={i}>
                  k={a.k}
                </option>
              ))}
            </select>
          </label>
          <p>
            {comparisonResult?.comparable
              ? "같은 행·버전·속성·거리 공간: SSE 비교 가능"
              : comparisonResult?.reasons.join(" ")}
          </p>
          <p>
            현재 SSE {n(cand.sse)} / 비교 SSE{" "}
            {n(comparison.candidates[compareK]?.sse)} · 실루엣{" "}
            {n(cand.silhouette?.mean)} /{" "}
            {n(comparison.candidates[compareK]?.silhouette?.mean)}. 평가
            방식·표본도 확인하세요.
          </p>
          <p>
            군집 번호 자체는 같은 집단을 뜻하지 않습니다. 아래는 동일 행의 겹침
            개수입니다.
          </p>
          <details>
            <summary>비교하는 두 실행의 전체 조건</summary>
            <pre>
              {JSON.stringify(
                {
                  현재: record.configSnapshot.clustering,
                  비교: c.comparison?.configSnapshot.clustering,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {comparisonResult?.overlap && (
            <div className="table-scroll">
              <table className="cluster-table">
                <thead>
                  <tr>
                    <th>현재 / 비교</th>
                    {comparisonResult.overlap[0].map((_, j) => (
                      <th key={j}>비교 {j + 1}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonResult.overlap.map((row, i) => (
                    <tr key={i}>
                      <th>현재 {i + 1}</th>
                      {row.map((count, j) => (
                        <td key={j}>{count}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {cand.bestRestart !== null && (
        <>
          <h3>k={cand.k} · 재시작별 결과와 실제 계산 과정</h3>
          <p>
            완료한 재시작 중 최소 SSE를 사용하며 동률이면 먼저 실행한
            회차입니다. 최대 반복·이동 허용값 종료와 고정점 수렴은 구분합니다.
          </p>
          <div className="table-scroll">
            <table className="cluster-table">
              <thead>
                <tr>
                  <th>재시작</th>
                  <th>seed</th>
                  <th>SSE</th>
                  <th>반복·종료</th>
                </tr>
              </thead>
              <tbody>
                {cand.restarts.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <button
                        disabled={a.sse === null}
                        onClick={() => {
                          setRestart(i);
                          forward(null);
                        }}
                      >
                        {i + 1}회 {cand.bestRestart === i ? "· 채택" : ""}
                      </button>
                    </td>
                    <td>{a.seed}</td>
                    <td>{n(a.sse)}</td>
                    <td>
                      {a.iterations}회 · {a.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>선택 재시작의 실제 초기 중심 (분석 공간)</summary>
            <pre>{JSON.stringify(run.initialCenters, null, 2)}</pre>
          </details>
          <div className="cluster-toolbar">
            <button onClick={() => forward(0)}>처음</button>
            <button
              disabled={iteration === 0}
              onClick={() =>
                forward(
                  iteration === null ? run.history.length - 1 : iteration - 1,
                )
              }
            >
              이전
            </button>
            <button
              disabled={iteration === null}
              onClick={() =>
                forward(
                  iteration! + 1 >= run.history.length ? null : iteration! + 1,
                )
              }
            >
              다음
            </button>
            <button onClick={() => forward(null)}>최종</button>
            <label>
              계산 단계
              <select
                aria-label="군집 계산 단계"
                value={iteration ?? -1}
                onChange={(e) =>
                  forward(
                    Number(e.target.value) < 0 ? null : Number(e.target.value),
                  )
                }
              >
                <option value={-1}>최종 최근접 재할당</option>
                {run.history.map((_, i) => (
                  <option value={i} key={i}>
                    {i + 1}회
                  </option>
                ))}
              </select>
            </label>
            {hist && (
              <label>
                표시 상태
                <select
                  aria-label="군집 단계 상태"
                  value={phase}
                  onChange={(e) =>
                    setPhase(e.target.value as ClusterQuery["phase"])
                  }
                >
                  <option value="assignment">갱신 전 중심으로 할당</option>
                  <option value="update">
                    동일 할당 유지 · 평균 갱신 후 중심
                  </option>
                </select>
              </label>
            )}
          </div>
          {hist ? (
            <div className="scope-notice">
              <p>
                {iteration! + 1}회 · 이전 할당과 달라진 점 {hist.changes}개 ·
                전체 차원의 중심 이동 {n(hist.movement)} · 할당 SSE{" "}
                {n(hist.assignmentSse)} → 평균 갱신 SSE {n(hist.updatedSse)}
              </p>
              {hist.events.map((e, i) => (
                <p key={i}>{e}</p>
              ))}
              <p>
                거리 동률이면 작은 군집 번호. 아래 평균 갱신은 해당 단계의 전체
                구성원 기준입니다.
              </p>
              <div className="table-scroll">
                <table className="cluster-table">
                  <thead>
                    <tr>
                      <th>군집·구성원</th>
                      <th>할당에 사용한 중심</th>
                      <th>구성원 평균으로 갱신한 중심</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hist.before.map((v, i) => (
                      <tr key={i}>
                        <th>
                          {i + 1} · {hist.counts[i]}행
                        </th>
                        <td>{v.map(n).join(", ")}</td>
                        <td>{hist.after[i].map(n).join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p>
              {run.reason} · 최종 최근접 재할당 변경{" "}
              {run.finalReassignment ? "있음 (평균과 고정점 아님)" : "없음"}.
              선택 재시작{" "}
              {restart === null ? cand.bestRestart + 1 : restart + 1}회. 위 지표
              비교표는 채택한 재시작 기준입니다.
            </p>
          )}
          <h3>군집 분포 · 표시 축은 계산 속성과 별개</h3>
          <div className="cluster-grid">
            {(["x", "y"] as const).map((axis) => (
              <label key={axis}>
                {axis.toUpperCase()} 표시 축
                <select
                  aria-label={`군집 ${axis.toUpperCase()} 표시 축`}
                  value={axes[axis]}
                  onChange={(e) => setAxis(axis, e.target.value)}
                >
                  {axis === "y" && <option value="">없음 · 1차원</option>}
                  {table.columns
                    .filter((c) => c.storageType === "number")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <p>
            {r.features.length}개 특성으로 계산한 군집입니다. 축 변경은
            라벨·계산 조건을 바꾸지 않습니다. 3차원 이상 관계를 이 그림만으로
            판단하지 마세요.
          </p>
          <TaskStatus {...task} />
          {task.error && <ErrorNotice error={task.error} />}
          {detail && (
            <>
              <Suspense fallback={<p>산점도를 여는 중…</p>}>
                <Plot mode="scatter" detail={detail} select={select} context={[`자료 ${r.source.datasetId} · 버전 ${r.source.versionId}`,`특성 ${r.features.map(f=>f.name).join(", ")} · 전처리 ${JSON.stringify(r.basis).slice(0,600)}`]} />
              </Suspense>
              <p>
                전체 입력 {detail.total}행 · 표시 {detail.displayed}점 (최대
                1,000개 고정 표본). 통계·영역 조회는 전체 입력 기준. 표시점이
                겹치면 아래 좌표 범위로 모든 행을 조회하세요.
              </p>
              <p>
                중심 표시:{" "}
                {detail.centersAreMeans
                  ? "비계산 축을 포함한 군집 평균 (K-means 중심 아님)"
                  : "선택 버전 단위로 역변환한 K-means 중심"}
                .
              </p>
              <div className="table-scroll">
                <table className="cluster-table">
                  <thead>
                    <tr>
                      <th>군집 선택</th>
                      <th>채택 결과 크기·비율</th>
                      <th>군집 SSE</th>
                      <th>실루엣 평가 평균·표본</th>
                      <th>선택 재시작 중심 (분석 공간 → 버전 단위)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cand.counts.map((count, i) => (
                      <tr key={i}>
                        <td>
                          <button
                            onClick={() => {
                              setCluster(i);
                              setPage(0);
                            }}
                          >
                            군집 {i + 1}
                          </button>
                        </td>
                        <td>
                          {count}행 · {n((count / r.rowIds.length) * 100)}%
                        </td>
                        <td>{n(cand.clusterSse[i])}</td>
                        <td>
                          {n(cand.silhouette?.clusters[i].mean)} ·{" "}
                          {cand.silhouette?.clusters[i].evaluated}점
                          <small>{cand.silhouette?.clusters[i].reason}</small>
                        </td>
                        <td>
                          {run.centers[i].map(n).join(", ")} →{" "}
                          {run.centers[i]
                            .map((v, j) =>
                              n(v * r.basis[j].divisor + r.basis[j].offset),
                            )
                            .join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cluster-toolbar">
                <button
                  onClick={() => {
                    setCluster(null);
                    setRegion(null);
                    setPage(0);
                  }}
                >
                  전체 행 보기
                </button>
                {["X 최소", "X 최대", "Y 최소", "Y 최대"].map((label, i) => (
                  <label key={label}>
                    {label}
                    <input
                      aria-label={"영역 " + label}
                      type="number"
                      value={bounds[i]}
                      onChange={(e) =>
                        setBounds((v) =>
                          v.map((old, j) => (i === j ? e.target.value : old)),
                        )
                      }
                    />
                  </label>
                ))}
                <button
                  disabled={
                    bounds.some(
                      (v) => v.trim() === "" || !Number.isFinite(Number(v)),
                    ) ||
                    Number(bounds[0]) > Number(bounds[1]) ||
                    Number(bounds[2]) > Number(bounds[3])
                  }
                  onClick={() => {
                    setRegion({
                      x0: Number(bounds[0]),
                      x1: Number(bounds[1]),
                      y0: Number(bounds[2]),
                      y1: Number(bounds[3]),
                    });
                    setPage(0);
                  }}
                >
                  전체 입력에서 영역 조회
                </button>
              </div>
              <h3>
                {cluster === null ? "전체/영역" : "군집 " + (cluster + 1)} 행{" "}
                {detail.matched}개 · 당시 자료 확인
              </h3>
              <div className="table-scroll">
                <table className="cluster-table">
                  <thead>
                    <tr>
                      <th>당시 행 선택</th>
                      <th>군집</th>
                      <th>중심 거리</th>
                      <th>SSE 기여</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.map((row) => (
                      <tr key={row.rowId}>
                        <td>
                          <button onClick={() => select(row.rowId)}>
                            {row.rowId}
                          </button>
                        </td>
                        <td>{row.cluster + 1}</td>
                        <td>{n(row.distance)}</td>
                        <td>{n(row.sse)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cluster-toolbar">
                <button disabled={!page} onClick={() => setPage(page - 1)}>
                  이전 25행
                </button>
                <span>{page + 1}쪽</span>
                <button
                  disabled={(page + 1) * 25 >= detail.matched}
                  onClick={() => setPage(page + 1)}
                >
                  다음 25행
                </button>
              </div>
              {detail.point && (
                <section className="scope-notice">
                  <h3>선택 점 {detail.point.rowId}의 근거</h3>
                  <p>
                    분석 공간 좌표 [{detail.point.vector.map(n).join(", ")}],
                    군집 {detail.point.cluster + 1}. 할당 단계의 최근접 중심을
                    사용하며 거리 동률은 작은 번호입니다. 평균 갱신 보기에서는
                    할당을 유지합니다.
                  </p>
                  <p>
                    할당에 사용한 중심까지 거리:{" "}
                    {detail.point.assignmentDistances
                      .map((d, i) => `군집 ${i + 1}: ${n(d)}`)
                      .join(" / ")}
                    <br />
                    현재 표시 중심까지 거리:{" "}
                    {detail.point.distances
                      .map((d, i) => `군집 ${i + 1}: ${n(d)}`)
                      .join(" / ")}
                  </p>
                  <p>
                    이 단계의 개별 실루엣 {n(detail.point.silhouette.value)} ·
                    a={n(detail.point.silhouette.a)}, b=
                    {n(detail.point.silhouette.b)} · 가까운 다른 군집{" "}
                    {detail.point.silhouette.nearestCluster === null
                      ? "없음"
                      : detail.point.silhouette.nearestCluster + 1}
                    . {detail.point.silhouette.reason}
                  </p>
                  <p>
                    전체 구성원 거리 합: [
                    {detail.point.silhouette.sums.map(n).join(", ")}], 나눗수: [
                    {detail.point.silhouette.denominators.join(", ")}]. 자신은
                    제외합니다.
                  </p>
                  <div className="table-scroll">
                    <table className="cluster-table">
                      <thead>
                        <tr>
                          <th>당시 열</th>
                          <th>관측 원값 (추가 대체 전)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.columns.map((a) => (
                          <tr key={a.id}>
                            <th>{a.name}</th>
                            <td>
                              {String(
                                table.rows.find(
                                  (row) => row.id === detail.point!.rowId,
                                )!.values[a.id] ?? "결측",
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <h3>수치 분포 비교</h3>
              <p>
                전체 입력의 최솟값~최댓값을 같은 폭 10구간으로 나눕니다 (상수는
                1구간). 왼쪽 포함·오른쪽 제외, 마지막 구간은 양끝 포함.
                전체·선택 행에 같은 경계를 사용하며 결측은 제외합니다.
              </p>
              {detail.distributions.map((d) => (
                <details key={d.attributeId + d.space}>
                  <summary>
                    {table.columns.find((c) => c.id === d.attributeId)?.name} ·{" "}
                    {d.space === "observed" ? "관측값 분포" : "분석 공간 분포"}
                  </summary>
                  {d.bins.length ? (
                    <div className="table-scroll">
                      <table className="cluster-table">
                        <thead>
                          <tr>
                            <th>구간</th>
                            <th>선택 행 빈도</th>
                            <th>전체 입력 빈도</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.bins.map((b, i) => (
                            <tr key={i}>
                              <td>
                                {n(b.lower)} ~ {n(b.upper)}
                              </td>
                              <td>{b.selected}</td>
                              <td>{b.all}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>
                      유효값이 없거나 수치 범위를 넘어 분포를 표시할 수
                      없습니다.
                    </p>
                  )}
                </details>
              ))}
              <h3>속성별 군집 특징 · 선택한 전체 행 기준</h3>
              <p>
                관측값은 추가 결측 대체 전 값입니다. 수치 표준편차는 표본
                기준(n−1). 범주 빈도 비율은 선택 행 전체를 분모로 사용합니다.
              </p>
              <div className="table-scroll">
                <table className="cluster-table">
                  <thead>
                    <tr>
                      <th>속성</th>
                      <th>선택 군집/영역 관측값</th>
                      <th>전체 입력 관측값</th>
                      <th>선택 행 분석 공간 (대체·정규화 후)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map((a) => (
                      <tr key={a.id}>
                        <th>{a.name}</th>
                        <td>
                          <Statistics
                            stat={detail.statistics[a.id]}
                            total={detail.matched}
                          />
                        </td>
                        <td>
                          <Statistics
                            stat={detail.overall[a.id]}
                            total={detail.total}
                          />
                        </td>
                        <td>
                          <Statistics
                            stat={detail.analysisStatistics[a.id]}
                            total={detail.matched}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
function Statistics({
  stat,
  total,
}: {
  stat?: ColumnStatistics;
  total: number;
}) {
  if (!stat) return <>계산 속성 아님</>;
  const v = stat.numeric;
  return (
    <>
      <small>
        결측 {stat.missing} · 고유 {stat.unique}
      </small>
      {v ? (
        <span>
          유효 {v.valid} · 평균 {n(v.mean)} · 중앙값 {n(v.median)} · 최소{" "}
          {n(v.min)} · 최대 {n(v.max)} · 표준편차 {n(v.stddev)}
        </span>
      ) : stat.frequencies ? (
        <details>
          <summary>값별 빈도 {stat.frequencies.length}개</summary>
          {stat.frequencies.map((v, i) => (
            <p key={i}>
              {String(v.value)}: {v.count} (
              {n(total ? (v.count / total) * 100 : 0)}%)
            </p>
          ))}
        </details>
      ) : (
        <span>의미 유형에 따라 수치 통계 제외</span>
      )}
    </>
  );
}

export function usePointExperiment(c: ClusteringControl) {
  const [points, setPoints] = useState<{ id: string; x: number; y: number }[]>(
      [],
    ),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const update = (value: typeof points) => {
    setPoints(value);
    setDirty(true);
    setError("");
  };
  const save = () => {
    try {
      const dataset = experimentDataset(points);
      c.dispatch({ type: "import", dataset });
      const s = defaultClustering();
      s.features = ["x", "y"];
      s.scaling = "none";
      c.dispatch({
        type: "analysis-config",
        config: clusteringConfig(
          { datasetId: dataset.id, versionId: dataset.versions[0].id },
          s,
        ),
      });
      setDirty(false);
      c.dispatch({ type: "analysis-family", family: "experiment" });
    } catch (e) {
      setError(String(e));
    }
  };
  return { points, dirty, error, update, save };
}
export function PointExperiment({
  control: c,
  experiment: e,
}: {
  control: ClusteringControl;
  experiment: ReturnType<typeof usePointExperiment>;
}) {
  const [x, setX] = useState("0"),
    [y, setY] = useState("0"),
    [selected, setSelected] = useState<string | null>(null);
  const valid =
    x.trim() !== "" &&
    y.trim() !== "" &&
    Number.isFinite(Number(x)) &&
    Number.isFinite(Number(y));
  return (
    <section className="cluster-panel">
      <h2>직접 만든 점으로 실험하기</h2>
      <p>
        2차원 좌표를 추가하거나 선택하여 수정·이동·삭제하세요. 좌표 표는
        키보드와 터치로 조작할 수 있습니다. 임시 편집은 저장 전까지 프로젝트
        자료를 바꾸지 않습니다.
      </p>
      <div className="cluster-toolbar">
        <button
          onClick={() => {
            e.update([
              { id: crypto.randomUUID(), x: 0, y: 0 },
              { id: crypto.randomUUID(), x: 1, y: 0 },
              { id: crypto.randomUUID(), x: 9, y: 0 },
              { id: crypto.randomUUID(), x: 10, y: 0 },
            ]);
            setSelected(null);
          }}
        >
          손계산용 4점 만들기
        </button>
        <button
          onClick={() => {
            e.update([]);
            setSelected(null);
          }}
        >
          현재 실험 비우기
        </button>
        {c.dataset?.source.kind === "manual" && (
          <button
            onClick={() => {
              e.update(
                c.version!.rows.map((r) => ({
                  id: r.id,
                  x: Number(r.values.x),
                  y: Number(r.values.y),
                })),
              );
              setSelected(null);
            }}
          >
            확정 좌표 가져오기
          </button>
        )}
      </div>
      <Suspense fallback={<p>좌표를 표시하는 중…</p>}>
        <Plot
          mode="experiment"
          points={e.points}
          select={(id) => {
            const p = e.points.find((p) => p.id === id)!;
            setSelected(id);
            setX(String(p.x));
            setY(String(p.y));
          }}
        />
      </Suspense>
      <div className="cluster-grid">
        <label>
          X 좌표
          <input
            aria-label="실험 X 좌표"
            type="number"
            value={x}
            onChange={(ev) => setX(ev.target.value)}
          />
        </label>
        <label>
          Y 좌표
          <input
            aria-label="실험 Y 좌표"
            type="number"
            value={y}
            onChange={(ev) => setY(ev.target.value)}
          />
        </label>
      </div>
      <div className="cluster-toolbar">
        <button
          disabled={!valid || e.points.length >= 300}
          onClick={() =>
            e.update([
              ...e.points,
              { id: crypto.randomUUID(), x: Number(x), y: Number(y) },
            ])
          }
        >
          점 추가
        </button>
        <button
          disabled={!valid || !selected}
          onClick={() =>
            e.update(
              e.points.map((p) =>
                p.id === selected ? { ...p, x: Number(x), y: Number(y) } : p,
              ),
            )
          }
        >
          선택 점 좌표 수정
        </button>
        <button
          disabled={!selected}
          onClick={() => {
            e.update(e.points.filter((p) => p.id !== selected));
            setSelected(null);
          }}
        >
          선택 점 삭제
        </button>
        <button
          disabled={!e.points.length || !e.dirty}
          className="primary-button"
          onClick={e.save}
        >
          좌표를 새 자료로 확정 저장
        </button>
      </div>
      {e.error && <p role="alert">{e.error}</p>}
      <p>
        {e.dirty
          ? "미확정 좌표 편집 있음 · 이전 결과는 변경 전 확정 자료의 결과입니다. 새 자료로 저장한 뒤 다시 실행하세요."
          : "좌표 편집 없음"}{" "}
        · {e.points.length}/300점
      </p>
      <div className="table-scroll">
        <table className="cluster-table">
          <thead>
            <tr>
              <th>점 선택</th>
              <th>X</th>
              <th>Y</th>
            </tr>
          </thead>
          <tbody>
            {e.points.map((p, i) => (
              <tr key={p.id}>
                <td>
                  <button
                    aria-pressed={selected === p.id}
                    onClick={() => {
                      setSelected(p.id);
                      setX(String(p.x));
                      setY(String(p.y));
                    }}
                  >
                    점 {i + 1}
                  </button>
                </td>
                <td>{p.x}</td>
                <td>{p.y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        확정 저장은 원본·버전·작업 기록을 가진 별도 수동 자료를 만듭니다. 이전
        자료와 결과도 보존됩니다. 저장 후 오른쪽에서 k·초기 중심·seed를 정하고
        같은 군집 엔진으로 실행하세요.
      </p>
      <ClusteringPanel control={c} />
    </section>
  );
}
