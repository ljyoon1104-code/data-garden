import Papa from 'papaparse';
import type { AnalysisRecord, Cell, DeepReadonly, SourceInfo, TableData, TableView, VersionRef } from './types';
import type { AssociationView } from './association-types';
import { scopedRows } from './graphs';
import { isMissing } from './table';
import { reconstructClusters } from './clustering';
import { queryAssociationRules } from './association';

export interface OutputTable { name: string; columns: string[]; rows: Cell[][] }
export interface OutputBook { title: string; generatedAt: string; metadata: Record<string,string>; tables: OutputTable[] }
export type ExportInput =
  | {kind:'data'; title:string; source:VersionRef; sourceInfo:SourceInfo; table:DeepReadonly<TableData>; view:TableView; scope:'all'|'filtered'|'selected'; selectedColumns:boolean; sorted:boolean}
  | {kind:'analysis'; title:string; record:AnalysisRecord; table:DeepReadonly<TableData>; sourceInfo:SourceInfo; freshness:string; ruleQuery:AssociationView|null; includeTransactions:boolean};
export interface OutputFile {name:string; type:string; data:string|Uint8Array}
export const exportLimits = {cells:1_000_000, rows:200_000, bytes:32*1024*1024};
const error = (s:string):never=>{throw new Error('출력: '+s+' 범위·열·출력 표를 줄여 다시 시도하세요.');};
const scalar = (v:unknown):Cell=> typeof v==='number'&&!Number.isFinite(v)?error('NaN·Infinity는 출력할 수 없습니다.'):v===undefined?null : v===null||typeof v==='boolean'||typeof v==='string'||(typeof v==='number'&&Number.isFinite(v))?v:JSON.stringify(v);
function add(book:OutputBook,name:string,columns:string[],rows:unknown[][]) {
  const table={name,columns,rows:rows.map(r=>r.map(scalar))};
  book.tables.push(table);
  if(book.tables.reduce((n,t)=>n+(t.rows.length+1)*t.columns.length,0)>exportLimits.cells || book.tables.reduce((n,t)=>n+t.rows.length,0)>exportLimits.rows) error('100만 셀 또는 20만 출력 행 한도입니다.');
}
export function prepareOutput(input:ExportInput, progress:(s:string)=>void=()=>{}):OutputBook {
  progress('출력 범위와 당시 조건 확인 중…');
  const book:OutputBook={title:input.title,generatedAt:new Date().toISOString(),metadata:{앱:'데이터뜰 1.0',출처:JSON.stringify(input.sourceInfo),결측:'null과 빈 문자열은 CSV에서 구별되지 않습니다. 정확한 복원은 JSON 백업을 사용하세요.'},tables:[]};
  if(input.kind==='data') {
    const {table,view}=input;
    const rows=[...scopedRows(table,{kind:input.scope,filter:view.filter,duplicatesOnly:view.duplicatesOnly,rowIds:view.selectedRowIds})];
    const cols=table.columns.filter(c=>!input.selectedColumns||view.selectedColumnIds.includes(c.id));
    if(!cols.length) error('출력할 열을 선택하세요. 빈 열 선택을 전체로 바꾸지 않습니다.');
    if(input.sorted && view.sort) {
      const {attributeId,direction}=view.sort;
      rows.sort((a,b)=>{
        const x=a.values[attributeId],y=b.values[attributeId];
        if(isMissing(x))return isMissing(y)?0:1;
        if(isMissing(y))return -1;
        const rank=(v:Cell)=>typeof v==='boolean'?0:typeof v==='number'?1:2;
        const c=rank(x)-rank(y)||(typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'ko'));
        return direction==='asc'?c:-c;
      });
    }
    Object.assign(book.metadata,{자료버전:JSON.stringify(input.source),행범위:input.scope,정렬:JSON.stringify(input.sorted?view.sort:null),필터:JSON.stringify(input.scope==='filtered'?{filter:view.filter,duplicatesOnly:view.duplicatesOnly}:null),선택행:JSON.stringify(input.scope==='selected'?view.selectedRowIds:[]),출력행:String(rows.length),출력열:String(cols.length),속성:JSON.stringify(cols)});
    add(book,'자료',cols.map(c=>c.name),rows.map(r=>cols.map(c=>r.values[c.id])));
  } else {
    const a=input.record;
    Object.assign(book.metadata,{분석ID:a.id,종류:a.kind,상태:a.status,자료버전:JSON.stringify(a.configSnapshot.source),현재와의차이:input.freshness,시작:a.createdAt,완료:a.completedAt??'미완료',당시조건:JSON.stringify(a.configSnapshot),오류:JSON.stringify(a.error??null)});
    if(a.regression) {
      const r=a.regression;
      Object.assign(book.metadata,{계산규칙:r.calculationVersion,분할:JSON.stringify(r.split),전처리:JSON.stringify(r.pipeline),범위:JSON.stringify(r.scopeRowIds),평가:'전체 평가 행; 그림 표시 표본과 별개'});
      add(book,'모델평가',['모델','상태','평가수','MAE','MSE','RMSE','R²','계산불가·실패 이유'],r.models.map(m=>m.status==='completed'?[m.kind,m.status,m.metrics.n,m.metrics.mae,m.metrics.mse,m.metrics.rmse,m.metrics.r2,m.metrics.r2Reason]:[m.kind,m.status,null,null,null,null,null,m.reason]));
      add(book,'평가행',['모델','행 ID','실제값','예측값','잔차','절대오차','제곱오차'],r.models.flatMap(m=>m.status==='completed'?m.rows.map(x=>[m.kind,x.rowId,x.actual,x.predicted,x.residual,x.absoluteError,x.squaredError]):[]));
      add(book,'제외행',['행 ID','단계','이유'],r.excluded.map(x=>[x.rowId,x.phase,x.reason]));
    } else if(a.clustering) {
      const r=a.clustering, vectors=reconstructClusters(input.table,r);
      Object.assign(book.metadata,{계산규칙:r.calculationVersion,범위:JSON.stringify(r.scopeRowIds),전처리:JSON.stringify(r.basis),실루엣:'mode=exact 전체 평가, sample 고정 표본 평가(군집 전체를 거리 기준으로 사용), none 계산 안 함'});
      add(book,'군집수비교',['k','SSE','실루엣','평가방식','평가수','전체수','계산불가·실패 이유'],r.candidates.map(c=>[c.k,c.sse,c.silhouette?.mean,c.silhouette?.mode,c.silhouette?.evaluationRowIds.length,r.rowIds.length,c.error??c.silhouette?.reason]));
      add(book,'군집행',['k','행 ID','군집','거리','SSE 기여'],r.candidates.flatMap(c=>c.error?[]:r.rowIds.map((id,i)=>[c.k,id,c.labels[i]+1,Math.sqrt(c.squaredDistances[i]),c.squaredDistances[i]])));
      const stats:unknown[][]=[];
      for(const c of r.candidates)if(!c.error)for(let k=0;k<c.k;k++)for(let j=0;j<r.features.length;j++){
        const values=vectors.filter((_,i)=>c.labels[i]===k).map(x=>x[j]).sort((a,b)=>a-b),n=values.length;
        const mean=n?values.reduce((s,x)=>s+x,0)/n:null;
        stats.push([c.k,k+1,r.features[j].name,'대체·스케일 후 분석 공간',n,values[0]??null,values[n-1]??null,mean,n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,c.centers[k]?.[j]??null,c.silhouette?.clusters[k]?.mean??null]);
      }
      add(book,'군집특징',['k','군집','속성','공간','행수','최소','최대','평균','중앙값','최종 중심(미수렴시 평균과 다를 수 있음)','군집 실루엣'],stats);
      add(book,'제외행',['행 ID','속성','이유'],r.excluded.map(x=>[x.rowId,x.attributes.join(', '),x.reason]));
    } else if(a.association) {
      const r=a.association, names=new Map(r.prepared.items.map(i=>[i.id,`${i.label} [${i.valueType}; ${i.id}]`]));
      const label=(ids:readonly string[])=>ids.map(id=>names.get(id)).join(' ∧ ');
      const rules=input.ruleQuery?queryAssociationRules(r,input.ruleQuery):r.rules;
      Object.assign(book.metadata,{계산규칙:r.calculationVersion,N:String(r.prepared.transactions.length),규칙범위:input.ruleQuery?'현재 검색에 일치하는 모든 페이지':'전체 저장 규칙',검색:JSON.stringify(input.ruleQuery),탐색길이:String(r.maxLength),종료:r.termination,빈거래:String(r.prepared.emptyCount),제외:JSON.stringify(r.prepared.excluded),전체규칙:String(r.rules.length)});
      add(book,'연관규칙',['선행','후행','지지도(비율)','신뢰도(비율)','향상도','N','count(A)','count(B)','count(A∪B)','규칙 ID'],rules.map(x=>[label(x.antecedent),label(x.consequent),x.support,x.confidence,x.lift,x.n,x.countA,x.countB,x.countUnion,x.id]));
      add(book,'후보빈발집합',['길이','항목','거래수','지지도(비율)','가지치기','빈발'],r.levels.flatMap(l=>l.candidates.map(x=>[l.length,label(x.items),x.count,x.count===null?null:x.count/r.prepared.transactions.length,x.pruned,x.frequent])));
      if(input.includeTransactions)add(book,'변환거래',['거래 ID','거래 키(타입 보존 JSON)','전체 항목','원자료 행 ID'],r.prepared.transactions.map(t=>[t.id,JSON.stringify(t.key),label(t.items),JSON.stringify(t.rowIds)]));
    } else add(book,'상태',['종류','상태','이유'],[[a.kind,a.status,a.error?.message??'상세 저장 결과 없음']]);
  }
  progress('출력 표와 크기 확인 중…');
  if(new TextEncoder().encode(JSON.stringify(book)).length>exportLimits.bytes)error('출력 내용 32 MiB 한도입니다.');
  return book;
}
export const formulaString=(v:Cell)=>typeof v==='string'&&/^[\s\uFEFF]*[=+\-@\t\r]/.test(v);
export function csvText(table:OutputTable,safe:boolean) {
  let changed=0;
  const transform=(v:Cell):Cell=>{if(safe&&formulaString(v)){changed++;return "'"+v;}return v;};
  const data=[table.columns,...table.rows].map(r=>r.map(transform));
  return {text:'\uFEFF'+Papa.unparse(data,{newline:'\r\n'}),changed};
}
export async function serializeOutput(book:OutputBook,format:'csv'|'xlsx',tableIndex:number,safe:boolean):Promise<OutputFile[]> {
  const base=book.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)||'데이터뜰';
  if(format==='csv'){
    const table=book.tables[tableIndex];if(!table)error('출력 표를 선택하세요.');
    const csv=csvText(table,safe);
    return [{name:base+'-'+table.name+'.csv',type:'text/csv;charset=utf-8',data:csv.text},{name:base+'-'+table.name+'-정보.json',type:'application/json',data:JSON.stringify({title:book.title,generatedAt:book.generatedAt,metadata:book.metadata,table:table.name,rows:table.rows.length,columns:table.columns,safeStrings:csv.changed,csvLimit:'CSV는 타입과 null/빈 문자열을 완전히 복원하지 못합니다.'},null,2)}];
  }
  const XLSX=await import('xlsx');
  const wb=XLSX.utils.book_new();
  for(const [i,t] of book.tables.entries()){
    const cells=[t.columns,...t.rows].map(row=>row.map(v=>v===null?{t:'z' as const}:{t:typeof v==='number'?'n' as const:typeof v==='boolean'?'b' as const:'s' as const,v}));
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(cells),`${i+1}-${t.name}`.slice(0,31));
  }
  const meta=[['항목','내용'],['생성 시각',book.generatedAt],...Object.entries(book.metadata).flatMap(([k,v])=>{
    const chunks=[];for(let i=0;i<v.length;i+=30000)chunks.push([i?k+' (계속)':k,v.slice(i,i+30000)]);return chunks.length?chunks:[[k,'']];
  })];
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(meta),'파일 정보');
  const data=new Uint8Array(XLSX.write(wb,{type:'array',bookType:'xlsx',compression:true}));
  if(data.byteLength>exportLimits.bytes)error('파일 32 MiB 한도입니다.');
  return [{name:base+'.xlsx',type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',data}];
}
