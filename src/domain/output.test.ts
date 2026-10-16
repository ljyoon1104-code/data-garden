import {describe,it,expect} from 'vitest';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {createWorkspace,workspaceReducer} from '../state/workspace';
import {createAnalysisRecord,snapshot} from './model';
import {analysisFreshness,defaultReport} from './results';
import {buildExamples} from '../data/example-build';
import {prepareOutput,serializeOutput,csvText,formulaString} from './export';
import type {ExportInput,OutputBook} from './export';
import {defaultTableView} from './table';
import {makeBackup,readBackup,restoreAsCopy,validateWorkspace} from '../persistence/format';
import {captureReport,prepareReport,reportHtml} from './report';
import {JobGate} from '../workers/protocol';
import {newGraph,normalizedGraph,calculateGraph} from './graphs';
import {writeFileSync,mkdirSync} from 'node:fs';
const examples=buildExamples();
function input():Extract<ExportInput,{kind:'data'}>{const d=examples.regression.project.datasets[0];return {kind:'data',title:'한글 자료',source:{datasetId:d.id,versionId:d.versions[0].id},sourceInfo:d.source,table:d.versions[0],view:defaultTableView(),scope:'all',selectedColumns:false,sorted:false};}
describe('interpretations and cross-dataset freshness',()=>{
  it('creates/edits/deletes interpretation references without copying or mutating frozen model results',()=>{
    let s=examples.association;const a=s.project.analyses[0],result=a.association,config=a.configSnapshot,now=new Date().toISOString();
    const i={id:'student-note',target:{kind:'analysis' as const,id:a.id},text:'질문\n근거',createdAt:now,updatedAt:now};
    s=workspaceReducer(s,{type:'interpretation-save',interpretation:i});
    expect(s.project.analyses[0].association).toBe(result);expect(s.project.analyses[0].configSnapshot).toBe(config);expect(a.interpretationIds).not.toContain(i.id);expect(s.project.analyses[0].interpretationIds).toContain(i.id);
    s=workspaceReducer(s,{type:'interpretation-save',interpretation:{...i,text:'수정한 해석'}});expect(s.project.interpretations.find(x=>x.id===i.id)?.text).toBe('수정한 해석');
    expect(analysisFreshness(s.project,s.project.analyses[0]).state).toBe('current');
    s=workspaceReducer(s,{type:'interpretation-delete',id:i.id});expect(s.project.analyses[0].interpretationIds).not.toContain(i.id);expect(s.project.analyses[0].association).toBe(result);
  });
  it('uses each result dataset active version, not the unrelated displayed dataset',()=>{
    const s=structuredClone(examples.association),a=s.project.analyses[0];s.project.selection={datasetId:'unrelated',versionId:'other'};
    expect(analysisFreshness(s.project,a).state).toBe('current');s.project.activeVersions[a.configSnapshot.source.datasetId]=null;expect(analysisFreshness(s.project,a).reasons).toContain('자료 버전이 달라졌습니다.');
  });
  it('persists interpretation and report refs; project-copy remaps project interpretation',()=>{
    const s=examples.dates,copy=readBackup(JSON.stringify(makeBackup(s)),true);expect(copy.project.id).not.toBe(s.project.id);expect(copy.view.report).toEqual(s.view.report);expect(copy.project.interpretations[0].target.id).toBe(copy.project.id);expect(copy.project.interpretations[0].origin).toBe('example');
  });
  it('cleans report/detail references on graph and analysis deletion before backup',()=>{
    let s=structuredClone(examples.association);const a=s.project.analyses[0];s.view.resultDetail={kind:'analysis',id:a.id};
    s=workspaceReducer(s,{type:'analysis-delete',id:a.id});expect(s.view.resultDetail).toBeNull();expect(s.view.report!.items.every(t=>t.id!==a.id)).toBe(true);
    s=workspaceReducer(s,{type:'graph-delete',id:s.project.graphs[0].id});expect(s.view.report!.items).toEqual([]);expect(()=>readBackup(JSON.stringify(makeBackup(s)))).not.toThrow();
  });
  it.each(['text','reference','report','backlink'])('rejects damaged new %s state',kind=>{
    const s=structuredClone(examples.association),i=s.project.interpretations[0];
    if(kind==='text')i.text='가'.repeat(20001);if(kind==='reference')i.target.id='missing';if(kind==='report')s.view.report!.items.push({kind:'graph',id:'missing'});if(kind==='backlink')s.project.analyses[0].interpretationIds=[];
    expect(()=>validateWorkspace(s)).toThrow();
  });
});
describe('exact table and analysis file export',()=>{
  it('exports all rows independently of page, or selected/filtered rows and selected columns',()=>{
    const i=input();i.view.page=1;i.view.pageSize=25;expect(prepareOutput(i).tables[0].rows).toHaveLength(40);
    i.scope='selected';expect(prepareOutput(i).tables[0].rows).toEqual([]);i.view.selectedRowIds=[i.table.rows[39].id];expect(prepareOutput(i).tables[0].rows).toEqual([[39,0,81]]);
    i.scope='filtered';i.view.filter={attributeId:'x',operator:'gt',value:'35'};expect(prepareOutput(i).tables[0].rows).toHaveLength(4);
    i.selectedColumns=true;expect(()=>prepareOutput(i)).toThrow(/열/);i.view.selectedColumnIds=['z'];expect(prepareOutput(i).tables[0].columns).toEqual(['입력 Z']);
  });
  it('applies sort only on request without mutating source order',()=>{const i=input();i.view.sort={attributeId:'x',direction:'desc'};expect(prepareOutput(i).tables[0].rows[0][0]).toBe(0);i.sorted=true;expect(prepareOutput(i).tables[0].rows[0][0]).toBe(39);expect(i.table.rows[0].values.x).toBe(0);});
  it('roundtrips Korean commas, quotes, newlines, leading-zero strings and raw precision in CSV',()=>{
    const table={name:'자료',columns:['한글','값'],rows:[['쉼표, "따옴표"\n다음 줄','00123'],[1.23456789012345,null]]};
    const text=csvText(table,false).text;expect(text.charCodeAt(0)).toBe(0xfeff);expect(Papa.parse<string[]>(text).data).toEqual([['한글','값'],['쉼표, "따옴표"\n다음 줄','00123'],['1.23456789012345','']]);
  });
  it('protects formula-like strings and headers, preserving negative numeric cells',()=>{
    const t={name:'a',columns:['=header'],rows:[['=1+1'],[' @SUM(A1)'],['-5'],[-5],['안전']]};const csv=csvText(t,true);expect(csv.changed).toBe(4);expect(Papa.parse<string[]>(csv.text).data[4]).toEqual(['-5']);expect(formulaString(-5)).toBe(false);expect(csvText(t,false).changed).toBe(0);
  });
  it('writes explicit XLSX types without formulas and preserves code and numeric precision',async()=>{
    const book:OutputBook={title:'가상',generatedAt:'2026-10-16T00:00:00Z',metadata:{출처:'가상'},tables:[{name:'검증',columns:['코드','숫자','불리언','문자'],rows:[['00123',1.23456789012345,true,'=1+1']]}]};
    const [file]=await serializeOutput(book,'xlsx',0,true);const wb=XLSX.read(file.data,{type:'array'}),s=wb.Sheets[wb.SheetNames[0]];
    expect([s.A2.t,s.A2.v,s.B2.t,s.B2.v,s.C2.t,s.C2.v,s.D2.t,s.D2.v,s.D2.f]).toEqual(['s','00123','n',1.23456789012345,'b',true,'s','=1+1',undefined]);expect(wb.SheetNames).toContain('파일 정보');
  });
  it('exports original model metrics, all evaluation rows and null calculation status',()=>{
    const s=examples.regression,a=s.project.analyses[1],d=s.project.datasets[0];const b=prepareOutput({kind:'analysis',title:'회귀',record:a,table:d.versions[0],sourceInfo:d.source,freshness:'과거 조건',ruleQuery:null,includeTransactions:false});
    const m=a.regression!.models[0];if(m.status!=='completed')throw Error('fixture');expect(b.tables[0].rows[0][3]).toBe(m.metrics.mae);expect(b.tables[1].rows).toHaveLength(a.regression!.models.flatMap(m=>m.status==='completed'?m.rows:[]).length);expect(b.metadata.현재와의차이).toBe('과거 조건');
  });
  it('exports cluster SSE contributions and explicit silhouette evaluation mode',()=>{
    const s=examples.clustering,a=s.project.analyses[0],d=s.project.datasets[0];const b=prepareOutput({kind:'analysis',title:'군집',record:a,table:d.versions[0],sourceInfo:d.source,freshness:'현재',ruleQuery:null,includeTransactions:false});
    expect(b.tables[0].rows[0].slice(0,4)).toEqual([2,1,(17/19+15/17)/2,'exact']);expect(b.tables[1].rows.filter(r=>r[0]===2).reduce((n,r)=>n+Number(r[4]),0)).toBe(1);
  });
  it('exports complete association counts, candidate nulls and optional transactions',()=>{
    const s=examples.association,a=s.project.analyses[0],d=s.project.datasets[0];const b=prepareOutput({kind:'analysis',title:'연관',record:a,table:d.versions[0],sourceInfo:d.source,freshness:'현재',ruleQuery:null,includeTransactions:true});expect(b.tables[0].rows).toHaveLength(a.association!.rules.length);expect(b.tables[2].rows).toHaveLength(6);expect(b.tables[0].rows[0][5]).toBe(6);
  });
});
describe('snapshot report, escaping and cancellation',()=>{
  it('freezes selected text/condition generation, limits rows explicitly and embeds no external dependencies',()=>{
    const s=structuredClone(examples.regression),capture=captureReport(s,s.view.report!);s.project.name='後の変更';s.project.interpretations[0].text='後';const prepared=prepareReport(capture);prepared.parts.forEach(p=>{delete p.graph;p.plots=[];});const html=reportHtml(prepared);expect(html).not.toContain('後の変更');expect(html).toContain('전체');expect(html).toContain('데이터뜰 1.0');expect(html).not.toMatch(/<(?:script|link)\b/);expect(html).toContain("script-src 'none'");expect(prepared.generatedAt).toBe(capture.generatedAt);
  });
  it('escapes arbitrary text and rejects non-PNG image URLs',()=>{
    const r=prepareReport(captureReport(examples.dates,examples.dates.view.report!));r.title='<script>alert(1)</script>';r.question='<img src=x onerror=alert(1)>';const html=reportHtml(r);expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');r.parts[0].images=['https://example.com/a.png'];expect(()=>reportHtml(r)).toThrow(/PNG/);
  });
  it('rejects empty selection, duplicate targets, oversized text and too many pictures',()=>{
    expect(()=>captureReport(examples.dates,defaultReport())).toThrow(/선택/);const r=prepareReport(captureReport(examples.dates,examples.dates.view.report!));r.parts[0].images=Array(21).fill('data:image/png;base64,AA==');expect(()=>reportHtml(r)).toThrow(/20개/);
    const sel=structuredClone(examples.dates.view.report!);sel.items.push(sel.items[0]);expect(()=>captureReport(examples.dates,sel)).toThrow(/중복/);
  });
  it('never accepts output after cancel or scope replacement',()=>{
    const gate=new JobGate(),request=gate.startTask('output',{kind:'report-html',report:prepareReport(captureReport(examples.dates,examples.dates.view.report!))});gate.invalidate('output');let downloads=0;expect(gate.receive({...request,type:'complete',result:{kind:'report-html',html:'old'}},()=>downloads++)).toBe(false);expect(downloads).toBe(0);
  });
  it('does not change versions, operations or data undo history during export',()=>{
    const s=createWorkspace(),before=snapshot(s);prepareOutput({...input()});expect(s).toEqual(before);const c=createAnalysisRecord(examples.regression.project.analyses[0].configSnapshot as import('./types').AnalysisConfig,'new','2026-10-16T00:00:00Z');expect(c.interpretationIds).toEqual([]);expect(()=>restoreAsCopy(s)).not.toThrow();
  });
});
it('prepares all eight graph types with fixed conditions for image rendering',()=>{
  let s=createWorkspace();s.project.name='[가상 검증] 8종 그래프';
  const source=s.project.selection!,v=s.project.datasets[0].versions[0];
  for(const kind of ['scatter','histogram','box','bar','line','pie','area','heatmap'] as const){
    const g=newGraph(v,source);g.kind=kind;
    Object.assign(g.visual!,{name:kind+' · 한글 검증',x:kind==='scatter'||kind==='histogram'||kind==='box'?'sleep':kind==='line'||kind==='area'?'survey-date':'commute',y:kind==='heatmap'?'grade':'reading',value:'reading',group:kind==='area'?'commute':'',aggregate:kind==='area'?'sum':'rows',unit:'검증 단위'});
    const result=calculateGraph(v,g);g.visual!.boundaries=result.boundaries;
    s=workspaceReducer(s,{type:'graph-save',graph:normalizedGraph(g)});
  }
  s.view.menu='results';s.view.report={...defaultReport(),items:s.project.graphs.map(g=>({kind:'graph',id:g.id}))};
  const r=prepareReport(captureReport(s,s.view.report));expect(r.parts).toHaveLength(8);expect(r.parts.every(p=>p.graph?.result.marks.length)).toBe(true);
  expect(()=>readBackup(JSON.stringify(makeBackup(s)))).not.toThrow();
  if(process.env.GENERATE_GRAPH_CHECK==='1'){mkdirSync('tmp',{recursive:true});writeFileSync('tmp/eight-graphs.json',JSON.stringify(makeBackup(s)));}
});
