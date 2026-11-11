import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  IndexedProjects,
  SaveQueue,
  StaleProjectGeneration,
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
  it("starts an output only if its generation still matches at the transaction boundary", async () => {
    const name = `output-${crypto.randomUUID()}`;
    const a = await IndexedProjects.open(name), b = await IndexedProjects.open(name);
    const before = vi.fn(), after = vi.fn();
    try {
      const old = await b.readGeneration();
      const started = b.runIfCurrent(old, before);
      const reset = a.clear(old);
      const blocked = b.runIfCurrent(old, after);
      await expect(started).resolves.toBe(true);
      await reset;
      await expect(blocked).resolves.toBe(false);
      expect(before).toHaveBeenCalledOnce();
      expect(after).not.toHaveBeenCalled();
    } finally {
      a.close();
      b.close();
    }
  });
  it("keeps a cleared library empty on reload instead of re-seeding a sample", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const db = await IndexedProjects.open(name);
    expect(await db.readGeneration()).toBeNull();
    await db.save(createWorkspace(), null);
    const resetGeneration = await db.clear(null);
    db.close();

    const reopened = await IndexedProjects.open(name);
    expect(await reopened.readGeneration()).toBe(resetGeneration);
    const loaded = await hydrateProjects(reopened, createWorkspace);
    expect(loaded.isNew).toBe(false);
    expect(loaded.state.project.datasets).toEqual([]);
    expect(loaded.projects).toEqual([]);
    reopened.close();
  });
  it("hydrates before any initial write and preserves original/version/view documents", async () => {
    const db = await open(),
      state = createWorkspace();
    state.project.name = "수업 자료";
    state.view.menu = "analyze";
    await db.save(state, null);
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
    await db.save(state, null);
    const save = vi.spyOn(db, "save"),
      fresh = vi.fn(() => createWorkspace());
    await expect(hydrateProjects(db, fresh)).rejects.toThrow("버전");
    expect(save).not.toHaveBeenCalled();
    expect(fresh).not.toHaveBeenCalled();
    db.close();
  });
  it("serializes racing writes, snapshots callers and recovers after a failed write", async () => {
    const db = await open(),
      q = new SaveQueue(db, null),
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
    await db.save(state, null);
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
    await expect(db.save(state, null)).rejects.toThrow();
    vi.restoreAllMocks();
    expect((await db.load(state.project.id)).project.name).toBe(oldName);
    expect((await db.list())[0].name).toBe(oldName);
    db.close();
  });
  it("invalidates queued saves before delete/reset so old data cannot reappear", async () => {
    const db = await open(),
      q = new SaveQueue(db, null),
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
  it("rejects a deferred save from a second session after reset without needing a notification", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const writer = await IndexedProjects.open(name);
    const inactive = await IndexedProjects.open(name);
    const generation = await inactive.readGeneration();
    const oldProject = createWorkspace();
    await writer.save(oldProject, generation);
    const retained = await hydrateProjects(inactive, createWorkspace);
    const stale = new SaveQueue(inactive, generation);
    expect(retained.state.project.id).toBe(oldProject.project.id);

    const resetGeneration = await new SaveQueue(writer, generation).clear();
    expect(resetGeneration).not.toBe(generation);
    await expect(stale.save(retained.state)).rejects.toBeInstanceOf(
      StaleProjectGeneration,
    );
    expect(await writer.list()).toEqual([]);
    expect(await writer.last()).toBeNull();

    const current = new SaveQueue(inactive, await inactive.readGeneration());
    const newProject = createWorkspace(false);
    expect(await current.save(newProject)).toBe(true);
    await expect(stale.remove(newProject.project.id)).rejects.toBeInstanceOf(
      StaleProjectGeneration,
    );
    await expect(stale.clear()).rejects.toBeInstanceOf(StaleProjectGeneration);
    expect(await writer.readGeneration()).toBe(resetGeneration);
    expect((await writer.list()).map(({ id }) => id)).toEqual([
      newProject.project.id,
    ]);
    expect(await writer.last()).toBe(newProject.project.id);
    inactive.close();
    writer.close();
  });
  it("orders in-flight and queued writes from a second connection around an atomic reset", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const writer = await IndexedProjects.open(name);
    const other = await IndexedProjects.open(name);
    const generation = await writer.readGeneration();

    const before = other.save(createWorkspace(false), generation);
    const reset = writer.clear(generation);
    const behind = other.save(createWorkspace(false), generation);
    const [beforeResult, resetResult, behindResult] = await Promise.allSettled([
      before,
      reset,
      behind,
    ]);

    expect(beforeResult.status).toBe("fulfilled");
    expect(resetResult.status).toBe("fulfilled");
    expect(behindResult).toMatchObject({
      status: "rejected",
      reason: expect.any(StaleProjectGeneration),
    });
    expect(await other.readGeneration()).not.toBe(generation);
    expect(await other.list()).toEqual([]);
    expect(await other.last()).toBeNull();
    expect(await other.initialized()).toBe(true);
    other.close();
    writer.close();
  });
  it("preserves both the saved project and generation if reset fails after its writes", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const writer = await IndexedProjects.open(name);
    const observer = await IndexedProjects.open(name);
    const generation = await writer.clear(null);
    const state = createWorkspace();
    await writer.save(state, generation);

    const original = IDBObjectStore.prototype.put;
    let generationWritten = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof original>
    ) {
      const request = original.apply(this, args);
      if (this.name === "meta" && typeof args[0] === "string")
        request.addEventListener(
          "success",
          () => {
            generationWritten = true;
            request.transaction?.abort();
          },
          { once: true },
        );
      return request;
    });
    await expect(new SaveQueue(writer, generation).clear()).rejects.toThrow();
    expect(generationWritten).toBe(true);
    vi.restoreAllMocks();

    expect(await observer.readGeneration()).toBe(generation);
    expect(await observer.last()).toBe(state.project.id);
    expect((await observer.list()).map(({ id }) => id)).toEqual([state.project.id]);
    expect(await observer.load(state.project.id)).toEqual(state);
    expect(await new SaveQueue(observer, generation).save(state)).toBe(true);
    observer.close();
    writer.close();
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
