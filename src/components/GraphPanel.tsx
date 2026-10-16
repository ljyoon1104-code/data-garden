import {
  useCallback,
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
} from "react";
import type { ComponentProps } from "react";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import { getSelection } from "../state/workspace";
import type { DeepReadonly, GraphConfig, TableData } from "../domain/types";
import type {
  GraphKind,
  GraphMark,
  GraphQuery,
  GraphResult,
  GraphRows,
  GraphSettings,
} from "../domain/graph-types";
import {
  aggregateLabels,
  graphLabels,
  graphScope,
  newGraph,
  normalizedGraph,
} from "../domain/graphs";
import { defaultTableView } from "../domain/table";
import { useTask } from "../workers/useTask";
import { ErrorNotice, TaskStatus } from "./DataControls";
import type { GraphCanvas as CanvasComponent } from "./GraphCanvas";
const LazyGraphCanvas = lazy(() =>
  import("./GraphCanvas").then((module) => ({ default: module.GraphCanvas })),
);
function GraphCanvas(props: ComponentProps<typeof CanvasComponent>) {
  return (
    <Suspense
      fallback={<p role="status">기기에 포함된 그래프 화면을 준비하는 중…</p>}
    >
      <LazyGraphCanvas {...props} />
    </Suspense>
  );
}

const valueText = (v: unknown) =>
  v === null
    ? "계산 불가 / 결측"
    : typeof v === "number"
      ? Number(v.toPrecision(8)).toLocaleString("ko-KR", {
          maximumSignificantDigits: 8,
        })
      : String(v);
