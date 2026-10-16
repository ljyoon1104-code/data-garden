import { useEffect,useRef,useState } from 'react';
import { getInstanceByDom } from 'echarts/core';
import type { EChartsOption } from 'echarts';
import { renderChartImage } from './chart-image';
import { downloadFile } from './OutputPanel';
import { registerExternalWork } from '../workers/client';
export function ChartDownload({node,title,context}:{node:React.RefObject<HTMLDivElement|null>;title:string;context:string[]}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const controller=useRef<AbortController|null>(null);
  const key=JSON.stringify([title,context]);
  useEffect(()=>()=>{controller.current?.abort();},[key]);
  const run=async()=>{
    const chart=node.current&&getInstanceByDom(node.current);if(!chart){setError('그림을 먼저 계산·표시하세요.');return;}
    const abort=new AbortController();controller.current?.abort();controller.current=abort;setBusy(true);setError('');
    const finish=registerExternalWork(()=>abort.abort());
    try{const uri=await renderChartImage({title,context:[...context,'데이터뜰 · '+new Date().toISOString(),'1600px 너비 · 흰 배경 · 화면의 데이터·조건'],option:chart.getOption() as EChartsOption},abort.signal);
      if(abort.signal.aborted)return;const bytes=Uint8Array.from(atob(uri.split(',')[1]),c=>c.charCodeAt(0));downloadFile({name:title.replace(/[<>:"/\\|?*]/g,'_').slice(0,80)+'.png',type:'image/png',data:bytes});
    }catch(e){if(!abort.signal.aborted)setError(String(e));}finally{finish();if(controller.current===abort)setBusy(false);}
  };
  return <div className="chart-download"><button disabled={busy} onClick={()=>void run()}>이 그림 PNG 내려받기</button>{busy&&<><span role="status">이미지 렌더링 중…</span><button onClick={()=>{controller.current?.abort();setBusy(false);}}>이미지 출력 취소</button></>}{error&&<p role="alert">{error}</p>}</div>;
}
