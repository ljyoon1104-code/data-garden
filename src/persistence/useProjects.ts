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
  StaleProjectGeneration,
} from "./store";
import type { ProjectSummary, ResetGeneration } from "./store";
import { cancelAllWorkers } from "../workers/client";
import { snapshot } from "../domain/model";

interface Session {
  db: IndexedProjects;
  queue: SaveQueue;
  generation: ResetGeneration;
}

const sessionFor = (db: IndexedProjects, generation: ResetGeneration): Session => ({
  db, generation, queue: new SaveQueue(db, generation),
});

export function useProjects() {
  const [state, setState] = useState(() => createWorkspace(false));
  const current = useRef(state),
    session = useRef<Session | null>(null),
    announce = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allowed = useRef(false),
    autosave = useRef(false),
    dirty = useRef(false),
    resetting = useRef(false),
    blocked = useRef(false);
  const [ready, setReady] = useState(false),
    [writable, setWritable] = useState(false),
    [epoch, setEpoch] = useState(0);
  const [eraseEpoch, setEraseEpoch] = useState(0);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [list, setList] = useState<ProjectSummary[]>([]),
    [status, setStatus] = useState("저장된 프로젝트를 확인하는 중…"),
    [error, setError] = useState("");
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
    session.current?.queue.invalidate();
    cancelAllWorkers();
    current.current = next;
    autosave.current = save;
    dirty.current = save;
    setState(next);
    setEpoch((n) => n + 1);
    setError("");
    setStatus(save ? "저장 대기 중…" : "저장된 프로젝트를 불러왔습니다.");
  }, []);
  const applyErase = useCallback((previous: Session, generation: ResetGeneration, local: boolean) => {
    if (session.current !== previous) return;
    previous.queue.stop();
    session.current = sessionFor(previous.db, generation);
    replace(createWorkspace(false), false);
    setList([]);
    setEraseEpoch(n => n + 1);
    setStatus(local
      ? "이 배포 경로의 모든 사용자 자료와 설정을 삭제했습니다."
      : "다른 탭에서 사용자 자료와 설정을 삭제했습니다. 이전 작업을 비웠습니다.");
  }, [replace]);

  const reconcile = useCallback(async (expected: Session) => {
    if (session.current !== expected) return false;
    const generation = await expected.db.readGeneration();
    if (session.current !== expected) return false;
    if (generation === expected.generation) return true;
    applyErase(expected, generation, false);
    return false;
  }, [applyErase]);

  const markUnverified = useCallback((e: unknown) => {
    blocked.current = true;
    setChecking(true);
    setCheckError(String(e));
  }, []);

  const refreshSession = useCallback(async (expected: Session) => {
    const next = await expected.db.list();
    if (await reconcile(expected) && session.current === expected && !resetting.current) setList(next);
  }, [reconcile]);

  const requireSession = useCallback((expected: Session | null, write: boolean, automatic = false) => {
    if (!expected || session.current !== expected || resetting.current || (!automatic && blocked.current))
      throw new Error("저장소 상태가 바뀌었거나 확인 중입니다. 현재 화면에서 다시 시도하세요.");
    if (write && !allowed.current) throw new Error("이 탭에는 저장 권한이 없습니다.");
    return expected;
  }, []);

  const flushSession = useCallback(async (expected: Session | null) => {
    // Background saves remain supported; the write transaction still checks the generation.
    const active = requireSession(expected, true, true);
    clearTimeout(timer.current);
    const value = current.current;
    setStatus("저장 중…");
    try {
      const saved = await active.queue.save(value);
      if (!saved)
        throw new Error("저장 요청이 취소되었습니다. 다시 저장하세요.");
      if (!await reconcile(active) || session.current !== active || resetting.current)
        throw new StaleProjectGeneration();
      if (current.current === value) {
        dirty.current = false;
        setStatus(`저장 완료 · ${new Date().toLocaleTimeString("ko-KR")}`);
        setError("");
      }
      await refreshSession(active);
    } catch (e) {
      if (e instanceof StaleProjectGeneration && !resetting.current)
        await reconcile(active).catch(error => {
          if (session.current === active) markUnverified(error);
        });
      if (session.current === active && !resetting.current) {
        setError(String(e));
        setStatus("저장 실패 · 메모리의 자료는 유지됩니다.");
      }
      throw e;
    }
  }, [requireSession, refreshSession, reconcile, markUnverified]);
  useEffect(() => {
    let disposed = false,
      checkId = 0,
      channel: BroadcastChannel | null = null,
      release: (() => void) | null = null,
      db: IndexedProjects | null = null;
    const synchronize = (mask = false, notification = false) => {
      const active = session.current;
      if (!active || disposed) return;
      const hidden = document.visibilityState === "hidden";
      if (hidden || mask) {
        blocked.current = true;
        setChecking(true);
      }
      if (resetting.current || (hidden && !notification)) return;
      const id = ++checkId;
      void reconcile(active).then(() => {
        if (disposed || id !== checkId || resetting.current || !session.current ||
            document.visibilityState === "hidden") return;
        blocked.current = false;
        setChecking(false);
        setCheckError("");
      }).catch(e => {
        if (!disposed && id === checkId && session.current === active) markUnverified(e);
      });
    };
    (async () => {
      let active: Session | null = null;
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
        const generation = await db.readGeneration();
        if (disposed) return;
        active = sessionFor(db, generation);
        session.current = active;
        try {
          channel = new BroadcastChannel(`${name}:erase`);
          channel.onmessage = () => synchronize(true, true);
          // The notification is a wake-up hint; only IndexedDB is authoritative.
          announce.current = () => channel?.postMessage("erase");
        } catch {
          // Activation checks and polling cover unavailable or missed messages.
        }
        const {
          projects,
          state: loaded,
          isNew,
        } = await hydrateProjects(db, createWorkspace);
        if (disposed || !await reconcile(active) || disposed || session.current !== active) return;
        setList(projects);
        replace(loaded, isNew && !!release);
        if (!release)
          setStatus(
            "읽기 전용 · 다른 탭에서 사용 중이거나 브라우저가 쓰기 잠금을 지원하지 않습니다.",
          );
      } catch (e) {
        if (!disposed && (!active || await reconcile(active).catch(() => true)) &&
            !disposed && (!active || session.current === active)) {
          if (!active) {
            allowed.current = false;
            setWritable(false);
            release?.();
            release = null;
            db?.close();
          }
          autosave.current = false;
          setError(String(e));
          setStatus("저장소 복원 실패 · 기존 저장 내용을 덮어쓰지 않았습니다.");
        }
      } finally {
        if (!disposed) {
          setReady(true);
          if (document.visibilityState === "hidden") synchronize(true);
        }
      }
    })();
    const leave = () => {
      clearTimeout(timer.current);
      const active = session.current;
      if (active && active.db === db) {
        active.queue.stop();
        session.current = null;
      }
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
      else synchronize(true);
    };
    const activate = () => synchronize(true);
    const poll = setInterval(() => synchronize(), 1000);
    document.addEventListener("visibilitychange", activate);
    window.addEventListener("focus", activate);
    window.addEventListener("pageshow", show);
    window.addEventListener("beforeunload", before);
    return () => {
      disposed = true;
      leave();
      clearInterval(poll);
      channel?.close();
      announce.current = null;
      db?.close();
      document.removeEventListener("visibilitychange", activate);
      window.removeEventListener("focus", activate);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("beforeunload", before);
    };
  }, [replace, reconcile, markUnverified]);

  // Old event handlers and async work retain the session that rendered them.
  const rendered = session.current;
  const flush = useCallback(async () => {
    requireSession(rendered, true);
    await flushSession(rendered);
  }, [requireSession, flushSession, rendered]);
  const checkAccess = useCallback(async (action: () => void) => {
    if (!rendered || session.current !== rendered || resetting.current || blocked.current) return;
    try {
      const current = await rendered.db.runIfCurrent(rendered.generation, () => {
        if (session.current === rendered && !resetting.current && !blocked.current) action();
      });
      if (!current) await reconcile(rendered);
    } catch (e) {
      if (session.current === rendered) markUnverified(e);
    }
  }, [rendered, reconcile, markUnverified]);

  useEffect(() => {
    if (ready && writable && !resetting.current && autosave.current && dirty.current) {
      setStatus("저장 대기 중…");
      timer.current = setTimeout(() => {
        void flushSession(rendered).catch(() => {});
      }, 700);
    }
    return () => clearTimeout(timer.current);
  }, [state, ready, writable, flushSession, rendered]);
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!rendered || session.current !== rendered || resetting.current || blocked.current) return;
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
  }, [rendered]);
  const refresh = async () => {
    if (rendered && session.current === rendered) await refreshSession(rendered);
  };
  const open = async (id: string) => {
    const active = requireSession(rendered, false);
    // Validation and current save must both succeed before replacement.
    if (!await reconcile(active)) return;
    const loaded = await active.db.load(id);
    if (dirty.current && allowed.current) await flushSession(active);
    if (!await reconcile(active)) return;
    requireSession(active, false);
    replace(loaded, false);
    if (allowed.current) {
      autosave.current = true;
      dirty.current = true;
      await flush();
    }
  };
  const add = async (next: WorkspaceState) => {
    const active = requireSession(rendered, true);
    if (dirty.current) await flushSession(active);
    if (!await reconcile(active)) throw new StaleProjectGeneration();
    requireSession(active, true);
    replace(next, true);
  };
  const remove = async (id: string) => {
    const active = requireSession(rendered, true);
    clearTimeout(timer.current);
    try {
      await active.queue.remove(id);
    } catch (e) {
      if (e instanceof StaleProjectGeneration) await reconcile(active).catch(markUnverified);
      throw e;
    }
    if (!await reconcile(active) || session.current !== active || resetting.current) return;
    if (current.current.project.id === id)
      replace(createWorkspace(false), false);
    else if (dirty.current) await flush();
    await refreshSession(active);
    if (session.current === active && !resetting.current)
      setStatus("프로젝트를 삭제했습니다. 새 작업을 시작하면 다시 저장합니다.");
  };
  const reset = async () => {
    const active = requireSession(rendered, true);
    resetting.current = true;
    clearTimeout(timer.current);
    try {
      const generation = await active.queue.clear();
      applyErase(active, generation, true);
      try { announce.current?.(); } catch { /* The committed reset is unchanged. */ }
    } catch (e) {
      if (e instanceof StaleProjectGeneration) await reconcile(active).catch(markUnverified);
      if (session.current === active) setStatus("삭제 실패 · 기존 자료는 유지됩니다.");
      throw e;
    } finally {
      resetting.current = false;
    }
  };
  return {
    state,
    dispatch,
    ready,
    writable,
    epoch,
    eraseEpoch,
    checking,
    checkError,
    checkAccess,
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
