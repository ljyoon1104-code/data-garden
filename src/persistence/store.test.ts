import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  IndexedProjects,
  SaveQueue,
  hydrateProjects,
  storageNamespace,
  acquireWriter,
} from "./store";
import { createWorkspace } from "../state/workspace";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const open = () => IndexedProjects.open(`test-${crypto.randomUUID()}`);
describe("atomic local library", () => {
  it("keeps a cleared library empty on reload instead of re-seeding a sample", async () => {
    const db = await open();
    await db.save(createWorkspace());
    await db.clear();
    const loaded = await hydrateProjects(db, createWorkspace);
    expect(loaded.isNew).toBe(false);
    expect(loaded.state.project.datasets).toEqual([]);
    expect(loaded.projects).toEqual([]);
    db.close();
  });
  it("hydrates before any initial write and preserves original/version/view documents", async () => {
    const db = await open(),
      state = createWorkspace();
    state.project.name = "수업 자료";
    state.view.menu = "analyze";
    await db.save(state);
    const save = vi.spyOn(db, "save"),
      fresh = vi.fn(() => createWorkspace());
    const restored = await hydrateProjects(db, fresh);
    expect(restored.state).toEqual(state);
    expect(fresh).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(
      Object.isFrozen(restored.state.project.datasets[0].versions[0]),
    ).toBe(true);
    db.close();
  });
  it("does not replace invalid stored data with sample data", async () => {
    const db = await open(),
      state = createWorkspace();
    (state.project as any).schemaVersion = 900;
    await db.save(state);
    const save = vi.spyOn(db, "save"),
      fresh = vi.fn(() => createWorkspace());
    await expect(hydrateProjects(db, fresh)).rejects.toThrow("버전");
    expect(save).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    db.close();
  });
  it("serializes racing writes, snapshots callers and recovers after a failed write", async () => {
    const db = await open(),
      q = new SaveQueue(db),
      state = createWorkspace();
    const first = q.save(state);
    state.project.name = "두 번째";
    const second = q.save(state);
    state.project.name = "아직 저장 안 함";
    await Promise.all([first, second]);
    expect((await db.load(state.project.id)).project.name).toBe("두 번째");
    vi.spyOn(db, "save").mockRejectedValueOnce(
      new DOMException("공간 부족", "QuotaExceededError"),
    );
    await expect(q.save(state)).rejects.toThrow("공간 부족");
    expect((await db.load(state.project.id)).project.name).toBe("두 번째");
    await q.save(state);
    expect((await db.load(state.project.id)).project.name).toBe(
      "아직 저장 안 함",
    );
    db.close();
  });
  it("aborts the whole transaction if metadata writing fails after project put", async () => {
    const db = await open(),
      state = createWorkspace();
    await db.save(state);
    const oldName = state.project.name;
    state.project.name = "실패할 변경";
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof original>
    ) {
      if (this.name === "meta")
        throw new DOMException("공간 부족", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expect(db.save(state)).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await db.load(state.project.id)).project.name).toBe(oldName);
    expect((await db.list())[0].name).toBe(oldName);
    db.close();
  });
  it("invalidates queued saves before delete/reset so old data cannot reappear", async () => {
    const db = await open(),
      q = new SaveQueue(db),
      state = createWorkspace();
    await q.save(state);
    const pending = q.save(state),
      deleted = q.remove(state.project.id);
    await Promise.all([pending, deleted]);
    expect(await db.list()).toEqual([]);
    await q.save(state);
    const stale = q.save(state),
      clear = q.clear();
    await Promise.all([stale, clear]);
    expect(await db.list()).toEqual([]);
    expect(await db.last()).toBeNull();
    db.close();
  });
  it("separates deployments and grants only one writer, without fallback writes", async () => {
    expect(storageNamespace("/")).not.toBe(storageNamespace("/data/"));
    let held = false;
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: object | null) => Promise<void> | void,
        ) => {
          if (held) return callback(null);
          held = true;
          await callback({});
          held = false;
        },
      },
    });
    const release = await acquireWriter("test");
    expect(release).toBeTypeOf("function");
    expect(await acquireWriter("test")).toBeNull();
    release!();
    await Promise.resolve();
    await Promise.resolve();
    const next = await acquireWriter("test");
    expect(next).not.toBeNull();
    next!();
    vi.stubGlobal("navigator", {});
    expect(await acquireWriter("test")).toBeNull();
  });
});
