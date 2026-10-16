import { useEffect, useState } from 'react';
import type { WorkspaceState,WorkspaceAction } from '../state/workspace';
import type { Interpretation } from '../domain/types';
import { analysisFreshness,graphFreshness,resultLabels,statusLabels } from '../domain/results';
import type { ResultTarget } from '../domain/results';
import { OutputPanel } from './OutputPanel';
import { ReportPanel } from './ReportPanel';

export function InterpretationEditor({state,dispatch,target,writable,onDraft}:{state:WorkspaceState;dispatch:(a:WorkspaceAction)=>void;target:Interpretation['target'];writable:boolean;onDraft:(v:boolean)=>void}) {
  const items=state.project.interpretations.filter(i=>i.target.kind===target.kind&&i.target.id===target.id);
  const [editing,setEditing]=useState<string|null>(null),[text,setText]=useState('');
  const dirty=editing!==null;
  useEffect(()=>{onDraft(dirty);return()=>onDraft(false);},[dirty,onDraft]);
  const key=JSON.stringify(target);
  useEffect(()=>{setEditing(null);setText('');},[key]);
  const save=()=>{const now=new Date().toISOString();dispatch({type:'interpretation-save',interpretation:{id:editing==='new'?crypto.randomUUID():editing!,target,text,createdAt:now,updatedAt:now,origin:'user'}});setEditing(null);};
  return <section className="interpretations"><h3>{target.kind==='project'?'프로젝트 탐구 기록':'이 결과의 해석'}</h3>
    {items.length===0&&<p>아직 작성한 해석이 없습니다.</p>}
    {items.map(i=><article key={i.id}><p className="muted">{i.origin==='example'?'예제 작성자의 예시 해석':'사용자 해석'} · {new Date(i.updatedAt).toLocaleString('ko-KR')}</p><p className="interpretation-text">{i.text}</p><button disabled={!writable||dirty} onClick={()=>{setEditing(i.id);setText(i.text);}}>해석 수정</button><button disabled={!writable||dirty} onClick={()=>dispatch({type:'interpretation-delete',id:i.id})}>해석 삭제</button></article>)}
    {editing!==null?<div><details><summary>선택적 작성 안내</summary><p>질문: 무엇이 궁금했나요? 발견: 어떤 차이나 관계가 보이나요? 근거: 어떤 표·지표·거래가 뒷받침하나요? 한계: 표본·결측·설정에 따른 제한은 무엇인가요? 추가 분석: 다음에는 무엇을 바꿔볼까요?</p><p>함께 나타나거나 예측된다는 사실만으로 원인이라고 단정할 수 없습니다.</p></details><label>해석 내용<textarea rows={8} maxLength={20000} value={text} onChange={e=>setText(e.target.value)}/></label><p>{text.length}/20,000자 · 저장해야 프로젝트에 반영됩니다.</p><button disabled={!writable||!text.trim()} onClick={save}>해석 저장</button><button onClick={()=>setEditing(null)}>해석 편집 취소</button></div>:<button disabled={!writable||state.project.interpretations.length>=200} onClick={()=>{setEditing('new');setText('');}}>해석 작성</button>}
  </section>;
}
export function ResultsHub({state,dispatch,writable,onDraft,onOpen,children}:{state:WorkspaceState;dispatch:(a:WorkspaceAction)=>void;writable:boolean;onDraft:(v:boolean)=>void;onOpen:(t:ResultTarget)=>void;children?:React.ReactNode}) {
  const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[datasetId,setDataset]=useState('all'),[page,setPage]=useState(0);
  const [projectDraft,setProjectDraft]=useState(false),[detailDraft,setDetailDraft]=useState(false),[outputBusy,setOutputBusy]=useState(false),[reportBusy,setReportBusy]=useState(false);
  useEffect(()=>{onDraft(projectDraft||detailDraft||outputBusy||reportBusy);return()=>onDraft(false);},[projectDraft,detailDraft,outputBusy,reportBusy,onDraft]);
  const p=state.project;
  const rows=[...p.graphs.map(g=>({target:{kind:'graph' as const,id:g.id},kind:'graph',name:g.visual?.name??'구형 그래프',source:g.source,time:g.visual?.createdAt??'',status:'저장',conditions:JSON.stringify(g.visual?.scope??{}),fresh:graphFreshness(p,g)})),...p.analyses.map(a=>({target:{kind:'analysis' as const,id:a.id},kind:a.kind,name:`${resultLabels[a.kind]} · ${new Date(a.createdAt).toLocaleString('ko-KR')}`,source:a.configSnapshot.source,time:a.createdAt,status:statusLabels[a.status],conditions:JSON.stringify(a.configSnapshot.association??a.configSnapshot.clustering??a.configSnapshot.regression??a.configSnapshot.parameters),fresh:analysisFreshness(p,a).reasons.join(' ')||'현재 활성 버전·조건과 일치'}))];
  const filtered=rows.filter(r=>(kind==='all'||r.kind===kind)&&(datasetId==='all'||r.source.datasetId===datasetId)&&[r.name,p.datasets.find(d=>d.id===r.source.datasetId)?.name,r.status,r.conditions].join(' ').toLowerCase().includes(query.toLowerCase()));
  const detail=state.view.resultDetail,record=detail?.kind==='analysis'?p.analyses.find(a=>a.id===detail.id):undefined;
  return <section className="results-hub"><h2>탐구 결과 모아보기</h2><p>그래프·회귀·군집·연관 결과를 당시 조건과 함께 보존합니다. 서로 다른 분석의 점수로 순위를 매기지 않습니다.</p>
    <div className="form-grid"><label>결과 검색<input value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label><label>결과 종류<select value={kind} onChange={e=>{setKind(e.target.value);setPage(0);}}><option value="all">전체 종류</option>{Object.entries(resultLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label>결과 자료<select value={datasetId} onChange={e=>{setDataset(e.target.value);setPage(0);}}><option value="all">모든 자료</option>{p.datasets.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label></div>
    <p>{filtered.length}개 결과 · 20개씩 표시</p>
    <div className="result-cards">{filtered.slice(page*20,page*20+20).map(r=><article key={r.target.id}><h3>{r.name}</h3><p>{resultLabels[r.kind as keyof typeof resultLabels]} · {r.status} · {p.datasets.find(d=>d.id===r.source.datasetId)?.name}</p><p>버전 {r.source.versionId}</p><p>{r.fresh}</p><details><summary>주요 조건</summary><pre>{r.conditions}</pre></details><p>해석 {p.interpretations.filter(i=>i.target.kind===r.target.kind&&i.target.id===r.target.id).length}개</p><button onClick={()=>onOpen(r.target)}>결과 상세 · 해석 · 출력</button></article>)}</div>
    {!filtered.length&&<p>조건에 맞는 저장 결과가 없습니다. 시각화에서 그래프를 저장하거나 분석을 실행하세요.</p>}
    <div className="pager"><button disabled={!page} onClick={()=>setPage(page-1)}>결과 이전</button><span>{page+1}/{Math.max(1,Math.ceil(filtered.length/20))}</span><button disabled={(page+1)*20>=filtered.length} onClick={()=>setPage(page+1)}>결과 다음</button></div>
    <ReportPanel state={state} dispatch={dispatch} onPending={setReportBusy}/>
    <InterpretationEditor key={'project-'+p.id} state={state} dispatch={dispatch} target={{kind:'project',id:p.id}} writable={writable} onDraft={setProjectDraft}/>
    {detail&&<section className="result-detail"><h2>선택 결과 상세</h2><button disabled={detailDraft} onClick={()=>dispatch({type:'result-detail',target:null})}>상세 닫기</button>{children}{record&&<OutputPanel state={state} record={record} onPending={setOutputBusy}/>}<InterpretationEditor key={detail.kind+detail.id} state={state} dispatch={dispatch} target={detail} writable={writable} onDraft={setDetailDraft}/></section>}
  </section>;
}
