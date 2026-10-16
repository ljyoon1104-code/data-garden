import { init } from 'echarts/core';
import type { EChartsOption } from 'echarts';
export interface ChartImage {title:string; context:string[]; option:EChartsOption}
/** Same rendered options, a fixed export viewport, and an explicit text margin. */
export async function renderChartImage(image:ChartImage, signal?:AbortSignal):Promise<string> {
  if(signal?.aborted)throw new Error('이미지 출력 취소');
  const title=image.title.slice(0,400),context=image.context.join(' · ');
  if(context.length>5000)throw new Error('이미지 설명 5,000자 한도입니다. 조건을 보고서로 출력하세요.');
  await document.fonts.ready;
  const lines=(text:string,max=90)=>{const out=[];for(let i=0;i<text.length;i+=max)out.push(text.slice(i,i+max));return out;};
  const titleLines=lines(title,75),details=lines(context,100);
  const width=1600, header=35+titleLines.length*38,footer=35+details.length*25;
  if(header+footer>900)throw new Error('이미지 설명이 너무 깁니다. 조건을 보고서로 분리하세요.');
  const node=document.createElement('div');Object.assign(node.style,{position:'fixed',left:'-20000px',top:'0',width:width+'px',height:'850px'});document.body.append(node);
  const chart=init(node,undefined,{renderer:'canvas',width,height:850,devicePixelRatio:1});
  try{
    // ECharts options can contain trusted formatter functions; retain them without cloning code.
    const option={...image.option};
    option.animation=false;option.backgroundColor='#fff';
    const legends=(Array.isArray(option.legend)?option.legend:option.legend?[option.legend]:[]).map(l=>({...l}));
    option.legend=legends;
    legends.forEach(l=>{l.type='plain';});
    chart.setOption(option,{notMerge:true,lazyUpdate:false});
    await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    if(signal?.aborted)throw new Error('이미지 출력 취소');
    const raw=chart.getDataURL({type:'png',pixelRatio:1,backgroundColor:'#ffffff'});
    const raster=new Image();raster.src=raw;await raster.decode();
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=header+850+footer;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#173c36';ctx.font='bold 28px system-ui, sans-serif';
    titleLines.forEach((line,i)=>ctx.fillText(line,40,40+i*38));ctx.drawImage(raster,0,header);
    ctx.font='19px system-ui, sans-serif';ctx.fillStyle='#334b46';details.forEach((line,i)=>ctx.fillText(line,40,header+880+i*25));
    if(signal?.aborted)throw new Error('이미지 출력 취소');
    return canvas.toDataURL('image/png');
  }finally{chart.dispose();node.remove();}
}
