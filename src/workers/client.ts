import { JobGate } from "./protocol";
import type { DataTask, DataTaskResult, WorkerResponse } from "./protocol";
const running = new Set<WorkerRunner>();
export function cancelAllWorkers() {
  for (const runner of [...running]) runner.cancel();
}
export function hasRunningWorkers() {
  return running.size > 0;
}

/** A dedicated worker is terminated on cancellation: synchronous XLSX parsing is
 * interruptible without waiting for its message queue. Gate invalidates first. */
export class WorkerRunner {
  private gate = new JobGate();
  private worker: Worker | null = null;
  constructor(private scopeId: string) {}
  cancel() {
    running.delete(this);
    const cancel = this.gate.invalidate(this.scopeId);
    if (cancel) this.worker?.postMessage(cancel);
    this.worker?.terminate();
    this.worker = null;
    return cancel
      ? {
          type: "cancelled" as const,
          jobId: cancel.jobId,
          scopeId: cancel.scopeId,
        }
      : null;
  }
  run(
    task: DataTask,
    commit: (message: WorkerResponse<DataTaskResult>) => void,
  ) {
    this.cancel();
    const request = this.gate.startTask(this.scopeId, task);
    const worker = new Worker(new URL("./data.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    running.add(this);
    worker.onmessage = (event: MessageEvent<WorkerResponse<DataTaskResult>>) =>
      this.gate.receive(event.data, (message) => {
        if (message.type !== "progress") {
          running.delete(this);
          worker.terminate();
          if (this.worker === worker) this.worker = null;
        }
        commit(message);
      });
    worker.onerror = (event) =>
      this.gate.receive<DataTaskResult>(
        {
          type: "error",
          jobId: request.jobId,
          scopeId: request.scopeId,
          error: {
            code: "WORKER_ERROR",
            message: "작업 스레드를 시작하거나 실행하지 못했습니다.",
            cause: event.message || "Worker 파일 로딩 실패",
            remedy:
              "페이지를 새로고침하고 브라우저의 로컬 파일·Worker 지원을 확인하세요.",
          },
        },
        (message) => {
          running.delete(this);
          worker.terminate();
          this.worker = null;
          commit(message);
        },
      );
    worker.postMessage(request);
  }
}
