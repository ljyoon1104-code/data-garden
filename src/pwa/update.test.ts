import { it, expect, vi } from "vitest";
import { applyWaitingUpdate } from "./usePwa";
it("activates only after a successful latest save and no outstanding work", async () => {
  const postMessage = vi.fn(),
    reg = { waiting: { postMessage } } as unknown as ServiceWorkerRegistration;
  await expect(
    applyWaitingUpdate(
      reg,
      async () => {
        throw new Error("저장 실패");
      },
      () => false,
    ),
  ).rejects.toThrow("저장 실패");
  expect(postMessage).not.toHaveBeenCalled();
  const save = vi.fn(async () => {});
  await expect(applyWaitingUpdate(reg, save, () => true)).rejects.toThrow(
    "확정",
  );
  expect(save).not.toHaveBeenCalled();
  let blocked = false;
  await expect(
    applyWaitingUpdate(
      reg,
      async () => {
        blocked = true;
      },
      () => blocked,
    ),
  ).rejects.toThrow("새 작업");
  expect(postMessage).not.toHaveBeenCalled();
  await applyWaitingUpdate(reg, save, () => false);
  expect(save).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "ACTIVATE_UPDATE",
  });
});
