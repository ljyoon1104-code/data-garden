import type { Attribute, WorkError } from "../domain/types";
import { semanticLabels, storageLabels } from "../domain/table";

export function ErrorNotice({ error }: { error: WorkError | null }) {
  return error ? (
    <div className="error-notice" role="alert">
      <strong>{error.message}</strong>
      <p>원인: {error.cause}</p>
      <p>해결 방법: {error.remedy}</p>
    </div>
  ) : null;
}
export function TaskStatus({
  busy,
  message,
  cancel,
}: {
  busy: boolean;
  message: string;
  cancel: () => void;
}) {
  return message ? (
    <div className="task-status" role="status">
      <span>
        {busy && <span className="spinner" />}
        {message}
      </span>
      {busy && <button onClick={cancel}>작업 취소</button>}
    </div>
  ) : null;
}
export function AttributeFields({
  attribute,
  onChange,
  prefix = "",
}: {
  attribute: Attribute;
  onChange: (attribute: Attribute) => void;
  prefix?: string;
}) {
  return (
    <div className="attribute-fields">
      <label>
        열 이름
        <input
          aria-label={`${prefix}열 이름`}
          value={attribute.name}
          onChange={(e) => onChange({ ...attribute, name: e.target.value })}
        />
      </label>
      <label>
        저장 자료형
        <select
          aria-label={`${prefix}저장 자료형`}
          value={attribute.storageType}
          onChange={(e) =>
            onChange({
              ...attribute,
              storageType: e.target.value as Attribute["storageType"],
            })
          }
        >
          {Object.entries(storageLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        의미 유형
        <select
          aria-label={`${prefix}의미 유형`}
          value={attribute.semanticType}
          onChange={(e) =>
            onChange({
              ...attribute,
              semanticType: e.target.value as Attribute["semanticType"],
            })
          }
        >
          {Object.entries(semanticLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="description-field">
        설명
        <input
          aria-label={`${prefix}설명`}
          value={attribute.description}
          onChange={(e) =>
            onChange({ ...attribute, description: e.target.value })
          }
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={attribute.useInAnalysis}
          onChange={(e) =>
            onChange({ ...attribute, useInAnalysis: e.target.checked })
          }
        />
        분석에 사용
      </label>
    </div>
  );
}
