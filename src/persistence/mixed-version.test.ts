import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, type WorkspaceState } from "../state/workspace";
import {
  hydrateProjects,
  IndexedProjects,
  PROJECT_DATABASE_OPEN_TIMEOUT_MS,
  PROJECT_DATABASE_VERSION,
} from "./store";

const connections: Array<{ close(): void }> = [];
const databaseName = () => `mixed-version-${crypto.randomUUID()}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) connection.close();
});

// This deliberately models the deployed v1 API: it opens version 1, closes its
// connection on versionchange, and writes without reading reset metadata.
function openLegacy(
  name: string,
  closeOnVersionChange = true,
  onVersionChange: () => void = () => {},
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("projects");
      request.result.createObjectStore("meta");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      connections.push(db);
      db.onversionchange = () => {
        onVersionChange();
        if (closeOnVersionChange) db.close();
      };
      resolve(db);
    };
  });
}

async function openCurrent(name: string) {
  const db = await IndexedProjects.open(name);
  connections.push(db);
  return db;
}

function legacyWrite(
  db: IDBDatabase,
  state: WorkspaceState,
  onComplete: () => void = () => {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "meta"], "readwrite");
    tx.objectStore("projects").put(state, state.project.id);
    const meta = tx.objectStore("meta");
    meta.put(
      {
        id: state.project.id,
        name: state.project.name,
        updatedAt: state.project.updatedAt,
        datasetCount: Object.values(state.project.activeVersions).filter(Boolean)
          .length,
      },
      state.project.id,
    );
    meta.put(state.project.id, "last");
    meta.put(true, "initialized");
    tx.oncomplete = () => {
      onComplete();
      resolve();
    };
    tx.onabort = () => reject(tx.error);
  });
}

function legacyReset(db: IDBDatabase, generation: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["projects", "meta"], "readwrite");
    tx.objectStore("projects").clear();
    const meta = tx.objectStore("meta");
    meta.clear();
    meta.put(true, "initialized");
    meta.put(generation, 0);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

function legacyRead<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).get(key);
    tx.oncomplete = () => resolve(request.result as T);
    tx.onabort = () => reject(tx.error);
  });
}

describe("mixed deployed-v1 and current database clients", () => {
  it("reproduces generation-blind v1 resurrection when no version fence exists", async () => {
    const name = databaseName();
    const deletingTab = await openLegacy(name);
    const staleTab = await openLegacy(name);
    const state = createWorkspace();
    await legacyWrite(staleTab, state);
    const generation = crypto.randomUUID();
    await legacyReset(deletingTab, generation);
    expect(
      await legacyRead(deletingTab, "projects", state.project.id),
    ).toBeUndefined();

    // Keeping the reset token alone cannot constrain a client that ignores it.
    await legacyWrite(staleTab, state);
    expect(
      await legacyRead(deletingTab, "projects", state.project.id),
    ).toEqual(state);
    expect(await legacyRead(deletingTab, "meta", 0)).toBe(generation);
  });

  it.each([null, "d6b99911-03b2-4c86-b863-fb046caf3bd8"])(
    "upgrades v1 without deleting its project or reset generation %s",
    async (generation) => {
      const name = databaseName();
      const legacy = await openLegacy(name);
      const state = createWorkspace();
      state.project.name = "업데이트 전 가상 프로젝트";
      state.view.menu = "analyze";
      if (generation) await legacyReset(legacy, generation);
      await legacyWrite(legacy, state);

      const current = await openCurrent(name);
      expect(PROJECT_DATABASE_VERSION).toBe(2);
      expect(await current.readGeneration()).toBe(generation);
      expect(await current.initialized()).toBe(true);
      expect(await current.last()).toBe(state.project.id);
      expect(await current.list()).toEqual([
        {
          id: state.project.id,
          name: state.project.name,
          updatedAt: state.project.updatedAt,
          datasetCount: 1,
        },
      ]);
      expect(await current.load(state.project.id)).toEqual(state);
    },
  );

  it("commits an already-started v1 save before upgrade, then fences late saves and v1 reopen", async () => {
    const name = databaseName();
    const order: string[] = [];
    const legacy = await openLegacy(name, true, () =>
      order.push("versionchange"),
    );
    const state = createWorkspace();
    const saving = legacyWrite(legacy, state, () =>
      order.push("legacy-write-complete"),
    );
    const opening = openCurrent(name).then((db) => {
      order.push("current-opened");
      return db;
    });
    await saving;
    const current = await opening;
    expect(order).toContain("versionchange");
    expect(order.indexOf("legacy-write-complete")).toBeLessThan(
      order.indexOf("current-opened"),
    );
    expect(await current.load(state.project.id)).toEqual(state);

    const generation = await current.clear(await current.readGeneration());
    expect(await current.list()).toEqual([]);
    await expect(legacyWrite(legacy, state)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await expect(openLegacy(name)).rejects.toMatchObject({ name: "VersionError" });
    expect(await current.list()).toEqual([]);
    expect(await current.readGeneration()).toBe(generation);

    current.close();
    const reloaded = await openCurrent(name);
    const hydrated = await hydrateProjects(reloaded, createWorkspace);
    expect(hydrated.projects).toEqual([]);
    expect(hydrated.state.project.datasets).toEqual([]);
    expect(hydrated.isNew).toBe(false);

    const fresh = createWorkspace(false);
    fresh.project.name = "삭제 이후 새 가상 프로젝트";
    await reloaded.save(fresh, generation);
    reloaded.close();
    const reopened = await openCurrent(name);
    expect(await reopened.readGeneration()).toBe(generation);
    expect(await reopened.load(fresh.project.id)).toEqual(fresh);
    expect((await reopened.list()).map(({ id }) => id)).toEqual([
      fresh.project.id,
    ]);
  });

  it("fails a blocked upgrade without clearing or silently upgrading later, then allows retry", async () => {
    const name = databaseName();
    // A frozen tab does not run the deployed onversionchange close handler.
    const frozen = await openLegacy(name, false);
    const state = createWorkspace();
    const generation = crypto.randomUUID();
    await legacyReset(frozen, generation);
    await legacyWrite(frozen, state);

    await expect(IndexedProjects.open(name)).rejects.toThrow(
      /다른 데이터뜰 탭을 닫고.*새로고침.*자료는 삭제하지 않았습니다/,
    );
    expect(frozen.version).toBe(1);
    expect(await legacyRead(frozen, "projects", state.project.id)).toEqual(state);
    expect(await legacyRead(frozen, "meta", 0)).toBe(generation);
    frozen.close();

    // Queue a v1 open behind the rejected upgrade. If that upgrade commits
    // after the UI has already reported failure, this rejects VersionError.
    const probe = await openLegacy(name);
    expect(probe.version).toBe(1);
    expect(await legacyRead(probe, "projects", state.project.id)).toEqual(state);
    expect(await legacyRead(probe, "meta", 0)).toBe(generation);
    probe.close();

    const retried = await openCurrent(name);
    expect(await retried.load(state.project.id)).toEqual(state);
    expect(await retried.readGeneration()).toBe(generation);
    const nextGeneration = await retried.clear(generation);
    expect(nextGeneration).not.toBe(generation);
    expect(await retried.list()).toEqual([]);
  });

  it("times out an upgrade when the blocked event is missing and aborts its delayed migration", async () => {
    const name = databaseName();
    const frozen = await openLegacy(name, false);
    const state = createWorkspace();
    const generation = crypto.randomUUID();
    await legacyReset(frozen, generation);
    await legacyWrite(frozen, state);

    const originalOpen = indexedDB.open.bind(indexedDB);
    let signalBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      signalBlocked = resolve;
    });
    const suppressBlocked = vi.fn((event: Event) => {
      // Register before the application's onblocked handler. The real IDB
      // connection and upgrade queue still run; only delivery is suppressed.
      event.stopImmediatePropagation();
      signalBlocked();
    });
    vi.spyOn(indexedDB, "open").mockImplementation((database, version) => {
      const request = originalOpen(database, version);
      if (database === name && version === PROJECT_DATABASE_VERSION)
        request.addEventListener("blocked", suppressBlocked);
      return request;
    });
    // Keep fake IndexedDB's setImmediate queue real so only the application's
    // bounded wait advances under test control.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const opening = IndexedProjects.open(name);
    void opening.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    const rejection = expect(opening).rejects.toThrow(
      /다른 데이터뜰 탭을 닫고.*새로고침.*자료는 삭제하지 않았습니다/,
    );
    await blocked;
    expect(suppressBlocked).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PROJECT_DATABASE_OPEN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
    vi.useRealTimers();
    vi.restoreAllMocks();

    expect(frozen.version).toBe(1);
    expect(await legacyRead(frozen, "projects", state.project.id)).toEqual(state);
    expect(await legacyRead(frozen, "meta", 0)).toBe(generation);
    frozen.close();
    const probe = await openLegacy(name);
    expect(probe.version).toBe(1);
    expect(await legacyRead(probe, "projects", state.project.id)).toEqual(state);
    probe.close();

    const retried = await openCurrent(name);
    expect(await retried.readGeneration()).toBe(generation);
    expect(await retried.load(state.project.id)).toEqual(state);
  });
});
