import { wranglingLabels } from "../domain/wrangling";
import { WranglingBasis } from "./WranglingPanel";
import { preprocessingLabels, methodLabels } from "../domain/preprocessing";
import { FittedDetails } from "./PreprocessingPanel";
import { useEffect, useState } from "react";
import type { ProjectLibrary } from "../persistence/useProjects";
import { makeBackup } from "../persistence/format";
import { createWorkspace, activeDatasets } from "../state/workspace";
import type { WorkspaceState } from "../state/workspace";
import type { Project, DeepReadonly, OperationRecord } from "../domain/types";
import { storageLabels, semanticLabels } from "../domain/table";
import { usePwa } from "../pwa/usePwa";
import { useTask } from "../workers/useTask";
import { hasRunningWorkers } from "../workers/client";
import { ErrorNotice, TaskStatus } from "./DataControls";

function changeDescription(
  project: Project,
  op: DeepReadonly<OperationRecord>,
) {
  const d = project.datasets.find((d) => d.id === op.datasetId);
  const before = d?.versions.find((v) => v.id === op.inputVersionIds[0]),
    after = d?.versions.find((v) => v.id === op.outputVersionIds[0]);
  if (op.kind === "edit-cell" && before && after) {
    const settings = op.settings;
    if (
      settings &&
      typeof settings === "object" &&
      !Array.isArray(settings) &&
      "rowId" in settings &&
      "attributeId" in settings &&
      typeof settings.rowId === "string" &&
      typeof settings.attributeId === "string"
    ) {
      const i = after.rows.findIndex((r) => r.id === settings.rowId),
        col = after.columns.find((c) => c.id === settings.attributeId);
      if (i >= 0 && col) {
        const old = before.rows.find((r) => r.id === settings.rowId)?.values[
            col.id
          ],
          value = after.rows[i].values[col.id];
        return `${i + 1}행 · ${col.name}: ${old === null ? "결측" : String(old)} → ${value === null ? "결측" : String(value)}`;
      }
    }
  }
  if (op.kind === "edit-attribute" && before && after) {
    const c = after.columns.find(
      (c) =>
        JSON.stringify(c) !==
        JSON.stringify(before.columns.find((b) => b.id === c.id)),
    );
    if (c) {
      const b = before.columns.find((b) => b.id === c.id)!;
      return [
        b.name !== c.name ? `열 이름 ${b.name} → ${c.name}` : "",
        b.storageType !== c.storageType
          ? `저장형 ${storageLabels[b.storageType]} → ${storageLabels[c.storageType]}`
          : "",
        b.semanticType !== c.semanticType
          ? `의미 ${semanticLabels[b.semanticType]} → ${semanticLabels[c.semanticType]}`
          : "",
        b.description !== c.description
          ? `설명 ${b.description || "없음"} → ${c.description || "없음"}`
          : "",
        b.useInAnalysis !== c.useInAnalysis
          ? `분석 ${c.useInAnalysis ? "사용" : "제외"}`
          : "",
      ]
        .filter(Boolean)
        .join(" / ");
    }
  }
  if (op.wrangling)
    return `${wranglingLabels[op.wrangling.fitted.settings.kind]} · 입력 ${op.wrangling.inputs.length}개 → ${after?.rows.length ?? 0}행 · ${after?.columns.length ?? 0}열`;
  if (op.preprocessing) {
    const p = op.preprocessing,
      s = p.fitted.settings;
    return (
      preprocessingLabels[s.kind] +
      " · " +
      methodLabels["method" in s ? s.method : "keep" in s ? s.keep : s.action] +
      " · 변경 셀 " +
      p.changedCells +
      "개 · 제거 행 " +
      p.removedRowIds.length +
      "개"
    );
  }
  if (op.kind === "import")
    return `파일 ${d?.source.fileName || d?.name} · ${after?.rows.length ?? 0}행 · ${after?.columns.length ?? 0}열`;
  if (op.kind === "transform")
    return "입력 시 선택한 열 이름·자료형·의미 유형 적용";
  return op.kind === "sample" ? "화면 확인용 샘플 준비" : op.kind;
}
const opNames: Record<string, string> = {
  wrangle: "자료 가공·통합",
  preprocess: "자료 전처리",
  sample: "샘플 준비",
  import: "파일 입력",
  transform: "입력 자료형 적용",
  "edit-cell": "셀 값 수정",
  "edit-attribute": "속성 수정",
  clean: "자료 정리",
  derive: "계산 열",
  join: "자료 결합",
};

