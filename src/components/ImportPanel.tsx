import { useState } from "react";
import type {
  Attribute,
  Dataset,
  ImportOptions,
  ParsedImport,
} from "../domain/types";
import { defaultImportOptions } from "../data/import-options";
import { convertCell, semanticLabels, storageLabels } from "../domain/table";
import { useTask } from "../workers/useTask";
import { AttributeFields, ErrorNotice, TaskStatus } from "./DataControls";

export function ImportPanel({
  onImport,
  onClose,
}: {
  onImport: (dataset: Dataset) => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<ImportOptions>(defaultImportOptions);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [columns, setColumns] = useState<Attribute[]>([]);
  const [selected, setSelected] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const task = useTask("file-import");
  const parse = (newFile: File, nextOptions: ImportOptions) => {
    task.cancel();
    setParsed(null);
    setColumns([]);
    setAcknowledged(false);
    setSelected(0);
    task.run(
      { kind: "parse", file: newFile, options: nextOptions },
      (result) => {
        if (result.kind === "parse") {
          setParsed(result.parsed);
          setSheets(result.parsed.sheets);
          setColumns(result.parsed.proposed.columns);
          setOptions(result.parsed.options);
        }
      },
    );
  };
  const change = (patch: Partial<ImportOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    if (file) parse(file, next);
  };
  const xlsx = /\.xlsx$/i.test(file?.name || "");
  return (
    <section className="import-panel" aria-label="파일 입력 미리보기">
      <div className="section-heading">
        <div>
          <span className="eyebrow">기기에서 불러오기</span>
          <h2>파일 열기</h2>
        </div>
        <button
          onClick={() => {
            task.cancel();
            onClose();
          }}
        >
          취소 · 닫기
        </button>
      </div>
      <p>
        미리보기를 확인하고 불러오기를 눌러야 프로젝트에 추가됩니다. 같은 파일도
        새로운 자료로 등록합니다.
      </p>
      <label className="file-field">
        CSV 또는 XLSX 파일
        <input
          type="file"
          accept=".csv,.xlsx"
          aria-label="CSV 또는 XLSX 파일"
          onChange={(e) => {
            const next = e.target.files?.[0];
            if (next) {
              setFile(next);
              setSheets([]);
              const settings = { ...options, sheet: "" };
              setOptions(settings);
              parse(next, settings);
            }
          }}
        />
      </label>
      <div className="input-options">
        {!xlsx && (
          <>
            <label>
              인코딩
              <select
                aria-label="인코딩"
                value={options.encoding}
                onChange={(e) =>
                  change({
                    encoding: e.target.value as ImportOptions["encoding"],
                  })
                }
              >
                <option value="utf-8">UTF-8 / UTF-8 BOM</option>
                <option value="euc-kr">EUC-KR / CP949</option>
              </select>
            </label>
            <label>
              구분자
              <select
                aria-label="구분자"
                value={options.delimiter}
                onChange={(e) =>
                  change({
                    delimiter: e.target.value as ImportOptions["delimiter"],
                  })
                }
              >
                <option value=",">쉼표 (,)</option>
                <option value=";">세미콜론 (;)</option>
                <option value={"\t"}>탭</option>
                <option value="|">파이프 (|)</option>
              </select>
            </label>
          </>
        )}
        {xlsx && (
          <>
            <label>
              시트
              <select
                aria-label="시트"
                value={options.sheet}
                disabled={!sheets.length}
                onChange={(e) => change({ sheet: e.target.value })}
              >
                {(sheets.length ? sheets : [options.sheet]).map((name) => (
                  <option key={name} value={name}>
                    {name || "시트 읽는 중"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              XLSX 값 기준
              <select
                aria-label="XLSX 값 기준"
                value={options.xlsxValues}
                onChange={(e) =>
                  change({
                    xlsxValues: e.target.value as ImportOptions["xlsxValues"],
                  })
                }
              >
                <option value="smart">날짜·앞자리 0 형식 고려</option>
                <option value="raw">실제 셀 값</option>
                <option value="display">표시 문자열</option>
              </select>
            </label>
          </>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={options.header}
            onChange={(e) => change({ header: e.target.checked })}
          />
          첫 행을 열 이름으로 사용
        </label>
        <button
          disabled={!file || task.busy}
          onClick={() => file && parse(file, options)}
        >
          미리보기 갱신
        </button>
      </div>
      <TaskStatus {...task} />
      <ErrorNotice error={task.error} />
      {parsed && (
        <>
          {parsed.empty ? (
            <div className="error-notice" role="alert">
              빈 파일·빈 시트이거나 자료 행이 없습니다. 다른 시트를 선택하거나
              첫 행 설정을 확인하세요.
            </div>
          ) : (
            <>
              <div className="preview-heading">
                <strong>
                  앞 {Math.min(10, parsed.proposed.rows.length)}행 미리보기 /
                  전체 {parsed.proposed.rows.length}행 · {columns.length}열
                </strong>
                <span>열 제목을 눌러 제안 설정을 수정하세요.</span>
              </div>
              <div
                className="table-scroll preview-scroll"
                tabIndex={0}
                role="region"
                aria-label="입력 미리보기 표"
              >
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>행</th>
                      {columns.map((column, i) => (
                        <th key={column.id}>
                          <button
                            onClick={() => setSelected(i)}
                            aria-pressed={selected === i}
                          >
                            <span>
                              {column.name}
                              <small>
                                {storageLabels[column.storageType]} /{" "}
                                {semanticLabels[column.semanticType]} /{" "}
                                {column.useInAnalysis ? "분석 사용" : "제외"}
                              </small>
                            </span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.proposed.rows.slice(0, 10).map((row, i) => (
                      <tr key={row.id}>
                        <th>{i + 1}</th>
                        {columns.map((column) => {
                          const original =
                            parsed.original.rows[i].values[column.id];
                          let value = "";
                          try {
                            value = String(
                              convertCell(row.values[column.id], column) ?? "∅",
                            );
                          } catch {
                            value = "⚠ 변환 불가";
                          }
                          const meta = parsed.cellMetadata[row.id]?.[column.id];
                          return (
                            <td
                              key={column.id}
                              title={`원본: ${String(original ?? "∅")}${meta ? ` / 표시: ${meta.display} / 형식: ${meta.format}` : ""}`}
                            >
                              <span>
                                {value === "" ? "(빈 문자열)" : value}
                              </span>
                              {String(original ?? "∅") !== value && (
                                <small className="raw-value">
                                  원본: {String(original ?? "∅")}
                                </small>
                              )}
                              {meta &&
                                meta.display !== String(original ?? "") && (
                                  <small className="raw-value">
                                    파일 표시: {meta.display}
                                  </small>
                                )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="schema-editor">
                <label>
                  설정할 열
                  <select
                    aria-label="설정할 열"
                    value={selected}
                    onChange={(e) => setSelected(Number(e.target.value))}
                  >
                    {columns.map((c, i) => (
                      <option key={c.id} value={i}>
                        {i + 1}. {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                {columns[selected] && (
                  <AttributeFields
                    prefix="미리보기 "
                    attribute={columns[selected]}
                    onChange={(column) => {
                      task.cancel();
                      setColumns(
                        columns.map((c, i) => (i === selected ? column : c)),
                      );
                      setAcknowledged(false);
                    }}
                  />
                )}
              </div>
              <div className="import-warnings">
                <strong>입력 기준과 확인 사항</strong>
                <p>
                  빈 문자열과 null만 결측값으로 셉니다. 공백, NA, 0은 그대로
                  보존합니다. 숫자 변환 시 00123 → 123처럼 앞자리 0이
                  사라집니다. 코드·번호는 문자열·식별자를 권장합니다.
                </p>
                {xlsx && (
                  <p>
                    실제 셀 값과 표시 형식을 원본에 함께 보존합니다. XLSX에 이미
                    없는 앞자리 0과 정밀도는 복구하지 않습니다. 날짜 문자열에는
                    시간대를 덧붙이지 않습니다.
                  </p>
                )}
                {parsed.issues.length > 0 && (
                  <details open>
                    <summary>입력 보정 안내 {parsed.issues.length}건</summary>
                    <ul>
                      {parsed.issues.map((issue, i) => (
                        <li key={i}>
                          {issue.message}
                          <br />
                          <span>{issue.remedy}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <label className="check-label review-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => {
                    task.cancel();
                    setAcknowledged(e.target.checked);
                  }}
                />
                열 이름·자료형·의미 유형과 보정·앞자리 0 손실 안내를
                확인했습니다.
              </label>
              <button
                className="primary-button"
                disabled={task.busy || !acknowledged}
                onClick={() =>
                  task.run(
                    { kind: "register", parsed, columns, acknowledged },
                    (result) => {
                      if (result.kind === "register") {
                        onImport(result.dataset);
                        onClose();
                      }
                    },
                  )
                }
              >
                불러오기
              </button>
            </>
          )}
        </>
      )}
      <p className="muted">
        지원 범위: 파일 20MB, 50,000행, 200열, 500,000셀. 범위를 넘으면 부분
        입력 없이 안내합니다.
      </p>
    </section>
  );
}
