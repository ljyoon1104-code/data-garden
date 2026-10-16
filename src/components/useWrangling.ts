import { useEffect, useRef, useState } from "react";
import {
  activeDatasets,
  getSelection,
  type WorkspaceAction,
  type WorkspaceState,
} from "../state/workspace";
import { defaultWrangling } from "../domain/wrangling";
import type {
  InputTable,
  WranglingPreview,
  WranglingSettings,
} from "../domain/wrangling-types";
import { MAX_PRESERVED_CELLS, preservedCellCount } from "../domain/limits";
import { useTask } from "../workers/useTask";

export function useWrangling(
  state: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
) {
  const { dataset, version } = getSelection(state),
    available = activeDatasets(state.project);
  const getInputs = (ids: string[]): InputTable[] =>
    ids.flatMap((id) => {
      const d = available.find((d) => d.id === id),
        v = d?.versions.find((v) => v.id === state.project.activeVersions[id]);
      return d && v
        ? [
            {
              source: { datasetId: d.id, versionId: v.id },
              name: d.name,
              table: { columns: v.columns, rows: v.rows },
            },
          ]
        : [];
    });
  const initialIds = () =>
    [
      dataset?.id,
      ...available
        .filter((d) => d.id !== dataset?.id)
        .slice(0, 1)
        .map((d) => d.id),
    ].filter((id): id is string => !!id);
  const [ids, setIds] = useState(initialIds),
    [settings, setSettings] = useState<WranglingSettings>(() =>
      defaultWrangling("calculate", getInputs(dataset ? [dataset.id] : [])),
    );
  const [result, setResult] = useState<{
      key: string;
      preview: WranglingPreview;
    } | null>(null),
    [ack, setAck] = useState(false),
    [mappingConfirmed, setMappingConfirmed] = useState(false);
  const inputs = getInputs(
      settings.kind === "join"
        ? ids.slice(0, 2)
        : settings.kind === "stack"
          ? ids
          : dataset
            ? [dataset.id]
            : [],
    ),
    key = JSON.stringify(inputs.map((i) => i.source));
  const task = useTask("wrangling"),
    generation = useRef(0),
    current = useRef(key);
  current.current = key;
  const clear = () => {
    generation.current++;
    task.cancel();
    setResult(null);
    setAck(false);
  };
  useEffect(() => {
    generation.current++;
    task.cancel();
    setResult(null);
    setAck(false);
    setMappingConfirmed(false);
  }, [key, task.cancel]);
  useEffect(() => {
    const next = initialIds();
    setIds(next);
    setSettings((s) =>
      defaultWrangling(
        s.kind,
        getInputs(
          s.kind === "join" || s.kind === "stack"
            ? next
            : dataset
              ? [dataset.id]
              : [],
        ),
      ),
    );
    setMappingConfirmed(false);
  }, [dataset?.id]);
  const change = (s: WranglingSettings) => {
    clear();
    setSettings(s);
    if (s.kind === "stack") setMappingConfirmed(false);
  };
  const chooseKind = (kind: WranglingSettings["kind"]) => {
    const next = initialIds();
    setIds(next);
    change(
      defaultWrangling(
        kind,
        getInputs(
          kind === "join" || kind === "stack"
            ? next
            : dataset
              ? [dataset.id]
              : [],
        ),
      ),
    );
  };
  const chooseInputs = (next: string[]) => {
    setIds(next);
    change(defaultWrangling(settings.kind, getInputs(next)));
  };
  const remaining = MAX_PRESERVED_CELLS - preservedCellCount(state.project),
    preview = result?.key === key ? result.preview : null;
  const run = () => {
    if (!inputs.length || (settings.kind === "stack" && !mappingConfirmed))
      return;
    clear();
    const token = generation.current;
    task.run({ kind: "wrangle-preview", inputs, settings, remaining }, (r) => {
      if (
        r.kind === "wrangle-preview" &&
        token === generation.current &&
        key === current.current
      )
        setResult({ key, preview: r.preview });
    });
  };
  const apply = () => {
    if (
      !preview ||
      task.busy ||
      preview.issues.some((i) => i.blocking) ||
      (preview.summary.manyToManyGroups > 0 && !ack)
    )
      return;
    const token = generation.current;
    task.run(
      {
        kind: "wrangle-commit",
        inputs,
        fitted: preview.fitted,
        remaining,
        acknowledgedMany: ack,
      },
      (r) => {
        if (
          r.kind !== "wrangle-commit" ||
          token !== generation.current ||
          key !== current.current
        )
          return;
        if (r.dataset)
          dispatch({
            type: "register-derived",
            dataset: r.dataset,
            expectedInputs: inputs.map((i) => i.source),
          });
        else if (dataset && version)
          dispatch({
            type: "commit-version",
            datasetId: dataset.id,
            baseVersionId: version.id,
            version: r.version,
          });
        setResult(null);
      },
    );
  };
  return {
    settings,
    change,
    chooseKind,
    inputs,
    ids,
    chooseInputs,
    available,
    preview,
    run,
    apply,
    clear,
    task,
    ack,
    setAck,
    mappingConfirmed,
    setMappingConfirmed: (confirmed: boolean) => {
      if (!confirmed) clear();
      setMappingConfirmed(confirmed);
    },
    pending: task.busy || !!preview,
  };
}
export type WranglingControl = ReturnType<typeof useWrangling>;
