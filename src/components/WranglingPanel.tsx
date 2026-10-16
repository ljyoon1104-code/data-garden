import { useState, type ReactNode } from "react";
import type { WranglingControl } from "./useWrangling";
import type {
  Attribute,
  Cell,
  DeepReadonly,
  Project,
  VersionRef,
} from "../domain/types";
import type {
  WranglingSettings,
  DatePart,
  FittedWrangling,
  WranglingPreview,
  InputTable,
} from "../domain/wrangling-types";
import {
  wranglingLabels,
  operatorLabels,
  datePartLabels,
  aggregateLabels,
  isDerived,
  typedKey,
} from "../domain/wrangling";
import {
  traceProcessing,
  attributeAncestors,
  resolveVersion,
} from "../domain/processing";
import { TaskStatus, ErrorNotice } from "./DataControls";
import { storageLabels, semanticLabels } from "../domain/table";

const operationLabels: Record<string, string> = {
  sample: "샘플 준비", import: "파일 입력", transform: "자료형 적용",
  "edit-cell": "셀 편집", "edit-attribute": "속성 편집",
  preprocess: "전처리", clean: "자료 정리", derive: "계산 열", join: "결합",
};

const valueText = (v: Cell) =>
  v === null ? "null" : v === "" ? "빈 문자열" : String(v);
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {Object.entries(options).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="check-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
const options = (columns: readonly DeepReadonly<Attribute>[], empty = true) =>
  Object.fromEntries([
    ...(empty ? [["", "선택하세요"]] : []),
    ...columns.map((c) => [
      c.id,
      `${c.name} · ${storageLabels[c.storageType]}/${semanticLabels[c.semanticType]}`,
    ]),
  ]);
function Paged({
  items,
  render,
  label,
}: {
  items: readonly unknown[];
  render: (item: any, index: number) => ReactNode;
  label: string;
}) {
  const [page, setPage] = useState(0),
    pages = Math.max(1, Math.ceil(items.length / 20)),
    current = Math.min(page, pages - 1);
  return (
    <div className="wrangle-list">
      <p>
        {label} · 전체 {items.length.toLocaleString()}개 · {current + 1}/{pages}
        쪽
      </p>
      {items.slice(current * 20, current * 20 + 20).map((item, i) => (
        <div className="wrangle-list-item" key={current * 20 + i}>
          {render(item, current * 20 + i)}
        </div>
      ))}
      {pages > 1 && (
        <div className="pagination">
          <button disabled={!current} onClick={() => setPage(current - 1)}>
            이전 {label}
          </button>
          <button
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            다음 {label}
          </button>
        </div>
      )}
    </div>
  );
}

export function WranglingSettingsPanel({
  control: c,
}: {
  control: WranglingControl;
}) {
  const s = c.settings,
    change = c.change,
    columns = c.inputs[0]?.table.columns ?? [],
    numeric = columns.filter(
      (c) => c.storageType === "number" && c.semanticType === "numeric",
    );
  const errorPolicy = (
    v: "block" | "missing",
    onChange: (v: "block" | "missing") => void,
  ) => (
    <Select
      label="잘못된 값 처리"
      value={v}
      options={{
        block: "오류가 있으면 적용 차단",
        missing: "오류 행 결과를 결측으로 유지",
      }}
      onChange={(v) => onChange(v as "block" | "missing")}
    />
  );
  const field =
    "output" in s ? (
      <>
        <Text
          label="결과 열 이름"
          value={s.output.name}
          onChange={(name) => change({ ...s, output: { ...s.output, name } })}
        />
        <Text
          label="결과 열 설명"
          value={s.output.description}
          onChange={(description) =>
            change({ ...s, output: { ...s.output, description } })
          }
        />
      </>
    ) : null;
  const multi = s.kind === "join" || s.kind === "stack";
  return (
    <section id="wrangle-settings" className="wrangle-settings">
      <h3>가공·통합 설정</h3>
      <Select
        label="가공 작업"
        value={s.kind}
        options={wranglingLabels}
        onChange={(v) => c.chooseKind(v as WranglingSettings["kind"])}
      />
      <p>
        선택한 버전의 <strong>전체 행</strong>을 사용합니다. 표
        필터·정렬·페이지와 독립적입니다.
      </p>
      {multi && (
        <fieldset>
          <legend>입력 자료와 순서</legend>
          {c.ids.map((id, i) => (
            <div key={id} className="wrangle-input">
              <Select
                label={`입력 자료 ${i + 1}`}
                value={id}
                options={Object.fromEntries(
                  c.available
                    .filter((d) => d.id === id || !c.ids.includes(d.id))
                    .map((d) => [d.id, d.name]),
                )}
                onChange={(v) =>
                  c.chooseInputs(c.ids.map((x, j) => (j === i ? v : x)))
                }
              />
              {s.kind === "stack" && (
                <div className="button-row">
                  <button
                    disabled={i === 0}
                    onClick={() => {
                      const ids = [...c.ids];
                      [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                      c.chooseInputs(ids);
                    }}
                  >
                    앞으로
                  </button>
                  <button
                    disabled={c.ids.length <= 2}
                    onClick={() =>
                      c.chooseInputs(c.ids.filter((_, j) => j !== i))
                    }
                  >
                    입력 제외
                  </button>
                </div>
              )}
            </div>
          ))}
          {(s.kind === "stack" || c.ids.length < 2) && (
            <button
              disabled={c.ids.length === c.available.length}
              onClick={() => {
                const next = c.available.find((d) => !c.ids.includes(d.id));
                if (next) c.chooseInputs([...c.ids, next.id]);
              }}
            >
              입력 자료 추가
            </button>
          )}
        </fieldset>
      )}
      <details>
        <summary>사용 자료 버전</summary>
        {c.inputs.map((i, n) => (
          <p key={i.source.versionId}>
            {n + 1}. {i.name} · {i.table.rows.length}행{" "}
            <small className="technical-id">
              {i.source.datasetId} / {i.source.versionId}
            </small>
          </p>
        ))}
      </details>
      {"name" in s && (
        <Text
          label="새 자료 이름"
          value={s.name}
          onChange={(name) => change({ ...s, name })}
        />
      )}
      {field}
      {s.kind === "calculate" && (
        <>
          <Select
            label="연산"
            value={s.operator}
            options={operatorLabels}
            onChange={(v) =>
              change({
                ...s,
                operator: v as typeof s.operator,
                missing: "propagate",
                operands: ["sum", "mean"].includes(v)
                  ? s.operands
                  : s.operands.slice(0, 2).length === 2
                    ? s.operands
                    : [...s.operands, { kind: "constant", value: 1 }],
              })
            }
          />
          {s.operands.map((o, i) => (
            <fieldset key={i}>
              <legend>피연산자 {i + 1}</legend>
              <Select
                label={`피연산자 ${i + 1} 종류`}
                value={o.kind}
                options={{ attribute: "수치 속성", constant: "상수" }}
                onChange={(kind) =>
                  change({
                    ...s,
                    operands: s.operands.map((x, j) =>
                      j === i
                        ? kind === "attribute"
                          ? { kind, attributeId: numeric[0]?.id ?? "" }
                          : { kind: "constant", value: 0 }
                        : x,
                    ),
                  })
                }
              />
              {o.kind === "attribute" ? (
                <Select
                  label={`피연산자 ${i + 1} 속성`}
                  value={o.attributeId}
                  options={options(numeric)}
                  onChange={(attributeId) =>
                    change({
                      ...s,
                      operands: s.operands.map((x, j) =>
                        j === i ? { kind: "attribute", attributeId } : x,
                      ),
                    })
                  }
                />
              ) : (
                <label>
                  상수 {i + 1}
                  <input
                    aria-label={`상수 ${i + 1}`}
                    type="number"
                    value={Number.isFinite(o.value) ? o.value : ""}
                    onChange={(e) =>
                      change({
                        ...s,
                        operands: s.operands.map((x, j) =>
                          j === i
                            ? {
                                kind: "constant",
                                value:
                                  e.target.value === ""
                                    ? NaN
                                    : Number(e.target.value),
                              }
                            : x,
                        ),
                      })
                    }
                  />
                </label>
              )}
              {["sum", "mean"].includes(s.operator) && (
                <button
                  disabled={s.operands.length === 1}
                  onClick={() =>
                    change({
                      ...s,
                      operands: s.operands.filter((_, j) => j !== i),
                    })
                  }
                >
                  피연산자 {i + 1} 제외
                </button>
              )}
            </fieldset>
          ))}
          {["sum", "mean"].includes(s.operator) && (
            <>
              <button
                onClick={() =>
                  change({
                    ...s,
                    operands: [
                      ...s.operands,
                      { kind: "attribute", attributeId: numeric[0]?.id ?? "" },
                    ],
                  })
                }
              >
                피연산자 추가
              </button>
              <Select
                label="피연산자 결측 규칙"
                value={s.missing}
                options={{
                  propagate: "하나라도 결측이면 결과도 결측",
                  skip: "결측을 제외한 유효값으로 계산",
                }}
                onChange={(v) =>
                  change({ ...s, missing: v as typeof s.missing })
                }
              />
            </>
          )}
          {errorPolicy(s.invalid, (invalid) => change({ ...s, invalid }))}
          <p className="scope-notice">
            {s.operands
              .map((o) =>
                o.kind === "constant"
                  ? String(o.value)
                  : (columns.find((c) => c.id === o.attributeId)?.name ??
                    "미선택"),
              )
              .join(" · ")}{" "}
            → {operatorLabels[s.operator]}
            {s.operator === "percent"
              ? " (첫 값 ÷ 둘째 값 × 100)"
              : s.operator === "ratio"
                ? " (첫 값 ÷ 둘째 값)"
                : ""}
            . 유효값이 없으면 결측입니다. 내부 값은 반올림하지 않습니다.
          </p>
        </>
      )}
      {s.kind === "date" && (
        <>
          <Select
            label="날짜 속성"
            value={s.attributeId}
            options={options(columns.filter((c) => c.semanticType === "date"))}
            onChange={(attributeId) => change({ ...s, attributeId })}
          />
          <p>
            시간대 변환 없이 문자열의 날짜·시각을 분리합니다. 요일은 월요일
            1~일요일 7입니다. 시각이 없는 날짜의 시·분·초는 결측입니다.
          </p>
          {(Object.entries(datePartLabels) as [DatePart, string][]).map(
            ([part, label]) => {
              const p = s.parts.find((p) => p.part === part);
              return (
                <fieldset key={part}>
                  <Check
                    label={label + " 생성"}
                    checked={!!p}
                    onChange={(checked) =>
                      change({
                        ...s,
                        parts: checked
                          ? [
                              ...s.parts,
                              {
                                part,
                                name: label,
                                description: "",
                                storageType: "number",
                                semanticType: [
                                  "month",
                                  "quarter",
                                  "weekday",
                                ].includes(part)
                                  ? "categorical"
                                  : "numeric",
                              },
                            ]
                          : s.parts.filter((p) => p.part !== part),
                      })
                    }
                  />
                  {p && (
                    <>
                      <Text
                        label={label + " 열 이름"}
                        value={p.name}
                        onChange={(name) =>
                          change({
                            ...s,
                            parts: s.parts.map((x) =>
                              x.part === part ? { ...x, name } : x,
                            ),
                          })
                        }
                      />
                      <Text
                        label={label + " 설명"}
                        value={p.description}
                        onChange={(description) =>
                          change({
                            ...s,
                            parts: s.parts.map((x) =>
                              x.part === part ? { ...x, description } : x,
                            ),
                          })
                        }
                      />
                      <Select
                        label={label + " 저장형"}
                        value={p.storageType}
                        options={{ number: "숫자", string: "문자열" }}
                        onChange={(v) =>
                          change({
                            ...s,
                            parts: s.parts.map((x) =>
                              x.part === part
                                ? {
                                    ...x,
                                    storageType: v as "number" | "string",
                                    semanticType:
                                      v === "string" &&
                                      x.semanticType === "numeric"
                                        ? "categorical"
                                        : x.semanticType,
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                      <Select
                        label={label + " 의미 유형"}
                        value={p.semanticType}
                        options={
                          p.storageType === "number"
                            ? {
                                numeric: "수치",
                                categorical: "범주",
                                identifier: "식별자",
                                text: "텍스트",
                              }
                            : {
                                categorical: "범주",
                                identifier: "식별자",
                                text: "텍스트",
                              }
                        }
                        onChange={(v) =>
                          change({
                            ...s,
                            parts: s.parts.map((x) =>
                              x.part === part
                                ? {
                                    ...x,
                                    semanticType: v as typeof p.semanticType,
                                  }
                                : x,
                            ),
                          })
                        }
                      />
                    </>
                  )}
                </fieldset>
              );
            },
          )}
          {errorPolicy(s.invalid, (invalid) => change({ ...s, invalid }))}
        </>
      )}
      {s.kind === "encode" && (
        <>
          <Select
            label="범주 속성"
            value={s.attributeId}
            options={options(
              columns.filter((c) => c.semanticType === "categorical"),
            )}
            onChange={(attributeId) =>
              change({ ...s, attributeId, order: null, baseline: null })
            }
          />
          <Select
            label="인코딩 방법"
            value={s.method}
            options={{ code: "범주별 숫자 코드", onehot: "원핫 0/1 열" }}
            onChange={(v) => change({ ...s, method: v as typeof s.method })}
          />
          <p>
            코드는 처음 나타난 순서의 0부터 시작하며 범주 의미를 유지합니다.
            숫자 크기는 양이나 서열을 뜻하지 않습니다. 결측은 null, 미등록
            범주의 원핫 결과도 모든 열 null이며 기준 범주(모두 0)와 구분합니다.
          </p>
          <Select
            label="미등록 범주 처리"
            value={s.unknown}
            options={{
              block: "미등록 범주가 있으면 적용 차단",
              missing: "새 열 생성 없이 결측 유지",
            }}
            onChange={(v) => change({ ...s, unknown: v as typeof s.unknown })}
          />
          {s.method === "onehot" && (
            <>
              <Check
                label="기준 범주 하나 제외"
                checked={s.dropBaseline}
                onChange={(dropBaseline) => change({ ...s, dropBaseline })}
              />
              <p>
                기본 기준은 사전의 첫 범주입니다. 미리보기의 대응표에서 기준
                범주를 바꿀 수 있습니다.
              </p>
            </>
          )}
          {s.order && (
            <>
              <h4>사용자 지정 코드 순서</h4>
              <Paged
                label="범주 순서"
                items={s.order}
                render={(v: Cell, i) => (
                  <div>
                    {i} · {typeof v}:{valueText(v)}{" "}
                    <button
                      disabled={!i}
                      onClick={() => {
                        const order = [...s.order!];
                        [order[i - 1], order[i]] = [order[i], order[i - 1]];
                        change({ ...s, order });
                      }}
                    >
                      앞 순서로
                    </button>
                  </div>
                )}
              />
              <button onClick={() => change({ ...s, order: null })}>
                등장 순서로 복원
              </button>
            </>
          )}
        </>
      )}
      {s.kind === "bin" && (
        <>
          <Select
            label="구간화 속성"
            value={s.attributeId}
            options={options(numeric)}
            onChange={(attributeId) => change({ ...s, attributeId })}
          />
          <Select
            label="구간화 방법"
            value={s.method}
            options={{
              width: "동일 폭",
              frequency: "동일 빈도 (선형 보간 분위수)",
            }}
            onChange={(v) => change({ ...s, method: v as typeof s.method })}
          />
          <label>
            요청 구간 수
            <input
              aria-label="요청 구간 수"
              type="number"
              min="2"
              max="200"
              value={s.count}
              onChange={(e) => {
                const count = Number(e.target.value);
                change({
                  ...s,
                  count,
                  labels: Array.from(
                    { length: Math.max(0, Math.min(200, count)) },
                    (_, i) => s.labels[i] ?? `구간 ${i + 1}`,
                  ),
                });
              }}
            />
          </label>
          <details>
            <summary>구간 범주 이름</summary>
            <Paged
              label="구간 이름"
              items={s.labels}
              render={(name: string, i) => (
                <Text
                  label={`구간 ${i + 1} 이름`}
                  value={name}
                  onChange={(v) =>
                    change({
                      ...s,
                      labels: s.labels.map((x, j) => (j === i ? v : x)),
                    })
                  }
                />
              )}
            />
          </details>
          <Select
            label="학습 범위 밖의 값"
            value={s.outside}
            options={{
              missing: "결측 유지",
              block: "적용 차단",
              edge: "가장 가까운 끝 구간",
            }}
            onChange={(v) => change({ ...s, outside: v as typeof s.outside })}
          />
          <p>
            왼쪽 포함·오른쪽 제외, 마지막 구간은 양끝 포함입니다. 동일 빈도는
            (n−1)p 선형 보간을 사용합니다. 중복 경계는 통합하며 같은 값은 같은
            구간에 배정합니다. 범주 이름은 경계를 바꾸지 않습니다.
          </p>
        </>
      )}
      {s.kind === "join" && (
        <>
          <Select
            label="결합 방식"
            value={s.mode}
            options={{
              inner: "내부 결합",
              left: "왼쪽 결합",
              full: "전체 외부 결합",
            }}
            onChange={(v) => change({ ...s, mode: v as typeof s.mode })}
          />
          {s.keys.map((key, i) => (
            <fieldset key={i}>
              <legend>결합 키 {i + 1}</legend>
              <Select
                label={`왼쪽 키 ${i + 1}`}
                value={key.left}
                options={options(columns)}
                onChange={(left) =>
                  change({
                    ...s,
                    keys: s.keys.map((x, j) => (j === i ? { ...x, left } : x)),
                  })
                }
              />
              <Select
                label={`오른쪽 키 ${i + 1}`}
                value={key.right}
                options={options(c.inputs[1]?.table.columns ?? [])}
                onChange={(right) =>
                  change({
                    ...s,
                    keys: s.keys.map((x, j) => (j === i ? { ...x, right } : x)),
                  })
                }
              />
              <button
                disabled={s.keys.length === 1}
                onClick={() =>
                  change({ ...s, keys: s.keys.filter((_, j) => j !== i) })
                }
              >
                키 {i + 1} 제외
              </button>
            </fieldset>
          ))}
          <button
            onClick={() =>
              change({ ...s, keys: [...s.keys, { left: "", right: "" }] })
            }
          >
            복합 키 추가
          </button>
          <p>
            숫자·문자열, 앞자리 0, 공백, 대소문자를 구분합니다. null·빈 문자열
            키는 연결하지 않습니다. 양쪽 키 열을 보존합니다.
          </p>
          <details>
            <summary>결합 출력 열 이름</summary>
            {c.inputs.map((input, i) => (
              <fieldset key={i}>
                <legend>
                  {i === 0 ? "왼쪽" : "오른쪽"} · {input.name}
                </legend>
                {input.table.columns.map((col) => (
                  <Text
                    key={col.id}
                    label={`${i === 0 ? "왼쪽" : "오른쪽"} ${col.name} 결과 이름`}
                    value={
                      s.columnNames[`${i}:${col.id}`] ??
                      `${col.name}${c.inputs[1 - i]?.table.columns.some((other) => other.name === col.name) ? (i === 0 ? " (왼쪽)" : " (오른쪽)") : ""}`
                    }
                    onChange={(name) =>
                      change({
                        ...s,
                        columnNames: {
                          ...s.columnNames,
                          [`${i}:${col.id}`]: name,
                        },
                      })
                    }
                  />
                ))}
              </fieldset>
            ))}
          </details>
        </>
      )}
      {s.kind === "stack" && (
        <>
          <p>
            이름 기반 대응은 제안입니다. 각 입력 열의 결과 열을 확인하세요. 값은
            변환하지 않으며 없는 칸은 null입니다.
          </p>
          {c.inputs.map((input, i) => (
            <fieldset key={i}>
              <legend>
                {i + 1}. {input.name}
              </legend>
              {input.table.columns.map((col) => {
                const source = { input: i, attributeId: col.id },
                  selected =
                    s.mappings.find((m) =>
                      m.sources.some(
                        (a) => a.input === i && a.attributeId === col.id,
                      ),
                    )?.key ?? "exclude";
                return (
                  <Select
                    key={col.id}
                    label={`${i + 1}번 ${col.name} 대응 (${storageLabels[col.storageType]}/${semanticLabels[col.semanticType]})`}
                    value={selected}
                    options={{
                      ...Object.fromEntries(
                        s.mappings.map((m) => [m.key, m.name]),
                      ),
                      new: "새 별도 열",
                      exclude: "명시적으로 제외",
                    }}
                    onChange={(key) => {
                      const mappings = s.mappings.map((m) => ({
                          ...m,
                          sources: m.sources.filter(
                            (a) => a.input !== i || a.attributeId !== col.id,
                          ),
                        })),
                        excluded = s.excluded.filter(
                          (a) => a.input !== i || a.attributeId !== col.id,
                        );
                      if (key === "exclude") excluded.push(source);
                      else if (key === "new")
                        mappings.push({
                          key: crypto.randomUUID(),
                          name: col.name,
                          sources: [source],
                        });
                      else
                        mappings
                          .find((m) => m.key === key)!
                          .sources.push(source);
                      change({
                        ...s,
                        mappings: mappings.filter((m) => m.sources.length),
                        excluded,
                      });
                    }}
                  />
                );
              })}
            </fieldset>
          ))}
          <details>
            <summary>이어 붙이기 결과 열 이름</summary>
            {s.mappings.map((m, i) => (
              <Text
                key={m.key}
                label={`대응 열 ${i + 1} 이름`}
                value={m.name}
                onChange={(name) =>
                  change({
                    ...s,
                    mappings: s.mappings.map((x) =>
                      x.key === m.key ? { ...x, name } : x,
                    ),
                  })
                }
              />
            ))}
          </details>
          <Select
            label="저장형·의미 유형 충돌"
            value={s.typeConflict}
            options={{
              block: "충돌 시 차단 (별도 열로 대응)",
              mixed: "변환 없이 혼합 저장형·텍스트로 보존",
            }}
            onChange={(v) =>
              change({ ...s, typeConflict: v as typeof s.typeConflict })
            }
          />
          <Check
            label="모든 열 대응·제외·유형 충돌을 확인했습니다"
            checked={c.mappingConfirmed}
            onChange={c.setMappingConfirmed}
          />
        </>
      )}
      {s.kind === "aggregate" && (
        <>
          <fieldset>
            <legend>그룹 속성 (복수 선택)</legend>
            {columns.map((col) => (
              <Check
                key={col.id}
                label={col.name}
                checked={s.groupIds.includes(col.id)}
                onChange={(yes) =>
                  change({
                    ...s,
                    groupIds: yes
                      ? [...s.groupIds, col.id]
                      : s.groupIds.filter((id) => id !== col.id),
                  })
                }
              />
            ))}
          </fieldset>
          <Check
            label="결측 그룹 포함 (null과 빈 문자열은 별개)"
            checked={s.includeMissing}
            onChange={(includeMissing) => change({ ...s, includeMissing })}
          />
          {s.aggregates.map((a, i) => (
            <fieldset key={i}>
              <legend>집계 {i + 1}</legend>
              <Select
                label={`집계 ${i + 1} 방법`}
                value={a.method}
                options={aggregateLabels}
                onChange={(v) =>
                  change({
                    ...s,
                    aggregates: s.aggregates.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            method: v as typeof a.method,
                            attributeId:
                              v === "rows" ? null : (numeric[0]?.id ?? ""),
                            name: aggregateLabels[v as typeof a.method],
                          }
                        : x,
                    ),
                  })
                }
              />
              {a.method !== "rows" && (
                <Select
                  label={`집계 ${i + 1} 속성`}
                  value={a.attributeId ?? ""}
                  options={options(a.method === "valid" ? columns : numeric)}
                  onChange={(attributeId) =>
                    change({
                      ...s,
                      aggregates: s.aggregates.map((x, j) =>
                        j === i ? { ...x, attributeId } : x,
                      ),
                    })
                  }
                />
              )}
              <Text
                label={`집계 ${i + 1} 열 이름`}
                value={a.name}
                onChange={(name) =>
                  change({
                    ...s,
                    aggregates: s.aggregates.map((x, j) =>
                      j === i ? { ...x, name } : x,
                    ),
                  })
                }
              />
              <Text
                label={`집계 ${i + 1} 설명`}
                value={a.description}
                onChange={(description) =>
                  change({
                    ...s,
                    aggregates: s.aggregates.map((x, j) =>
                      j === i ? { ...x, description } : x,
                    ),
                  })
                }
              />
              <button
                disabled={s.aggregates.length === 1}
                onClick={() =>
                  change({
                    ...s,
                    aggregates: s.aggregates.filter((_, j) => j !== i),
                  })
                }
              >
                집계 {i + 1} 제외
              </button>
            </fieldset>
          ))}
          <button
            onClick={() =>
              change({
                ...s,
                aggregates: [
                  ...s.aggregates,
                  {
                    method: "mean",
                    attributeId: numeric[0]?.id ?? "",
                    name: "평균",
                    description: "",
                  },
                ],
              })
            }
          >
            집계 추가
          </button>
          <p>
            행 수에는 결측 행도 포함합니다. 유효값 수는 null·빈 문자열을
            제외합니다. 수치 집계는 유한한 수치만 사용하며 전부 결측이면 합계도
            null입니다.
          </p>
        </>
      )}
      <div className="wrangle-actions">
        <button
          className="primary-button"
          disabled={c.task.busy || (s.kind === "stack" && !c.mappingConfirmed)}
          onClick={c.run}
        >
          가공 미리보기
        </button>
        <button onClick={c.clear}>가공 취소</button>
      </div>
      <TaskStatus {...c.task} cancel={c.clear} />
      <ErrorNotice error={c.task.error} />
      {c.preview && (
        <>
          <p>
            {isDerived(s.kind)
              ? "새 파생 자료를 등록합니다."
              : "현재 자료에 새 버전을 만듭니다."}{" "}
            입력 원본과 과거 버전은 보존됩니다.
          </p>
          {c.preview.summary.manyToManyGroups > 0 && (
            <Check
              label={`다대다 결합 ${c.preview.summary.manyToManyGroups}개 그룹, 결과 ${c.preview.summary.outputRows}행 생성을 확인했습니다`}
              checked={c.ack}
              onChange={c.setAck}
            />
          )}
          <button
            className="primary-button"
            disabled={
              c.task.busy ||
              c.preview.issues.some((i) => i.blocking) ||
              (c.preview.summary.manyToManyGroups > 0 && !c.ack)
            }
            onClick={c.apply}
          >
            가공 적용
          </button>
        </>
      )}
    </section>
  );
}

export function WranglingBasis({
  fitted: f,
}: {
  fitted: DeepReadonly<FittedWrangling>;
}) {
  const b = f.basis;
  return (
    <div>
      <p>
        기준 계산:{" "}
        {f.fitScopes
          .map(
            (scope, i) =>
              `입력 ${i + 1} ${scope.kind === "all" ? "전체" : "학습"} ${scope.count}행`,
          )
          .join(" / ")}
        . 결측: null 또는 빈 문자열, 자료형별로 다른 값을 구분합니다.
      </p>
      {b?.kind === "encode" && (
        <Paged
          label="범주 대응"
          items={b.categories}
          render={(cat: any, i) => (
            <p>
              코드 {cat.code} · {typeof cat.value}:{valueText(cat.value)} ·{" "}
              {cat.count}행 {i === b.baselineIndex ? "· 제외한 기준 범주" : ""}{" "}
              ·{" "}
              {f.columns.find((c) => c.id === cat.columnId)?.name ??
                "생성 열 없음"}
            </p>
          )}
        />
      )}{" "}
      {b?.kind === "bin" && (
        <>
          <p>
            요청 {f.settings.kind === "bin" ? f.settings.count : ""}개 → 실제{" "}
            {b.labels.length}개. 왼쪽 포함·오른쪽 제외, 마지막은 양끝 포함.
            분위수: (n−1)p 선형 보간.
          </p>
          <Paged
            label="구간 기준"
            items={b.labels}
            render={(label: string, i) => (
              <p>
                {label}: [{b.boundaries[i]}, {b.boundaries[i + 1]}
                {i === b.labels.length - 1 ? "]" : ")"} · 기준 {b.counts[i]}행
              </p>
            )}
          />
        </>
      )}
    </div>
  );
}

export function WranglingComparison({
  control: c,
}: {
  control: WranglingControl;
}) {
  const p = c.preview;
  if (!p) return null;
  const b = p.fitted.basis,
    s = c.settings;
  return (
    <section className="wrangle-preview">
      <h2>{wranglingLabels[s.kind]} 미리보기</h2>
      <p>
        입력 {p.summary.inputRows.join(" + ")}행 → 결과{" "}
        <strong>
          {p.summary.outputRows.toLocaleString()}행 · {p.summary.outputColumns}
          열
        </strong>{" "}
        ·{" "}
        {isDerived(s.kind)
          ? "새 파생 자료"
          : "새 버전 / 결과 열 " + p.summary.addedColumns + "개"}
      </p>
      {p.warnings.map((w, i) => (
        <p className="scope-notice" key={i}>
          {w}
        </p>
      ))}
      <WranglingBasis fitted={p.fitted} />
      {s.kind === "encode" && b?.kind === "encode" && (
        <>
          <button
            onClick={() =>
              c.change({ ...s, order: b.categories.map((cat) => cat.value) })
            }
          >
            이 대응표로 코드 순서 지정
          </button>
          {s.method === "onehot" && s.dropBaseline && (
            <Select
              label="제외할 기준 범주"
              value={String(b.baselineIndex ?? 0)}
              options={Object.fromEntries(
                b.categories.map((cat, i) => [
                  String(i),
                  `${typeof cat.value}:${valueText(cat.value)}`,
                ]),
              )}
              onChange={(v) =>
                c.change({ ...s, baseline: b.categories[Number(v)].value })
              }
            />
          )}
        </>
      )}
      {p.issues.length > 0 && (
        <details open>
          <summary>
            문제·안내 {p.issues.length}건 (차단{" "}
            {p.issues.filter((i) => i.blocking).length}건)
          </summary>
          <Paged
            label="문제 행"
            items={p.issues}
            render={(issue: any) => (
              <p className={issue.blocking ? "error-text" : ""}>
                입력 {issue.input + 1} · 행 {issue.rowId} ·{" "}
                {issue.blocking ? "적용 차단" : "안내"}: {issue.message}
              </p>
            )}
          />
        </details>
      )}
      {s.kind === "join" && (
        <>
          <p>
            연결된 왼쪽 {p.summary.matchedLeft}행 / 오른쪽{" "}
            {p.summary.matchedRight}행 · 연결 안 됨 왼쪽{" "}
            {p.summary.unmatchedLeft}행 / 오른쪽 {p.summary.unmatchedRight}행.
            아래 키 목록은 결측 키를 제외합니다.
          </p>
          <details open>
            <summary>중복 키와 대응 관계</summary>
            <Paged
              label="결합 키"
              items={p.joinGroups}
              render={(g: any) => (
                <p>
                  {typedKey(g.key)} · {g.relation} · 왼쪽 {g.leftRowIds.length}
                  행 × 오른쪽 {g.rightRowIds.length}행
                  <small className="technical-id">
                    왼쪽 {g.leftRowIds.join(", ")} / 오른쪽{" "}
                    {g.rightRowIds.join(", ")}
                  </small>
                </p>
              )}
            />
          </details>
        </>
      )}
      {s.kind === "bin" && (
        <p>적용 자료 구간별 행 수: {p.summary.binCounts.join(" / ")}</p>
      )}
      <details>
        <summary>출력 열과 참조 속성</summary>
        <Paged
          label="출력 열"
          items={p.table.columns}
          render={(col: Attribute) => (
            <p>
              {col.name} · {storageLabels[col.storageType]}/{semanticLabels[col.semanticType]} ·{" "}
              {col.description}
              <small className="technical-id">{col.id}</small>
              {p.fitted.columnSources[col.id]
                ?.map(
                  (a) =>
                    `입력 ${a.input + 1}: ${c.inputs[a.input].table.columns.find((x) => x.id === a.attributeId)?.name}`,
                )
                .join(" / ") ?? "기존 열 보존"}
            </p>
          )}
        />
      </details>
      <PreviewRows preview={p} inputs={c.inputs} />
    </section>
  );
}
function PreviewRows({
  preview: p,
  inputs,
}: {
  preview: WranglingPreview;
  inputs: InputTable[];
}) {
  const [page, setPage] = useState(0),
    pages = Math.max(1, Math.ceil(p.table.rows.length / 25)),
    current = Math.min(page, pages - 1);
  return (
    <>
      <div className="table-scroll">
        <table>
          <caption>
            결과 미리보기 · 한 쪽 최대 25행 · {current + 1}/{pages}쪽
          </caption>
          <thead>
            <tr>
              <th>행 출처</th>
              {p.table.columns.map((col) => (
                <th key={col.id}>{col.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.table.rows.slice(current * 25, current * 25 + 25).map((row) => (
              <tr key={row.id}>
                <td>
                  <details>
                    <summary>출처 확인</summary>
                    {p.rowSources[row.id].map((origin) => (
                      <div key={origin.input}>
                        {inputs[origin.input].name}
                        <Paged
                          label="입력 행"
                          items={origin.rowIds}
                          render={(id: string) => (
                            <small className="technical-id">{id}</small>
                          )}
                        />
                      </div>
                    ))}
                    {p.summary.validOperandCounts[row.id] !== undefined && (
                      <p>
                        유효 피연산자 {p.summary.validOperandCounts[row.id]}개
                      </p>
                    )}
                  </details>
                </td>
                {p.table.columns.map((col) => (
                  <td key={col.id}>{valueText(row.values[col.id])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <button disabled={!current} onClick={() => setPage(current - 1)}>
          이전 결과
        </button>
        <span>
          전체 {p.table.rows.length}행 · 현재{" "}
          {p.table.rows.slice(current * 25, current * 25 + 25).length}행
        </span>
        <button
          disabled={current === pages - 1}
          onClick={() => setPage(current + 1)}
        >
          다음 결과
        </button>
      </div>
    </>
  );
}

export function ProcessingHistory({
  project,
  source,
}: {
  project: Project;
  source: VersionRef;
}) {
  const lineage = traceProcessing(project, source),
    version = resolveVersion(project, source);
  return (
    <details className="processing-history">
      <summary>전체 가공 이력·자료 출처 ({lineage.steps.length}단계)</summary>
      <p>
        입력 버전은 확정 당시의 보존본입니다. 비활성 자료도 과거 작업의 출처로
        유지됩니다.
      </p>
      {lineage.steps.map((v, i) => {
        const r = v.operation.wrangling;
        return (
          <details key={v.id}>
            <summary>
              {i + 1}.{" "}
              {project.datasets.find((d) => d.id === v.datasetId)?.name} ·{" "}
              {r
                ? wranglingLabels[r.fitted.settings.kind]
                : operationLabels[v.operation.kind] ?? "자료 작업"}
            </summary>
            <small className="technical-id">
              작업 {v.operation.id} · 버전 {v.id}
            </small>
            {r && (
              <>
                <WranglingBasis fitted={r.fitted} />
                {r.inputs.map((input) => (
                  <p key={input.versionId}>
                    {
                      project.datasets.find((d) => d.id === input.datasetId)
                        ?.name
                    }{" "}
                    ·{" "}
                    {project.activeVersions[input.datasetId] === input.versionId
                      ? "현재 버전과 같음"
                      : project.activeVersions[input.datasetId]
                        ? "입력 자료가 갱신됨 · 당시 버전 유지"
                        : "현재 비활성 · 당시 버전 유지"}
                    <small className="technical-id">{input.versionId}</small>
                  </p>
                ))}
                <details>
                  <summary>보존된 방법 설정</summary>
                  <pre>{JSON.stringify(r.fitted.settings, null, 2)}</pre>
                </details>
              </>
            )}
          </details>
        );
      })}
      <details>
        <summary>현재 열의 최초 참조 속성</summary>
        <Paged
          label="속성 계보"
          items={version.columns}
          render={(col: Attribute) => (
            <div>
              {col.name}
              {attributeAncestors(project, source, col.id).map((a) => (
                <small
                  className="technical-id"
                  key={a.versionId + a.attributeId}
                >
                  {project.datasets.find((d) => d.id === a.datasetId)?.name} /{" "}
                  {
                    resolveVersion(project, a).columns.find(
                      (c) => c.id === a.attributeId,
                    )?.name
                  }{" "}
                  · {a.versionId}
                </small>
              ))}
            </div>
          )}
        />
      </details>
      {version.operation.wrangling && (
        <details>
          <summary>결과 행의 입력 행 출처</summary>
          <Paged
            label="결과 행 출처"
            items={version.rows}
            render={(row: any) => (
              <details>
                <summary>결과 행 {row.id}</summary>
                {version.operation.wrangling!.rowSources[row.id].map(
                  (origin) => (
                    <div key={origin.input}>
                      입력 {origin.input + 1}
                      <Paged
                        label="구성 행"
                        items={origin.rowIds}
                        render={(id: string) => (
                          <small className="technical-id">{id}</small>
                        )}
                      />
                    </div>
                  ),
                )}
              </details>
            )}
          />
        </details>
      )}
    </details>
  );
}
