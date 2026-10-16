import { describe, expect, it, vi } from "vitest";
import { JobGate } from "./protocol";
import type { AnalysisConfig } from "../domain/types";

const config: AnalysisConfig = {
  kind: "clustering",
  source: { datasetId: "d1", versionId: "v1" },
  attributeIds: ["c1"],
  parameters: {},
  preprocessing: { steps: [] },
  calculation: { method: null, missingValuePolicy: null, settings: {} },
  split: { method: "none", settings: {} },
  randomness: { seed: null, settings: {} },
};
describe("worker integration guard", () => {
  it("rejects old responses and duplicate terminal responses", () => {
    const gate = new JobGate();
    const old = gate.start("panel", config);
    const latest = gate.start("panel", config);
    const commit = vi.fn();
    expect(
      gate.receive({ ...old, type: "complete", result: "old" }, commit),
    ).toBe(false);
    expect(
      gate.receive(
        { ...old, type: "error", error: { code: "old", message: "old error" } },
        commit,
      ),
    ).toBe(false);
    expect(
      gate.receive(
        {
          ...latest,
          type: "progress",
          completed: 1,
          total: 2,
          message: "진행 중",
        },
        commit,
      ),
    ).toBe(true);
    expect(
      gate.receive({ ...latest, type: "complete", result: "latest" }, commit),
    ).toBe(true);
    expect(
      gate.receive(
        { ...latest, type: "complete", result: "duplicate" },
        commit,
      ),
    ).toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
  });
  it("blocks results immediately on cancel, even before acknowledgement", () => {
    const gate = new JobGate();
    const request = gate.start("panel", config);
    expect(gate.invalidate("panel")).toEqual({
      type: "cancel",
      jobId: request.jobId,
      scopeId: "panel",
    });
    const commit = vi.fn();
    expect(
      gate.receive({ ...request, type: "complete", result: 1 }, commit),
    ).toBe(false);
    expect(gate.receive({ ...request, type: "cancelled" }, commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  it("isolates panel scopes and copies request conditions", () => {
    const gate = new JobGate();
    const draft = structuredClone(config);
    const request = gate.start("one", draft);
    gate.start("two", config);
    draft.attributeIds.push("c2");
    expect(request.type === "run" && request.config.attributeIds).toEqual([
      "c1",
    ]);
    gate.invalidate("two");
    expect(
      gate.receive(
        {
          ...request,
          type: "error",
          error: {
            code: "invalid",
            message: "실행 실패",
            cause: "값 누락",
            remedy: "자료를 확인하세요.",
          },
        },
        vi.fn(),
      ),
    ).toBe(true);
  });
});
