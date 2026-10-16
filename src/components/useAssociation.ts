import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceAction, WorkspaceState } from "../state/workspace";
import { getSelection } from "../state/workspace";
import type { AnalysisConfig, AnalysisRecord } from "../domain/types";
import type {
  AssociationConfig,
  AssociationSettings,
  AssociationTransactions,
} from "../domain/association-types";
import {
  associationConfig,
  associationInput,
  defaultAssociation,
  validateAssociationSettings,
} from "../domain/association";
import { associationValidationBudget } from "../domain/association-validation";
import { analysisConfigKey } from "../domain/clustering";
import { createAnalysisRecord } from "../domain/model";
import { defaultTableView } from "../domain/table";
import { WorkerRunner } from "../workers/client";

export function useAssociation(
  state: WorkspaceState,
  dispatch: (a: WorkspaceAction) => void,
  writable = true,
) {
  const { project, view } = state,
    { dataset, version } = getSelection(state);
  const stored = dataset
    ? project.analysisConfigs[analysisConfigKey(dataset.id, "association")]
    : null;
  const config = useMemo(() => {
    if (!version || !dataset) return null;
    const settings = stored?.association
      ? structuredClone(stored.association)
      : defaultAssociation();
    if (stored && stored.source.versionId !== version.id) {
      settings.columns = settings.columns.filter((id) =>
        version.columns.some((c) => c.id === id),
      );
      if (!version.columns.some((c) => c.id === settings.transactionId))
        settings.transactionId = "";
      settings.scope = {
        kind: "all",
        filter: null,
        duplicatesOnly: false,
        rowIds: [],
      };
    }
    return associationConfig(
      { datasetId: dataset.id, versionId: version.id },
      settings,
    );
  }, [stored, dataset, version]);
  const key = JSON.stringify({ project: project.id, config });
  const current = useRef({ key, project });
  current.current = { key, project };
  const [runner] = useState(() => new WorkerRunner("association-run"));
  const active = useRef<AnalysisRecord | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [draftFields, setDraftFields] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<{
    key: string;
    result: AssociationTransactions;
  } | null>(null);
  const cancel = (reason = "사용자가 작업을 취소했습니다.") => {
    runner.cancel();
    setBusy(false);
    const record = active.current;
    active.current = null;
    if (record)
      dispatch({
        type: "analysis-record",
        record: {
          ...record,
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: {
            code: "CANCELLED",
            message: reason,
            remedy: "조건을 확인하고 다시 실행하세요.",
          },
        },
      });
    setMessage(reason);
  };
  useEffect(() => {
    cancel("자료 또는 조건이 바뀌어 이전 작업을 무효화했습니다.");
    setPreview(null);
  }, [key]);
  useEffect(
    () => () => {
      runner.cancel();
    },
    [runner],
  );
  useEffect(() => {setDraftFields({});}, [dataset?.id, version?.id]);
  const invalidatePreview = (field: string) => {
    cancel("미확정 조건이 있어 이전 작업을 취소했습니다.");
    setPreview(null);
    setDraftFields((old) => ({ ...old, [field]: true }));
  };
  const patch = (patch: Partial<AssociationSettings>, field?: string) => {
    if (!writable || !config) return;
    cancel("조건 변경으로 이전 작업을 취소했습니다.");
    setPreview(null);
    setError("");
    try {
      const s = { ...config.association, ...patch };
      validateAssociationSettings(s);
      dispatch({
        type: "analysis-config",
        config: associationConfig(config.source, s),
      });
      if (field) setDraftFields((old) => ({ ...old, [field]: false }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const tableView = (dataset && view.tables[dataset.id]) || defaultTableView();
  const scope = (kind: AssociationSettings["scope"]["kind"]) =>
    patch({
      scope: {
        kind,
        filter: kind === "filtered" ? structuredClone(tableView.filter) : null,
        duplicatesOnly: kind === "filtered" && tableView.duplicatesOnly,
        rowIds: kind === "selected" ? [...tableView.selectedRowIds] : [],
      },
    });
  const start = (
    mode: "association-preview" | "association-run",
    requested: AnalysisConfig | null = config,
  ) => {
    if (!requested?.association || !writable) return;
    cancel();
    setError("");
    let record: AnalysisRecord | null = null;
    try {
      validateAssociationSettings(requested.association);
      const input = associationInput(project, requested as AssociationConfig);
      if (mode === "association-run") {
        if (project.analyses.length >= 50)
          throw new Error(
            "분석 기록 50개 한도입니다. 백업 후 불필요한 기록을 삭제하세요.",
          );
        record = {
          ...createAnalysisRecord(
            requested,
            crypto.randomUUID(),
            new Date().toISOString(),
          ),
          status: "running",
        };
        active.current = record;
        dispatch({ type: "analysis-record", record });
      }
      const captured = key,
        recordId = record?.id;
      setBusy(true);
      setMessage(
        mode === "association-preview"
          ? "거래 미리보기 준비 중…"
          : "거래·Apriori 계산 준비 중…",
      );
      runner.run(
        { kind: mode, input, settings: requested.association },
        (response) => {
          if (
            current.current.key !== captured ||
            current.current.project.id !== project.id ||
            (recordId && active.current?.id !== recordId)
          )
            return;
          if (
            recordId &&
            !current.current.project.analyses.some(
              (a) => a.id === recordId && a.status === "running",
            )
          )
            return;
          if (response.type === "progress") {
            setMessage(response.message);
            return;
          }
          active.current = null;
          setBusy(false);
          setMessage("");
          if (response.type === "complete") {
            if (response.result.kind === "association-preview")
              setPreview({ key: captured, result: response.result.result });
            if (response.result.kind === "association-run" && record) {
              const completed: AnalysisRecord = {
                ...record,
                status: "completed",
                association: response.result.result,
                completedAt: new Date().toISOString(),
              };
              try {
                associationValidationBudget([
                  ...current.current.project.analyses.filter(
                    (a) => a.id !== recordId,
                  ),
                  completed,
                ]);
                dispatch({ type: "analysis-record", record: completed });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setError(msg);
                dispatch({
                  type: "analysis-record",
                  record: {
                    ...record,
                    status: "failed",
                    completedAt: new Date().toISOString(),
                    error: {
                      code: "RESTORE_BUDGET",
                      message: msg,
                      remedy:
                        "백업 후 이전 기록을 삭제하거나 범위·길이를 줄이세요.",
                    },
                  },
                });
              }
            }
          } else if (response.type === "error") {
            setError(
              (response.error.cause || response.error.message) +
                " " +
                (response.error.remedy || ""),
            );
            if (record)
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
      active.current = null;
      setBusy(false);
      setMessage("");
      setError(e instanceof Error ? e.message : String(e));
      if (record)
        dispatch({
          type: "analysis-record",
          record: {
            ...record,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: {
              code: "START_FAILED",
              message: String(e),
              remedy: "입력·Worker 지원을 확인하세요.",
            },
          },
        });
    }
  };
  const selected =
    project.analyses.find(
      (a) =>
        a.id === view.associationSelection?.current && a.kind === "association",
    ) ?? null;
  const comparison =
    project.analyses.find(
      (a) =>
        a.id === view.associationSelection?.comparison &&
        a.kind === "association",
    ) ?? null;
  const cloneCurrent = (record: AnalysisRecord) => {
    if (!writable || !config || !record.configSnapshot.association) return;
    const old = structuredClone(
      record.configSnapshot.association,
    ) as AssociationSettings;
    old.columns = old.columns.filter((id) =>
      version?.columns.some((c) => c.id === id),
    );
    if (!version?.columns.some((c) => c.id === old.transactionId))
      old.transactionId = "";
    patch({
      ...old,
      scope: { kind: "all", filter: null, duplicatesOnly: false, rowIds: [] },
    });
  };
  const remove = (id: string) => {
    if (!writable) return;
    if (active.current?.id === id) cancel();
    dispatch({ type: "analysis-delete", id });
  };
  return {
    state,
    dispatch,
    writable,
    invalidatePreview,
    hasDraft: Object.values(draftFields).some(Boolean),
    config,
    version,
    dataset,
    patch,
    scope,
    busy,
    message,
    error,
    cancel,
    selected,
    comparison,
    cloneCurrent,
    remove,
    preview: preview?.key === key ? preview.result : null,
    previewRun: () => start("association-preview"),
    run: (requested: AnalysisConfig | null = config) =>
      start("association-run", requested),
  };
}
export type AssociationControl = ReturnType<typeof useAssociation>;
