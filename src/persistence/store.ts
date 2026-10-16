import type { WorkspaceState } from "../state/workspace";
import { MAX_PRESERVED_CELLS as RESTORE_CELLS } from "../domain/limits";
import { WorkerRunner } from "../workers/client";

/** Validation may recalculate saved processing bases. Keep it off the browser UI thread. */
async function validateStored(input: unknown): Promise<WorkspaceState> {
  if (typeof Worker === "undefined") return (await import("./format")).validateWorkspace(input);
  return new Promise((resolve, reject) => {
    const runner = new WorkerRunner("stored-project-validation");
    try {
      runner.run(
        { kind: "validate-workspace", workspace: input },
        (message) => {
          if (message.type === "complete" && message.result.kind === "restore")
            resolve(message.result.workspace);
          else if (message.type === "error")
            reject(new Error(message.error.cause ?? message.error.message));
        },
      );
    } catch (error) {
      runner.cancel();
      reject(error);
    }
  });
}

export const deploymentPath = () => new URL(".", document.baseURI).pathname;
export const storageNamespace = (path: string) =>
  `data-garden:${encodeURIComponent(path)}`;
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
  save(state: WorkspaceState): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
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
      const req = indexedDB.open(name, 1);
      let failed = false;
      req.onupgradeneeded = () => {
        req.result.createObjectStore("projects");
        req.result.createObjectStore("meta");
      };
      req.onblocked = () => {
        failed = true;
        reject(
          new Error(
            "저장소 열기가 다른 탭에 의해 차단되었습니다. 다른 탭을 닫고 다시 여세요.",
          ),
        );
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        if (failed) {
          req.result.close();
          return;
        }
        req.result.onversionchange = () => req.result.close();
        resolve(new IndexedProjects(req.result));
      };
    });
  }
  private read<T>(store: string, key?: string): Promise<T> {
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
      if (keys[i] === "last" || keys[i] === "initialized") continue;
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
  private write(
    work: (projects: IDBObjectStore, meta: IDBObjectStore) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(["projects", "meta"], "readwrite", {
        durability: "strict",
      });
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error || new Error("저장 트랜잭션이 중단되었습니다."));
      try {
        work(tx.objectStore("projects"), tx.objectStore("meta"));
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  save(state: WorkspaceState) {
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
    return this.write((projects, meta) => {
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
  remove(id: string) {
    return this.write((projects, meta) => {
      projects.delete(id);
      meta.delete(id);
      meta.delete("last");
    });
  }
  clear() {
    return this.write((projects, meta) => {
      projects.clear();
      meta.clear();
      meta.put(true, "initialized");
    });
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
  constructor(private storage: ProjectStorage) {}
  save(state: WorkspaceState): Promise<boolean> {
    const generation = this.generation;
    const copy = structuredClone(state);
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.stopped || generation !== this.generation) return false;
        await this.storage.save(copy);
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
    const work = this.tail.catch(() => {}).then(() => this.storage.remove(id));
    this.tail = work;
    await work;
  }
  async clear() {
    this.invalidate();
    const work = this.tail.catch(() => {}).then(() => this.storage.clear());
    this.tail = work;
    await work;
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
