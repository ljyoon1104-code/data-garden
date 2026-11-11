import { checkWranglingSettings } from "../domain/wrangling-validation";
import { RESTORE_WORK_LIMIT } from "./backup-limits";

export interface WorkTable {
  rows: number;
  columns: number;
  textWork: number;
}

/** Conservative units for fit/apply replay, including settings-dependent passes. */
export function estimateWranglingWork(
  settings: unknown,
  inputs: readonly WorkTable[],
  output: WorkTable,
): number {
  checkWranglingSettings(settings);
  const first = inputs[0] ?? { rows: 0, columns: 0, textWork: 0 };
  const inputRows = inputs.reduce((sum, table) => sum + table.rows, 0);
  const inputColumns = inputs.reduce((sum, table) => sum + table.columns, 0);
  const sortPasses = Math.ceil(Math.log2(Math.max(1, first.rows)));
  const tableWork = (table: WorkTable) => (table.rows + 1) * (table.columns + 1);
  let work = 3 * tableWork(output);
  for (const table of inputs) work += 4 * (tableWork(table) + table.textWork);

  switch (settings.kind) {
    case "calculate":
      work += settings.operands.length * (first.columns + 2 + 6 * first.rows);
      break;
    case "date":
      work += settings.parts.length * (first.columns + 1 + 4 * first.rows);
      break;
    case "encode":
      work += 6 * first.rows + 4 * (settings.order?.length ?? 0);
      break;
    case "bin": {
      const searchPasses = Math.ceil(Math.log2(Math.max(1, settings.count) + 1));
      work += settings.count + first.rows * (4 + 2 * sortPasses + 4 * searchPasses);
      break;
    }
    case "join":
      work += 4 * settings.keys.length * (inputRows + inputColumns + output.rows);
      break;
    case "stack": {
      const sources = settings.mappings.reduce((sum, mapping) => sum + mapping.sources.length, 0);
      work += sources * (inputRows + inputColumns) + settings.excluded.length;
      break;
    }
    case "aggregate": {
      const passes = settings.aggregates.reduce(
        (sum, aggregate) => sum + 6 + (aggregate.method === "median" ? 2 * sortPasses : 0),
        0,
      );
      work += first.rows * (4 * settings.groupIds.length + passes) +
        settings.aggregates.length * first.columns;
      break;
    }
  }
  // Saturation keeps repeated ancestor sums finite while guaranteeing rejection.
  return Number.isSafeInteger(work) && work >= 0
    ? Math.min(work, RESTORE_WORK_LIMIT + 1)
    : RESTORE_WORK_LIMIT + 1;
}
