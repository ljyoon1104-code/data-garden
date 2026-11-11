import type { WorkspaceState } from "../state/workspace";
import { MAX_PRESERVED_CELLS as RESTORE_CELLS } from "../domain/limits";
import { registerExternalWork, WorkerRunner } from "../workers/client";

/** Validation may recalculate saved processing bases. Keep it off the browser UI thread. */
async function validateStored(input: unknown): Promise<WorkspaceState> {
  if (typeof Worker === "undefined") return (await import("./format")).validateWorkspace(input);
  return new Promise((resolve, reject) => {
    const runner = new WorkerRunner("stored-project-validation");
    const finish = registerExternalWork(() => {
      runner.cancel();
      reject(new DOMException("저장된 프로젝트 열기를 취소했습니다.", "AbortError"));
    });
    try {
      runner.run(
        { kind: "validate-workspace", workspace: input },
        (message) => {
          if (message.type === "complete" && message.result.kind === "restore") {
            finish();
            resolve(message.result.workspace);
          } else if (message.type === "error") {
            finish();
            reject(new Error(message.error.cause ?? message.error.message));
          }
        },
      );
    } catch (error) {
      finish();
      runner.cancel();
      reject(error);
    }
  });
}

export const deploymentPath = () => new URL(".", document.baseURI).pathname;
export const storageNamespace = (path: string) =>
  `data-garden:${encodeURIComponent(path)}`;
// This is the IndexedDB connection protocol, not the project's schema version.
// Public v1 clients close on versionchange and explicitly reopen at version 1.
export const PROJECT_DATABASE_VERSION = 2;
export const PROJECT_DATABASE_OPEN_TIMEOUT_MS = 10_000;
// Project keys are strings. This metadata key cannot collide with a project ID.
const RESET_GENERATION = 0;
export type ResetGeneration = string | null;

function decodeGeneration(value: unknown): ResetGeneration {
  if (value === undefined) return null; // Existing libraries before their first reset.
  if (typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) return value;
  throw new Error("저장소의 전체 삭제 기록을 확인할 수 없습니다.");
}

