/** Build/test only. Public examples are generated JSON; opening never retrains models. */
import {createWorkspace,workspaceReducer} from '../state/workspace';
import type {WorkspaceState} from '../state/workspace';
import type {Attribute,Cell,Dataset,AnalysisConfig,AnalysisRecord,GraphConfig} from '../domain/types';
import {createVersion,preserveOriginal,createAnalysisRecord} from '../domain/model';
import {newGraph,normalizedGraph,calculateGraph} from '../domain/graphs';
import {defaultRegression,regressionConfig,buildRegressionPlan,runRegression} from '../domain/regression';
import {defaultClustering,clusteringConfig,buildClusteringPlan,runClustering} from '../domain/clustering';
import {defaultAssociation,associationConfig,associationInput,runAssociation} from '../domain/association';
import {previewWrangling,commitWrangling} from '../domain/wrangling';
import type {WranglingSettings} from '../domain/wrangling-types';
import {previewPreprocessing,commitPreprocessing,preprocessingLineage} from '../domain/preprocessing';
import {validateWorkspace} from '../persistence/format';
const date='2026-10-16T00:00:00.000Z';
function col(id:string,name:string,semanticType:Attribute['semanticType']='numeric'):Attribute{return {id,name,semanticType,storageType:semanticType==='numeric'?'number':'string',description:'직접 만든 가상 교육 자료. 단위는 열 이름 참조.',useInAnalysis:true};}
function dataset(id:string,name:string,columns:Attribute[],values:Cell[][]):Dataset{
  const table={columns,rows:values.map((r,i)=>({id:id+'-r'+String(i+1).padStart(4,'0'),values:Object.fromEntries(columns.map((c,j)=>[c.id,r[j]]))}))};
  const operation={id:id+'-op',kind:'sample' as const,datasetId:id,inputVersionIds:[],outputVersionIds:[id+'-v1'],settings:{generator:'data-garden-example-v1'},executedAt:date};
  return {id,name,source:{kind:'sample',label:'데이터뜰 직접 생성 가상 자료 · 실제 학생·관측 자료 아님 · CC0',importedAt:date},original:preserveOriginal(table),versions:[createVersion(table,{id:id+'-v1',datasetId:id,parentVersionIds:[],operation,createdAt:date})]};
}
function base(name:string){const s=createWorkspace(false);s.project.name='[가상 예제] '+name;return s;}
const add=(s:WorkspaceState,d:Dataset)=>workspaceReducer(s,{type:'import',dataset:d});
function source(s:WorkspaceState,id?:string){const d=id??s.project.selection!.datasetId;return {datasetId:d,versionId:s.project.activeVersions[d]!};}
function graph(s:WorkspaceState,kind:GraphConfig['kind'],name:string,patch:Partial<NonNullable<GraphConfig['visual']>>={}){
  const ref=source(s),table=s.project.datasets.find(d=>d.id===ref.datasetId)!.versions.find(v=>v.id===ref.versionId)!;
  let g=newGraph(table,ref);g={...g,kind,visual:{...g.visual!,name,...patch}};const r=calculateGraph(table,g);g.visual!.boundaries=r.boundaries;
  return workspaceReducer(s,{type:'graph-save',graph:normalizedGraph(g)});
}
function interpret(s:WorkspaceState,text:string,target:import('../domain/types').Interpretation['target']={kind:'project',id:s.project.id}){
  const id=crypto.randomUUID();s=workspaceReducer(s,{type:'interpretation-save',interpretation:{id,target,text,createdAt:date,updatedAt:date}});
  return {...s,project:{...s.project,interpretations:s.project.interpretations.map(i=>i.id===id?{...i,origin:'example' as const}:i)}};
}
function analyze(s:WorkspaceState,c:AnalysisConfig){
  s=workspaceReducer(s,{type:'analysis-config',config:c});
  const a:AnalysisRecord={...createAnalysisRecord(c,crypto.randomUUID(),date),status:'completed',completedAt:date};
  if(c.regression)a.regression=runRegression(buildRegressionPlan(s.project,c),c.regression);
  if(c.clustering)a.clustering=runClustering(buildClusteringPlan(s.project,c as import('../domain/clustering-types').ClusteringConfig),c.clustering);
  if(c.association)a.association=runAssociation(associationInput(s.project,c as import('../domain/association-types').AssociationConfig),c.association);
  s=workspaceReducer(s,{type:'analysis-record',record:a});return s;
}
function wrangle(s:WorkspaceState,settings:WranglingSettings,ids=[s.project.selection!.datasetId]){
  const inputs=ids.map(id=>{const ref=source(s,id),d=s.project.datasets.find(d=>d.id===id)!;return {source:ref,name:d.name,table:d.versions.find(v=>v.id===ref.versionId)!};});
  const preview=previewWrangling(inputs,settings,3_000_000),committed=commitWrangling(inputs,preview.fitted,3_000_000,true);
  return committed.dataset?workspaceReducer(s,{type:'register-derived',dataset:committed.dataset,expectedInputs:inputs.map(i=>i.source)}):workspaceReducer(s,{type:'commit-version',datasetId:inputs[0].source.datasetId,baseVersionId:inputs[0].source.versionId,version:committed.version});
}
export function buildExamples():Record<string,WorkspaceState>{
  let dates=add(base('날짜에서 월별 합계까지'),dataset('dates','가상 매일 관측',[col('day','날짜','date'),col('site','장소 코드','identifier'),col('value','측정량 (g)')],[['2026-01-01','001',2],['2026-01-02','001',4],['2026-02-01','002',6],['2026-02-02','002',null]]));
  const d=dates.project.datasets[0],ref=source(dates),v=d.versions[0];
  const pre=previewPreprocessing(v,ref,{kind:'missing',attributeIds:['value'],method:'mean',rowRule:'any',fixedValues:{}});
  const version=commitPreprocessing(v,ref,pre.fitted,preprocessingLineage(d,v.id))!;
  dates=workspaceReducer(dates,{type:'commit-version',datasetId:d.id,baseVersionId:v.id,version});
  dates=wrangle(dates,{kind:'date',attributeId:'day',parts:[{part:'month',name:'월',description:'날짜에서 분리',storageType:'number',semanticType:'categorical'}],invalid:'block'});
  dates=wrangle(dates,{kind:'calculate',operator:'multiply',operands:[{kind:'attribute',attributeId:'value'},{kind:'constant',value:2}],missing:'propagate',invalid:'block',output:{name:'두 배 측정량 (g)',description:'가상 단위 실험'}});
  dates=add(dates,dataset('places','가상 장소 이름',[col('code','장소 코드','identifier'),col('name','장소 이름','categorical')],[['001','교실'],['002','도서실']]));
  dates=wrangle(dates,{kind:'join',mode:'left',keys:[{left:'site',right:'code'}],columnNames:{},name:'날짜와 장소 결합'},['dates','places']);
  const joined=dates.project.datasets.find(d=>d.id===dates.project.selection!.datasetId)!.versions[0];
  const month=joined.columns.find(c=>c.name==='월')!.id,value=joined.columns.find(c=>c.name==='측정량 (g)')!.id;
  dates=wrangle(dates,{kind:'aggregate',groupIds:[month],includeMissing:true,aggregates:[{method:'sum',attributeId:value,name:'월별 합계 (g)',description:'평균 4로 대체한 뒤의 합계'}],name:'가상 월별 합계'});
  const agg=dates.project.datasets.find(d=>d.id===dates.project.selection!.datasetId)!.versions[0];
  dates=graph(dates,'bar','월별 측정량 합계',{x:agg.columns[0].id,value:agg.columns[1].id,aggregate:'sum'});
  dates=interpret(dates,'질문: 두 달의 측정량 합계가 다른가요?\n근거: 1월은 2+4=6g, 2월은 6+4=10g입니다. 결측 1개를 전체 유효값 평균 4g으로 대체했습니다.\n한계: 가상 자료이며 대체한 값이 포함돼 있습니다. 날짜 분리→계산 열→장소 결합→월별 집계의 버전을 확인하세요.');

  let regression=add(base('회귀 세 모델 비교'),dataset('regression','가상 입력과 점수',[col('x','입력 X'),col('z','입력 Z'),col('y','결과 Y')],Array.from({length:40},(_,i)=>[i,(i*7)%13,3+2*i-4*((i*7)%13)])));
  regression=analyze(regression,regressionConfig(source(regression),{...defaultRegression(),target:'y',features:['x'],models:['linear','tree','knn']}));
  regression=analyze(regression,regressionConfig(source(regression),{...defaultRegression(),target:'y',features:['x','z'],models:['linear','tree','knn']}));
  regression=graph(regression,'scatter','입력 X와 결과 Y',{x:'x',y:'y'});
  regression=interpret(regression,'자료 생성식은 Y=3+2X−4Z입니다. 다중 선형 회귀에서 절편 3, X 계수 2, Z 계수 −4와 평가 오차 약 0을 확인할 수 있습니다. 단순 회귀·트리·이웃 모델의 평가는 같은 분할에서 비교하세요. 실제 학생 성취도나 원인 관계를 나타내는 자료가 아닙니다.',{kind:'analysis',id:regression.project.analyses[1].id});

  let clustering=add(base('두 속성과 중심 이동'),dataset('clustering','가상 네 점',[col('x','X 좌표'),col('y','Y 좌표')],[[0,0],[1,0],[9,0],[10,0]]));
  clustering=analyze(clustering,clusteringConfig(source(clustering),{...defaultClustering(),features:['x','y'],ks:[2,3],scaling:'none',restarts:1,silhouette:{mode:'exact',sampleSize:100,seed:42}}));
  clustering=graph(clustering,'scatter','네 점의 거리',{x:'x',y:'y'});
  clustering=interpret(clustering,'k=2에서 중심은 (0.5,0), (9.5,0)이고 SSE=1입니다. 개별 실루엣은 17/19, 15/17, 15/17, 17/19입니다. k=3과 SSE·실루엣·크기를 비교하고 실제 할당/평균 갱신 과정을 펼쳐보세요. 군집 번호는 정답 집단 이름이 아닙니다.',{kind:'analysis',id:clustering.project.analyses[0].id});

  let association=add(base('빈 거래와 복합 규칙'),dataset('association','가상 여섯 장바구니',[col('basket','항목 목록','categorical')],[['A,B,C,D'],['A,B,C,D'],['A,B,C'],['A'],[''],['']]));
  association=analyze(association,associationConfig(source(association),{...defaultAssociation(),columns:['basket'],supportPercent:'30',confidencePercent:'50',maxLength:4}));
  association=graph(association,'bar','장바구니 내용별 거래 수',{x:'basket',aggregate:'rows'});
  association=interpret(association,'빈 거래 2개를 포함하여 N=6입니다. {A,B}→{C,D}의 지지도는 2/6, 신뢰도는 2/3, 향상도는 2입니다. 역방향 신뢰도는 1입니다. 같은 장바구니 두 개를 각각 세며, 함께 나타난다는 사실은 인과관계가 아닙니다.',{kind:'analysis',id:association.project.analyses[0].id});
  const examples={dates,regression,clustering,association};
  for(const s of Object.values(examples)){s.view.menu='results';s.view.report={question:'가상 자료에서 조건에 따른 결과 차이를 탐구합니다.',items:[...s.project.graphs.map(g=>({kind:'graph' as const,id:g.id})),...s.project.analyses.map(a=>({kind:'analysis' as const,id:a.id}))],includeInterpretations:true,tableLimit:25};validateWorkspace(s);}
  return examples;
}
