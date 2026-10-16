import type { AnalysisRecord, Interpretation, Project, GraphConfig, ViewState } from './types';
import { getResultFreshness } from './model';

export type ResultTarget = { kind: 'graph' | 'analysis'; id: string };
export interface ReportSelection { question: string; items: ResultTarget[]; includeInterpretations: boolean; tableLimit: number }
export const defaultReport = (): ReportSelection => ({ question: '', items: [], includeInterpretations: true, tableLimit: 100 });
export const resultLabels = { graph: '그래프', regression: '회귀', clustering: '군집', association: '연관' };
export const statusLabels = { pending: '대기', running: '진행', completed: '완료', failed: '실패', cancelled: '취소' };
export function analysisFreshness(project: Project, record: AnalysisRecord) {
  const datasetId = record.configSnapshot.source.datasetId;
  const versionId = project.activeVersions[datasetId];
  return getResultFreshness(record, versionId ? { datasetId, versionId } : null,
    project.analysisConfigs[JSON.stringify([datasetId, record.kind])] ?? null);
}
export function graphFreshness(project: Project, graph: GraphConfig) {
  return project.activeVersions[graph.source.datasetId] === graph.source.versionId
    ? '현재 활성 버전과 일치 · 저장 당시 그래프 조건'
    : '자료의 활성 버전이 달라졌습니다. 당시 버전·조건의 그래프입니다.';
}
export function targetExists(p: Project, t: Interpretation['target']) {
  return t.kind === 'project' ? t.id === p.id : t.kind === 'analysis'
    ? p.analyses.some(a => a.id === t.id) : p.graphs.some(g => g.id === t.id);
}
export function validateResultState(p: Project, v: ViewState) {
  if (p.interpretations.length > 200) throw new Error('해석은 프로젝트당 200개 이하입니다.');
  for (const i of p.interpretations) {
    if (!targetExists(p, i.target) || i.text.length > 20000 || (i.origin !== undefined && !['user','example'].includes(i.origin)))
      throw new Error('해석 대상·출처 또는 20,000자 한도를 확인하세요.');
    if (i.target.kind === 'analysis' && !p.analyses.find(a=>a.id===i.target.id)?.interpretationIds.includes(i.id))
      throw new Error('분석과 해석의 양방향 참조가 일치하지 않습니다.');
  }
  const r = v.report;
  if (r) {
    if (typeof r.question !== 'string' || r.question.length > 5000 || typeof r.includeInterpretations !== 'boolean' || ![25,100,500].includes(r.tableLimit) || !Array.isArray(r.items) || r.items.length > 20)
      throw new Error('보고서 질문·표 범위·20개 항목 한도를 확인하세요.');
    const keys = new Set<string>();
    for (const t of r.items) {
      if (!t || !['graph','analysis'].includes(t.kind) || !targetExists(p,t) || keys.has(JSON.stringify(t))) throw new Error('보고서에 없거나 중복된 결과 참조가 있습니다.');
      keys.add(JSON.stringify(t));
    }
  }
  if (v.resultDetail && (!['graph','analysis'].includes(v.resultDetail.kind) || !targetExists(p,v.resultDetail))) throw new Error('결과 상세 참조가 없습니다.');
}
export function cleanResultReferences(p: Project, v: ViewState): ViewState {
  return { ...v, ...(v.report ? {report: {...v.report, items:v.report.items.filter(t=>targetExists(p,t))}} : {}),
    ...(v.resultDetail && !targetExists(p,v.resultDetail) ? {resultDetail:null} : {}) };
}
