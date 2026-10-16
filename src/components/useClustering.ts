import { clusteringValidationBudget } from "../domain/clustering-validation";
import { analysisConfigKey } from "../domain/clustering";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import { getSelection } from "../state/workspace";
import type { AnalysisConfig, AnalysisRecord } from "../domain/types";
import type {
  ClusteringConfig,
  ClusteringSettings,
} from "../domain/clustering-types";
import {
  buildClusteringPlan,
  defaultClustering,
  clusteringConfig,
  validateClusteringSettings,
} from "../domain/clustering";
import { createAnalysisRecord } from "../domain/model";
import { WorkerRunner } from "../workers/client";
import { defaultTableView } from "../domain/table";

export function useClustering(
  state: WorkspaceState,
  dispatch: (a: WorkspaceAction) => void,
  writable = true,
) {
  const { project, view } = state,
    { version, dataset } = getSelection(state);
  const stored = dataset
    ? project.analysisConfigs[analysisConfigKey(dataset.id, "clustering")]
    : null;
  const config = useMemo(() => {
    if (!version || !dataset) return null;
    const settings = stored?.clustering
      ? structuredClone(stored.clustering)
      : defaultClustering();
    if (stored?.source.versionId !== version.id) {
      settings.features = settings.features.filter((id) =>
        version.columns.some((c) => c.id === id),
      );
      settings.scope = {
        kind: "all",
        filter: null,
        duplicatesOnly: false,
        rowIds: [],
      };
    }
    if (!stored?.clustering)
      settings.features = version.columns
        .filter(
          (c) =>
            c.storageType === "number" &&
            c.semanticType === "numeric" &&
            c.useInAnalysis,
        )
        .slice(0, 2)
        .map((c) => c.id);
    return clusteringConfig(
      { datasetId: dataset.id, versionId: version.id },
      settings,
    );
  }, [version, dataset, stored]);
  const key = JSON.stringify({ project: project.id, config }),
    current = useRef({ key, project });
  current.current = { key, project };
  const [runner] = useState(() => new WorkerRunner("clustering-run"));
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
  const patch = (patch: Partial<ClusteringSettings>) => {
    cancel("조건 변경으로 이전 계산을 취소했습니다.");
    setError("");
    if (config) {
      try {
        validateClusteringSettings({ ...config.clustering, ...patch });
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        return;
      }
      dispatch({
        type: "analysis-config",
        config: clusteringConfig(config.source, {
          ...config.clustering,
          ...patch,
        }),
      });
    }
  };
  const tableView = (dataset && view.tables[dataset.id]) || defaultTableView();
  const scope = (kind: ClusteringSettings["scope"]["kind"]) =>
    patch({
      scope: {
        kind,
        filter: kind === "filtered" ? structuredClone(tableView.filter) : null,
        duplicatesOnly: kind === "filtered" && tableView.duplicatesOnly,
        rowIds: kind === "selected" ? [...tableView.selectedRowIds] : [],
      },
    });
  const run = (requested: AnalysisConfig | null = config) => {
    if (!writable) return;
    if (!requested?.clustering) return;
    cancel();
    setError("");
    try {
      if (project.analyses.length >= 50)
        throw new Error(
          "분석 기록은 프로젝트당 50개까지입니다. 백업한 후 필요 없는 기록을 삭제하세요.",
        );
      const plan = buildClusteringPlan(project, requested as ClusteringConfig),
        record = {
          ...createAnalysisRecord(
            requested,
            crypto.randomUUID(),
            new Date().toISOString(),
          ),
          status: "running" as const,
        };
      const cs = requested.clustering,
        count = plan.scopeRowIds.length;
      clusteringValidationBudget(
        project.analyses,
        count *
          cs.features.length *
          (cs.ks.reduce((a, b) => a + b, 0) *
            cs.restarts *
            cs.maxIterations *
            3 +
            (cs.silhouette.mode === "none"
              ? 0
              : cs.silhouette.mode === "exact"
                ? count
                : Math.min(count, cs.silhouette.sampleSize)) *
              cs.ks.length),
      );
      const captured = key;
      active.current = record;
      dispatch({ type: "analysis-record", record });
      setBusy(true);
      setMessage("군집 입력·초기화 준비 중…");
      runner.run(
        { kind: "clustering-run", plan, settings: requested.clustering },
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
            response.result.kind === "clustering-run"
          ) {
            const clustering = response.result.result;
            if (new TextEncoder().encode(JSON.stringify(clustering)).byteLength > 12 * 1024 * 1024) {
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
                clustering,
                completedAt: new Date().toISOString(),
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
      (a) => a.id === view.clusterSelection?.current && a.kind === "clustering",
    ) ?? null;
  const comparison =
    project.analyses.find(
      (a) =>
        a.id === view.clusterSelection?.comparison && a.kind === "clustering",
    ) ?? null;
  const cloneCurrent = (record: AnalysisRecord) => {
    if (!config || !record.configSnapshot.clustering) return;
    cancel();
    const old = structuredClone(
      record.configSnapshot.clustering,
    ) as ClusteringSettings;
    old.features = old.features.filter((id) =>
      version?.columns.some((c) => c.id === id),
    );
    dispatch({
      type: "analysis-config",
      config: clusteringConfig(config.source, {
        ...old,
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
    writable,
    state,
    dispatch,
    config: config as ClusteringConfig | null,
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
export type ClusteringControl = ReturnType<typeof useClustering>;
