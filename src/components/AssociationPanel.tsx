import { useEffect, useMemo, useState } from "react";
import type { AssociationControl } from "./useAssociation";
import type {
  AssociationSettings,
  AssociationTransactions,
  AssociationView,
  AssociationDetail,
  AssociationResult,
  AssociationItem,
} from "../domain/association-types";
import type { AnalysisRecord, Cell } from "../domain/types";
import {
  compareAssociations,
  defaultAssociationView,
  percentFraction,
  supportCount,
} from "../domain/association";
import { getResultFreshness } from "../domain/model";
import { resolveVersion } from "../domain/processing";
import { useTask } from "../workers/useTask";
import { ErrorNotice, TaskStatus } from "./DataControls";

const number = (v: number) =>
  v.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
const status = {
  pending: "준비",
  running: "계산 중",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
};
const formats = {
  list: "한 행의 항목 목록",
  vertical: "거래 ID·항목의 세로 자료",
  binary: "항목별 선택 여부 표",
  category: "범주 속성 표",
};
const displayItem = (i: AssociationItem) => i.label + ' [' + ({string:'문자열',number:'숫자',boolean:'불리언'}[i.valueType]) + ']';
const namedItems = (items: AssociationItem[]) => new Map(items.map((item,index)=>[item.id, items.some(other=>other.id!==item.id&&other.label===item.label) ? displayItem(item)+' · 항목 '+(index+1) : displayItem(item)]));
function Pager({
  page,
  total,
  set,
  label,
}: {
  page: number;
  total: number;
  set: (n: number) => void;
  label: string;
}) {
  return (
    <div className="table-pagination">
      <button
        disabled={page === 0}
        onClick={() => set(page - 1)}
        aria-label={`${label} 이전 페이지`}
      >
        이전
      </button>
      <span>
        {page + 1} / {Math.max(1, Math.ceil(total / 25))}쪽 · {total}개
      </span>
      <button
        disabled={(page + 1) * 25 >= total}
        onClick={() => set(page + 1)}
        aria-label={`${label} 다음 페이지`}
      >
        다음
      </button>
    </div>
  );
}
function DecimalField({
  label,
  value,
  positive,
  set,
  invalidate,
}: {
  label: string;
  value: string;
  positive: boolean;
  set: (v: string) => void;
  invalidate: () => void;
}) {
  const [text, setText] = useState(value),
    [error, setError] = useState("");
  useEffect(() => {
    setText(value);
    setError("");
  }, [value]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          invalidate();
          try {
            percentFraction(e.target.value, positive);
            setError("");
          } catch (e) {
            setError(String(e instanceof Error ? e.message : e));
          }
        }}
      />
      <button
        onClick={() => {
          try {
            percentFraction(text, positive);
            set(text);
            setError("");
          } catch (e) {
            setError(String(e instanceof Error ? e.message : e));
          }
        }}
      >
        적용: {label}
      </button>
      {error && (
        <span role="alert" className="error-notice">
          {error}
        </span>
      )}
      <small>
        저장된 조건 {value}% · 내부 비율 {number(Number(value) / 100)}
      </small>
    </label>
  );
}
function ValuesField({
  label,
  values,
  set,
  invalidate,
}: {
  label: string;
  values: Cell[];
  set: (v: Cell[]) => void;
  invalidate: () => void;
}) {
  const [text, setText] = useState(JSON.stringify(values)),
    [error, setError] = useState("");
  useEffect(() => setText(JSON.stringify(values)), [values]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          invalidate();
        }}
      />
      <button
        onClick={() => {
          try {
            const v: unknown = JSON.parse(text);
            if (!Array.isArray(v)) throw new Error("배열을 입력하세요.");
            set(v);
            setError("");
          } catch {
            setError(
              'JSON 배열로 입력하세요. 예: [true,1,"예"]. 문자열은 큰따옴표로 구분합니다.',
            );
          }
        }}
      >
        적용: {label}
      </button>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