export function ProjectManager({
  library,
  pwa,
  draft,
  busy,
  setBusy,
}: {
  library: ProjectLibrary;
  pwa: ReturnType<typeof usePwa>;
  draft: boolean;
  busy: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  const [restored, setRestored] = useState<WorkspaceState | null>(null),
    [deleteId, setDeleteId] = useState<string | null>(null),
    [resetText, setResetText] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const task = useTask("project-restore");
  useEffect(() => {
    task.cancel();
    setRestored(null);
  }, [library.epoch, task.cancel]);
  const project = library.state.project;
  const run = async (work: () => Promise<void>, needsClear = true) => {
    if (needsClear && draft) {
      setError(
        "먼저 열려 있는 파일 입력·셀·속성 편집·전처리 미리보기를 확정하거나 취소하세요.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const backup = () => {
    // Confirmed state only; drafts and Workers are absent from this document.
    const blob = new Blob([JSON.stringify(makeBackup(library.state))], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `${project.name.replace(/[<>:"/\\|?*]/g, "_")}-${new Date().toISOString().slice(0, 10)}.datagarden.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const history = [...project.operations].reverse(),
    pages = Math.max(1, Math.ceil(history.length / 20));
  return (
    <section className="project-manager" aria-label="프로젝트 관리">
      <div className="project-toolbar">
        <button
          className={open ? "primary-button" : ""}
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            void library.refresh().catch((e) => setError(String(e)));
          }}
        >
          프로젝트 관리
        </button>
        <button
          disabled={
            busy || draft || !library.writable || project.history.cursor === 0
          }
          onClick={() => library.dispatch({ type: "undo" })}
        >
          되돌리기
        </button>
        <button
          disabled={
            busy ||
            draft ||
            !library.writable ||
            project.history.cursor === project.history.entries.length
          }
          onClick={() => library.dispatch({ type: "redo" })}
        >
          다시 실행
        </button>
        <span className="save-status" role="status">
          {library.status}
        </span>
        <button onClick={backup} disabled={busy}>
          JSON 백업
        </button>
      </div>
      {!library.writable && (
        <p className="storage-warning">
          이 탭은 읽기 전용입니다. 다른 데이터뜰 탭을 닫고 새로고침하면 저장
          권한을 다시 확인합니다. JSON 백업은 가능합니다.
        </p>
      )}
      {(library.error || error) && (
        <div role="alert" className="error-notice">
          <strong>작업을 완료하지 못했습니다.</strong>
          <p>원인: {error || library.error}</p>
          <p>
            해결 방법: 저장 공간·브라우저 권한을 확인하세요. 메모리 자료는
            JSON으로 백업할 수 있습니다. 복원 실패 파일은 변경하지 않고
            보관하며, 올바른 파일을 다시 선택하세요.
          </p>
          <button
            onClick={() => void run(library.flush, false)}
            disabled={busy || !library.writable}
          >
            저장 다시 시도
          </button>
        </div>
      )}
      {pwa.waiting && (
        <div className="update-notice">
          <strong>새 버전이 준비되었습니다.</strong>
          <span>
            원하는 때에 적용하세요. 현재 작업을 저장한 뒤 이 탭만
            새로고침합니다.
          </span>
          <button
            disabled={busy || !library.writable}
            onClick={() =>
              void run(() =>
                pwa.apply(library.flush, () => draft || hasRunningWorkers()),
              )
            }
          >
            저장 후 업데이트 적용
          </button>
        </div>
      )}
      {open && (
        <div className="project-panel">
          <div className="project-columns">
            <section>
              <h2>나의 프로젝트</h2>
              <p className="muted">
                이 브라우저의 로컬 저장과 외부 JSON 백업은 별개입니다. 브라우저
                데이터 삭제 시 로컬 자료도 사라질 수 있으니 중요한 자료는
                백업하세요.
              </p>
              <label>
                프로젝트 이름
                <input
                  aria-label="프로젝트 이름"
                  value={name}
                  placeholder={project.name}
                  maxLength={200}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={busy || !library.writable || !name.trim()}
                  onClick={() => {
                    library.dispatch({ type: "rename", name });
                    setName("");
                  }}
                >
                  이름 변경
                </button>
                <button
                  disabled={busy || !library.writable}
                  onClick={() =>
                    void run(async () => {
                      const next = createWorkspace(false);
                      next.project.name = name.trim() || "새 데이터 탐구";
                      await library.add(next);
                      setName("");
                    })
                  }
                >
                  새 프로젝트
                </button>
              </div>
              <h3>저장된 프로젝트 · {library.list.length}개</h3>
              <ul className="project-list">
                {library.list.map((p) => (
                  <li key={p.id}>
                    <div>
                      <strong>
                        {p.name}
                        {p.id === project.id ? " · 현재" : ""}
                      </strong>
                      <small>
                        {new Date(p.updatedAt).toLocaleString("ko-KR")} · 자료{" "}
                        {p.datasetCount}개
                      </small>
                    </div>
                    <button
                      disabled={busy || p.id === project.id}
                      onClick={() => void run(() => library.open(p.id))}
                    >
                      열기
                    </button>
                    <button
                      disabled={busy || !library.writable}
                      onClick={() => setDeleteId(p.id)}
                    >
                      삭제
                    </button>
                  </li>
                ))}
              </ul>
              {deleteId && (
                <div className="confirm-box">
                  <p>
                    「{library.list.find((p) => p.id === deleteId)?.name}」의
                    로컬 자료·모든 버전·작업 기록을 삭제합니다. 외부 JSON 백업은
                    남습니다.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await library.remove(deleteId);
                        setDeleteId(null);
                      })
                    }
                  >
                    이 프로젝트 삭제 확정
                  </button>
                  <button onClick={() => setDeleteId(null)}>삭제 취소</button>
                </div>
              )}
            </section>
            <section>
              <h2>백업 파일 복원</h2>
              <p>
                검증과 확인을 거쳐 새 프로젝트 사본으로 추가합니다. 최대 80 MiB
                · 원본과 모든 버전을 합해 300만 셀.
              </p>
              <label className="file-label">
                JSON 백업 파일 선택
                <input
                  aria-label="JSON 백업 파일 선택"
                  type="file"
                  accept=".json,application/json"
                  disabled={busy || !library.writable}
                  onChange={(e) => {
                    task.cancel();
                    setRestored(null);
                    const file = e.target.files?.[0];
                    if (file)
                      task.run({ kind: "restore", file }, (result) => {
                        if (result.kind === "restore")
                          setRestored(result.workspace);
                      });
                    e.target.value = "";
                  }}
                />
              </label>
              <TaskStatus {...task} />
              <ErrorNotice error={task.error} />
              {restored && (
                <div className="confirm-box">
                  <h3>{restored.project.name}</h3>
                  <p>
                    자료 {activeDatasets(restored.project).length}개 · 보존 버전{" "}
                    {restored.project.datasets.reduce(
                      (sum, d) => sum + d.versions.length,
                      0,
                    )}
                    개 · 작업 기록 {restored.project.operations.length}개
                  </p>
                  <p>
                    원본·과거 결과·되돌리기 기록과 화면 설정을 함께 복원합니다.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await library.add(restored);
                        setRestored(null);
                        task.cancel();
                      })
                    }
                  >
                    새 프로젝트로 복원 확정
                  </button>
                  <button
                    onClick={() => {
                      task.cancel();
                      setRestored(null);
                    }}
                  >
                    복원 취소
                  </button>
                </div>
              )}
              <h3>앱과 오프라인</h3>
              <p role="status">{pwa.status}</p>
              {pwa.error && <p role="alert">{pwa.error}</p>}
              <div className="button-row">
                {pwa.canInstall && (
                  <button onClick={() => void pwa.prompt()}>
                    기기에 앱 설치
                  </button>
                )}
                <button disabled={busy} onClick={() => void pwa.check()}>
                  업데이트 확인
                </button>
                <button
                  disabled={busy || !library.writable}
                  onClick={() => void run(library.flush, false)}
                >
                  지금 저장
                </button>
              </div>
              <details>
                <summary>공용 PC · 사용자 자료와 설정 지우기</summary>
                <p>
                  이 배포 경로에 저장된 모든 프로젝트와 화면 설정을 지웁니다.
                  앱의 오프라인 프로그램 파일은 남으며, 다른 앱의 저장소는
                  건드리지 않습니다.
                </p>
                <label>
                  확인 문구: 모두 삭제
                  <input
                    aria-label="전체 삭제 확인 문구"
                    value={resetText}
                    onChange={(e) => setResetText(e.target.value)}
                  />
                </label>
                <button
                  disabled={
                    busy || !library.writable || resetText !== "모두 삭제"
                  }
                  onClick={() =>
                    void run(async () => {
                      task.cancel();
                      setRestored(null);
                      await library.reset();
                      setResetText("");
                    })
                  }
                >
                  모든 사용자 자료·설정 삭제 확정
                </button>
              </details>
            </section>
          </div>
          <details className="operation-history">
            <summary>
              작업 기록 · {history.length}개 · 되돌리기 {project.history.cursor}
              /{project.history.entries.length}
            </summary>
            <p>
              되돌리거나 새 분기를 만들어도 과거 작업·버전은 보존합니다. 화면
              정렬·필터는 기록에 포함하지 않습니다.
            </p>
            <ol>
              {history
                .slice(
                  Math.min(historyPage, pages - 1) * 20,
                  (Math.min(historyPage, pages - 1) + 1) * 20,
                )
                .map((op) => (
                  <li key={op.id}>
                    <strong>
                      {opNames[op.kind] || op.kind} ·{" "}
                      {
                        project.datasets.find((d) => d.id === op.datasetId)
                          ?.name
                      }
                    </strong>
                    <p>{changeDescription(project, op)}</p>
                    {op.wrangling && (
                      <details>
                        <summary>가공 설정·계산 기준</summary>
                        <WranglingBasis fitted={op.wrangling.fitted} />
                        <pre>
                          {JSON.stringify(
                            op.wrangling.fitted.settings,
                            null,
                            2,
                          )}
                        </pre>
                        <p>
                          전체 입력·행·열 출처는 해당 자료의 전체 가공 이력에서
                          확인할 수 있습니다.
                        </p>
                      </details>
                    )}
                    {op.preprocessing && (
                      <details>
                        <summary>전처리 설정·계산 기준</summary>
                        <p>
                          최초 전처리 입력: {op.preprocessing.origin.versionId}
                        </p>
                        <p>
                          이전 전처리 작업:{" "}
                          {op.preprocessing.previousOperationIds.join(" → ") ||
                            "없음"}
                        </p>
                        <pre>
                          {JSON.stringify(
                            op.preprocessing.fitted.settings,
                            null,
                            2,
                          )}
                        </pre>
                        <FittedDetails
                          fitted={op.preprocessing.fitted}
                          table={project.datasets
                            .find((d) => d.id === op.datasetId)!
                            .versions.find(
                              (v) => v.id === op.preprocessing!.input.versionId,
                            )!}
                        />
                      </details>
                    )}
                    <small>
                      {new Date(op.executedAt).toLocaleString("ko-KR")}
                    </small>
                    <details>
                      <summary>입력·출력 버전 ID</summary>
                      <p>입력: {op.inputVersionIds.join(", ") || "없음"}</p>
                      <p>출력: {op.outputVersionIds.join(", ") || "없음"}</p>
                    </details>
                  </li>
                ))}
            </ol>
            <div className="button-row">
              <button
                disabled={historyPage === 0}
                onClick={() => setHistoryPage((n) => n - 1)}
              >
                이전 기록
              </button>
              <span>
                {Math.min(historyPage, pages - 1) + 1} / {pages}
              </span>
              <button
                disabled={historyPage >= pages - 1}
                onClick={() => setHistoryPage((n) => n + 1)}
              >
                다음 기록
              </button>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
