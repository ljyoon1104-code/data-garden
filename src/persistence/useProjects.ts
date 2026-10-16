import { useCallback, useEffect, useRef, useState } from "react";
import { createWorkspace, workspaceReducer } from "../state/workspace";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import {
  IndexedProjects,
  SaveQueue,
  acquireWriter,
  deploymentPath,
  storageNamespace,
  hydrateProjects,
} from "./store";
import type { ProjectSummary } from "./store";
import { cancelAllWorkers } from "../workers/client";
import { snapshot } from "../domain/model";

export function useProjects() {
  const [state, setState] = useState(() => createWorkspace(false));
  const current = useRef(state),
    storage = useRef<IndexedProjects | null>(null),
    queue = useRef<SaveQueue | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allowed = useRef(false),
    autosave = useRef(false),
    dirty = useRef(false);
  const [ready, setReady] = useState(false),
    [writable, setWritable] = useState(false),
    [epoch, setEpoch] = useState(0);
  const [list, setList] = useState<ProjectSummary[]>([]),
    [status, setStatus] = useState("저장된 프로젝트를 확인하는 중…"),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (storage.current) setList(await storage.current.list());
  }, []);
  const replace = useCallback((next: WorkspaceState, save = true) => {
    // Structured cloning from a Worker does not retain Object.freeze.
    next = {
      ...next,
      project: {
        ...next.project,
        datasets: next.project.datasets.map((d) => ({
          ...d,
          original: snapshot(d.original),
          versions: d.versions.map((v) => snapshot(v)),
        })),
        operations: next.project.operations.map((op) => snapshot(op)),
        analyses: next.project.analyses.map((a) => ({
          ...a,
          configSnapshot: snapshot(a.configSnapshot),
          ...(a.association
            ? { association: snapshot(a.association) as typeof a.association }
            : {}),
          ...(a.clustering
            ? { clustering: snapshot(a.clustering) as typeof a.clustering }
            : {}),
          ...(a.regression
            ? { regression: snapshot(a.regression) as typeof a.regression }
            : {}),
        })),
      },
    };
    clearTimeout(timer.current);
    queue.current?.invalidate();
    cancelAllWorkers();
    current.current = next;
    autosave.current = save;
    dirty.current = save;
    setState(next);
    setEpoch((n) => n + 1);
    setError("");
    setStatus(save ? "저장 대기 중…" : "저장된 프로젝트를 불러왔습니다.");
  }, []);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (!allowed.current || !queue.current)
      throw new Error(
        "이 탭에는 저장 권한이 없습니다. 쓰기 가능한 탭에서 저장하거나 JSON으로 백업하세요.",
      );
    const value = current.current;
    setStatus("저장 중…");
    try {
      const saved = await queue.current.save(value);
      if (!saved)
        throw new Error("저장 요청이 취소되었습니다. 다시 저장하세요.");
      if (current.current === value) {
        dirty.current = false;
        setStatus(`저장 완료 · ${new Date().toLocaleTimeString("ko-KR")}`);
        setError("");
      }
      await refresh();
    } catch (e) {
      setError(String(e));
      setStatus("저장 실패 · 메모리의 자료는 유지됩니다.");
      throw e;
    }
  }, [refresh]);
  useEffect(() => {
    let disposed = false,
      release: (() => void) | null = null,
      db: IndexedProjects | null = null;
    (async () => {
      try {
        const name = storageNamespace(deploymentPath());
        release = await acquireWriter(name);
        if (disposed) {
          release?.();
          return;
        }
        allowed.current = !!release;
        setWritable(!!release);
        db = await IndexedProjects.open(name);
        if (disposed) {
          db.close();
          release?.();
          return;
        }
        storage.current = db;
        queue.current = new SaveQueue(db);
        const {
          projects,
          state: loaded,
          isNew,
        } = await hydrateProjects(db, createWorkspace);
        if (disposed) return;
        setList(projects);
        replace(loaded, isNew && !!release);
        if (!release)
          setStatus(
            "읽기 전용 · 다른 탭에서 사용 중이거나 브라우저가 쓰기 잠금을 지원하지 않습니다.",
          );
      } catch (e) {
        if (!disposed) {
          autosave.current = false;
          setError(String(e));
          setStatus("저장소 복원 실패 · 기존 저장 내용을 덮어쓰지 않았습니다.");
        }
      } finally {
        if (!disposed) setReady(true);
      }
    })();
    const leave = () => {
      clearTimeout(timer.current);
      queue.current?.stop();
      release?.();
      release = null;
    };
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("pagehide", leave);
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) location.reload();
    };
    window.addEventListener("pageshow", show);
    window.addEventListener("beforeunload", before);
    return () => {
      disposed = true;
      leave();
      db?.close();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("beforeunload", before);
    };
  }, [replace]);
  useEffect(() => {
    if (ready && writable && autosave.current && dirty.current) {
      setStatus("저장 대기 중…");
      timer.current = setTimeout(() => {
        void flush().catch(() => {});
      }, 700);
    }
    return () => clearTimeout(timer.current);
  }, [state, ready, writable, flush]);
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (
      !allowed.current &&
      ![
        "menu",
        "attribute",
        "dataset",
        "density",
        "inspector",
        "table-view",
        "analysis-family",
        "analysis-select",
        "cluster-select",
        "cluster-axes",
        "association-select",
        "association-view",
        "graph-select",
        "result-detail",
        "report-selection",
      ].includes(action.type)
    )
      return;
    const next = workspaceReducer(current.current, action);
    if (next === current.current) return;
    if (action.type === "undo" || action.type === "redo") {
      cancelAllWorkers();
      setEpoch((n) => n + 1);
    }
    current.current = next;
    dirty.current = allowed.current;
    autosave.current = allowed.current;
    setState(next);
  }, []);
  const open = async (id: string) => {
    if (!storage.current) throw new Error("저장소를 열 수 없습니다.");
    // Validation and current save must both succeed before replacement.
    const loaded = await storage.current.load(id);
    if (dirty.current && allowed.current) await flush();
    replace(loaded, false);
    if (allowed.current) {
      autosave.current = true;
      dirty.current = true;
      await flush();
    }
  };
  const add = async (next: WorkspaceState) => {
    if (!allowed.current) throw new Error("읽기 전용 탭입니다.");
    if (dirty.current) await flush();
    replace(next, true);
  };
  const remove = async (id: string) => {
    if (!allowed.current || !queue.current || !storage.current)
      throw new Error("저장 권한이 없습니다.");
    clearTimeout(timer.current);
    await queue.current.remove(id);
    if (current.current.project.id === id)
      replace(createWorkspace(false), false);
    else if (dirty.current) await flush();
    await refresh();
    setStatus("프로젝트를 삭제했습니다. 새 작업을 시작하면 다시 저장합니다.");
  };
  const reset = async () => {
    if (!allowed.current || !queue.current)
      throw new Error("저장 권한이 없습니다.");
    clearTimeout(timer.current);
    cancelAllWorkers();
    await queue.current.clear();
    replace(createWorkspace(false), false);
    await refresh();
    setStatus("이 배포 경로의 모든 사용자 자료와 설정을 삭제했습니다.");
  };
  return {
    state,
    dispatch,
    ready,
    writable,
    epoch,
    list,
    status,
    error,
    flush,
    refresh,
    open,
    add,
    remove,
    reset,
  };
}
export type ProjectLibrary = ReturnType<typeof useProjects>;
