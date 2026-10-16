import { useEffect, useState } from "react";
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
/** Update activation is separate from registration/download; failed saves never activate. */
export async function applyWaitingUpdate(
  registration: ServiceWorkerRegistration,
  save: () => Promise<void>,
  blocked: () => boolean,
) {
  if (blocked())
    throw new Error(
      "열려 있는 입력·편집을 확정하거나 취소하고, 계산 작업을 마친 뒤 적용하세요.",
    );
  await save();
  if (blocked())
    throw new Error(
      "저장 중 새 작업이 시작되었습니다. 작업을 마친 뒤 다시 적용하세요.",
    );
  if (!registration.waiting)
    throw new Error(
      "대기 중인 업데이트가 없습니다. 업데이트를 다시 확인하세요.",
    );
  registration.waiting.postMessage({ type: "ACTIVATE_UPDATE" });
}
export function usePwa() {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [waiting, setWaiting] = useState(false),
    [status, setStatus] = useState("오프라인 준비 상태 확인 중…"),
    [error, setError] = useState("");
  const [install, setInstall] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    if (!import.meta.env.PROD) {
      setStatus(
        "개발 모드 · 설치·오프라인 확인은 빌드 미리보기에서 가능합니다.",
      );
      return () => window.removeEventListener("beforeinstallprompt", onInstall);
    }
    if (!("serviceWorker" in navigator)) {
      setStatus("이 브라우저에서는 오프라인 준비를 지원하지 않습니다.");
      return;
    }
    let disposed = false;
    navigator.serviceWorker
      .register(new URL("sw.js", document.baseURI), {
        scope: "./",
        updateViaCache: "none",
      })
      .then((reg) => {
        if (disposed) return;
        setRegistration(reg);
        setWaiting(!!reg.waiting);
        const track = (worker: ServiceWorker) => {
          worker.addEventListener("statechange", () => {
            if (disposed) return;
            if (worker.state === "installed") {
              setWaiting(!!reg.waiting && !!reg.active);
              setStatus(
                "오프라인 파일 준비 완료 · 앱·시각화·회귀·군집·연관 작업 스레드 포함",
              );
            }
            if (worker.state === "activated") setWaiting(!!reg.waiting);
            if (worker.state === "redundant")
              setError(
                "오프라인 파일 준비에 실패했습니다. 연결 상태와 저장 공간을 확인하고 다시 시도하세요.",
              );
          });
        };
        if (reg.installing) track(reg.installing);
        reg.addEventListener("updatefound", () => {
          if (reg.installing) track(reg.installing);
        });
        navigator.serviceWorker.ready.then(() => {
          if (!disposed)
            setStatus(
              "오프라인 파일 준비 완료 · 앱·시각화·회귀·군집·연관 작업 스레드 포함",
            );
        });
      })
      .catch((e) => {
        setStatus("오프라인 준비 실패");
        setError(String(e));
      });
    return () => {
      disposed = true;
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);
  const check = async () => {
    try {
      setError("");
      await registration?.update();
      setWaiting(!!registration?.waiting);
    } catch (e) {
      setError(
        `업데이트 확인 실패: ${String(e)}. 인터넷 연결 후 다시 확인하세요.`,
      );
    }
  };
  const apply = async (save: () => Promise<void>, blocked: () => boolean) => {
    if (!registration) return;
    let reload = false;
    const changed = () => {
      if (reload) location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed, {
      once: true,
    });
    try {
      await applyWaitingUpdate(registration, save, blocked);
      reload = true;
    } catch (e) {
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      throw e;
    }
  };
  const prompt = async () => {
    if (install) {
      await install.prompt();
      await install.userChoice;
      setInstall(null);
    }
  };
  return {
    waiting,
    status,
    error,
    check,
    apply,
    canInstall: !!install,
    prompt,
  };
}
