import { createRoot } from 'react-dom/client';
import { getInstanceByDom } from 'echarts/core';
import type { EChartsOption } from 'echarts';
import { GraphCanvas,RegressionCanvas,ClusteringCanvas } from './GraphCanvas';
import { renderChartImage } from './chart-image';
import type { PreparedReport } from '../domain/report';
export async function renderReportImages(report:PreparedReport,signal:AbortSignal,progress:(s:string)=>void) {
  let count=0;
  for(const part of report.parts){
    const pictures:{title:string;node:React.ReactNode;context:string[]}[]=[];
    const g=part.graph;
    if(g){const groups=g.config.visual?.layout==='facets'?g.result.groups:[undefined];
      for(const group of groups)pictures.push({title:part.title+(group?' · '+group:''),node:<GraphCanvas graph={g.config} result={g.result} table={g.table} group={group} select={()=>{}}/>,context:[`전체 ${g.result.total}행 중 사용 ${g.result.used} · 표시 ${g.result.displayed} · ${g.result.sampled?'표시 표본':'표본 아님'}`,group?'집단 패널: '+group:'모든 표시 집단',`집계 ${g.config.visual?.aggregate} · 단위 ${g.config.visual?.unit||'없음'}`]});
    }
    for(const plot of part.plots){
      if(plot.kind==='regression')pictures.push({title:part.title+' · '+plot.name,node:<RegressionCanvas rows={plot.rows} seed={plot.seed} select={()=>{}}/>,context:[`전체 평가 ${plot.rows.length}행 · 최대 1,000 표시점 · ${plot.rows.length>1000?'표시 표본':'전체 표시'}`]});
      else if(plot.kind==='cluster-metrics')pictures.push({title:part.title+' · k 비교',node:<ClusteringCanvas mode="metrics" result={plot.result}/>,context:[`분석 ${plot.result.rowIds.length}행`,...plot.result.candidates.map(c=>`k=${c.k}: 실루엣 ${c.silhouette?.mode??'계산 불가'}`)]});
      else pictures.push({title:part.title+' · '+plot.name,node:<ClusteringCanvas mode="scatter" detail={plot.detail} select={()=>{}}/>,context:[`분석 ${plot.detail.total}행 · 표시 ${plot.detail.displayed}점 · ${plot.detail.displayed<plot.detail.total?'표시 표본':'전체 표시'}`]});
    }
    for(const picture of pictures){
      if(signal.aborted)throw new Error('보고서 생성 취소');
      const host=document.createElement('div');Object.assign(host.style,{position:'fixed',left:'-20000px',width:'1200px',top:'0'});document.body.append(host);const root=createRoot(host);
      try{
        root.render(picture.node);
        let nodes:HTMLDivElement[]=[];
        for(let attempt=0;attempt<90;attempt++){
          await new Promise<void>(r=>requestAnimationFrame(()=>r()));
          if(signal.aborted)throw new Error('보고서 생성 취소');
          nodes=[...host.querySelectorAll<HTMLDivElement>('.graph-canvas')];
          if(nodes.length&&nodes.every(n=>getInstanceByDom(n)))break;
        }
        if(!nodes.length||nodes.some(n=>!getInstanceByDom(n)))throw new Error('보고서 그림이 준비되지 않았습니다. 다시 시도하세요.');
        for(const [i,node]of nodes.entries()){
          if(++count>20)throw new Error('보고서 이미지 20개 한도입니다. 결과·집단·모델 수를 줄이세요.');
          progress(`보고서 그림 ${count}개 · ${picture.title}`);
          part.images.push(await renderChartImage({title:picture.title+(nodes.length>1?i===0?' · 실제/예측':' · 예측/잔차':''),context:[...picture.context,part.metadata.자료버전??part.metadata.버전??'',part.metadata.현재와의차이??'',`고정 생성 시점 ${report.generatedAt} · 상세 출처·조건은 보고서 본문`],option:getInstanceByDom(node)!.getOption() as EChartsOption},signal));
        }
      }finally{root.unmount();host.remove();}
    }
    // Rendering-only payload is no longer needed when serializing HTML.
    delete part.graph;part.plots=[];
  }
  return report;
}