export function useGraphs(
  state: WorkspaceState,
  dispatch: (a: WorkspaceAction) => void,
) {
  const { dataset, version } = getSelection(state);
  const [draft, setDraft] = useState<GraphConfig | null>(
    () =>
      state.project.graphs.find((g) => g.id === state.view.currentGraphId) ||
      null,
  );
  const [dirty, setDirty] = useState(false);
  const task = useTask("graph-current");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queued, setQueued] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const cancelCalculation = () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setQueued(false);
    setCancelled(true);
    task.cancel();
  };
  const [calculated, setCalculated] = useState<{
    key: string;
    result: GraphResult;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const table = state.project.datasets
    .find((d) => d.id === draft?.source.datasetId)
    ?.versions.find((v) => v.id === draft?.source.versionId);
  const queryKey = JSON.stringify(draft);
  const result = calculated?.key === queryKey ? calculated.result : null;
  useEffect(() => {
    task.cancel();
    setQueued(false);
    setCalculated(null);
    if (!draft?.visual || !table) return;
    setQueued(true);
    setCancelled(false);
    const timer = setTimeout(() => {
      timerRef.current = null;
      setQueued(false);
      task.run(
        {
          kind: "graph-calculate",
          table: { columns: table.columns, rows: table.rows },
          graph: draft,
        },
        (response) => {
          if (response.kind === "graph-calculate")
            setCalculated({ key: queryKey, result: response.result });
        },
      );
    }, 300);
    timerRef.current = timer;
    return () => {
      clearTimeout(timer);
      task.cancel();
    };
  }, [queryKey, table, attempt, task.run, task.cancel]);
  const change = (patch: Partial<GraphSettings>, kind?: GraphKind) => {
    task.cancel();
    setCalculated(null);
    setDirty(true);
    setDraft((g) =>
      g?.visual
        ? {
            ...g,
            kind: kind || g.kind,
            visual: {
              ...g.visual,
              ...patch,
              boundaries: [],
              updatedAt: new Date().toISOString(),
            },
          }
        : g,
    );
  };
  const create = () => {
    if (!version || !dataset) return;
    task.cancel();
    setDraft(
      newGraph(version, { datasetId: dataset.id, versionId: version.id }),
    );
    setDirty(true);
    dispatch({ type: "graph-select", id: null });
  };
  const open = (id: string) => {
    task.cancel();
    setDraft(state.project.graphs.find((g) => g.id === id) || null);
    setDirty(false);
    dispatch({ type: "graph-select", id: id || null });
  };
  const save = () => {
    if (!draft?.visual || !result) return;
    const g = normalizedGraph({
      ...draft,
      visual: {
        ...draft.visual,
        boundaries: result.boundaries,
        updatedAt: new Date().toISOString(),
      },
    });
    dispatch({ type: "graph-save", graph: g });
    setDraft(g);
    setDirty(false);
  };
  const clone = (current = false) => {
    if (!draft) return;
    const target = state.project.datasets.find(
        (d) => d.id === draft.source.datasetId,
      ),
      v = target?.versions.find(
        (v) =>
          v.id ===
          (current
            ? state.project.activeVersions[target.id]
            : draft.source.versionId),
      );
    if (!v) return;
    const fresh = newGraph(v, { datasetId: v.datasetId, versionId: v.id }),
      now = new Date().toISOString();
    const g = draft.visual
      ? {
          ...structuredClone(draft),
          id: fresh.id,
          source: fresh.source,
          visual: {
            ...structuredClone(draft.visual),
            name: draft.visual.name + " (복제)",
            createdAt: now,
            updatedAt: now,
            boundaries: current ? [] : draft.visual.boundaries,
            scope: current
              ? {
                  kind: "all" as const,
                  filter: null,
                  duplicatesOnly: false,
                  rowIds: [],
                }
              : draft.visual.scope,
          },
        }
      : fresh;
    task.cancel();
    setDraft(g);
    setDirty(true);
    dispatch({ type: "graph-select", id: null });
  };
  const remove = () => {
    if (!draft) return;
    task.cancel();
    dispatch({ type: "graph-delete", id: draft.id });
    setDraft(null);
    setCalculated(null);
    setDirty(false);
  };
  const setScope = (kind: GraphSettings["scope"]["kind"]) => {
    if (!draft) return;
    const view =
      state.view.tables[draft.source.datasetId] || defaultTableView();
    change({ scope: graphScope(view, kind) });
  };
  return {
    state,
    dispatch,
    draft,
    dirty,
    table,
    result,
    task: {
      ...task,
      busy: task.busy || queued,
      message: queued
        ? "계산 요청을 모으는 중…"
        : cancelled
          ? "계산이 취소되었습니다. 다시 계산을 눌러 재개하세요."
          : task.message,
      cancel: cancelCalculation,
    },
    change,
    create,
    open,
    save,
    clone,
    remove,
    setScope,
    retry: () => setAttempt((n) => n + 1),
    discard: () => {
      task.cancel();
      setDraft(
        state.project.graphs.find((g) => g.id === state.view.currentGraphId) ||
          null,
      );
      setDirty(false);
    },
  };
}
type Control = ReturnType<typeof useGraphs>;
export function GraphSettingsPanel({ control: c }: { control: Control }) {
  const g = c.draft,
    s = g?.visual,
    t = c.table;
  if (!g || !s || !t)
    return (
      <section>
        <p>그래프를 만들거나 저장 목록에서 여세요.</p>
        {g && !s && (
          <p>
            과거 그래프에 필수 설정이 없습니다. ‘설정 보완’으로 새 그래프를
            만드세요.
          </p>
        )}
      </section>
    );
  const patch = c.change;
  const selectColumn = (
    label: string,
    field: "x" | "y" | "group" | "value",
    optional = false,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={s[field]}
        onChange={(e) => patch({ [field]: e.target.value })}
      >
        {optional && <option value="">사용 안 함</option>}
        {t.columns.map((col) => (
          <option key={col.id} value={col.id}>
            {col.name} ·{" "}
            {col.semanticType === "numeric"
              ? "수치"
              : col.semanticType === "date"
                ? "날짜"
                : col.semanticType === "identifier"
                  ? "식별자"
                  : col.semanticType === "categorical"
                    ? "범주"
                    : "텍스트"}
          </option>
        ))}
      </select>
    </label>
  );
  const changeKind = (kind: GraphKind) => {
    const numeric = t.columns.filter(
        (col) => col.storageType === "number" && col.semanticType === "numeric",
      ),
      cat = t.columns.filter(
        (col) => col.semanticType !== "numeric" && col.semanticType !== "date",
      ),
      date = t.columns.find((col) => col.semanticType === "date");
    const x = ["bar", "pie", "heatmap"].includes(kind)
      ? cat[0]?.id || s.x
      : ["line", "area"].includes(kind)
        ? date?.id || numeric[0]?.id || s.x
        : numeric[0]?.id || s.x;
    patch(
      {
        x,
        y:
          kind === "heatmap"
            ? cat[1]?.id || cat[0]?.id || s.y
            : numeric[1]?.id || numeric[0]?.id || s.y,
        value: numeric[0]?.id || s.value,
        group: kind === "area" ? cat[0]?.id || "" : "",
        aggregate: ["line", "area"].includes(kind) ? "mean" : "rows",
        ratio: false,
        xRange: null,
        yRange: null,
      },
      kind,
    );
  };
  const aggregate =
    ["bar", "line", "pie", "area"].includes(g.kind) ||
    (g.kind === "heatmap" && s.heatmap === "cross");
  return (
    <section className="graph-settings" id="graph-settings">
      <h3>그래프 설정</h3>
      <label>
        그래프 이름
        <input
          value={s.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>
      <label>
        그래프 종류
        <select
          value={g.kind}
          onChange={(e) => changeKind(e.target.value as GraphKind)}
        >
          {Object.entries(graphLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        자료 범위
        <select
          value={s.scope.kind}
          onChange={(e) =>
            c.setScope(e.target.value as GraphSettings["scope"]["kind"])
          }
        >
          <option value="all">전체 자료</option>
          <option value="filtered">표 필터 조건에 맞는 자료</option>
          <option value="selected">선택한 행</option>
        </select>
      </label>
      <small>
        범위 조건은 이 그래프의 사본입니다. 표 변경 후 갱신하려면 아래 버튼을
        누르세요.
      </small>
      <button onClick={() => c.setScope(s.scope.kind)}>
        현재 표 조건 다시 가져오기
      </button>
      {s.scope.kind === "selected" && (
        <p>선택 사본 {s.scope.rowIds.length}행</p>
      )}
      {s.scope.kind === "filtered" && (
        <p>
          필터:{" "}
          {s.scope.filter
            ? `${t.columns.find((col) => col.id === s.scope.filter?.attributeId)?.name} / ${s.scope.filter.operator} / ${s.scope.filter.value}`
            : "없음"}{" "}
          · 중복만 {s.scope.duplicatesOnly ? "예" : "아니오"}
        </p>
      )}
      {g.kind === "heatmap" && (
        <label>
          히트맵 용도
          <select
            value={s.heatmap}
            onChange={(e) =>
              patch({ heatmap: e.target.value as GraphSettings["heatmap"] })
            }
          >
            <option value="cross">범주 교차</option>
            <option value="correlation">Pearson 상관</option>
          </select>
        </label>
      )}
      {g.kind === "heatmap" && s.heatmap === "correlation" ? (
        <fieldset>
          <legend>상관 수치 속성 (2~20개)</legend>
          {t.columns
            .filter(
              (col) =>
                col.storageType === "number" && col.semanticType === "numeric",
            )
            .map((col) => (
              <label key={col.id}>
                <input
                  type="checkbox"
                  checked={s.correlationIds.includes(col.id)}
                  onChange={(e) =>
                    patch({
                      correlationIds: e.target.checked
                        ? [...s.correlationIds, col.id]
                        : s.correlationIds.filter((id) => id !== col.id),
                    })
                  }
                />
                {col.name}
              </label>
            ))}
        </fieldset>
      ) : (
        <>
          {selectColumn(
            ["histogram", "box"].includes(g.kind)
              ? "대상 수치 속성"
              : "X축 속성",
            "x",
          )}
          {(g.kind === "scatter" || g.kind === "heatmap") &&
            selectColumn("Y축 속성", "y")}
          {g.kind !== "heatmap" &&
            g.kind !== "pie" &&
            selectColumn("집단 속성", "group", true)}
          {aggregate && (
            <>
              <label>
                집계 방법
                <select
                  value={s.aggregate}
                  onChange={(e) =>
                    patch({
                      aggregate: e.target.value as GraphSettings["aggregate"],
                    })
                  }
                >
                  {Object.entries(aggregateLabels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {s.aggregate !== "rows" &&
                selectColumn("집계 수치 속성", "value")}
            </>
          )}
        </>
      )}
      {g.kind === "histogram" && (
        <>
          <label>
            구간 기준
            <select
              value={s.binMode}
              onChange={(e) =>
                patch({ binMode: e.target.value as "count" | "width" })
              }
            >
              <option value="count">구간 수</option>
              <option value="width">구간 폭</option>
            </select>
          </label>
          <label>
            {s.binMode === "count" ? "구간 수" : "구간 폭"}
            <input
              type="number"
              min="0.000001"
              value={s.binMode === "count" ? s.binCount : s.binWidth}
              onChange={(e) =>
                patch(
                  s.binMode === "count"
                    ? { binCount: Number(e.target.value) }
                    : { binWidth: Number(e.target.value) },
                )
              }
            />
          </label>
          <label>
            세로 표시
            <select
              value={s.ratio ? "ratio" : "count"}
              onChange={(e) => patch({ ratio: e.target.value === "ratio" })}
            >
              <option value="count">빈도</option>
              <option value="ratio">집단 내 유효값 대비 비율</option>
            </select>
          </label>
        </>
      )}
      {s.group && (
        <label>
          집단 비교
          <select
            value={s.layout}
            onChange={(e) =>
              patch({ layout: e.target.value as "color" | "facets" })
            }
          >
            <option value="color">색상·기호로 함께 보기</option>
            <option value="facets">공통 축으로 나누어 보기</option>
          </select>
        </label>
      )}
      {g.kind === "bar" && (
        <label>
          <input
            type="checkbox"
            checked={s.stacked}
            onChange={(e) => patch({ stacked: e.target.checked })}
          />
          누적 막대
        </label>
      )}
      <details>
        <summary>고급 설정 · 순서·범위·표본</summary>
        <label>
          범주 순서
          <select
            value={s.order}
            onChange={(e) =>
              patch({ order: e.target.value as GraphSettings["order"] })
            }
          >
            <option value="source">자료에 나온 순서</option>
            <option value="ascending">오름차순</option>
            <option value="descending">내림차순</option>
          </select>
        </label>
        {g.kind === "line" && (
          <label>
            <input
              type="checkbox"
              checked={s.categoricalOrderConfirmed}
              onChange={(e) =>
                patch({ categoricalOrderConfirmed: e.target.checked })
              }
            />
            범주형 X축의 위 연결 순서를 확인했습니다
          </label>
        )}
        {["line", "area"].includes(g.kind) && (
          <label>
            <input
              type="checkbox"
              checked={s.fillAbsent}
              onChange={(e) => patch({ fillAbsent: e.target.checked })}
            />
            없는 X·집단 조합을 명시적으로 0으로 표시 (실제 결측 제외)
          </label>
        )}
        <label>
          표시 시작 범주 (1부터)
          <input
            type="number"
            min="1"
            value={s.categoryStart + 1}
            onChange={(e) =>
              patch({ categoryStart: Number(e.target.value) - 1 })
            }
          />
        </label>
        <label>
          표시 범주 수 (최대 100)
          <input
            type="number"
            min="1"
            max="100"
            value={s.categoryLimit}
            onChange={(e) => patch({ categoryLimit: Number(e.target.value) })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={s.categoryRangeConfirmed}
            onChange={(e) =>
              patch({ categoryRangeConfirmed: e.target.checked })
            }
          />
          나머지 범주는 표시에서 제외하며 기타로 합치지 않음을 확인
        </label>
        {(["xTitle", "yTitle", "unit"] as const).map((k, i) => (
          <label key={k}>
            {["X축 이름", "Y축 이름", "단위"][i]}
            <input
              value={s[k]}
              onChange={(e) => patch({ [k]: e.target.value })}
            />
          </label>
        ))}
        {(["xRange", "yRange"] as const)
          .filter((k) =>
            k === "xRange"
              ? ["scatter", "line", "area"].includes(g.kind)
              : !["pie", "heatmap"].includes(g.kind),
          )
          .map((k, i) => (
            <fieldset key={k}>
              <legend>{i ? "Y" : "X"}축 범위</legend>
              <label>
                <input
                  type="checkbox"
                  checked={s[k] !== null}
                  onChange={(e) =>
                    patch({ [k]: e.target.checked ? [0, 100] : null })
                  }
                />
                직접 지정
              </label>
              {s[k] &&
                [0, 1].map((j) => (
                  <label key={j}>
                    {j ? "최댓값" : "최솟값"}
                    <input
                      type="number"
                      aria-label={`${i ? "Y" : "X"}축 ${j ? "최댓값" : "최솟값"}`}
                      value={s[k]![j]}
                      onChange={(e) => {
                        const range = [...s[k]!] as [number, number];
                        range[j] = Number(e.target.value);
                        patch({ [k]: range });
                      }}
                    />
                  </label>
                ))}
            </fieldset>
          ))}
        <label>
          점 표시 최대 수 (1~5000)
          <input
            type="number"
            value={s.sampling.limit}
            onChange={(e) =>
              patch({
                sampling: { ...s.sampling, limit: Number(e.target.value) },
              })
            }
          />
        </label>
        <label>
          표본 난수 seed
          <input
            type="number"
            value={s.sampling.seed}
            onChange={(e) =>
              patch({
                sampling: { ...s.sampling, seed: Number(e.target.value) },
              })
            }
          />
        </label>
        <p>
          범위를 넘는 점은 재현 가능한 reservoir 표본으로 표시합니다. 집계와
          원자료 조회는 전체 범위 기준입니다.
        </p>
      </details>
      <TaskStatus {...c.task} />
      <ErrorNotice error={c.task.error} />
      <button onClick={c.retry}>다시 계산</button>
    </section>
  );
}

function GraphDetail({
  graph,
  result,
  table,
}: {
  graph: GraphConfig;
  result: GraphResult;
  table: DeepReadonly<TableData>;
}) {
  const [page, setPage] = useState(0),
    [facetPage, setFacetPage] = useState(0),
    [selection, setSelection] = useState<{
      query: GraphQuery;
      label: string;
      detail: string;
    } | null>(null),
    [raw, setRaw] = useState<GraphRows | null>(null);
  const [region, setRegion] = useState({
    xMin: result.xRange[0],
    xMax: result.xRange[1],
    yMin: result.yRange[0],
    yMax: result.yRange[1],
  });
  const task = useTask("graph-source-" + graph.id);
  const select = useCallback((mark: GraphMark) => {
    setSelection({ query: mark.query, label: mark.label, detail: mark.detail });
    setRaw(null);
  }, []);
  const fetchRows = (p: number) => {
    if (!selection) return;
    task.run(
      {
        kind: "graph-rows",
        table: { columns: table.columns, rows: table.rows },
        graph,
        query: selection.query,
        page: p,
      },
      (r) => {
        if (r.kind === "graph-rows") setRaw(r.result);
      },
    );
  };
  useEffect(() => {
    if (selection) {
      task.run(
        {
          kind: "graph-rows",
          table: { columns: table.columns, rows: table.rows },
          graph,
          query: selection.query,
          page: 0,
        },
        (r) => {
          if (r.kind === "graph-rows") setRaw(r.result);
        },
      );
    }
    return () => task.cancel();
  }, [selection, graph, table, task.run, task.cancel]);
  const facets =
    graph.visual?.layout === "facets" &&
    !!graph.visual.group &&
    graph.kind !== "heatmap" &&
    graph.kind !== "pie";
  const marks = result.marks.slice(page * 25, page * 25 + 25);
  return (
    <div className="graph-detail">
      <p className="graph-counts">
        전체 {result.total.toLocaleString()}행 · 범위{" "}
        {result.scoped.toLocaleString()}행 · 사용 {result.used.toLocaleString()}
        행 · 결측/불가 제외 {result.excluded.toLocaleString()}행 · 표시 대상{" "}
        {result.displayed.toLocaleString()}행
      </p>
      {result.sampled && (
        <p className="scope-notice">
          점 표본 {result.sampleCount.toLocaleString()}개 · reservoir · seed{" "}
          {graph.visual!.sampling.seed} · 집계는 전체 범위
        </p>
      )}
      <p>
        집계:{" "}
        {graph.kind === "scatter"
          ? "실제 좌표"
          : graph.kind === "box"
            ? "사분위수·수염"
            : graph.kind === "histogram"
              ? graph.visual!.ratio
                ? "집단 내 비율"
                : "빈도"
              : graph.kind === "heatmap" &&
                  graph.visual!.heatmap === "correlation"
                ? "Pearson 상관"
                : aggregateLabels[graph.visual!.aggregate]}{" "}
        · 범위:{" "}
        {graph.visual!.scope.kind === "all"
          ? "전체"
          : graph.visual!.scope.kind === "filtered"
            ? "저장한 필터"
            : "저장한 선택 행"}{" "}
        · 계산 {result.durationMs.toFixed(1)} ms
      </p>
      {result.warnings.map((w) => (
        <p className="scope-notice" key={w}>
          {w}
        </p>
      ))}
      {facets ? (
        <>
          <div className="graph-facets">
            {result.groups.slice(facetPage * 4, facetPage * 4 + 4).map((gr) => (
              <section key={gr}>
                <h4>{gr}</h4>
                <GraphCanvas
                  graph={graph}
                  result={result}
                  table={table}
                  select={select}
                  group={gr}
                />
              </section>
            ))}
          </div>
          <Page
            page={facetPage}
            total={result.groups.length}
            size={4}
            change={setFacetPage}
          />
        </>
      ) : (
        <GraphCanvas
          graph={graph}
          result={result}
          table={table}
          select={select}
        />
      )}
      <p>
        그래프를 누르거나 아래 ‘자료 보기’로 실제 값을 확인하세요. 색상 외에
        범례 이름·기호·선 모양을 제공합니다. 결측은 null과 빈 문자열이며 0·NA는
        결측이 아닙니다.
      </p>
      {graph.kind === "scatter" && (
        <details>
          <summary>산점도 영역으로 행 선택</summary>
          <div className="graph-region">
            {(Object.keys(region) as (keyof typeof region)[]).map((k, i) => (
              <label key={k}>
                {["X 최솟값", "X 최댓값", "Y 최솟값", "Y 최댓값"][i]}
                <input
                  type="number"
                  value={region[k]}
                  onChange={(e) =>
                    setRegion({ ...region, [k]: Number(e.target.value) })
                  }
                />
              </label>
            ))}
          </div>
          <button
            disabled={
              !Object.values(region).every(Number.isFinite) ||
              region.xMin > region.xMax ||
              region.yMin > region.yMax
            }
            onClick={() => {
              setRaw(null);
              setSelection({
                label: "선택 영역 (양끝 포함)",
                detail: "표본과 무관하게 전체 범위의 실제 X·Y 값으로 조회",
                query: {
                  region: { ...region, x: graph.visual!.x, y: graph.visual!.y },
                },
              });
            }}
          >
            영역의 모든 행 보기
          </button>
        </details>
      )}
      <details>
        <summary>집단별 요약 · 전체 범위 기준</summary>
        <p>
          수치 요약 대상:{" "}
          {
            table.columns.find(
              (c) =>
                c.id ===
                (["scatter", "histogram", "box"].includes(graph.kind)
                  ? graph.visual!.x
                  : graph.visual!.value),
            )?.name
          }{" "}
          (숫자 저장형·수치 의미만 계산)
        </p>
        <div className="graph-table">
          <table>
            <thead>
              <tr>
                <th>집단</th>
                <th>행 수</th>
                <th>유효 수치</th>
                <th>평균</th>
                <th>중앙값</th>
              </tr>
            </thead>
            <tbody>
              {result.summaries.map((s) => (
                <tr key={s.group}>
                  <th>{s.group}</th>
                  <td>{s.rows}</td>
                  <td>{s.valid}</td>
                  <td>{valueText(s.mean)}</td>
                  <td>{valueText(s.median)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {result.boundaries.length > 0 && (
        <p>실제 공통 경계: {result.boundaries.join(" / ")}</p>
      )}
      <h4>그래프 값과 계산 근거</h4>
      <div className="graph-table">
        <table>
          <thead>
            <tr>
              <th>범주 / 좌표</th>
              <th>집단</th>
              <th>표시값</th>
              <th>행 수</th>
              <th>기준·구성비</th>
              <th>원자료</th>
            </tr>
          </thead>
          <tbody>
            {marks.map((m) => (
              <tr key={m.id}>
                <th>{m.label}</th>
                <td>{m.group}</td>
                <td>{valueText(m.y)}</td>
                <td>{m.count}</td>
                <td>
                  {m.detail}
                  {m.ratio !== undefined &&
                    ` · ${(m.ratio * 100).toFixed(2)}% (분모 ${m.denominator})`}
                </td>
                <td>
                  <button
                    onClick={() => select(m)}
                    aria-label={`${m.label} 자료 보기`}
                  >
                    자료 보기
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Page
        page={page}
        total={result.marks.length}
        size={25}
        change={setPage}
      />
      {graph.kind === "area" && (
        <details>
          <summary>시점별 표시 집단 합계</summary>
          <div className="graph-table">
            <table>
              <tbody>
                {result.totals.map(({ x, value: total }, i) => {
                  return (
                    <tr key={i}>
                      <th>{String(x)}</th>
                      <td>{valueText(total)}</td>
                      <td>
                        {total === null
                          ? "집단 공백 포함으로 전체 합계 계산 불가"
                          : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {selection && (
        <section className="graph-source">
          <h4>{selection.label} · 당시 입력 자료</h4>
          <p>{selection.detail}</p>
          <p>
            읽기 전용 · 버전 {graph.source.versionId} · 현재 자료 버전은 바뀌지
            않습니다.
          </p>
          <TaskStatus {...task} />
          <ErrorNotice error={task.error} />
          {raw && (
            <>
              <p>
                해당 {raw.total}행 · 현재 페이지 {raw.rows.length}행
              </p>
              <div className="graph-table">
                <table>
                  <thead>
                    <tr>
                      <th>행 ID</th>
                      {table.columns.map((c) => (
                        <th key={c.id}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {raw.rows.map((r) => (
                      <tr key={r.id}>
                        <th>{r.id}</th>
                        {table.columns.map((c) => (
                          <td key={c.id}>
                            {r.values[c.id] === null
                              ? "(결측)"
                              : String(r.values[c.id])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Page
                page={raw.page}
                total={raw.total}
                size={25}
                change={fetchRows}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}
function Page({
  page,
  total,
  size,
  change,
}: {
  page: number;
  total: number;
  size: number;
  change: (p: number) => void;
}) {
  return (
    <div className="graph-pages">
      <button disabled={page === 0} onClick={() => change(page - 1)}>
        이전
      </button>
      <span>
        {total
          ? `${page * size + 1}~${Math.min(total, (page + 1) * size)} / ${total}`
          : "0개"}
      </span>
      <button
        disabled={(page + 1) * size >= total}
        onClick={() => change(page + 1)}
      >
        다음
      </button>
    </div>
  );
}
function Comparison({
  graph,
  table,
}: {
  graph: GraphConfig;
  table: DeepReadonly<TableData>;
}) {
  const task = useTask("graph-comparison"),
    [result, setResult] = useState<GraphResult | null>(null);
  useEffect(() => {
    setResult(null);
    if (graph.visual)
      task.run(
        {
          kind: "graph-calculate",
          table: { columns: table.columns, rows: table.rows },
          graph,
        },
        (r) => {
          if (r.kind === "graph-calculate") setResult(r.result);
        },
      );
    return () => task.cancel();
  }, [graph, table, task.run, task.cancel]);
  return (
    <section className="graph-card">
      <h3>{graph.visual?.name || "설정 보완 필요"} · 비교</h3>
      <p>자료 버전 {graph.source.versionId}</p>
      <TaskStatus {...task} />
      <ErrorNotice error={task.error} />
      {result && <GraphDetail graph={graph} result={result} table={table} />}
    </section>
  );
}
export function GraphPanel({ control: c, writable=true }: { control: Control; writable?:boolean }) {
  const g = c.draft,
    s = g?.visual,
    comparison = c.state.project.graphs.find(
      (g) => g.id === c.state.view.comparisonGraphId,
    ),
    comparisonTable = c.state.project.datasets
      .find((d) => d.id === comparison?.source.datasetId)
      ?.versions.find((v) => v.id === comparison?.source.versionId);
  const stale =
    g &&
    c.state.project.activeVersions[g.source.datasetId] !== g.source.versionId;
  return (
    <section className="graphs-panel">
      <div className="graph-toolbar">
        <button disabled={!writable} className="primary-button" onClick={c.create}>
          그래프 만들기
        </button>
        <label>
          저장한 그래프
          <select
            value={c.state.view.currentGraphId || ""}
            onChange={(e) => c.open(e.target.value)}
          >
            <option value="">저장 목록에서 선택</option>
            {c.state.project.graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.visual?.name || "설정 보완 필요"} · {graphLabels[g.kind]}
              </option>
            ))}
          </select>
        </label>
        <label>
          나란히 비교
          <select
            value={c.state.view.comparisonGraphId || ""}
            onChange={(e) =>
              c.dispatch({
                type: "graph-select",
                id: e.target.value || null,
                comparison: true,
              })
            }
          >
            <option value="">비교 안 함</option>
            {c.state.project.graphs.map((g) => (
              <option key={g.id} value={g.id}>
                {g.visual?.name || "설정 보완 필요"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {g ? (
        <>
          <div className="graph-toolbar">
            <button disabled={!writable || !s || !c.result || c.task.busy} onClick={c.save}>
              그래프 저장
            </button>
            <button disabled={!writable} onClick={() => c.clone(false)}>
              {s ? "그래프 복제" : "설정 보완"}
            </button>
            <button
              disabled={
                !writable || !c.state.project.graphs.some((saved) => saved.id === g.id)
              }
              onClick={c.remove}
            >
              그래프 삭제
            </button>
            <button onClick={c.discard}>편집 취소</button>
            <button
              onClick={() =>
                document
                  .getElementById("graph-settings")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              그래프 설정으로 이동
            </button>
            <span>{c.dirty ? "저장하지 않은 그래프 설정" : "저장한 설정"}</span>
          </div>
          {stale && (
            <div className="scope-notice">
              <strong>자료 버전 변경</strong>
              <p>
                이 그래프는 당시 버전을 유지합니다. 새 버전으로 복제하면 자료
                범위를 전체로 초기화하며 과거 그래프는 보존합니다.
              </p>
              <button disabled={!writable} onClick={() => c.clone(true)}>
                현재 자료 버전으로 복제하여 다시 그리기
              </button>
            </div>
          )}
          <div className={comparison ? "graph-compare" : ""}>
            <section className="graph-card">
              <h2>{s?.name || "설정 보완 필요"}</h2>
              <p>
                {
                  c.state.project.datasets.find(
                    (d) => d.id === g.source.datasetId,
                  )?.name
                }{" "}
                · 버전 {g.source.versionId}
              </p>
              <TaskStatus {...c.task} />
              <ErrorNotice error={c.task.error} />
              {!s && (
                <p>
                  이전 단계의 그래프 자리에는 필수 설정이 없습니다. 설정
                  보완으로 새 그래프를 만드세요.
                </p>
              )}
              {s && !c.result && !c.task.error && (
                <p>
                  현재 조건의 결과를 준비합니다. 계산을 취소했다면 ‘다시 계산’을
                  누르세요.
                </p>
              )}
              {c.result && c.table && (
                <GraphDetail
                  key={JSON.stringify(g)}
                  graph={g}
                  result={c.result}
                  table={c.table}
                />
              )}
            </section>
            {comparison && comparisonTable && (
              <Comparison
                key={comparison.id}
                graph={comparison}
                table={comparisonTable}
              />
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <h2>표에서 그래프로 질문을 넓혀 보세요</h2>
          <p>
            그래프 만들기에서 자료 범위와 속성을 선택하세요. 그래프 설정은 자료
            편집 이력과 별도로 저장됩니다.
          </p>
        </div>
      )}
    </section>
  );
}
