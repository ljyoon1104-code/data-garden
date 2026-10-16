import type { DataVersion, DeepReadonly, Project } from "./types";
import type { WranglingSettings, InputTable } from "./wrangling-types";
import { fitWrangling, applyWrangling, isDerived } from "./wrangling";
import { resolveVersion } from "./processing";

const require = (ok: unknown, message: string) => {
  if (!ok) throw new Error("가공 기록: " + message);
};
function canonical(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
}
const same = (a: unknown, b: unknown, message: string) =>
  require(canonical(a) === canonical(b), message);
/** Explicit settings shape before invoking typed domain functions on imported JSON. */
export function checkWranglingSettings(
  value: unknown,
): asserts value is WranglingSettings {
  require(value && typeof value === "object", "설정 객체가 필요합니다.");
  const s = value as Record<string, any>;
  const str = (v: unknown) => typeof v === "string",
    list = (v: unknown) => Array.isArray(v),
    one = (v: unknown, choices: string[]) => choices.includes(String(v));
  const field = (v: any) => v && str(v.name) && str(v.description),
    ref = (v: any) =>
      v && Number.isInteger(v.input) && v.input >= 0 && str(v.attributeId);
  const cell = (v: unknown) =>
    v === null ||
    str(v) ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v));
  let ok = false;
  switch (s.kind) {
    case "calculate":
      ok =
        one(s.operator, [
          "add",
          "subtract",
          "multiply",
          "divide",
          "sum",
          "mean",
          "ratio",
          "percent",
        ]) &&
        list(s.operands) &&
        s.operands.every(
          (o: any) =>
            o &&
            (o.kind === "attribute"
              ? str(o.attributeId)
              : o.kind === "constant" &&
                typeof o.value === "number" &&
                Number.isFinite(o.value)),
        ) &&
        one(s.missing, ["propagate", "skip"]) &&
        one(s.invalid, ["block", "missing"]) &&
        field(s.output);
      break;
    case "date":
      ok =
        str(s.attributeId) &&
        list(s.parts) &&
        s.parts.every(
          (p: any) =>
            field(p) &&
            one(p.part, [
              "year",
              "month",
              "day",
              "quarter",
              "weekday",
              "hour",
              "minute",
              "second",
            ]) &&
            one(p.storageType, ["number", "string"]) &&
            one(p.semanticType, [
              "numeric",
              "categorical",
              "identifier",
              "text",
            ]),
        ) &&
        one(s.invalid, ["block", "missing"]);
      break;
    case "encode":
      ok =
        str(s.attributeId) &&
        one(s.method, ["code", "onehot"]) &&
        field(s.output) &&
        (s.order === null || (list(s.order) && s.order.every(cell))) &&
        typeof s.dropBaseline === "boolean" &&
        cell(s.baseline) &&
        one(s.unknown, ["block", "missing"]);
      break;
    case "bin":
      ok =
        str(s.attributeId) &&
        one(s.method, ["width", "frequency"]) &&
        Number.isInteger(s.count) &&
        list(s.labels) &&
        s.labels.every(str) &&
        one(s.outside, ["block", "missing", "edge"]) &&
        field(s.output);
      break;
    case "join":
      ok =
        str(s.name) &&
        one(s.mode, ["inner", "left", "full"]) &&
        list(s.keys) &&
        s.keys.every((k: any) => k && str(k.left) && str(k.right)) &&
        s.columnNames &&
        typeof s.columnNames === "object" &&
        !list(s.columnNames) &&
        Object.values(s.columnNames).every(str);
      break;
    case "stack":
      ok =
        str(s.name) &&
        list(s.mappings) &&
        s.mappings.every(
          (m: any) =>
            m &&
            str(m.key) &&
            str(m.name) &&
            list(m.sources) &&
            m.sources.every(ref),
        ) &&
        list(s.excluded) &&
        s.excluded.every(ref) &&
        one(s.typeConflict, ["block", "mixed"]);
      break;
    case "aggregate":
      ok =
        str(s.name) &&
        list(s.groupIds) &&
        s.groupIds.every(str) &&
        typeof s.includeMissing === "boolean" &&
        list(s.aggregates) &&
        s.aggregates.every(
          (a: any) =>
            field(a) &&
            one(a.method, [
              "rows",
              "valid",
              "sum",
              "mean",
              "min",
              "max",
              "median",
            ]) &&
            (a.method === "rows" ? a.attributeId === null : str(a.attributeId)),
        );
      break;
  }
  require(ok, "지원하지 않는 작업 설정 또는 자료형입니다.");
}
/** Reconstruct the deterministic plan and output from preserved inputs. Random output IDs are mapped,
 * never regenerated in the stored record. This checks learned bases, values, and every provenance edge. */
