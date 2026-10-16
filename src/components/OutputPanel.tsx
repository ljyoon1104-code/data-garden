import { useEffect, useState } from 'react';
import type { WorkspaceState } from '../state/workspace';
import type { AnalysisRecord } from '../domain/types';
import type { ExportInput, OutputBook, OutputFile } from '../domain/export';
import { analysisFreshness } from '../domain/results';
import { defaultTableView } from '../domain/table';
import { useTask } from '../workers/useTask';
import { TaskStatus, ErrorNotice } from './DataControls';

export function downloadFile(file:OutputFile) {
  const blob=new Blob([typeof file.data==='string'?file.data:new Uint8Array(file.data).buffer],{type:file.type});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file.name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export function OutputPanel({state,record,onPending=()=>{}}:{state:WorkspaceState;record?:AnalysisRecord;onPending?:(v:boolean)=>void}) {
  const [open,setOpen]=useState(false),[scope,setScope]=useState<'all'|'filtered'|'selected'>('all'),[selectedColumns,setColumns]=useState(false),[sorted,setSorted]=useState(false),[searched,setSearched]=useState(false),[transactions,setTransactions]=useState(false),[safe,setSafe]=useState(true),[format,setFormat]=useState<'csv'|'xlsx'>('csv'),[tableIndex,setTableIndex]=useState(0);
  const [book,setBook]=useState<OutputBook|null>(null),[files,setFiles]=useState<OutputFile[]>([]);
  const task=useTask('file-output');
  const source=record?.configSnapshot.source??state.project.selection;
  const dataset=state.project.datasets.find(d=>d.id===source?.datasetId),table=dataset?.versions.find(v=>v.id===source?.versionId);
  const view=dataset?state.view.tables[dataset.id]??defaultTableView():defaultTableView();
  const key=JSON.stringify([state.project.id,source,record?.id,record?.status,scope,selectedColumns,sorted,searched,transactions,view,record?state.view.associationViews?.[record.id]:null]);
  useEffect(()=>{task.cancel();setBook(null);setFiles([]);setTableIndex(0);},[key,task.cancel]);
  useEffect(()=>{onPending(task.busy);return()=>onPending(false);},[task.busy,onPending]);
  const prepare=()=>{
    if(!source||!dataset||!table)return;
    setFiles([]);setBook(null);
    const input:ExportInput=record?{kind:'analysis',title:dataset.name+'-'+record.kind,record,table,sourceInfo:dataset.source,freshness:analysisFreshness(state.project,record).reasons.join(' ')||'현재 활성 버전·조건과 일치',ruleQuery:searched?state.view.associationViews?.[record.id]??null:null,includeTransactions:transactions}
      :{kind:'data',title:dataset.name,source,sourceInfo:dataset.source,table,view,scope,selectedColumns,sorted};
    task.run({kind:'output-preview',input},r=>{if(r.kind==='output-preview'){setBook(r.book);setTableIndex(0);}});
  };
  return <section className="output-panel">
    <button aria-expanded={open} onClick={()=>{if(open)task.cancel();setOpen(!open);}}>{record?'분석 표 내보내기':'자료 내보내기'}</button>
    {open&&<div className="output-body">
      <h3>{record?'저장된 분석 결과 출력':'선택 버전 자료 출력'}</h3>
      <p>원자료·버전·작업 기록은 바꾸지 않습니다. CSV는 UTF-8 BOM이며 타입·결측의 정확한 복원에는 JSON 백업을 사용하세요.</p>
      {!record?<div className="form-grid">
        <label>출력할 행<select value={scope} onChange={e=>setScope(e.target.value as typeof scope)}><option value="all">버전 전체</option><option value="filtered">현재 필터의 모든 행</option><option value="selected">선택한 행만 (빈 선택은 0행)</option></select></label>
        <label><input type="checkbox" checked={selectedColumns} onChange={e=>setColumns(e.target.checked)}/>선택한 열만</label>
        <label><input type="checkbox" checked={sorted} onChange={e=>setSorted(e.target.checked)}/>현재 표의 정렬 적용</label>
      </div>:record.association&&<div>
        <label><input type="checkbox" checked={searched} onChange={e=>setSearched(e.target.checked)}/>현재 규칙 검색에 일치하는 모든 페이지 (해제: 전체 규칙)</label>
        <label><input type="checkbox" checked={transactions} onChange={e=>setTransactions(e.target.checked)}/>변환 거래 전체 포함</label>
      </div>}
      <button disabled={!table||task.busy} onClick={prepare}>출력 범위 확인</button>
      <TaskStatus {...task}/><ErrorNotice error={task.error}/>
      {book&&<>
        <p>고정 시점: {book.generatedAt} · 출처: {dataset?.source.label} · 버전: {source?.versionId}</p>
        {record&&<p>{book.metadata.현재와의차이}</p>}
        <ul>{book.tables.map(t=><li key={t.name}>{t.name}: {t.rows.length.toLocaleString()}행 × {t.columns.length}열</li>)}</ul>
        <label>파일 형식<select value={format} onChange={e=>{setFormat(e.target.value as typeof format);setFiles([]);}}><option value="csv">CSV 한 표 + 조건 정보 JSON</option><option value="xlsx">XLSX 모든 표 + 파일 정보 시트</option></select></label>
        {format==='csv'&&<><label>CSV 출력 표<select value={tableIndex} onChange={e=>{setTableIndex(Number(e.target.value));setFiles([]);}}>{book.tables.map((t,i)=><option key={i} value={i}>{t.name}</option>)}</select></label><label><input type="checkbox" checked={safe} onChange={e=>{setSafe(e.target.checked);setFiles([]);}}/>문자열 수식 해석 방지 (위험한 문자열 앞에 ' 추가, 숫자 음수는 유지)</label></>}
        <button disabled={task.busy} onClick={()=>{setFiles([]);task.run({kind:'output-file',book,format,tableIndex,safe},r=>{if(r.kind==='output-file')setFiles(r.files);});}}>파일 만들기</button>
        {files.length>0&&<div role="status"><p>파일이 준비됐습니다. CSV는 조건 정보 파일도 함께 보관하세요. 안전 처리 개수는 정보 파일에 기록됩니다.</p>{files.map(f=><button key={f.name} onClick={()=>downloadFile(f)}>{f.name} 내려받기</button>)}</div>}
      </>}
    </div>}
  </section>;
}