export class StaleProjectGeneration extends Error {
  constructor() {
    super("다른 탭에서 자료와 설정을 삭제했습니다. 이전 작업은 저장하지 않았습니다.");
  }
}
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  datasetCount: number;
}
export interface ProjectStorage {
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<WorkspaceState>;
  last(): Promise<string | null>;
  initialized(): Promise<boolean>;
  readGeneration(): Promise<ResetGeneration>;
  save(state: WorkspaceState, generation: ResetGeneration): Promise<void>;
  remove(id: string, generation: ResetGeneration): Promise<void>;
  clear(generation: ResetGeneration): Promise<string>;
}
export async function hydrateProjects(
  storage: ProjectStorage,
  fresh: (withSample?: boolean) => WorkspaceState,
) {
  const projects = await storage.list(),
    last = await storage.last();
  const id = projects.some((p) => p.id === last) ? last : projects[0]?.id;
  // This function never writes. Validation failure propagates, without a fallback sample save.
  const initialized = await storage.initialized();
  return {
    projects,
    state: id ? await storage.load(id) : fresh(!initialized),
    isNew: !id && !initialized,
  };
}
export class IndexedProjects implements ProjectStorage {
  constructor(private db: IDBDatabase) {}
  static open(name: string): Promise<IndexedProjects> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, PROJECT_DATABASE_VERSION);
      let failed = false;
      // A frozen client can delay versionchange delivery itself, so blocked
      // need not fire. Keep startup recoverable without changing stored data.
      const waiting = setTimeout(() => {
        failed = true;
        try {
          req.transaction?.abort();
        } catch {
          // The upgrade may already have completed; it never deletes records.
        }
        reject(new Error(
          "저장소 연결을 10초 안에 완료하지 못했습니다. 필요한 백업을 받은 뒤 다른 데이터뜰 탭을 닫고 이 탭을 새로고침하세요. 자료는 삭제하지 않았습니다.",
        ));
      }, PROJECT_DATABASE_OPEN_TIMEOUT_MS);
      req.onupgradeneeded = (event) => {
        // A blocked request has already failed in the UI. Do not silently
        // migrate later when a frozen/old tab eventually releases its handle.
        if (failed) {
          req.transaction?.abort();
          return;
        }
        if (event.oldVersion === 0) {
          req.result.createObjectStore("projects");
          req.result.createObjectStore("meta");
        }
      };
      req.onblocked = () => {
        failed = true;
        clearTimeout(waiting);
        reject(
          new Error(
            "저장소 업데이트가 구버전 또는 멈춘 탭에 의해 차단되었습니다. 필요한 백업을 받은 뒤 다른 데이터뜰 탭을 닫고 이 탭을 새로고침하세요. 자료는 삭제하지 않았습니다.",
          ),
        );
      };
      req.onerror = () => {
        clearTimeout(waiting);
        reject(req.error?.name === "VersionError"
          ? new Error("더 새로운 데이터뜰에서 사용한 저장소입니다. 현재 탭을 닫고 최신 버전으로 다시 여세요. 기존 자료는 변경하지 않았습니다.")
          : req.error);
      };
      req.onsuccess = () => {
        clearTimeout(waiting);
        if (failed) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => req.result.close();
        resolve(new IndexedProjects(req.result));
      };
    });
  }
  private read<T>(store: string, key?: IDBValidKey): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readonly"),
        bucket = tx.objectStore(store);
      const req = key === undefined ? bucket.getAll() : bucket.get(key);
      tx.oncomplete = () => resolve(req.result as T);
      tx.onabort = () => reject(tx.error || new Error("저장소 읽기 실패"));
    });
  }
  async list() {
    const { items, keys, projectKeys } = await new Promise<{
      items: unknown[];
      keys: IDBValidKey[];
      projectKeys: IDBValidKey[];
    }>((resolve, reject) => {
      const tx = this.db.transaction(["projects", "meta"], "readonly"),
        meta = tx.objectStore("meta");
      const values = meta.getAll(),
        ids = meta.getAllKeys(),
        projects = tx.objectStore("projects").getAllKeys();
      tx.oncomplete = () =>
        resolve({
          items: values.result,
          keys: ids.result,
          projectKeys: projects.result,
        });
      tx.onabort = () =>
        reject(tx.error || new Error("프로젝트 목록 읽기 실패"));
    });
    const summaries: ProjectSummary[] = [];
    for (let i = 0; i < items.length; i++) {
      if (keys[i] === "last" || keys[i] === "initialized" || keys[i] === RESET_GENERATION) continue;
      const v = items[i];
      if (
        typeof v !== "object" ||
        v === null ||
        !("id" in v) ||
        v.id !== keys[i] ||
        typeof v.id !== "string" ||
        !("name" in v) ||
        typeof v.name !== "string" ||
        !("updatedAt" in v) ||
        typeof v.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(v.updatedAt)) ||
        !("datasetCount" in v) ||
        !Number.isSafeInteger(v.datasetCount) ||
        Number(v.datasetCount) < 0
      )
        throw new Error(
          "프로젝트 목록 정보가 손상되었습니다. 기존 저장 내용은 유지합니다.",
        );
      summaries.push(v as ProjectSummary);
    }
    if (
      projectKeys.length !== summaries.length ||
      projectKeys.some((key) => !summaries.some((p) => p.id === key))
    )
      throw new Error(
        "프로젝트 목록과 본문이 일치하지 않습니다. 기존 저장 내용은 유지합니다.",
      );
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async last() {
    return (await this.read<string | undefined>("meta", "last")) || null;
  }
  async load(id: string) {
    const state = await validateStored(await this.read("projects", id));
    if (state.project.id !== id)
      throw new Error("저장 키와 프로젝트 ID가 다릅니다.");
    return state;
  }
  async initialized() {
    return (
      (await this.read<boolean | undefined>("meta", "initialized")) === true
    );
  }
  async readGeneration() {
    return decodeGeneration(await this.read("meta", RESET_GENERATION));
  }
  /** Start a prepared output before a competing reset can commit. */
  runIfCurrent(generation: ResetGeneration, action: () => void): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("meta", "readonly");
      let current = false, failure: unknown;
      tx.oncomplete = () => resolve(current);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("삭제 여부 확인이 중단되었습니다."));
      const check = tx.objectStore("meta").get(RESET_GENERATION);
      check.onsuccess = () => {
        try {
          current = decodeGeneration(check.result) === generation;
          if (current) action();
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  private write(
    generation: ResetGeneration,
    work: (projects: IDBObjectStore, meta: IDBObjectStore) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["projects", "meta"], "readwrite", {
        durability: "strict",
      });
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error("저장 트랜잭션이 중단되었습니다."));
      const meta = tx.objectStore("meta");
      const check = meta.get(RESET_GENERATION);
      // Checking outside this transaction would leave a race between check and put.
      check.onsuccess = () => {
        try {
          if (decodeGeneration(check.result) !== generation) throw new StaleProjectGeneration();
          work(tx.objectStore("projects"), meta);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
    });
  }
  save(state: WorkspaceState, generation: ResetGeneration) {
    const cells = state.project.datasets.reduce(
      (sum, d) =>
        sum +
        [d.original.table, ...d.versions].reduce(
          (n, t) => n + t.rows.length * t.columns.length,
          0,
        ),
      0,
    );
    if (cells > RESTORE_CELLS)
      return Promise.reject(
        new Error(
          "보존 버전을 합한 300만 셀 저장·복원 한도를 넘었습니다. 메모리 자료는 유지됩니다. JSON으로 백업하고 새 프로젝트로 작업을 나누세요.",
        ),
      );
    return this.write(generation, (projects, meta) => {
      const p = state.project;
      projects.put(state, p.id);
      meta.put(
        {
          id: p.id,
          name: p.name,
          updatedAt: p.updatedAt,
          datasetCount: Object.values(p.activeVersions).filter(Boolean).length,
        } satisfies ProjectSummary,
        p.id,
      );
      meta.put(p.id, "last");
      meta.put(true, "initialized");
    });
  }
  remove(id: string, generation: ResetGeneration) {
    return this.write(generation, (projects, meta) => {
      projects.delete(id);
      meta.delete(id);
      meta.delete("last");
    });
  }
  async clear(generation: ResetGeneration) {
    const next = crypto.randomUUID();
    await this.write(generation, (projects, meta) => {
      projects.clear();
      meta.clear();
      meta.put(true, "initialized");
      meta.put(next, RESET_GENERATION);
    });
    return next;
  }
  close() {
    this.db.close();
  }
}

