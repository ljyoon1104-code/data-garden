import type { Project } from "./types";
export const MAX_PRESERVED_CELLS = 3_000_000;
export function preservedCellCount(project: Project) {
  return project.datasets.reduce(
    (sum, d) =>
      sum +
      [d.original.table, ...d.versions].reduce(
        (n, v) => n + v.rows.length * v.columns.length,
        0,
      ),
    0,
  );
}
export function canAppendTable(
  project: Project,
  rows: number,
  columns: number,
) {
  return preservedCellCount(project) + rows * columns <= MAX_PRESERVED_CELLS;
}
