import { useEffect, useRef, useState } from "react";
import type {
  Attribute,
  Dataset,
  DeepReadonly,
  DataVersion,
  TableEdit,
} from "../domain/types";
import { useTask } from "../workers/useTask";
import { AttributeFields, ErrorNotice, TaskStatus } from "./DataControls";

export type EditTarget =
  | { kind: "attribute"; attribute: Attribute }
  | {
      kind: "cell";
      rowId: string;
      attribute: Attribute;
      value: string;
      missing: boolean;
    };
export function EditPanel({
  target,
  dataset,
  versionId,
  onCommit,
  onClose,
}: {
  target: EditTarget;
  dataset: Dataset;
  versionId: string;
  onCommit: (version: DeepReadonly<DataVersion>) => void;
  onClose: () => void;
}) {
  const [attribute, setAttribute] = useState(target.attribute);
  const [value, setValue] = useState(
    target.kind === "cell" ? target.value : "",
  );
  const [missing, setMissing] = useState(
    target.kind === "cell" && target.missing,
  );
  const [allowLoss, setAllowLoss] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "start" });
  }, []);
  const task = useTask("table-edit");
  const submit = () => {
    const edit: TableEdit =
      target.kind === "cell"
        ? {
            kind: "cell",
            rowId: target.rowId,
            attributeId: attribute.id,
            value,
            missing,
          }
        : { kind: "attribute", attribute, allowLoss };
    task.run({ kind: "edit", dataset, versionId, edit }, (result) => {
      if (result.kind === "edit") {
        if (result.version) {
          onCommit(result.version);
          onClose();
        } else {
          setUnchanged(true);
        }
      }
    });
  };
  return (
    <section ref={panel} className="edit-panel" aria-label="편집 확정">
      <div className="section-heading">
        <h2>
          {target.kind === "cell" ? `${attribute.name} · 셀 편집` : "속성 편집"}
        </h2>
        <button
          onClick={() => {
            task.cancel();
            onClose();
          }}
        >
          편집 취소
        </button>
      </div>
      <p>
        확정하면 새 버전이 생성됩니다. 원본과 이전 버전은 그대로 보존됩니다.
      </p>
      {target.kind === "attribute" ? (
        <>
          <AttributeFields
            attribute={attribute}
            onChange={(next) => {
              task.cancel();
              setAttribute(next);
              setUnchanged(false);
            }}
          />
          <label className="check-label">
            <input
              type="checkbox"
              checked={allowLoss}
              onChange={(e) => {
                task.cancel();
                setAllowLoss(e.target.checked);
                setUnchanged(false);
              }}
            />
            숫자 변환 시 앞자리 0이 사라질 수 있음을 확인했습니다. (00123 → 123)
          </label>
        </>
      ) : (
        <div className="cell-edit-fields">
          <label>
            새 값
            <textarea
              autoFocus
              aria-label="새 값"
              value={value}
              disabled={missing}
              onChange={(e) => {
                task.cancel();
                setValue(e.target.value);
                setUnchanged(false);
              }}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={missing}
              onChange={(e) => {
                task.cancel();
                setMissing(e.target.checked);
                setUnchanged(false);
              }}
            />
            빈 값(null)으로 지정
          </label>
          <p className="muted">
            숫자는 유한한 값, 날짜는 YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm:ss,
            불리언은 true/false로 입력하세요. 입력값은 자동으로 0으로 대체되지
            않습니다.
          </p>
        </div>
      )}
      {unchanged && (
        <p role="status">실제 변경이 없어 새 버전을 만들지 않았습니다.</p>
      )}
      {task.busy && <TaskStatus {...task} />}
      <ErrorNotice error={task.error} />
      <button className="primary-button" disabled={task.busy} onClick={submit}>
        편집 확정
      </button>
    </section>
  );
}
