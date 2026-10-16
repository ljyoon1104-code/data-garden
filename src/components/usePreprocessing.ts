import { useEffect, useRef, useState } from "react";
import type { WorkspaceState, WorkspaceAction } from "../state/workspace";
import { getSelection } from "../state/workspace";
import {
  defaultPreprocessing,
  preprocessingLineage,
} from "../domain/preprocessing";
import type {
  PreprocessingSettings,
  PreprocessingPreview,
} from "../domain/preprocessing-types";
import { useTask } from "../workers/useTask";
import { canAppendTable } from "../domain/limits";

export function usePreprocessing(
  state: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
) {
  const { dataset, version } = getSelection(state),
    key = version?.id ?? "";
  const [settings, setSettings] = useState<PreprocessingSettings>(() =>
    defaultPreprocessing("missing", version ?? { columns: [], rows: [] }),
  );
  const [result, setResult] = useState<{
    key: string;
    preview: PreprocessingPreview;
  } | null>(null);
  const task = useTask("preprocessing"),
    generation = useRef(0),
    current = useRef(key);
  current.current = key;
  const clear = () => {
    generation.current++;
    task.cancel();
    setResult(null);
  };
  useEffect(() => {
    generation.current++;
    task.cancel();
    setResult(null);
    setSettings(
      defaultPreprocessing("missing", version ?? { columns: [], rows: [] }),
    );
    // Reset only on input version changes; menu, sorting and filtering do not affect preprocessing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, task.cancel]);
  const change = (next: PreprocessingSettings) => {
    clear();
    setSettings(next);
  };
  const preview = result?.key === key ? result.preview : null;
  const overLimit =
    !!preview &&
    !canAppendTable(state.project, preview.afterRows, preview.columnCount);
  const run = () => {
    if (!dataset || !version) return;
    clear();
    const token = generation.current;
    task.run(
      {
        kind: "preprocess-preview",
        table: { columns: version.columns, rows: version.rows },
        source: { datasetId: dataset.id, versionId: version.id },
        settings,
      },
      (r) => {
        if (
          r.kind === "preprocess-preview" &&
          token === generation.current &&
          key === current.current
        )
          setResult({ key, preview: r.preview });
      },
    );
  };
  const apply = () => {
    if (!dataset || !version || !preview || overLimit || task.busy) return;
    const token = generation.current;
    task.run(
      {
        kind: "preprocess-commit",
        table: { columns: version.columns, rows: version.rows },
        source: { datasetId: dataset.id, versionId: version.id },
        fitted: preview.fitted,
        lineage: preprocessingLineage(dataset, version.id),
      },
      (r) => {
        if (
          r.kind !== "preprocess-commit" ||
          token !== generation.current ||
          key !== current.current
        )
          return;
        if (r.version)
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
    preview,
    run,
    apply,
    clear,
    task,
    overLimit,
    pending: task.busy || !!preview,
  };
}