export function AssociationSettingsPanel({
  control: c,
}: {
  control: AssociationControl;
}) {
  const s = c.config?.association;
  if (!s || !c.version) return <p>자료를 먼저 선택하세요.</p>;
  const change = <K extends keyof AssociationSettings>(
    k: K,
    v: AssociationSettings[K],
  ) => c.patch({ [k]: v });
  return (
    <section className="association-settings">
      <h3>거래 구성과 기준</h3>
      <fieldset disabled={!c.writable}>
        <label>
          거래 형식
          <select
            aria-label="거래 형식"
            value={s.format}
            onChange={(e) =>
              c.patch({
                format: e.target.value as AssociationSettings["format"],
                columns: [],
                transactionId: "",
              })
            }
          >
            {Object.entries(formats).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {s.format === "vertical" && (
          <label>
            거래 ID 열
            <select
              aria-label="거래 ID 열"
              value={s.transactionId}
              onChange={(e) => change("transactionId", e.target.value)}
            >
              <option value="">선택하세요</option>
              {c.version.columns.map((col) => (
                <option key={col.id} value={col.id}>
                  {col.name} · {col.storageType}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>
            {s.format === "vertical" ? "항목 열 하나" : "항목으로 사용할 열"}
          </legend>
          {c.version.columns.map((col) => (
            <label className="check-label" key={col.id}>
              <input
                type="checkbox"
                checked={s.columns.includes(col.id)}
                onChange={(e) =>
                  change(
                    "columns",
                    e.target.checked
                      ? s.format === "vertical"
                        ? [col.id]
                        : [...s.columns, col.id]
                      : s.columns.filter((id) => id !== col.id),
                  )
                }
              />
              {col.name}{" "}
              <small>
                ({col.storageType} / {col.semanticType})
              </small>
            </label>
          ))}
        </fieldset>
        {s.format === "list" && (
          <>
            <label>
              목록 셀 방식
              <select
                aria-label="목록 셀 방식"
                value={s.listMode}
                onChange={(e) =>
                  change(
                    "listMode",
                    e.target.value as AssociationSettings["listMode"],
                  )
                }
              >
                <option value="delimited">셀 안의 목록을 나누기</option>
                <option value="slots">각 셀을 항목 하나로 사용</option>
              </select>
            </label>
            {s.listMode === "delimited" && (
              <>
                <label>
                  목록 내부 구분 기호
                  <input
                    aria-label="목록 내부 구분 기호"
                    value={s.delimiter}
                    maxLength={1}
                    onChange={(e) => change("delimiter", e.target.value)}
                  />
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={s.quotes}
                    onChange={(e) => change("quotes", e.target.checked)}
                  />
                  큰따옴표 처리 (내부 따옴표는 두 번)
                </label>
                <small>
                  파일 CSV 구분자와 별개입니다. 따옴표 안의 구분자·줄바꿈은
                  항목의 일부입니다.
                </small>
              </>
            )}
          </>
        )}
        {s.format === "binary" && (
          <>
            <ValuesField
              label="선택 값 대응"
              values={s.presentValues}
              set={(v) => c.patch({ presentValues: v }, "선택 값 대응")}
              invalidate={() => c.invalidatePreview("선택 값 대응")}
            />
            <ValuesField
              label="미선택 값 대응"
              values={s.absentValues}
              set={(v) => c.patch({ absentValues: v }, "미선택 값 대응")}
              invalidate={() => c.invalidatePreview("미선택 값 대응")}
            />
            <p>
              true, 1, "1"은 서로 다른 실제 유형입니다. 미선택을 별도 항목으로
              만들지 않습니다.
            </p>
          </>
        )}
        {s.format !== "binary" && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={s.trim}
                onChange={(e) => change("trim", e.target.checked)}
              />
              문자열 앞뒤 공백 제거
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={s.foldCase}
                onChange={(e) => change("foldCase", e.target.checked)}
              />
              문자열 대소문자 통합 (소문자)
            </label>
          </>
        )}
        <label>
          빈 거래 정책
          <select
            aria-label="빈 거래 정책"
            value={s.empty}
            onChange={(e) =>
              change("empty", e.target.value as AssociationSettings["empty"])
            }
          >
            <option value="include">알려진 빈 거래를 N에 포함</option>
            <option value="exclude">빈 거래를 명시적으로 제외</option>
          </select>
        </label>
        {s.format === "list" ? (
          <p>
            빈 셀·빈 목록은 알려진 빈 거래입니다. 같은 거래의 반복 항목만 하나로
            셉니다.
          </p>
        ) : (
          <label>
            결측·미등록 항목 정책
            <select
              aria-label="결측·미등록 항목 정책"
              value={s.unknown}
              onChange={(e) =>
                change(
                  "unknown",
                  e.target.value as AssociationSettings["unknown"],
                )
              }
            >
              <option value="block">분석 차단 후 값 확인</option>
              <option value="exclude">해당 거래 전체 제외</option>
              <option value="absent">명시적으로 해당 항목 없음</option>
            </select>
          </label>
        )}
        {s.format === "vertical" && (
          <>
            <label>
              결측 거래 ID 정책
              <select
                aria-label="결측 거래 ID 정책"
                value={s.missingId}
                onChange={(e) =>
                  change(
                    "missingId",
                    e.target.value as AssociationSettings["missingId"],
                  )
                }
              >
                <option value="block">분석 차단</option>
                <option value="exclude">해당 행 제외</option>
              </select>
            </label>
            <p>
              범위에 포함된 ID의 모든 행을 같은 버전에서 모아 완전한 거래로
              확장합니다. ID의 실제 유형·앞자리 0을 구분합니다.
            </p>
          </>
        )}
        {s.format === "category" && (
          <p>
            속성 ID와 실제 값의 유형을 함께 구분합니다. 연속 수치·날짜는 정리
            메뉴에서 구간화·날짜 분리를 먼저 하세요.
          </p>
        )}
        <label>
          연관 자료 범위
          <select
            aria-label="연관 자료 범위"
            value={s.scope.kind}
            onChange={(e) =>
              c.scope(e.target.value as AssociationSettings["scope"]["kind"])
            }
          >
            <option value="all">전체 행</option>
            <option value="filtered">현재 필터의 모든 행</option>
            <option value="selected">선택 행</option>
          </select>
        </label>
        <button onClick={() => c.scope(s.scope.kind)}>
          현재 표의 범위 다시 가져오기
        </button>
        <DecimalField
          label="최소 지지도 (%)"
          value={s.supportPercent}
          positive
          set={(v) => c.patch({ supportPercent: v }, "최소 지지도 (%)")}
          invalidate={() => c.invalidatePreview("최소 지지도 (%)")}
        />
        <DecimalField
          label="최소 신뢰도 (%)"
          value={s.confidencePercent}
          positive={false}
          set={(v) => c.patch({ confidencePercent: v }, "최소 신뢰도 (%)")}
          invalidate={() => c.invalidatePreview("최소 신뢰도 (%)")}
        />
        <label>
          최대 항목 집합 길이
          <select
            aria-label="최대 항목 집합 길이"
            value={s.maxLength}
            onChange={(e) => change("maxLength", Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <small>
          지정 길이까지만 완전 탐색합니다. 길이 4부터 양쪽 복합 규칙을 확인할 수
          있습니다.
        </small>
        <button onClick={c.previewRun} disabled={c.busy || c.hasDraft}>
          거래 미리보기
        </button>
      </fieldset>
      {c.hasDraft && (
        <p role="status">
          입력한 조건의 적용 버튼을 눌러 확정하세요. 미확정 값으로 실행하지
          않습니다.
        </p>
      )}
      {c.error && (
        <div className="error-notice" role="alert">
          {c.error}
        </div>
      )}
    </section>
  );
}
function TransactionsSummary({
  prepared: p,
}: {
  prepared: AssociationTransactions;
}) {
  return (
    <>
      <div className="association-metrics">
        <span>입력 {p.inputRows}행</span>
        <span>범위 근거 {p.scopeRowIds.length}행</span>
        <span>포함 원자료 {p.includedRows}행</span>
        <strong>실제 거래 N = {p.transactions.length}</strong>
        <span>항목 {p.items.length}종</span>
        <span>빈 거래 {p.emptyCount}개</span>
        <span>
          제외 {p.excluded.length}건 /{" "}
          {p.excluded.reduce((n, e) => n + e.rowIds.length, 0)}행
        </span>
        <span>거래 내 반복 제거 {p.duplicatesRemoved}개</span>
      </div>
      <p>
        거래별 항목 수 분포:{" "}
        {p.sizeDistribution
          .map((d) => `${d.size}항목: ${d.count}거래`)
          .join(" · ") || "거래 없음"}
        . 모든 규칙은 동일한 N을 분모로 사용합니다.
      </p>
      <PagedIssues prepared={p} />
    </>
  );
}
function PagedIssues({ prepared: p }: { prepared: AssociationTransactions }) {
  const [page, setPage] = useState(0);
  const issues = [
    ...p.excluded.map((e) => `제외: ${e.rowIds.join(", ")} — ${e.reason}`),
    ...p.issues.map((e) => `${e.rowId} / ${e.columnId}: ${e.reason}`),
    ...p.merges.map(
      (e) =>
        `항목 병합: ${p.items.find((i) => i.id === e.itemId)?.label} ← ${e.originals.map((v) => JSON.stringify(v)).join(", ")}`,
    ),
  ];
  return (
    <details>
      <summary>제외·결측·미등록·병합 근거 ({issues.length}건)</summary>
      <ul>
        {issues.slice(page * 25, page * 25 + 25).map((text, i) => (
          <li key={i}>{text}</li>
        ))}
      </ul>
      <Pager
        label="변환 근거"
        page={page}
        total={issues.length}
        set={setPage}
      />
    </details>
  );
}
function Preview({ control: c }: { control: AssociationControl }) {
  const [page, setPage] = useState(0);
  const p = c.preview;
  useEffect(() => setPage(0), [p]);
  if (!p || !c.config)
    return (
      <div className="empty-state">
        <h3>거래 정의부터 확인하세요</h3>
        <p>
          오른쪽에서 거래 형식과 열·정책을 정한 후 거래 미리보기를 누르세요.
          변환은 분석용이며 자료 버전과 작업 이력을 바꾸지 않습니다.
        </p>
      </div>
    );
  const names = namedItems(p.items);
  return (
    <section className="association-card">
      <h3>실행 전 거래 미리보기</h3>
      <TransactionsSummary prepared={p} />
      <p>
        최소 지지도 {c.config.association.supportPercent}% →{" "}
        {supportCount(
          p.transactions.length,
          c.config.association.supportPercent,
        )}
        거래 이상 · 최소 신뢰도 {c.config.association.confidencePercent}%
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>거래 키 / 실제 유형</th>
              <th>전체 항목 집합</th>
              <th>당시 원자료 행</th>
            </tr>
          </thead>
          <tbody>
            {p.transactions.slice(page * 25, page * 25 + 25).map((t) => (
              <tr key={t.id}>
                <td>
                  {JSON.stringify(t.key)} ({typeof t.key})
                </td>
                <td>
                  {t.items.map((id) => names.get(id)).join(" · ") ||
                    "빈 거래 (항목 없음)"}
                </td>
                <td>{t.rowIds.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        label="미리보기 거래"
        page={page}
        total={p.transactions.length}
        set={setPage}
      />
      <button
        className="primary"
        onClick={() => c.run()}
        disabled={!c.writable || c.busy || !p.transactions.length}
      >
        확인한 거래로 연관 분석 실행
      </button>
      {!p.transactions.length && (
        <p role="alert">
          N=0이므로 계산할 수 없습니다. 범위·제외 정책을 수정하세요.
        </p>
      )}
    </section>
  );
}
function RecordSelect({ control: c }: { control: AssociationControl }) {
  const records = c.state.project.analyses.filter(
    (a) => a.kind === "association",
  );
  return (
    <div className="association-records">
      {(["current", "comparison"] as const).map((key) => (
        <label key={key}>
          {key === "current" ? "현재 연관 기록" : "비교할 연관 기록"}
          <select
            aria-label={
              key === "current" ? "현재 연관 기록" : "비교할 연관 기록"
            }
            value={c.state.view.associationSelection?.[key] ?? ""}
            onChange={(e) =>
              c.dispatch({
                type: "association-select",
                id: e.target.value || null,
                comparison: key === "comparison",
              })
            }
          >
            <option value="">선택 안 함</option>
            {records.map((a, i) => (
              <option key={a.id} value={a.id}>
                {i + 1}. {new Date(a.createdAt).toLocaleTimeString("ko-KR")} ·{" "}
                {status[a.status]} ·{" "}
                {a.configSnapshot.association?.supportPercent ?? "?"}% /{" "}
                {a.configSnapshot.association?.confidencePercent ?? "?"}%
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
function ItemFilter({
  label,
  items,
  selected,
  set,
}: {
  label: string;
  items: AssociationItem[];
  selected: string[];
  set: (ids: string[]) => void;
}) {
  return (
    <details>
      <summary>
        {label} ({selected.length}개 선택)
      </summary>
      <div className="association-item-picker">
        {items.map((item,index) => (
          <label key={item.id}>
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(e) =>
                set(
                  e.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            {index+1}. {displayItem(item)}
          </label>
        ))}
      </div>
    </details>
  );
}
function Result({
  control: c,
  record,
}: {
  control: AssociationControl;
  record: AnalysisRecord;
}) {
  const r = record.association!,
    s = record.configSnapshot.association!;
  const q =
    c.state.view.associationViews?.[record.id] ?? defaultAssociationView();
  const patch = (patch: Partial<AssociationView>) =>
    c.dispatch({ type: "association-view", id: record.id, patch });
  const task = useTask("association-detail");
  const [detail, setDetail] = useState<{
    key: string;
    value: AssociationDetail;
  } | null>(null);
  const table = useMemo(() => {
    const v = resolveVersion(c.state.project, r.source);
    return { columns: v.columns, rows: v.rows };
  }, [c.state.project.datasets, r.source]);
  const key = JSON.stringify([record.id, q]);
  useEffect(() => {
    setDetail(null);
    const sourceRows = new Set(r.prepared.transactions.find(t=>t.id===q.transactionId)?.rowIds ?? []);
    task.run(
      { kind: "association-detail", table: { columns:table.columns, rows:table.rows.filter(row=>sourceRows.has(row.id)) }, result: r, query: q },
      (response) => {
        if (response.kind === "association-detail")
          setDetail({ key, value: response.result });
      },
    );
    return task.cancel;
  }, [key, table, r, task.run, task.cancel]);
  const d = detail?.key === key ? detail.value : null;
  const names = new Map(r.prepared.items.map((i,index) => [i.id, r.prepared.items.some(other=>other.id!==i.id&&other.label===i.label)?i.label+' (항목 '+(index+1)+')':i.label]));
  const label = (ids: readonly string[]) =>
    "{" + ids.map((id) => names.get(id)).join(", ") + "}";
  const rule = r.rules.find((rule) => rule.id === q.ruleId);
  const freshness = getResultFreshness(
    record,
    c.state.project.selection,
    c.config,
  );
  const level = r.levels.find((l) => l.length === q.level);
  return (
    <section className="association-card">
      <h3>저장된 연관 결과</h3>
      <p className={freshness.state === "stale" ? "warning-notice" : "muted"}>
        {freshness.state === "current"
          ? "현재 자료·조건과 일치"
          : `재분석 필요: ${freshness.reasons.join(" ")}`}{" "}
        당시 버전: {r.source.versionId}
      </p>
      <TransactionsSummary prepared={r.prepared} />
      <p>
        지지도 ≥ {s.supportPercent}% ({r.minCount}거래) · 신뢰도 ≥{" "}
        {s.confidencePercent}% · 최대 길이 {r.maxLength} · 규칙 {r.rules.length}
        개. 지정 범위 계산 완료 ({({'max-length':'지정한 최대 길이 도달','no-frequent':'다음 빈발 집합 없음','no-candidates':'다음 후보 없음'})[r.termination]}).
      </p>
      <p>
        후보 결합 {r.work.candidateJoins}회 · 계수 방문 {r.work.countedVisits}회
        · 규칙 조합 {r.work.ruleCombinations}개. 서로 다른 거래는 내용이 같아도
        각각 셉니다.
      </p>
      <details>
        <summary>당시 거래 구성·범위·계산 조건</summary>
        <pre className="association-json">{JSON.stringify(s, null, 2)}</pre>
      </details>
      <div className="button-row">
        <button
          disabled={!c.writable || c.busy}
          onClick={() =>
            c.run(
              record.configSnapshot as import("../domain/types").AnalysisConfig,
            )
          }
        >
          당시 버전·조건으로 새 실행
        </button>
        <button disabled={!c.writable} onClick={() => c.cloneCurrent(record)}>
          현재 버전으로 조건 복제
        </button>
      </div>
      <details>
        <summary>
          실제 계산 과정: 후보 생성 → 가지치기 → 계수 → 빈발 → 규칙
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>길이</th>
                <th>생성</th>
                <th>가지치기</th>
                <th>계수</th>
                <th>빈발</th>
              </tr>
            </thead>
            <tbody>
              {r.levels.map((l) => (
                <tr key={l.length}>
                  <td>
                    <button
                      onClick={() =>
                        patch({ level: l.length, candidatePage: 0 })
                      }
                    >
                      {l.length}항목 조회
                    </button>
                  </td>
                  <td>{l.generated}</td>
                  <td>{l.pruned}</td>
                  <td>{l.counted}</td>
                  <td>{l.frequent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          부분집합 하나라도 빈발하지 않으면 계수 전에 가지치기합니다. 실제
          저장한 후보만 표시합니다.
        </p>
        {level && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>길이 {level.length} 항목 집합</th>
                    <th>거래 수</th>
                    <th>지지도</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {level.candidates
                    .slice(q.candidatePage * 25, q.candidatePage * 25 + 25)
                    .map((row) => (
                      <tr key={JSON.stringify(row.items)}>
                        <td>{label(row.items)}</td>
                        <td>{row.count ?? "계수하지 않음"}</td>
                        <td>
                          {row.count === null
                            ? "—"
                            : number(
                                (row.count / r.prepared.transactions.length) *
                                  100,
                              ) + "%"}
                        </td>
                        <td>
                          {row.pruned
                            ? "부분집합 가지치기"
                            : row.frequent
                              ? "빈발"
                              : "최소 지지도 미달"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <Pager
              label="후보"
              page={q.candidatePage}
              total={level.candidates.length}
              set={(candidatePage) => patch({ candidatePage })}
            />
          </>
        )}
      </details>
      <h4>규칙 탐색</h4>
      <div className="association-search">
        <label>
          선행 이름 검색
          <input
            aria-label="선행 이름 검색"
            value={q.antecedentText}
            onChange={(e) => patch({ antecedentText: e.target.value, page: 0 })}
          />
        </label>
        <label>
          후행 이름 검색
          <input
            aria-label="후행 이름 검색"
            value={q.consequentText}
            onChange={(e) => patch({ consequentText: e.target.value, page: 0 })}
          />
        </label>
        <ItemFilter
          label="선행 항목 선택"
          items={r.prepared.items}
          selected={q.antecedent}
          set={(antecedent) => patch({ antecedent, page: 0 })}
        />
        <ItemFilter
          label="후행 항목 선택"
          items={r.prepared.items}
          selected={q.consequent}
          set={(consequent) => patch({ consequent, page: 0 })}
        />
        <label>
          복수 항목 선택 기준
          <select
            aria-label="복수 항목 선택 기준"
            value={q.match}
            onChange={(e) =>
              patch({ match: e.target.value as "all" | "any", page: 0 })
            }
          >
            <option value="all">선택 항목 모두 포함</option>
            <option value="any">선택 항목 하나 이상 포함</option>
          </select>
        </label>
        <label>
          규칙 정렬
          <select
            aria-label="규칙 정렬"
            value={q.sort}
            onChange={(e) =>
              patch({
                sort: e.target.value as AssociationView["sort"],
                page: 0,
              })
            }
          >
            {Object.entries({
              support: "지지도",
              confidence: "신뢰도",
              lift: "향상도",
              countUnion: "관련 거래 수",
              length: "전체 항목 수",
            }).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          정렬 방향
          <select
            aria-label="정렬 방향"
            value={q.direction}
            onChange={(e) =>
              patch({ direction: e.target.value as "asc" | "desc", page: 0 })
            }
          >
            <option value="desc">내림차순</option>
            <option value="asc">오름차순</option>
          </select>
        </label>
      </div>
      <small>
        동률은 항목 ID와 방향의 사전 순서입니다. 검색·정렬은 저장 결과만
        탐색하며 재분석 조건을 바꾸지 않습니다.
      </small>
      <TaskStatus {...task} />
      <ErrorNotice error={task.error} />
      {d && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>선행 → 후행 (선택하여 근거 확인)</th>
                  <th>지지도</th>
                  <th>신뢰도</th>
                  <th>향상도</th>
                  <th>관련 거래</th>
                </tr>
              </thead>
              <tbody>
                {d.rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>
                      <button
                        aria-pressed={q.ruleId === rule.id}
                        onClick={() =>
                          patch({
                            ruleId: rule.id,
                            transactionPage: 0,
                            transactionId: null,
                            transactionGroup: "both",
                          })
                        }
                      >
                        {label(rule.antecedent)} → {label(rule.consequent)}
                      </button>
                    </td>
                    <td>{number(rule.support * 100)}%</td>
                    <td>{number(rule.confidence * 100)}%</td>
                    <td>{number(rule.lift)}</td>
                    <td>{rule.countUnion}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!d.matchedRules && (
            <p>
              조건에 맞는 항목/규칙 없음. 기준값을 자동으로 낮추지 않습니다.
            </p>
          )}
          <Pager
            label="규칙"
            page={q.page}
            total={d.matchedRules}
            set={(page) => patch({ page })}
          />
          {rule && d.counts && (
            <section className="association-evidence">
              <h4>
                {label(rule.antecedent)} → {label(rule.consequent)}의 계산 근거
              </h4>
              <p>
                합집합 {label([...rule.antecedent, ...rule.consequent])} · N=
                {rule.n}, count(A)={rule.countA}, count(B)={rule.countB},
                count(A∪B)={rule.countUnion}
              </p>
              <ul>
                <li>
                  지지도 = {rule.countUnion} / {rule.n} ={" "}
                  {number(rule.support * 100)}%
                </li>
                <li>
                  신뢰도 = {rule.countUnion} / {rule.countA} ={" "}
                  {number(rule.confidence * 100)}%
                </li>
                <li>
                  향상도 = ({rule.countUnion} / {rule.countA}) / ({rule.countB}{" "}
                  / {rule.n}) = {number(rule.lift)}
                </li>
              </ul>
              <p>
                후행 자체의 발생률은 {number((rule.countB / rule.n) * 100)}
                %입니다. 신뢰도가 높아도 이 발생률이 높으면 향상도는 낮을 수
                있습니다. 향상도는 인과 효과나 예측 정확도가 아닙니다.
              </p>
              <table>
                <caption>
                  2×2 거래 수 — 복합 항목 집합 전체를 포함해야 충족
                </caption>
                <thead>
                  <tr>
                    <th></th>
                    <th>후행 충족</th>
                    <th>후행 미충족</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>선행 충족</th>
                    <td>{d.counts.both} (둘 다)</td>
                    <td>{d.counts.aOnly} (선행만)</td>
                  </tr>
                  <tr>
                    <th>선행 미충족</th>
                    <td>{d.counts.bOnly} (후행만)</td>
                    <td>{d.counts.neither} (둘 다 아님)</td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}
          <h4>당시 거래와 원자료</h4>
          <label>
            관련 거래 범위
            <select
              aria-label="관련 거래 범위"
              value={q.transactionGroup}
              onChange={(e) =>
                patch({
                  transactionGroup: e.target
                    .value as AssociationView["transactionGroup"],
                  transactionPage: 0,
                  transactionId: null,
                })
              }
            >
              {Object.entries({
                all: "모든 거래",
                both: "선행·후행 둘 다",
                "a-only": "선행만",
                "b-only": "후행만",
                neither: "둘 다 아님",
                empty: "빈 거래",
              }).map(([v, label]) => (
                <option
                  key={v}
                  value={v}
                  disabled={!rule && !["all", "empty"].includes(v)}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>거래 키</th>
                  <th>전체 항목</th>
                  <th>원자료 행 수</th>
                </tr>
              </thead>
              <tbody>
                {d.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button onClick={() => patch({ transactionId: t.id })}>
                        {JSON.stringify(t.key)} · {typeof t.key}
                      </button>
                    </td>
                    <td>
                      {t.items.length ? label(t.items) : "빈 거래 — N에 포함"}
                    </td>
                    <td>{t.rowIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            label="관련 거래"
            page={q.transactionPage}
            total={d.transactionCount}
            set={(transactionPage) => patch({ transactionPage })}
          />
          {d.selectedTransaction && (
            <OriginalRows
              rows={d.sourceRows}
              table={table}
              transaction={d.selectedTransaction.id}
            />
          )}
        </>
      )}
    </section>
  );
}
function OriginalRows({
  rows,
  table,
  transaction,
}: {
  rows: AssociationDetail["sourceRows"];
  table:
    | ReturnType<typeof resolveVersion>
    | { columns: ReturnType<typeof resolveVersion>["columns"] };
  transaction: string;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [transaction]);
  return (
    <section>
      <h4>선택 거래의 당시 원자료 (현재 버전을 바꾸지 않음)</h4>
      <div className="table-scroll">
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
            {rows.slice(page * 25, page * 25 + 25).map((r) => (
              <tr key={r.id}>
                <th>{r.id}</th>
                {table.columns.map((c) => (
                  <td key={c.id}>
                    {r.values[c.id] === null
                      ? "결측 (null)"
                      : JSON.stringify(r.values[c.id])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager label="원자료 행" page={page} total={rows.length} set={setPage} />
    </section>
  );
}
function Comparison({ a, b }: { a: AnalysisRecord; b: AnalysisRecord }) {
  const [page, setPage] = useState(0),
    [kind, setKind] = useState<"retained" | "added" | "removed">("retained");
  if (
    !a.association ||
    !b.association ||
    !a.configSnapshot.association ||
    !b.configSnapshot.association
  )
    return <p>두 완료 연관 결과를 선택하세요.</p>;
  const ac = a.configSnapshot.association,
    bc = b.configSnapshot.association;
  const compared = compareAssociations(a.association, b.association, ac, bc);
  const names = new Map(
    [...a.association.prepared.items, ...b.association.prepared.items].map(
      (i) => [i.id, displayItem(i)],
    ),
  );
  const label = (
    r: import("../domain/types").DeepReadonly<
      AssociationResult["rules"][number]
    >,
  ) =>
    r.antecedent.map((id) => names.get(id)).join(" + ") +
    " → " +
    r.consequent.map((id) => names.get(id)).join(" + ");
  const rows =
    kind === "retained"
      ? compared.retained.map((r) => ({
          id: r.id,
          label: label(r.a),
          left: r.a,
          right: r.b,
        }))
      : compared[kind].map((r) => ({
          id: r.id,
          label: label(r),
          left: kind === "removed" ? r : null,
          right: kind === "added" ? r : null,
        }));
  const metrics = (
    r:
      | import("../domain/types").DeepReadonly<
          AssociationResult["rules"][number]
        >
      | null,
  ) =>
    r
      ? `${number(r.support * 100)}% / ${number(r.confidence * 100)}% / ${number(r.lift)} / ${r.countUnion}거래`
      : "없음";
  return (
    <section className="association-card">
      <h3>두 실행 비교: 현재 → 비교 기록</h3>
      <p>
        {compared.samePopulation
          ? "실제 거래 집합·항목 의미가 같습니다."
          : "거래 집합 또는 항목 의미가 다릅니다. 기준값만 바꾼 비교가 아닙니다."}{" "}
        {compared.samePolicy ? "변환 정책 같음." : "변환 정책·범위 다름."}{" "}
        {compared.sameVersion ? "같은 버전." : "서로 다른 버전."}{" "}
        {compared.sameLength ? "탐색 길이 같음." : "탐색 길이 다름."}
      </p>
      <table>
        <thead>
          <tr>
            <th>조건</th>
            <th>현재 기록</th>
            <th>비교 기록</th>
          </tr>
        </thead>
        <tbody>
          {[
            [
              "N",
              a.association.prepared.transactions.length,
              b.association.prepared.transactions.length,
            ],
            ["지지도 %", ac.supportPercent, bc.supportPercent],
            ["신뢰도 %", ac.confidencePercent, bc.confidencePercent],
            ["최대 길이", ac.maxLength, bc.maxLength],
            [
              "빈발 집합",
              a.association.levels.reduce((n, l) => n + l.frequent, 0),
              b.association.levels.reduce((n, l) => n + l.frequent, 0),
            ],
            ["규칙", a.association.rules.length, b.association.rules.length],
          ].map(([k, x, y]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{x}</td>
              <td>{y}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        유지 {compared.retained.length} · 추가 {compared.added.length} · 사라짐{" "}
        {compared.removed.length}. 항목 ID와 방향을 기준으로 대응합니다.
      </p>
      <label>
        비교 규칙 목록
        <select
          aria-label="비교 규칙 목록"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setPage(0);
          }}
        >
          <option value="retained">유지</option>
          <option value="added">추가</option>
          <option value="removed">사라짐</option>
        </select>
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>규칙</th>
              <th>현재: 지지도/신뢰도/향상도/거래</th>
              <th>비교: 같은 지표</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(page * 25, page * 25 + 25).map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td>{metrics(r.left)}</td>
                <td>{metrics(r.right)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager label="비교 규칙" page={page} total={rows.length} set={setPage} />
    </section>
  );
}
export function AssociationPanel({
  control: c,
}: {
  control: AssociationControl;
}) {
  return (
    <section className="association-panel">
      <header>
        <h2>연관 규칙 탐구</h2>
        <p>
          함께 나타나는 항목과 거래의 근거를 탐색합니다. 순서·수량·인과관계를
          분석하지 않습니다.
        </p>
      </header>
      <TaskStatus busy={c.busy} message={c.message} cancel={() => c.cancel()} />
      {c.error && (
        <div className="error-notice" role="alert">
          {c.error}
        </div>
      )}
      {c.writable && <Preview control={c} />}
      <RecordSelect control={c} />
      {c.selected && (
        <>
          <p>
            {status[c.selected.status]} ·{" "}
            {new Date(c.selected.createdAt).toLocaleString("ko-KR")}
          </p>
          {c.selected.error && <ErrorNotice error={c.selected.error} />}
          <button
            disabled={!c.writable}
            onClick={() => c.remove(c.selected!.id)}
          >
            선택한 연관 기록 삭제
          </button>
          {c.selected.association ? (
            <Result key={c.selected.id} control={c} record={c.selected} />
          ) : c.selected.status === "completed" ? (
            <p>
              이전 기록에 거래·규칙 계산 정보가 없어 상세 조회할 수 없습니다.
              당시 조건을 확인해 새로 실행하세요.
            </p>
          ) : null}
        </>
      )}
      {c.selected && c.comparison && (
        <Comparison
          key={c.selected.id + c.comparison.id}
          a={c.selected}
          b={c.comparison}
        />
      )}
    </section>
  );
}
