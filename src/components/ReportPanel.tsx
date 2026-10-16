import { useEffect,useRef,useState } from 'react';
import type { WorkspaceState,WorkspaceAction } from '../state/workspace';
import { resultLabels,statusLabels,defaultReport } from '../domain/results';
import { captureReport } from '../domain/report';
import { useTask } from '../workers/useTask';
import { TaskStatus,ErrorNotice } from './DataControls';
import { downloadFile } from './OutputPanel';
export function ReportPanel({state,dispatch,onPending}:{state:WorkspaceState;dispatch:(a:WorkspaceAction)=>void;onPending:(v:boolean)=>void}) {
  const [open,setOpen]=useState(false),[html,setHtml]=useState(''),[error,setError]=useState(''),[rendering,setRendering]=useState(false),[message,setMessage]=useState(''),[preview,setPreview]=useState(false);
  const task=useTask('report-output'),abort=useRef<AbortController|null>(null),generation=useRef(0),frame=useRef<HTMLIFrameElement>(null);
  const r=state.view.report??defaultReport(),[question,setQuestion]=useState(r.question);
  const cancel=()=>{generation.current++;abort.current?.abort();task.cancel();setRendering(false);setMessage('보고서 생성을 취소했습니다.');};
  useEffect(()=>()=>{generation.current++;abort.current?.abort();task.cancel();},[state.project.id,task.cancel]);
  useEffect(()=>{onPending(task.busy||rendering||question!==r.question);return()=>onPending(false);},[task.busy,rendering,question,r.question,onPending]);
  const patch=(patch:Partial<typeof r>)=>{cancel();setHtml('');dispatch({type:'report-selection',report:{...r,...patch}});};
  const items=[...state.project.graphs.map(g=>({kind:'graph' as const,id:g.id,name:g.visual?.name??'그래프'})),...state.project.analyses.map(a=>({kind:'analysis' as const,id:a.id,name:resultLabels[a.kind]+' · '+new Date(a.createdAt).toLocaleString('ko-KR')+' · '+statusLabels[a.status]}))];
  const run=()=>{
    cancel();setHtml('');setError('');setMessage('고정한 결과로 보고서를 준비 중…');const gen=++generation.current;
    try{const input=captureReport(state,r);task.run({kind:'report-prepare',input},async result=>{
      if(result.kind!=='report-prepare'||gen!==generation.current)return;
      const control=new AbortController();abort.current=control;setRendering(true);
      try{const {renderReportImages}=await import('./report-images');const report=await renderReportImages(result.report,control.signal,setMessage);
        if(control.signal.aborted||gen!==generation.current)return;
        task.run({kind:'report-html',report},result=>{if(result.kind==='report-html'&&gen===generation.current)setHtml(result.html);});
      }catch(e){if(!control.signal.aborted)setError(String(e));}finally{if(gen===generation.current)setRendering(false);}
    });}catch(e){setError(String(e));}
  };
  return <section className="report-panel"><button aria-expanded={open} onClick={()=>setOpen(!open)}>통합 보고서 · 인쇄</button>{open&&<>
    <h3>선택한 결과로 탐구 보고서 만들기</h3><label>탐구 질문<textarea maxLength={5000} value={question} onChange={e=>setQuestion(e.target.value)}/></label><button onClick={()=>patch({question})}>탐구 질문 적용</button>
    <fieldset><legend>포함할 결과 (최대 20개, 선택 순서대로)</legend>{items.map(t=><label key={t.id}><input type="checkbox" checked={r.items.some(x=>x.id===t.id&&x.kind===t.kind)} onChange={e=>patch({items:e.target.checked?[...r.items,{kind:t.kind,id:t.id}]:r.items.filter(x=>x.id!==t.id)})} disabled={!r.items.some(x=>x.id===t.id)&&r.items.length>=20}/>{t.name}</label>)}</fieldset>
    <ol>{r.items.map((t,i)=><li key={t.id}>{items.find(x=>x.id===t.id)?.name}<button aria-label={`${i+1}번째 보고서 항목 위로`} disabled={i===0} onClick={()=>{const list=[...r.items];[list[i-1],list[i]]=[list[i],list[i-1]];patch({items:list});}}>위로</button><button aria-label={`${i+1}번째 보고서 항목 아래로`} disabled={i===r.items.length-1} onClick={()=>{const list=[...r.items];[list[i+1],list[i]]=[list[i],list[i+1]];patch({items:list});}}>아래로</button></li>)}</ol>
    <label><input type="checkbox" checked={r.includeInterpretations} onChange={e=>patch({includeInterpretations:e.target.checked})}/>프로젝트·선택 결과의 해석 포함</label>
    <label>표당 수록 행 수<select value={r.tableLimit} onChange={e=>patch({tableLimit:Number(e.target.value)})}>{[25,100,500].map(n=><option key={n}>{n}</option>)}</select></label>
    <p>전체 규칙·평가 행 중 수록한 범위를 명시합니다. 그림은 저장된 조건으로 모든 집단 패널과 모델을 포함합니다. 한도: 결과 20개·그림 20개·표 12,000행·HTML 24 MiB. 인쇄 페이지 수는 용지·배율에 따라 달라집니다.</p>
    <button disabled={task.busy||rendering||!r.items.length||question!==r.question} onClick={run}>고정 시점 보고서 생성</button><TaskStatus {...task} cancel={cancel}/><ErrorNotice error={task.error}/>{rendering&&<p role="status">{message}<button onClick={cancel}>보고서 생성 취소</button></p>}{error&&<p role="alert">{error}</p>}
    {html&&<><p>생성 시점의 결과·조건·해석을 고정했습니다. 이후 변경 내용은 다시 생성해야 반영됩니다.</p><button onClick={()=>downloadFile({name:state.project.name.replace(/[<>:"/\\|?*]/g,'_')+'-보고서.html',type:'text/html;charset=utf-8',data:html})}>단일 HTML 보고서 내려받기</button><button onClick={()=>setPreview(!preview)}>인쇄용 화면 {preview?'접기':'열기'}</button>{preview&&<><p>브라우저 인쇄 대화상자에서 ‘PDF로 저장’을 선택하세요. 자동 PDF 생성은 아닙니다.</p><button onClick={()=>{frame.current?.contentWindow?.focus();frame.current?.contentWindow?.print();}}>브라우저 인쇄 / PDF로 저장</button><iframe title="인쇄용 탐구 보고서" ref={frame} srcDoc={html} sandbox="allow-same-origin allow-modals" className="report-preview"/></>}</>}
  </>}</section>;
}

