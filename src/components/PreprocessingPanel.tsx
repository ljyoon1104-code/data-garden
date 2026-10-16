import { useState, type ReactNode } from "react";
import type {
  DeepReadonly,
  TableData,
  ColumnStatistics,
  Cell,
} from "../domain/types";
import type {
  PreprocessingSettings,
  PreprocessingPreview,
  FittedPreprocessing,
} from "../domain/preprocessing-types";
import {
  defaultPreprocessing,
  isNumeric,
  methodLabels,
  preprocessingLabels,
} from "../domain/preprocessing";
import { semanticLabels } from "../domain/table";
import { TaskStatus, ErrorNotice } from "./DataControls";
import type { usePreprocessing } from "./usePreprocessing";

type Controller = ReturnType<typeof usePreprocessing>;
const display = (v: Cell | undefined) =>
  v === null
    ? "결측 (null)"
    : v === ""
      ? '빈 문자열 ("")'
      : v === undefined
        ? "—"
        : String(v);
export function PreprocessingSettingsPanel({
  table,
  control,
}: {
  table: DeepReadonly<TableData>;
  control: Controller;
}) {
  const { settings: s, change, preview, task } = control;
  const patch = (p: object) => change({ ...s, ...p } as PreprocessingSettings);
  const numeric =
    s.kind === "scale" ||
    s.kind === "outliers" ||
    (s.kind === "missing" && ["mean", "median"].includes(s.method));
  const mode = s.kind === "missing" && s.method === "mode";
  const eligible = table.columns.filter(
    (c) =>
      (!numeric || isNumeric(c)) && (!mode || c.semanticType === "categorical"),
  );
  return (
    <section className="preprocess-settings" id="preprocess-settings">
      <h3>전처리 설정</h3>
      <p className="scope-notice">
        현재 버전 전체 {table.rows.length.toLocaleString()}행에 적용합니다. 화면
        필터·정렬·선택 행·페이지와 무관합니다.
      </p>
      <label>
        처리 종류
        <select
          aria-label="처리 종류"
          value={s.kind}
          onChange={(e) =>
            change(
              defaultPreprocessing(
                e.target.value as PreprocessingSettings["kind"],
                table,
              ),
            )
          }
        >
          {Object.entries(preprocessingLabels).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {s.kind === "missing" && (
        <>
          <label>
            결측값 처리 방법
            <select
              aria-label="결측값 처리 방법"
              value={s.method}
              onChange={(e) => {
                const method = e.target.value as typeof s.method;
                patch({
                  method,
                  attributeIds: s.attributeIds.filter((id) => {
                    const c = table.columns.find((c) => c.id === id)!;
                    return ["mean", "median"].includes(method)
                      ? isNumeric(c)
                      : method === "mode"
                        ? c.semanticType === "categorical"
                        : true;
                  }),
                });
              }}
            >
              {["remove", "mean", "median", "mode", "fixed"].map((v) => (
                <option value={v} key={v}>
                  {methodLabels[v]}
                </option>
              ))}
            </select>
          </label>
          <p>
            결측값은 null과 빈 문자열만입니다. 공백·NA·0·false는 그대로
            유지합니다. 최빈값 동률이면 기준 자료에서 먼저 나온 값을 사용합니다.
          </p>
        </>
      )}
      {s.kind === "duplicates" && (
        <>
          <label>
            보존할 행
            <select
              aria-label="보존할 행"
              value={s.keep}
              onChange={(e) => patch({ keep: e.target.value })}
            >
              <option value="first">첫 행 보존</option>
              <option value="last">마지막 행 보존</option>
            </select>
          </label>
          <p>
            현재 자료 버전의 행 순서를 따릅니다. 숫자 1과 문자 “1”, null과 빈
            문자열은 서로 다릅니다.
          </p>
        </>
      )}
      {s.kind === "outliers" && (
        <>
          <label>
            이상값 탐색 기준
            <select
              aria-label="이상값 탐색 기준"
              value={s.detection}
              onChange={(e) => {
                const validBounds =
                  Number.isFinite(s.lower) &&
                  Number.isFinite(s.upper) &&
                  s.lower <= s.upper;
                patch({
                  detection: e.target.value,
                  ...(e.target.value === "iqr" && !validBounds
                    ? { lower: 0, upper: 100 }
                    : {}),
                  ...(e.target.value === "bounds" &&
                  (!Number.isFinite(s.multiplier) || s.multiplier < 0)
                    ? { multiplier: 1.5 }
                    : {}),
                });
              }}
            >
              <option value="iqr">IQR 경계</option>
              <option value="bounds">경계 직접 입력</option>
            </select>
          </label>
          {s.detection === "iqr" ? (
            <label>
              IQR 배수
              <input
                type="number"
                step="any"
                min="0"
                value={Number.isNaN(s.multiplier) ? "" : s.multiplier}
                onChange={(e) =>
                  patch({
                    multiplier:
                      e.target.value === "" ? NaN : Number(e.target.value),
                  })
                }
              />
            </label>
          ) : (
            <div className="bounds-fields">
              {(["lower", "upper"] as const).map((k) => (
                <label key={k}>
                  {k === "lower" ? "하한" : "상한"}
                  <input
                    type="number"
                    step="any"
                    value={Number.isNaN(s[k]) ? "" : s[k]}
                    onChange={(e) =>
                      patch({
                        [k]:
                          e.target.value === "" ? NaN : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <label>
            이상값 처리 방법
            <select
              aria-label="이상값 처리 방법"
              value={s.action}
              onChange={(e) => patch({ action: e.target.value })}
            >
              {["mark", "remove", "missing", "clip", "median"].map((v) => (
                <option key={v} value={v}>
                  {v === "median" ? "정상 범위의 중앙값 대체" : methodLabels[v]}
                </option>
              ))}
            </select>
          </label>
          <p>
            경계 밖의 값만 후보로 표시합니다. 경계값과 결측값은 후보가 아닙니다.
            IQR은 (n−1)p 위치를 선형 보간합니다.
          </p>
        </>
      )}
      {s.kind === "scale" && (
        <>
          <label>
            수치 변환 방법
            <select
              aria-label="수치 변환 방법"
              value={s.method}
              onChange={(e) => patch({ method: e.target.value })}
            >
              <option value="minmax">최소·최대 정규화</option>
              <option value="zscore">표준화 (모집단 n)</option>
            </select>
          </label>
          <p>
            {s.method === "minmax"
              ? "(x − 최솟값) / (최댓값 − 최솟값)"
              : "(x − 평균) / 모집단 표준편차 (분모 n)"}
            . 결측은 유지하고, 상수 열·유효값 2개 미만·수치 범위 초과는
            중단합니다. 저장값은 반올림하지 않습니다.
          </p>
        </>
      )}
      {((s.kind === "missing" && s.method === "remove") ||
        (s.kind === "outliers" && s.action === "remove")) && (
        <label>
          행 제거 조건
          <select
            aria-label="행 제거 조건"
            value={s.rowRule}
            onChange={(e) => patch({ rowRule: e.target.value })}
          >
            <option value="any">선택 속성 중 하나라도 해당</option>
            <option value="all">선택 속성 모두 해당</option>
          </select>
        </label>
      )}
      <fieldset className="target-columns">
        <legend>대상 속성 · {s.attributeIds.length}개</legend>
        {eligible.length === 0 && <p>이 방법을 적용할 속성이 없습니다.</p>}
        {eligible.map((c) => (
          <label className="check-label" key={c.id}>
            <input
              type="checkbox"
              checked={s.attributeIds.includes(c.id)}
              onChange={(e) =>
                patch({
                  attributeIds: e.target.checked
                    ? [...s.attributeIds, c.id]
                    : s.attributeIds.filter((id) => id !== c.id),
                })
              }
            />
            {c.name}{" "}
            <small>
              {semanticLabels[c.semanticType]}
              {!c.useInAnalysis ? " · 분석 제외" : ""}
            </small>
          </label>
        ))}
      </fieldset>
      {s.kind === "missing" &&
        s.method === "fixed" &&
        eligible
          .filter((c) => s.attributeIds.includes(c.id))
          .map((c) => (
            <label key={c.id}>
              {c.name} 대체값
              <input
                value={s.fixedValues[c.id] ?? ""}
                onChange={(e) =>
                  patch({
                    fixedValues: { ...s.fixedValues, [c.id]: e.target.value },
                  })
                }
              />
            </label>
          ))}
      <p>
        전체 자료에서 기준을 계산합니다. 향후 학습·평가에서는 전처리 전 자료를
        나눈 뒤 학습 자료로만 기준을 계산해야 합니다.
      </p>
      <TaskStatus {...task} cancel={control.clear} />
      <ErrorNotice error={task.error} />
      {control.overLimit && (
        <p className="error-notice" role="alert">
          적용 후 전체 보존 셀이 300만 개를 초과합니다. 기존 기록은 삭제하지
          않습니다. 별도 프로젝트로 자료를 나누세요.
        </p>
      )}
      <div className="button-row">
        <button
          className="primary-button"
          disabled={task.busy || !s.attributeIds.length}
          onClick={control.run}
        >
          전처리 미리보기
        </button>
        <button onClick={control.clear}>전처리 취소</button>
      </div>
      {preview && (
        <>
          <p>중앙의 처리 전후 비교와 실제 기준을 확인한 다음 적용하세요.</p>
          <button
            className="primary-button"
            disabled={
              task.busy ||
              control.overLimit ||
              (!preview.changedCells && !preview.removedRowIds.length)
            }
            onClick={control.apply}
          >
            전처리 적용
          </button>
          {!preview.changedCells && !preview.removedRowIds.length && (
            <p>
              자료 변경이 없어 새 버전을 만들지 않습니다.
              {s.kind === "outliers" && s.action === "mark"
                ? " 후보 목록만 확인할 수 있습니다."
                : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}
function Paged<T>({
  items,
  render,
  label,
}: {
  items: readonly T[];
  render: (item: T, index: number) => ReactNode;
  label: string;
}) {
  const [page, setPage] = useState(0),
    pages = Math.max(1, Math.ceil(items.length / 20)),
    p = Math.min(page, pages - 1);
  return (
    <div className="comparison-list">
      <p>
        {label} · 총 {items.length.toLocaleString()}개 · 한 페이지 최대 20개
      </p>
      <ul>
        {items.slice(p * 20, (p + 1) * 20).map((item, i) => (
          <li key={p * 20 + i}>{render(item, p * 20 + i)}</li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="button-row">
          <button onClick={() => setPage(p - 1)} disabled={p === 0}>
            이전 {label}
          </button>
          <span>
            {p + 1}/{pages}
          </span>
          <button onClick={() => setPage(p + 1)} disabled={p === pages - 1}>
            다음 {label}
          </button>
        </div>
      )}
    </div>
  );
}
const basisLabels: Record<string, string> = {
  validCount: "유효값 수",
  missingCount: "결측값 수",
  replacement: "대체값",
  min: "최솟값",
  max: "최댓값",
  mean: "평균",
  stddev: "모집단 표준편차 (n)",
  q1: "제1사분위수",
  q3: "제3사분위수",
  lower: "하한",
  upper: "상한",
};
export function FittedDetails({
  fitted,
  table,
}: {
  fitted: DeepReadonly<FittedPreprocessing>;
  table: DeepReadonly<TableData>;
}) {
  return (
    <div className="fitted-details">
      <p>
        기준 자료 버전: {fitted.source.versionId}
        <br />
        기준 범위: {fitted.fitRows.kind === "all"
          ? "전체 자료"
          : "학습 자료"}{" "}
        {fitted.fitRows.count}행
      </p>
      {fitted.settings.attributeIds.map((id) => (
        <article key={id}>
          <h4>{table.columns.find((c) => c.id === id)?.name ?? id}</h4>
          <dl>
            {Object.entries(fitted.columns[id])
              .filter(([k]) => k in basisLabels)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{basisLabels[k]}</dt>
                  <dd>{display(v)}</dd>
                </div>
              ))}
          </dl>
        </article>
      ))}
    </div>
  );
}
function Statistics({ stats }: { stats: ColumnStatistics }) {
  return (
    <>
      <p>
        결측 {stats.missing}개 ({(stats.missingRatio * 100).toFixed(2)}%) ·
        고유값 {stats.unique}개
      </p>
      {stats.numeric && (
        <p>
          유효값 {stats.numeric.valid} · 최소 {display(stats.numeric.min)} ·
          최대 {display(stats.numeric.max)} · 평균 {display(stats.numeric.mean)}{" "}
          · 중앙값 {display(stats.numeric.median)} · 표본 표준편차 (n−1){" "}
          {display(stats.numeric.stddev)}
          {stats.numeric.overflow
            ? " · 수치 범위 초과로 일부 통계 계산 불가"
            : ""}
        </p>
      )}
      {stats.frequencies && (
        <Paged
          items={stats.frequencies}
          label="값별 빈도"
          render={(x) => (
            <>
              {display(x.value)}: {x.count}개
            </>
          )}
        />
      )}
    </>
  );
}
export function PreprocessingComparison({
  preview: p,
  table,
}: {
  preview: PreprocessingPreview;
  table: DeepReadonly<TableData>;
}) {
  const rowIndexes = new Map(table.rows.map((r, i) => [r.id, i + 1])),
    columns = new Map(table.columns.map((c) => [c.id, c.name]));
  const rowsById = new Map(table.rows.map((r) => [r.id, r]));
  const rowValues = (id: string) => (
    <details>
      <summary>행 값 확인</summary>
      <ul>
        {table.columns.map((c) => (
          <li key={c.id}>
            {c.name}: {display(rowsById.get(id)!.values[c.id])}
          </li>
        ))}
      </ul>
    </details>
  );
  const rowLabel = (id: string) => `${rowIndexes.get(id)}행 (${id})`;
  return (
    <section className="preprocess-comparison" aria-label="처리 전후 비교">
      <h2>처리 전후 비교</h2>
      <p>
        {preprocessingLabels[p.fitted.settings.kind]} ·{" "}
        {
          methodLabels[
            "method" in p.fitted.settings
              ? p.fitted.settings.method
              : "keep" in p.fitted.settings
                ? p.fitted.settings.keep
                : p.fitted.settings.action
          ]
        }{" "}
        · 전체 자료 기준
      </p>
      <div className="comparison-summary">
        <strong>
          행 {p.beforeRows.toLocaleString()} → {p.afterRows.toLocaleString()}
        </strong>
        <strong>
          열 {p.columnCount} → {p.columnCount}
        </strong>
        <strong>변경 셀 {p.changedCells.toLocaleString()}개</strong>
        <strong>제거 행 {p.removedRowIds.length.toLocaleString()}개</strong>
      </div>
      <p>
        아직 적용 전입니다. 원본·현재 버전은 그대로 유지됩니다. 변경 셀 수에는
        제거 행의 셀을 포함하지 않습니다.
      </p>
      <details open>
        <summary>실제 계산 기준</summary>
        <FittedDetails fitted={p.fitted} table={table} />
      </details>
      <details>
        <summary>속성별 전후 통계 · 전체 자료</summary>
        <p>
          이곳의 기술통계 표준편차는 표본 기준 (n−1)입니다. 표준화 계산의 모집단
          기준 (n)과 다릅니다.
        </p>
        {table.columns.map((c) => (
          <article key={c.id}>
            <h3>{c.name}</h3>
            <div className="statistics-pair">
              <div>
                <h4>처리 전</h4>
                <Statistics stats={p.beforeStatistics[c.id]} />
              </div>
              <div>
                <h4>처리 후</h4>
                <Statistics stats={p.afterStatistics[c.id]} />
              </div>
            </div>
          </article>
        ))}
      </details>
      <details>
        <summary>변경 값 확인 · {p.changes.length}개</summary>
        <Paged
          items={p.changes}
          label="변경 값"
          render={(c) => (
            <>
              {rowLabel(c.rowId)} · {columns.get(c.attributeId)}:{" "}
              {display(c.before)} → {display(c.after)}
            </>
          )}
        />
      </details>
      <details>
        <summary>제거 행 확인 · {p.removedRowIds.length}개</summary>
        <Paged
          items={p.removedRowIds}
          label="제거 행"
          render={(id) => (
            <>
              {rowLabel(id)}
              {rowValues(id)}
            </>
          )}
        />
      </details>
      {p.fitted.settings.kind === "outliers" && (
        <details open>
          <summary>이상값 후보 확인 · {p.candidates.length}개</summary>
          <Paged
            items={p.candidates}
            label="이상값 후보"
            render={(c) => (
              <>
                {rowLabel(c.rowId)} · {columns.get(c.attributeId)}:{" "}
                {display(c.value)}
              </>
            )}
          />
        </details>
      )}
      {p.fitted.settings.kind === "duplicates" && (
        <details open>
          <summary>중복 그룹 확인 · {p.duplicateGroups.length}개</summary>
          <Paged
            items={p.duplicateGroups}
            label="중복 그룹"
            render={(g) => (
              <details>
                <summary>
                  보존: {rowLabel(g.keptRowId)} · 그룹 {g.rowIds.length}행
                </summary>
                <Paged
                  items={g.rowIds}
                  label="그룹 행"
                  render={(id) => (
                    <>
                      {rowLabel(id)} · {id === g.keptRowId ? "보존" : "제거"}
                      {rowValues(id)}
                    </>
                  )}
                />
              </details>
            )}
          />
        </details>
      )}
    </section>
  );
}
