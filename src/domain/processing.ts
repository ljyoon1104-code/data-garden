import type { Project, VersionRef, DeepReadonly, DataVersion } from "./types";

export function resolveVersion(
  project: Project,
  ref: DeepReadonly<VersionRef>,
) {
  const version = project.datasets
    .find((d) => d.id === ref.datasetId)
    ?.versions.find((v) => v.id === ref.versionId);
  if (!version)
    throw new Error("가공 계보: 존재하지 않는 입력 자료·버전입니다.");
  return version;
}
export function processingInputs(
  v: DeepReadonly<DataVersion>,
): DeepReadonly<VersionRef>[] {
  return (
    v.operation.wrangling?.inputs.map((r) => r) ??
    v.parentVersionIds.map((versionId) => ({
      datasetId: v.datasetId,
      versionId,
    }))
  );
}
/** Topological order includes legacy edits/preprocessing and all multi-input branches. */
export function traceProcessing(project: Project, ref: VersionRef) {
  const visiting = new Set<string>(),
    seen = new Set<string>(),
    steps: DeepReadonly<DataVersion>[] = [],
    roots: VersionRef[] = [];
  function visit(r: DeepReadonly<VersionRef>) {
    if (visiting.has(r.versionId))
      throw new Error("가공 계보에 순환 참조가 있습니다.");
    if (seen.has(r.versionId)) return;
    visiting.add(r.versionId);
    const v = resolveVersion(project, r),
      inputs = processingInputs(v);
    inputs.forEach(visit);
    if (!inputs.length) roots.push({ ...r });
    steps.push(v);
    visiting.delete(r.versionId);
    seen.add(r.versionId);
  }
  visit(ref);
  return { roots, steps };
}
/** Column dependency closure, including grouping and join keys (for future leakage checks). */
export function attributeAncestors(
  project: Project,
  ref: VersionRef,
  attributeId: string,
) {
  traceProcessing(project, ref);
  const result = new Map<string, VersionRef & { attributeId: string }>(),
    seen = new Set<string>();
  function visit(r: DeepReadonly<VersionRef>, id: string) {
    const key = r.versionId + ":" + id;
    if (seen.has(key)) return;
    seen.add(key);
    const v = resolveVersion(project, r);
    if (!v.columns.some((c) => c.id === id))
      throw new Error("가공 계보: 속성이 없습니다.");
    const record = v.operation.wrangling,
      sources = record?.fitted.columnSources[id];
    if (sources) {
      sources.forEach((a) => visit(record!.inputs[a.input], a.attributeId));
      return;
    }
    const inputs = processingInputs(v).filter((p) =>
      resolveVersion(project, p).columns.some((c) => c.id === id),
    );
    if (inputs.length) inputs.forEach((p) => visit(p, id));
    else result.set(key, { ...r, attributeId: id });
  }
  visit(ref, attributeId);
  return [...result.values()];
}
