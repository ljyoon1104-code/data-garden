import { analysisConfigKey } from "../domain/clustering";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import { getSelection } from "../state/workspace";
import type { AnalysisConfig, AnalysisRecord } from "../domain/types";
import type {
  RegressionConfig,
  RegressionSettings,
} from "../domain/regression-types";
import {
  buildRegressionPlan,
  defaultRegression,
  regressionConfig,
  validateRegressionSettings,
} from "../domain/regression";
import { createAnalysisRecord } from "../domain/model";
import { WorkerRunner } from "../workers/client";
import { defaultTableView } from "../domain/table";

export function useRegression(
  state: WorkspaceState,
  dispatch: (a: WorkspaceAction) => void,
) {
  const { project, view } = state,
    { version, dataset } = getSelection(state);
  const stored = dataset
    ? project.analysisConfigs[analysisConfigKey(dataset.id, "regression")]
    : null;
  const config = useMemo(() => {
    if (!version || !dataset) return null;
    const settings = stored?.regression
      ? structuredClone(stored.regression)
      : defaultRegression();
    if (stored?.source.versionId !== version.id) {
      settings.target = version.columns.some((c) => c.id === settings.target)
        ? settings.target
        : "";
      settings.features = settings.features.filter((id) =>
        version.columns.some((c) => c.id === id),
      );
      settings.reuseSplit = null;
      settings.scope = {
        kind: "all",
        filter: null,
        duplicatesOnly: false,
        rowIds: [],
      };
    }
    return regressionConfig(
      { datasetId: dataset.id, versionId: version.id },
      settings,
    );
  }, [version, dataset, stored]);
  const key = JSON.stringify({ project: project.id, config }),
    current = useRef({ key, project });
  current.current = { key, project };
  const [runner] = useState(() => new WorkerRunner("regression-run"));
  const active = useRef<AnalysisRecord | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const cancel = (reason = "사용자가 계산을 취소했습니다.") => {
    runner.cancel();
    const record = active.current;
    active.current = null;
    setBusy(false);
    if (record) {
      dispatch({
        type: "analysis-record",
        record: {
          ...record,
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: {
            code: "CANCELLED",
            message: reason,
            remedy: "필요하면 조건을 확인하고 다시 실행하세요.",
          },
        },
      });
      setMessage(reason);
    }
  };
  useEffect(() => {
    cancel("자료 또는 설정 변경으로 이전 계산을 취소했습니다.");
  }, [key]); // Gate invalidation is synchronous in settings handlers too.
  useEffect(
    () => () => {
      runner.cancel();
    },
    [runner],
  );
  const patch = (patch: Partial<RegressionSettings>) => {
    cancel("조건 변경으로 이전 계산을 취소했습니다.");
    setError("");
    if (config) {
      try {
        validateRegressionSettings({ ...config.regression, ...patch });
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        return;
      }
      dispatch({
        type: "analysis-config",
        config: regressionConfig(config.source, {
          ...config.regression,
          ...patch,
        }),
      });
    }
  };
  const tableView = (dataset && view.tables[dataset.id]) || defaultTableView();
  const scope = (kind: RegressionSettings["scope"]["kind"]) =>
    patch({
      scope: {
        kind,
        filter: kind === "filtered" ? structuredClone(tableView.filter) : null,
        duplicatesOnly: kind === "filtered" && tableView.duplicatesOnly,
        rowIds: kind === "selected" ? [...tableView.selectedRowIds] : [],
      },
      reuseSplit: null,
    });
  const run = (requested: AnalysisConfig | null = config) => {
    if (!requested?.regression) return;
    cancel();
    setError("");
    try {
      if (project.analyses.length >= 50)
        throw new Error(
          "분석 기록은 프로젝트당 50개까지입니다. 백업한 후 필요 없는 기록을 삭제하세요.",
        );
      const plan = buildRegressionPlan(project, requested),
        record = {
          ...createAnalysisRecord(
            requested,
            crypto.randomUUID(),
            new Date().toISOString(),
          ),
          status: "running" as const,
        };
      const captured = key;
      active.current = record;
      dispatch({ type: "analysis-record", record });
      setBusy(true);
      setMessage("분할·학습 준비 중…");
      runner.run(
        { kind: "regression-run", plan, settings: requested.regression },
        (response) => {
          if (
            current.current.key !== captured ||
            active.current?.id !== record.id ||
            current.current.project.id !== project.id
          )
            return;
          if (response.type === "progress") {
            setMessage(response.message);
            return;
          }
          active.current = null;
          setBusy(false);
          setMessage("");
          if (
            response.type === "complete" &&
            response.result.kind === "regression-run"
          ) {
            const regression = response.result.result;
            if (JSON.stringify(regression).length > 12 * 1024 * 1024) {
              dispatch({
                type: "analysis-record",
                record: {
                  ...record,
                  status: "failed",
                  error: {
                    code: "RESULT_LIMIT",
                    message: "결과가 12 MiB 한도를 넘습니다.",
                    remedy: "범위·입력·모델 수를 줄이세요.",
                  },
                  completedAt: new Date().toISOString(),
                },
              });
              return;
            }
            dispatch({
              type: "analysis-record",
              record: {
                ...record,
                status: "completed",
                regression,
                completedAt: regression.completedAt,
              },
            });
          } else if (response.type === "error") {
            setError(
              (response.error.cause || response.error.message) +
                " " +
                (response.error.remedy || ""),
            );
            dispatch({
              type: "analysis-record",
              record: {
                ...record,
                status: "failed",
                error: response.error,
                completedAt: new Date().toISOString(),
              },
            });
          }
        },
      );
    } catch (e) {
      runner.cancel();
      setBusy(false);
      setMessage("");
      const interrupted = active.current;
      active.current = null;
      if (interrupted)
        dispatch({
          type: "analysis-record",
          record: {
            ...interrupted,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: {
              code: "START_FAILED",
              message: String(e),
              remedy: "Worker 지원·자료 조건을 확인하고 다시 실행하세요.",
            },
          },
        });
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const selected =
    project.analyses.find(
      (a) => a.id === view.currentAnalysisId && a.kind === "regression",
    ) ?? null;
  const comparison =
    project.analyses.find(
      (a) => a.id === view.comparisonAnalysisId && a.kind === "regression",
    ) ?? null;
  const cloneCurrent = (record: AnalysisRecord) => {
    if (!config || !record.configSnapshot.regression) return;
    cancel();
    const old = structuredClone(
      record.configSnapshot.regression,
    ) as RegressionSettings;
    old.target = version?.columns.some((c) => c.id === old.target)
      ? old.target
      : "";
    old.features = old.features.filter((id) =>
      version?.columns.some((c) => c.id === id),
    );
    dispatch({
      type: "analysis-config",
      config: regressionConfig(config.source, {
        ...old,
        reuseSplit: null,
        scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
      }),
    });
    dispatch({ type: "menu", menu: "analyze" });
  };
  const remove = (id: string) => {
    if (active.current?.id === id) cancel();
    dispatch({ type: "analysis-delete", id });
  };
  return {
    state,
    dispatch,
    config: config as RegressionConfig | null,
    version,
    dataset,
    patch,
    scope,
    run,
    cancel,
    busy,
    message,
    error,
    selected,
    comparison,
    cloneCurrent,
    remove,
  };
}
export type RegressionControl = ReturnType<typeof useRegression>;
