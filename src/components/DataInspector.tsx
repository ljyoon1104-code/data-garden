import { useState } from "react";
import type {
  Dataset,
  DeepReadonly,
  DataVersion,
  Attribute,
  TableInspection,
  TableView,
} from "../domain/types";
import { semanticLabels, storageLabels } from "../domain/table";

const number = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "계산 불가"
    : n.toLocaleString("ko-KR", { maximumFractionDigits: 6 });
export function DataInspector({
  dataset,
  version,
  attribute,
  inspection,
  tableView,
  selectAttribute,
  editAttribute,
  setScope,
}: {
  dataset?: Dataset;
  version?: DeepReadonly<DataVersion>;
  attribute?: DeepReadonly<Attribute>;
  inspection: TableInspection | null;
  tableView: TableView;
  selectAttribute: (id: string | null) => void;
  editAttribute: (attribute: Attribute) => void;
  setScope: (scope: TableView["statisticsScope"]) => void;
}) {
  const [frequencyPage, setFrequencyPage] = useState(0);
  const stat = attribute ? inspection?.statistics[attribute.id] : undefined;
  const frequencies = stat?.frequencies;
  const maxPage = Math.max(1, Math.ceil((frequencies?.length || 0) / 20));
  const page = Math.min(frequencyPage, maxPage - 1);
  return (
    <>
      <section className="inspector-section">
        <h3>현재 자료</h3>
        {dataset && version ? (
          <>
            <strong>{dataset.name}</strong>
            <p className="source-note">
              {dataset.source.kind === "sample"
                ? "샘플 · 실제 학생 자료가 아닙니다."
                : dataset.source.label}
            </p>
            <div className="size-stats">
              <div>
                <span>전체 행</span>
                <strong>{version.rows.length}</strong>
              </div>
              <div>
                <span>속성</span>
                <strong>{version.columns.length}</strong>
              </div>
            </div>
            <dl className="attribute-info">
              <div>
                <dt>조건 일치 행</dt>
                <dd>{inspection?.rowIds.length ?? "계산 중"}</dd>
              </div>
              <div>
                <dt>선택 행 / 열</dt>
                <dd>
                  {tableView.selectedRowIds.length} /{" "}
                  {tableView.selectedColumnIds.length}
                </dd>
              </div>
              <div>
                <dt>현재 버전</dt>
                <dd>
                  {dataset.versions.findIndex((v) => v.id === version.id) + 1} /{" "}
                  {dataset.versions.length}
                </dd>
              </div>
            </dl>
            <details className="source-details">
              <summary>출처·버전 기록</summary>
              <p>출처: {dataset.source.label}</p>
              {dataset.source.importOptions && (
                <p>
                  인코딩 {dataset.source.importOptions.encoding} · 구분자{" "}
                  {JSON.stringify(dataset.source.importOptions.delimiter)} ·
                  시트 {dataset.source.importOptions.sheet || "CSV"} · 열 이름{" "}
                  {dataset.source.importOptions.header ? "첫 행" : "자동 생성"}{" "}
                  · XLSX 값 {dataset.source.importOptions.xlsxValues}
                </p>
              )}
              <p>버전 ID: {version.id}</p>
              <p>
                현재 버전 생성:{" "}
                {new Date(version.createdAt).toLocaleString("ko-KR")}
              </p>
              <p>
                {dataset.source.kind === "derived"
                  ? "파생 자료 최초 결과"
                  : "원본"}{" "}
                {dataset.original.table.rows.length}행과 이전 버전{" "}
                {Math.max(0, dataset.versions.length - 1)}개를 보존 중입니다.
              </p>
            </details>
          </>
        ) : (
          <p className="muted">자료를 선택하거나 파일을 열어 시작하세요.</p>
        )}
      </section>
      <section className="inspector-section">
        <h3>속성 정보</h3>
        {version ? (
          <>
            <label className="field-label">
              선택한 속성
              <select
                aria-label="선택한 속성"
                className="attribute-select"
                value={attribute?.id || ""}
                onChange={(e) => {
                  selectAttribute(e.target.value || null);
                  setFrequencyPage(0);
                }}
              >
                <option value="">속성을 선택하세요</option>
                {version.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {attribute && (
              <>
                <dl className="attribute-info">
                  <div>
                    <dt>저장 자료형</dt>
                    <dd>{storageLabels[attribute.storageType]}</dd>
                  </div>
                  <div>
                    <dt>의미 유형</dt>
                    <dd>{semanticLabels[attribute.semanticType]}</dd>
                  </div>
                  <div>
                    <dt>분석 사용</dt>
                    <dd>{attribute.useInAnalysis ? "사용" : "제외"}</dd>
                  </div>
                </dl>
                <p>{attribute.description || "설명 없음"}</p>
                <p className="attribute-id">고유 ID {attribute.id}</p>
                <button
                  className="secondary-button"
                  onClick={() => editAttribute({ ...attribute })}
                >
                  속성 편집
                </button>
              </>
            )}
          </>
        ) : (
          <p className="muted">선택한 자료가 없습니다.</p>
        )}
      </section>
      <section className="inspector-section">
        <h3>기술통계</h3>
        <label className="field-label">
          통계 기준
          <select
            aria-label="통계 기준"
            value={tableView.statisticsScope}
            onChange={(e) => {
              setScope(e.target.value as TableView["statisticsScope"]);
              setFrequencyPage(0);
            }}
          >
            <option value="all">전체 자료</option>
            <option value="filtered">현재 필터 조건에 맞는 자료</option>
          </select>
        </label>
        <p className="stat-basis">
          {tableView.statisticsScope === "all" ? "전체 자료" : "필터된 자료"}{" "}
          {inspection?.statisticsRows ?? "…"}행 기준 · 페이지와 선택 여부 무관
        </p>
        {!attribute ? (
          <p className="muted">속성을 선택하면 통계를 확인할 수 있습니다.</p>
        ) : !stat ? (
          <p role="status">통계 계산 중이거나 취소되었습니다.</p>
        ) : (
          <>
            <dl className="attribute-info">
              <div>
                <dt>결측값</dt>
                <dd>
                  {stat.missing}개 ({number(stat.missingRatio * 100)}%)
                </dd>
              </div>
              <div>
                <dt>고유값 (결측 제외)</dt>
                <dd>{stat.unique}개</dd>
              </div>
              {stat.numeric &&
                Object.entries({
                  유효값: stat.numeric.valid,
                  최솟값: stat.numeric.min,
                  최댓값: stat.numeric.max,
                  평균: stat.numeric.mean,
                  중앙값: stat.numeric.median,
                  "표본 표준편차": stat.numeric.stddev,
                }).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{number(value)}</dd>
                  </div>
                ))}
            </dl>
            {stat.numeric?.overflow && (
              <p role="alert">
                값의 범위가 너무 커 일부 통계를 계산할 수 없습니다.
              </p>
            )}
            {stat.numeric && (
              <p className="muted">
                결측 제외, 표준편차는 표본 기준(n−1)입니다. 유효값 2개 미만이면
                계산하지 않습니다.
              </p>
            )}
            {frequencies && (
              <>
                <h4>값별 빈도 (결측 제외)</h4>
                <ul className="frequency-list">
                  {frequencies
                    .slice(page * 20, (page + 1) * 20)
                    .map((entry, i) => (
                      <li key={i}>
                        <span title={String(entry.value)}>
                          {String(entry.value)}
                        </span>
                        <strong>{entry.count}</strong>
                      </li>
                    ))}
                </ul>
                {frequencies.length > 20 && (
                  <div className="frequency-pages">
                    <button
                      disabled={!page}
                      onClick={() => setFrequencyPage(page - 1)}
                    >
                      이전
                    </button>
                    <span>
                      {page + 1}/{maxPage}
                    </span>
                    <button
                      disabled={page + 1 >= maxPage}
                      onClick={() => setFrequencyPage(page + 1)}
                    >
                      다음
                    </button>
                  </div>
                )}
              </>
            )}
            {!stat.numeric && attribute.semanticType !== "categorical" && (
              <p className="muted">
                {semanticLabels[attribute.semanticType]} 속성에는 수치 통계를
                자동 적용하지 않습니다.
              </p>
            )}
          </>
        )}
        <p className="missing-policy">
          결측 기준: null과 빈 문자열만 해당합니다. 공백·NA·0은 값으로
          보존합니다.
        </p>
      </section>
    </>
  );
}