export function validateWranglingRecord(
  project: Project,
  version: DeepReadonly<DataVersion>,
) {
  const op = version.operation,
    r = op.wrangling;
  if (op.kind !== "wrangle") {
    require(!r, "다른 종류의 작업에 가공 기록이 있습니다.");
    return;
  }
  require(r && r.formatVersion === 1, "가공 기준이 없습니다.");
  if (!r) return;
  const f = r.fitted;
  require(f &&
    Array.isArray(r.inputs) &&
    Array.isArray(f.inputs) &&
    Array.isArray(f.columns) &&
    Array.isArray(f.fitScopes) &&
    r.rowSources &&
    typeof r.rowSources === "object", "계산 기준 구조가 잘못되었습니다.");
  checkWranglingSettings(f.settings);
  same(op.settings, f.settings, "설정 사본이 다릅니다.");
  same(
    r.output,
    { datasetId: version.datasetId, versionId: version.id },
    "출력 참조가 다릅니다.",
  );
  same(op.outputVersionIds, [version.id], "출력 버전이 다릅니다.");
  same(
    op.inputVersionIds,
    r.inputs.map((i) => i.versionId),
    "입력 버전이 다릅니다.",
  );
  same(r.inputs, f.inputs, "기준의 입력 참조가 다릅니다.");
  const inputs: InputTable[] = r.inputs.map((i) => ({
    source: { ...i },
    name: project.datasets.find((d) => d.id === i.datasetId)?.name ?? "",
    table: resolveVersion(project, i),
  }));
  const derived = isDerived(f.settings.kind);
  same(
    version.parentVersionIds,
    derived ? [] : [r.inputs[0].versionId],
    "부모 버전이 다릅니다.",
  );
  require(derived
    ? r.inputs.every((i) => i.datasetId !== version.datasetId)
    : r.inputs[0].datasetId ===
        version.datasetId, "출력 자료 참조가 잘못되었습니다.");
  const scope = f.fitScopes[0];
  require(scope &&
    ["all", "training"].includes(scope.kind) &&
    Array.isArray(scope.rowIds), "기준 계산 범위가 없습니다.");
  const expected = fitWrangling(
    inputs,
    structuredClone(f.settings) as WranglingSettings,
    { kind: scope.kind, rowIds: [...scope.rowIds] },
  );
  require(expected.columns.length ===
    f.columns.length, "출력 열 수가 다릅니다.");
  const idMap = new Map(
    expected.columns.map((c, i) => [c.id, f.columns[i].id]),
  );
  const normalized = JSON.parse(
    JSON.stringify(expected, (_, v) => {
      if (typeof v === "string" && idMap.has(v)) return idMap.get(v);
      if (v && typeof v === "object" && !Array.isArray(v))
        return Object.fromEntries(
          Object.entries(v).map(([key, value]) => [
            idMap.get(key) ?? key,
            value,
          ]),
        );
      return v;
    }),
  );
  same(
    f,
    normalized,
    "작업 설정·계산 기준·속성 출처가 입력과 일치하지 않습니다.",
  );
  const expectedResult = applyWrangling(inputs, f);
  require(!expectedResult.issues.some(
    (i) => i.blocking,
  ), "오류가 있는 가공 결과입니다.");
  same(version.columns, expectedResult.table.columns, "결과 열이 다릅니다.");
  require(version.rows.length ===
    expectedResult.table.rows.length, "결과 행 수가 다릅니다.");
  same(
    Object.keys(r.rowSources).sort(),
    version.rows.map((row) => row.id).sort(),
    "행 출처 목록이 다릅니다.",
  );
  const inputIds = new Set(
      inputs.flatMap((i) => i.table.rows.map((row) => row.id)),
    ),
    inputCols = new Set(
      inputs.flatMap((i) => i.table.columns.map((c) => c.id)),
    );
  require(f.columns.every(
    (c) => !inputCols.has(c.id),
  ), "새 열 ID가 입력 열 ID와 같습니다.");
  version.rows.forEach((row, i) => {
    const expectedRow = expectedResult.table.rows[i];
    same(row.values, expectedRow.values, "결과 값이 계산 기준과 다릅니다.");
    same(
      r.rowSources[row.id],
      expectedResult.rowSources[expectedRow.id],
      "행 출처가 입력과 다릅니다.",
    );
    require(derived
      ? !inputIds.has(row.id)
      : row.id === expectedRow.id, "결과 행 ID가 올바르지 않습니다.");
  });
  if (derived) {
    const d = project.datasets.find((d) => d.id === version.datasetId)!;
    require(d.source.kind === "derived" &&
      d.versions[0].id === version.id, "파생 자료의 최초 결과가 아닙니다.");
    same(
      d.original.table,
      { columns: version.columns, rows: version.rows },
      "파생 자료 최초 보존본이 다릅니다.",
    );
  }
}
