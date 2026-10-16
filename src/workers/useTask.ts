import { useCallback, useEffect, useState } from "react";
import type { WorkError } from "../domain/types";
import type { DataTask, DataTaskResult } from "./protocol";
import { WorkerRunner } from "./client";

export function useTask(scopeId: string) {
  const [runner] = useState(() => new WorkerRunner(scopeId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<WorkError | null>(null);
  const cancel = useCallback(() => {
    const acknowledged = runner.cancel();
    setBusy(false);
    setMessage(
      acknowledged
        ? "작업이 취소되었습니다. 기존 자료는 변경되지 않았습니다."
        : "",
    );
    setError(null);
  }, [runner]);
  const run = useCallback(
    (task: DataTask, done: (result: DataTaskResult) => void) => {
      setBusy(true);
      setMessage("작업 준비 중…");
      setError(null);
      try {
        runner.run(task, (response) => {
          if (response.type === "progress") setMessage(response.message);
          else {
            setBusy(false);
            setMessage("");
            if (response.type === "complete") done(response.result);
            else if (response.type === "error") setError(response.error);
          }
        });
      } catch (cause) {
        runner.cancel();
        setBusy(false);
        setError({
          code: "START_FAILED",
          message: "작업 시작 실패",
          cause: String(cause),
          remedy: "브라우저 지원을 확인하고 다시 실행하세요.",
        });
      }
    },
    [runner],
  );
  useEffect(
    () => () => {
      runner.cancel();
    },
    [runner],
  );
  return { busy, message, error, run, cancel };
}
