import { useMemo, useState } from "react";
import type {
  Attribute,
  Dataset,
  DeepReadonly,
  DataVersion,
  TableInspection,
  TableView,
  TableFilter,
  WorkError,
} from "../domain/types";
import { semanticLabels, storageLabels } from "../domain/table";
import type { EditTarget } from "./EditPanel";
import { ErrorNotice, TaskStatus } from "./DataControls";

export function DataTable({
  dataset,
  version,
  view,
  selectedAttributeId,
  density,
  inspection,
  busy,
  message,
  error,
  cancel,
  retry,
  setView,
  selectAttribute,
  edit,
  setDensity,
}: {
  dataset: Dataset;
  version: DeepReadonly<DataVersion>;
  view: TableView;
  selectedAttributeId?: string;
  density: string;
  inspection: TableInspection | null;
  busy: boolean;
  message: string;
  error: WorkError | null;
  cancel: () => void;
  retry: () => void;
  setView: (patch: Partial<TableView>) => void;
  selectAttribute: (id: string) => void;
  edit: (target: EditTarget) => void;
  setDensity: (value: "compact" | "comfortable") => void;
}) {
  const [filterColumn, setFilterColumn] = useState(
    version.columns[0]?.id || "",
  );
  const [operator, setOperator] = useState<TableFilter["operator"]>("equals");
  const [filterValue, setFilterValue] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);
  const rowMap = useMemo(
    () =>
      new Map(version.rows.map((row, i) => [row.id, { row, number: i + 1 }])),
    [version],
  );
  const selectedRows = new Set(view.selectedRowIds);
  const selectedColumns = new Set(view.selectedColumnIds);
  const rowIds = inspection?.rowIds || [];
  const pages = Math.max(1, Math.ceil(rowIds.length / view.pageSize));
  const page = Math.min(view.page, pages - 1);
  const pageIds = rowIds.slice(
    page * view.pageSize,
    (page + 1) * view.pageSize,
  );
  const filterAttribute =
    version.columns.find((c) => c.id === filterColumn) || version.columns[0];
  const filterOps: TableFilter["operator"][] =
    filterAttribute?.storageType === "number" ||
    filterAttribute?.semanticType === "date"
      ? ["equals", "gt", "lt", "missing", "present"]
      : filterAttribute?.storageType === "boolean"
        ? ["equals", "missing", "present"]
        : ["contains", "equals", "missing", "present"];
  const activeOperator = filterOps.includes(operator) ? operator : filterOps[0];
  const toggleRow = (id: string) =>
    setView({
      selectedRowIds: selectedRows.has(id)
        ? view.selectedRowIds.filter((x) => x !== id)
        : [...view.selectedRowIds, id],
    });
  const toggleColumn = (id: string) =>
    setView({
      selectedColumnIds: selectedColumns.has(id)
        ? view.selectedColumnIds.filter((x) => x !== id)
        : [...view.selectedColumnIds, id],
    });
  const openCell = (rowId: string, column: Attribute) => {
    const value = rowMap.get(rowId)!.row.values[column.id];
    selectAttribute(column.id);
    edit({
      kind: "cell",
      rowId,
      attribute: { ...column },
      value: value === null ? "" : String(value),
      missing: value === null,
    });
  };
  return (
    <>
      <section className="table-tools" aria-label="표 탐색 설정">
        <div className="filter-controls">
          <label>
            필터 속성
            <select
              aria-label="필터 속성"
              value={filterAttribute?.id}
              onChange={(e) => {
                setFilterColumn(e.target.value);
                setFilterValue("");
              }}
            >
              {version.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            조건
            <select
              aria-label="필터 조건"
              value={activeOperator}
              onChange={(e) =>
                setOperator(e.target.value as TableFilter["operator"])
              }
            >
              {filterOps.map((op) => (
                <option key={op} value={op}>
                  {
                    {
                      contains: "포함",
                      equals: "같음",
                      gt: "초과 / 이후",
                      lt: "미만 / 이전",
                      missing: "결측",
                      present: "값 있음",
                    }[op]
                  }
                </option>
              ))}
            </select>
          </label>
          {!["missing", "present"].includes(activeOperator) && (
            <label>
              비교 값
              {filterAttribute?.storageType === "boolean" ? (
                <select
                  aria-label="필터 값"
                  value={filterValue || "true"}
                  onChange={(e) => setFilterValue(e.target.value)}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  aria-label="필터 값"
                  value={filterValue}
                  placeholder={
                    filterAttribute?.semanticType === "date"
                      ? "YYYY-MM-DD"
                      : "값 입력"
                  }
                  onChange={(e) => setFilterValue(e.target.value)}
                />
              )}
            </label>
          )}
          <button
            onClick={() => {
              const value =
                filterAttribute?.storageType === "boolean"
                  ? filterValue || "true"
                  : filterValue;
              if (
                !["missing", "present"].includes(activeOperator) &&
                !value.length
              ) {
                setFilterError(
                  "비교 값을 입력하세요. 빈 값은 결측 조건을 사용하세요.",
                );
                return;
              }
              setFilterError(null);
              setView({
                filter: {
                  attributeId: filterAttribute.id,
                  operator: activeOperator,
                  value,
                },
                page: 0,
              });
            }}
          >
            필터 적용
          </button>
          <button
            disabled={!view.filter && !view.duplicatesOnly}
            onClick={() => {
              setView({ filter: null, duplicatesOnly: false, page: 0 });
              setFilterError(null);
            }}
          >
            필터 해제
          </button>
        </div>
        {filterError && (
          <p role="alert" className="error-text">
            {filterError}
          </p>
        )}
        {view.filter && (
          <p className="active-filter">
            적용된 조건:{" "}
            {
              version.columns.find((c) => c.id === view.filter?.attributeId)
                ?.name
            }{" "}
            ·{" "}
            {
              {
                contains: "포함",
                equals: "같음",
                gt: "초과 / 이후",
                lt: "미만 / 이전",
                missing: "결측",
                present: "값 있음",
              }[view.filter.operator]
            }{" "}
            {view.filter.value}
          </p>
        )}
        <div className="sort-controls">
          <label>
            정렬 기준
            <select
              aria-label="정렬 기준"
              value={view.sort?.attributeId || ""}
              onChange={(e) =>
                setView({
                  sort: e.target.value
                    ? {
                        attributeId: e.target.value,
                        direction: view.sort?.direction || "asc",
                      }
                    : null,
                  page: 0,
                })
              }
            >
              <option value="">원래 행 순서</option>
              {version.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            정렬 방향
            <select
              aria-label="정렬 방향"
              value={view.sort?.direction || "asc"}
              disabled={!view.sort}
              onChange={(e) =>
                view.sort &&
                setView({
                  sort: {
                    ...view.sort,
                    direction: e.target.value as "asc" | "desc",
                  },
                  page: 0,
                })
              }
            >
              <option value="asc">오름차순</option>
              <option value="desc">내림차순</option>
            </select>
          </label>
          <label>
            표 간격
            <select
              aria-label="표 간격"
              value={density}
              onChange={(e) =>
                setDensity(e.target.value as "compact" | "comfortable")
              }
            >
              <option value="comfortable">여유롭게</option>
              <option value="compact">촘촘하게</option>
            </select>
          </label>
        </div>
        <p className="muted">
          정렬·필터는 화면에만 적용합니다. 가려진 행과 선택 상태는 보존되며 원래
          행 번호를 표시합니다. 결측값은 정렬 시 마지막에 놓입니다.
        </p>
      </section>
      <TaskStatus busy={busy} message={message} cancel={cancel} />
      <ErrorNotice error={error} />
      {!busy && !inspection && (
        <button onClick={retry}>표·통계 다시 계산</button>
      )}
      <section className="table-card" aria-label="현재 자료 표">
        <div className="table-heading">
          <div>
            <h2>
              {dataset.name}
              <span className="version-badge">
                버전{" "}
                {dataset.versions.findIndex((v) => v.id === version.id) + 1}
              </span>
            </h2>
            <p>
              전체 {version.rows.length}행 · {version.columns.length}열 / 조건
              일치 {inspection ? rowIds.length : "계산 중"}행 / 현재 페이지{" "}
              {pageIds.length}행
            </p>
          </div>
          <span>
            {dataset.source.kind === "sample"
              ? "샘플 · 가상 자료"
              : dataset.source.kind === "derived"
                ? "파생 자료"
                : dataset.source.kind === "manual"
                  ? "직접 입력한 자료"
                  : "내 기기의 파일"}
          </span>
        </div>
        <div className="selection-summary">
          선택: 행 {view.selectedRowIds.length}개 · 열{" "}
          {view.selectedColumnIds.length}개 (필터로 가려진 선택 포함)
          <button
            onClick={() =>
              setView({ selectedRowIds: [], selectedColumnIds: [] })
            }
            disabled={
              !view.selectedRowIds.length && !view.selectedColumnIds.length
            }
          >
            선택 해제
          </button>
        </div>
        <div
          className="table-scroll editable-scroll"
          tabIndex={0}
          role="region"
          aria-label="편집 가능한 데이터 표"
        >
          <table className={`editable-table ${density}`}>
            <caption className="sr-only">
              셀 값을 누르면 편집하고 확정 또는 취소할 수 있습니다.
            </caption>
            <thead>
              <tr>
                <th className="row-select">
                  <input
                    type="checkbox"
                    aria-label="현재 페이지 행 모두 선택"
                    disabled={!pageIds.length}
                    checked={
                      !!pageIds.length &&
                      pageIds.every((id) => selectedRows.has(id))
                    }
                    onChange={(e) =>
                      setView({
                        selectedRowIds: e.target.checked
                          ? [...new Set([...view.selectedRowIds, ...pageIds])]
                          : view.selectedRowIds.filter(
                              (id) => !pageIds.includes(id),
                            ),
                      })
                    }
                  />
                </th>
                <th className="row-index">행</th>
                {version.columns.map((column) => (
                  <th
                    key={column.id}
                    className={
                      selectedAttributeId === column.id ? "selected-column" : ""
                    }
                  >
                    <div className="column-selection">
                      <input
                        type="checkbox"
                        aria-label={`${column.name} 열 선택`}
                        checked={selectedColumns.has(column.id)}
                        onChange={() => toggleColumn(column.id)}
                      />
                      <button
                        aria-pressed={selectedAttributeId === column.id}
                        onClick={() => selectAttribute(column.id)}
                      >
                        {column.name}
                        <small>
                          {storageLabels[column.storageType]} ·{" "}
                          {semanticLabels[column.semanticType]}
                        </small>
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageIds.map((id) => {
                const { row, number } = rowMap.get(id)!;
                return (
                  <tr
                    key={row.id}
                    className={selectedRows.has(id) ? "selected-row" : ""}
                  >
                    <td className="row-select">
                      <input
                        type="checkbox"
                        aria-label={`${number}행 선택`}
                        checked={selectedRows.has(id)}
                        onChange={() => toggleRow(id)}
                      />
                    </td>
                    <th scope="row" className="row-index">
                      {number}
                    </th>
                    {version.columns.map((column) => (
                      <td
                        key={column.id}
                        className={
                          selectedAttributeId === column.id
                            ? "selected-column"
                            : ""
                        }
                      >
                        <button
                          className="cell-button"
                          aria-label={`${number}행 ${column.name} 편집`}
                          title={String(row.values[column.id] ?? "빈 값")}
                          onClick={() => openCell(row.id, column)}
                        >
                          {row.values[column.id] === null ? (
                            <span className="null-cell">∅</span>
                          ) : row.values[column.id] === "" ? (
                            <span className="null-cell">빈 문자열</span>
                          ) : (
                            String(row.values[column.id])
                          )}
                        </button>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {inspection && !rowIds.length && (
          <p className="no-rows">
            조건에 맞는 행이 없습니다. 필터를 해제해 보세요.
          </p>
        )}
        <div className="pagination">
          <label>
            페이지당 행
            <select
              aria-label="페이지당 행"
              value={view.pageSize}
              onChange={(e) =>
                setView({ pageSize: Number(e.target.value), page: 0 })
              }
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}행
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={page === 0 || busy}
            onClick={() => setView({ page: page - 1 })}
          >
            이전 페이지
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            disabled={page + 1 >= pages || busy}
            onClick={() => setView({ page: page + 1 })}
          >
            다음 페이지
          </button>
        </div>
      </section>
      <section className="duplicate-panel">
        <div>
          <strong>중복 행 확인 · 전체 자료 기준</strong>
          <p>
            {inspection
              ? `중복 집단 ${inspection.duplicateGroupCount}개 · 해당 행 ${inspection.duplicateRowIds.length}개 · 첫 행을 제외한 추가 중복 ${inspection.duplicateExtraCount}개`
              : "계산 결과를 기다리는 중입니다."}
          </p>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={view.duplicatesOnly}
            onChange={(e) =>
              setView({ duplicatesOnly: e.target.checked, page: 0 })
            }
          />
          중복에 해당하는 행만 보기
        </label>
        <p className="muted">
          모든 열의 실제 값과 자료형이 같은 행을 비교합니다. 빈 문자열과 null은
          서로 다릅니다. 중복 제거는 정리 메뉴에서 미리보기 후 적용할 수
          있습니다.
        </p>
      </section>
    </>
  );
}
