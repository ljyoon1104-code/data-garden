import type { AnalysisRecord,DeepReadonly,GraphConfig,Interpretation,SourceInfo,TableData } from './types';
import type { ReportSelection } from './results';
import type { WorkspaceState } from '../state/workspace';
import type { GraphResult } from './graph-types';
import { analysisFreshness,graphFreshness,validateResultState } from './results';
import { calculateGraph } from './graphs';
import { prepareOutput } from './export';
import { clusterDetail } from './clustering';
import type { ClusteringResult,ClusterDetail } from './clustering-types';
import type { EvaluationRow } from './regression-types';
import type { OutputBook, OutputTable } from './export';
export interface ReportInput {
  title:string;question:string;generatedAt:string;tableLimit:number;interpretations:Interpretation[];
  sources:{key:string;table:DeepReadonly<TableData>;name:string;source:SourceInfo}[];
  entries:({kind:'graph';graph:GraphConfig}|{kind:'analysis';record:AnalysisRecord})[];
  statuses:Record<string,string>; processing:{id:string;kind:string;inputs:string[];outputs:string[];time:string}[];
}
export type ReportPlot={kind:'regression';name:string;rows:EvaluationRow[];seed:number}|{kind:'cluster-metrics';result:ClusteringResult}|{kind:'cluster-scatter';name:string;detail:ClusterDetail};
export interface ReportPart {id:string;title:string;metadata:Record<string,string>;tables:OutputTable[];tableTotals:number[];interpretations:Interpretation[];images:string[];plots:ReportPlot[];graph?:{config:GraphConfig;result:GraphResult;table:TableData}}
export interface PreparedReport {title:string;question:string;generatedAt:string;interpretations:Interpretation[];parts:ReportPart[];processing:ReportInput['processing'];comparison:string[]}
export const reportLimits={items:20,images:20,rows:12000,bytes:24*1024*1024};
export function captureReport(state:WorkspaceState,selection:ReportSelection):ReportInput {
  validateResultState(state.project,{...state.view,report:selection});
  if(!selection.items.length)throw new Error('보고서에 포함할 결과를 선택하세요.');
  const p=state.project,sources:ReportInput['sources']=[],entries:ReportInput['entries']=[],statuses:Record<string,string>={};
  const sourceIds=new Set<string>();
  for(const item of selection.items){
    const graph=item.kind==='graph'?p.graphs.find(g=>g.id===item.id)!:null;
    const record=item.kind==='analysis'?p.analyses.find(a=>a.id===item.id)!:null;
    const ref=graph?.source??record!.configSnapshot.source,key=JSON.stringify(ref);
    const d=p.datasets.find(d=>d.id===ref.datasetId)!,table=d.versions.find(v=>v.id===ref.versionId)!;
    if(!sourceIds.has(key)){sourceIds.add(key);sources.push({key,table,name:d.name,source:d.source});}
    entries.push(graph?{kind:'graph',graph}:{kind:'analysis',record:record!});
    statuses[item.id]=graph?graphFreshness(p,graph):analysisFreshness(p,record!).reasons.join(' ')||'현재 활성 버전·조건과 일치';
  }
  const ids=new Set(selection.items.map(x=>x.id));
  // Only selected records and referenced tables are captured; versions are immutable.
  return {title:p.name,question:selection.question,generatedAt:new Date().toISOString(),tableLimit:selection.tableLimit,sources,entries,statuses,
    interpretations:selection.includeInterpretations?p.interpretations.filter(i=>i.target.kind==='project'||ids.has(i.target.id)).map(i=>structuredClone(i)):[],
    processing:p.operations.filter(o=>sources.some(s=>JSON.parse(s.key).datasetId===o.datasetId)).map(o=>({id:o.id,kind:o.kind,inputs:[...o.inputVersionIds],outputs:[...o.outputVersionIds],time:o.executedAt}))};
}
export function prepareReport(input:ReportInput,progress:(s:string)=>void=()=>{}):PreparedReport {
  if(input.entries.length>20||![25,100,500].includes(input.tableLimit))throw new Error('보고서는 20개 결과, 표당 25/100/500행을 지원합니다.');
  const report:PreparedReport={title:input.title,question:input.question,generatedAt:input.generatedAt,interpretations:input.interpretations.filter(i=>i.target.kind==='project'),parts:[],processing:input.processing,comparison:[]};
  for(const [index,e]of input.entries.entries()){
    progress(`보고서 ${index+1}/${input.entries.length} · 고정 조건과 표 준비 중…`);
    const ref=e.kind==='graph'?e.graph.source:e.record.configSnapshot.source;
    const src=input.sources.find(s=>s.key===JSON.stringify(ref));if(!src)throw new Error('보고서 원자료 참조가 없습니다.');
    const id=e.kind==='graph'?e.graph.id:e.record.id;
    let book:OutputBook,graph:ReportPart['graph'];
    if(e.kind==='graph'){
      const result=calculateGraph(src.table,e.graph);
      graph={config:e.graph,result,table:{columns:structuredClone(src.table.columns) as TableData['columns'],rows:[]}};
      book={title:e.graph.visual?.name??'그래프',generatedAt:input.generatedAt,metadata:{자료:src.name,출처:JSON.stringify(src.source),버전:ref.versionId,현재와의차이:input.statuses[id],조건:JSON.stringify(e.graph),범위:`전체 ${result.total} · 범위 ${result.scoped} · 사용 ${result.used} · 표시 ${result.displayed}`,표본:result.sampled?`고정 표시 표본 ${result.sampleCount}`:'표시 표본 없음',주의:result.warnings.join(' ')},tables:[{name:'그래프 표시 집계표',columns:['항목','집단','X','Y','행 수','유효 수','비율','분모','상세'],rows:result.marks.map(m=>[m.label,m.group,m.x,m.y,m.count,m.valid,m.ratio??null,m.denominator??null,m.detail])}]};
    }else book=prepareOutput({kind:'analysis',title:src.name+' · '+e.record.kind,record:e.record,table:src.table,sourceInfo:src.source,freshness:input.statuses[id],ruleQuery:null,includeTransactions:false},progress);
    const plots:ReportPlot[]=[];
    if(e.kind==='analysis'&&e.record.regression){const r=e.record.regression;for(const m of r.models)if(m.status==='completed')plots.push({kind:'regression',name:m.kind,rows:m.rows,seed:r.sampling.seed});}
    if(e.kind==='analysis'&&e.record.clustering){const r=e.record.clustering;plots.push({kind:'cluster-metrics',result:r});
      r.candidates.forEach((c,index)=>{if(c.error)return;plots.push({kind:'cluster-scatter',name:`k=${c.k}`,detail:clusterDetail(src.table,r,{candidate:index,restart:null,iteration:null,phase:'final',x:r.features[0].id,y:r.features[1]?.id??'',cluster:null,page:0,rowId:null,region:null})});});
    }
    report.parts.push({id,title:book.title,metadata:book.metadata,tables:book.tables.map(t=>({...t,rows:t.rows.slice(0,input.tableLimit)})),tableTotals:book.tables.map(t=>t.rows.length),interpretations:input.interpretations.filter(i=>i.target.id===id),images:[],plots,...(graph?{graph}:{})});
  }
  for(const kind of ['regression','clustering','association']){
    const records=input.entries.filter(e=>e.kind==='analysis'&&e.record.kind===kind);
    if(records.length>1)report.comparison.push(`${kind} 비교: ${records.map(e=>e.kind==='analysis'?`${e.record.id} · 자료/버전 ${JSON.stringify(e.record.configSnapshot.source)} · 조건 ${JSON.stringify(e.record.configSnapshot[kind as 'regression'|'clustering'|'association'])}`:'').join('\n')}. 각 실행의 평가값·개수는 아래 표에 보존합니다. 모집단·분할·전처리가 다르면 기준만 바꾼 비교가 아닙니다.`);
  }
  const analyses=input.entries.flatMap(e=>e.kind==='analysis'?[e.record]:[]);
  for(let i=1;i<analyses.length;i++){
    const a=analyses[i-1],b=analyses[i];if(a.kind!==b.kind)continue;
    if(a.regression&&b.regression){const ar=a.regression,br=b.regression;
      report.comparison.push('회귀 평가 비교 '+a.id+' → '+b.id+' · 같은 평가 행: '+(JSON.stringify(ar.split.evaluation)===JSON.stringify(br.split.evaluation))+' · 같은 목표: '+(ar.target.id===br.target.id)+' · '+JSON.stringify(br.models.map(m=>{const old=ar.models.find(o=>o.kind===m.kind);return m.status==='completed'&&old?.status==='completed'?{모델:m.kind,이전RMSE:old.metrics.rmse,이후RMSE:m.metrics.rmse,차이:m.metrics.rmse-old.metrics.rmse,이전R2:old.metrics.r2,이후R2:m.metrics.r2}:{모델:m.kind,상태:m.status};})));
    }
    if(a.clustering&&b.clustering)report.comparison.push('군집 결과 비교 '+a.id+' → '+b.id+' · '+JSON.stringify([a.clustering,b.clustering].map(r=>r.candidates.map(c=>({k:c.k,SSE:c.sse,실루엣:c.silhouette?.mean,방식:c.silhouette?.mode}))))+' · 거리 공간·입력 행이 같을 때만 SSE 크기를 비교하세요.');
    if(a.association&&b.association){const old=new Set(a.association.rules.map(r=>r.id)),next=new Set(b.association.rules.map(r=>r.id));report.comparison.push('연관 규칙 비교 '+a.id+' → '+b.id+' · 유지 '+[...old].filter(id=>next.has(id)).length+' · 추가 '+[...next].filter(id=>!old.has(id)).length+' · 사라짐 '+[...old].filter(id=>!next.has(id)).length+' · 거래 모집단·정책 차이는 당시 조건을 확인하세요.');}
  }
  if(report.parts.reduce((n,p)=>n+p.tables.reduce((s,t)=>s+t.rows.length,0),0)>reportLimits.rows)throw new Error('보고서 표시 표 12,000행 한도입니다. 결과 수나 표당 행 수를 줄이세요. 전체 표는 CSV/XLSX로 출력하세요.');
  return report;
}
export const escapeHtml=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function reportHtml(r:PreparedReport):string {
  const e=escapeHtml;
  const interpretations=(items:Interpretation[])=>items.map(i=>`<section class="interpretation"><h3>${i.origin==='example'?'예제 작성자의 예시 해석':'사용자 해석'}</h3><p>${e(i.text)}</p></section>`).join('');
  const table=(t:OutputTable,total:number)=>`<h3>${e(t.name)}</h3><p>전체 ${total}행 중 ${t.rows.length}행 수록${total>t.rows.length?' · 요약 범위이며 전체 결과는 CSV/XLSX로 출력하세요.':''}</p><table><thead><tr>${t.columns.map(c=>`<th>${e(c)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(row=>`<tr>${row.map(v=>`<td>${v===null?'계산 불가 / 결측':e(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  let imageCount=0;
  const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>${e(r.title)} · 데이터뜰 보고서</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#183c35;max-width:1100px;margin:auto;padding:28px}h1,h2,h3{line-height:1.35}section.part{border-top:2px solid #287a67;margin-top:32px;padding-top:20px}p,dd,pre{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:bold}dd{margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:12px;table-layout:auto}th,td{border:1px solid #becfc8;padding:6px;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#edf5f1}img{display:block;width:100%;height:auto;margin:16px 0}.interpretation{background:#eff5f1;padding:16px}.note{border:1px solid #bd9461;padding:12px}@media print{@page{size:A4 landscape;margin:14mm}body{font-size:11pt;max-width:none;padding:0}thead{display:table-header-group}tr,img,.interpretation{break-inside:avoid}h1,h2,h3{break-after:avoid}.part{break-before:page}table{font-size:8pt}button,nav{display:none}a{color:inherit;text-decoration:none}}</style><body><h1>${e(r.title)}</h1><p>데이터뜰 1.0 · 고정 생성 시점 ${e(r.generatedAt)}</p><h2>탐구 질문</h2><p>${e(r.question||'작성하지 않음')}</p><p class="note">이 보고서는 선택한 당시 자료·조건·해석의 사본입니다. 과거 결과도 유효한 탐구 기록이며, 표본·계산 불가·조건 차이를 아래에 표시합니다. 브라우저 인쇄에서 PDF로 저장할 수 있으며 자동 PDF 생성 파일은 아닙니다.</p>${interpretations(r.interpretations)}<h2>자료 처리 내역</h2><p>${e(JSON.stringify(r.processing,null,2))}</p>${r.comparison.length?'<h2>선택한 실행의 비교 조건</h2>'+r.comparison.map(x=>`<p>${e(x)}</p>`).join(''):''}${r.parts.map(p=>`<section class="part"><h2>${e(p.title)}</h2><dl>${Object.entries(p.metadata).map(([k,v])=>`<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}</dl>${p.images.map(src=>{if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(src)||++imageCount>reportLimits.images)throw new Error('PNG 이미지 형식 또는 20개 이미지 한도를 확인하세요.');return `<img alt="${e(p.title)}" src="${src}">`;}).join('')}${p.tables.map((t,i)=>table(t,p.tableTotals[i])).join('')}${interpretations(p.interpretations)}</section>`).join('')}</body></html>`;
  if(new TextEncoder().encode(html).length>reportLimits.bytes)throw new Error('HTML 보고서 24 MiB 한도입니다. 이미지·표·결과 수를 줄이세요.');
  return html;
}