/** One serial queue owns all writes/deletes. Invalidated generations cannot resurrect data. */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  constructor(
    private storage: ProjectStorage,
    private readonly resetGeneration: ResetGeneration,
  ) {}
  save(state: WorkspaceState): Promise<boolean> {
    const generation = this.generation;
    const copy = structuredClone(state);
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.stopped || generation !== this.generation) return false;
        await this.storage.save(copy, this.resetGeneration);
        return true;
      });
    this.tail = work;
    return work;
  }
  invalidate() {
    this.generation++;
  }
  async remove(id: string) {
    this.invalidate();
    const work = this.tail.catch(() => {}).then(() => {
      if (this.stopped) throw new StaleProjectGeneration();
      return this.storage.remove(id, this.resetGeneration);
    });
    this.tail = work;
    await work;
  }
  async clear() {
    this.invalidate();
    const work = this.tail.catch(() => {}).then(() => {
      if (this.stopped) throw new StaleProjectGeneration();
      return this.storage.clear(this.resetGeneration);
    });
    this.tail = work;
    return work;
  }
  stop() {
    this.stopped = true;
    this.invalidate();
  }
}

/** Exclusive lock covers this deployment's library, including deletion and reset. */
export async function acquireWriter(
  name: string,
): Promise<(() => void) | null> {
  if (!navigator.locks) return null;
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(
        `${name}:writer`,
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          return new Promise<void>((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}
