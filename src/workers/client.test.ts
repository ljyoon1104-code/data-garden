import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerRunner, cancelAllWorkers, hasRunningWorkers } from "./client";
import type { DataTask, DataTaskResult, WorkerResponse } from "./protocol";
import { defaultTableView } from "../domain/table";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: WorkerResponse<DataTaskResult> }) => void) | null =
    null;
  onerror = null;
  sent: any[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(data: unknown) {
    this.sent.push(data);
  }
  terminate() {
    this.terminated = true;
  }
}
const task: DataTask = {
  kind: "inspect",
  table: { columns: [], rows: [] },
  view: defaultTableView(),
};
afterEach(() => {
  cancelAllWorkers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});
describe("worker lifecycle and condition changes", () => {
  it("invalidates all scopes synchronously on undo or project replacement", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const commit = vi.fn();
    new WorkerRunner("edit").run(task, commit);
    new WorkerRunner("restore").run(task, commit);
    expect(hasRunningWorkers()).toBe(true);
    cancelAllWorkers();
    expect(hasRunningWorkers()).toBe(false);
    for (const worker of FakeWorker.instances) {
      expect(worker.terminated).toBe(true);
      worker.onmessage?.({
        data: {
          ...worker.sent[0],
          type: "complete",
          result: { kind: "edit", version: null },
        },
      });
    }
    expect(commit).not.toHaveBeenCalled();
  });
  it("terminates previous work and rejects late progress, error and completion", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const runner = new WorkerRunner("inspect");
    const done = vi.fn();
    runner.run(task, done);
    const old = FakeWorker.instances[0];
    runner.run(task, done);
    const current = FakeWorker.instances[1];
    expect(old.terminated).toBe(true);
    expect(old.sent[1].type).toBe("cancel");
    old.onmessage?.({
      data: {
        ...old.sent[0],
        type: "complete",
        result: { kind: "edit", version: null },
      },
    });
    old.onmessage?.({
      data: {
        ...old.sent[0],
        type: "error",
        error: { code: "old", message: "old" },
      },
    });
    expect(done).not.toHaveBeenCalled();
    current.onmessage?.({
      data: {
        ...current.sent[0],
        type: "complete",
        result: { kind: "edit", version: null },
      },
    });
    expect(done).toHaveBeenCalledTimes(1);
    expect(current.terminated).toBe(true);
  });
  it("blocks preprocessing replies after source/settings changes and cancellation", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const runner = new WorkerRunner("preprocessing"),
      commit = vi.fn();
    const task: DataTask = {
      kind: "preprocess-preview",
      table: { columns: [], rows: [] },
      source: { datasetId: "d", versionId: "v1" },
      settings: { kind: "scale", method: "minmax", attributeIds: ["x"] },
    };
    runner.run(task, commit);
    const old = FakeWorker.instances[0];
    runner.run(
      {
        ...task,
        source: { datasetId: "d", versionId: "v2" },
        settings: { kind: "scale", method: "zscore", attributeIds: ["x"] },
      },
      commit,
    );
    const current = FakeWorker.instances[1];
    runner.cancel();
    for (const worker of [old, current]) {
      worker.onmessage?.({
        data: {
          ...worker.sent[0],
          type: "complete",
          result: { kind: "preprocess-commit", version: null },
        },
      });
      expect(worker.terminated).toBe(true);
    }
    expect(commit).not.toHaveBeenCalled();
  });
  it("acknowledges termination and leaves no partial result after cancellation", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const runner = new WorkerRunner("import");
    const done = vi.fn();
    runner.run(task, done);
    const worker = FakeWorker.instances[0];
    const acknowledgement = runner.cancel();
    expect(acknowledgement?.type).toBe("cancelled");
    expect(worker.terminated).toBe(true);
    worker.onmessage?.({
      data: {
        ...worker.sent[0],
        type: "complete",
        result: { kind: "edit", version: null },
      },
    });
    expect(done).not.toHaveBeenCalled();
    expect(runner.cancel()).toBeNull();
  });
});
