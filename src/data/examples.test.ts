import {describe,it,expect} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {buildExamples} from './example-build';
import {makeBackup,readBackup,restoreAsCopy} from '../persistence/format';
describe('published synthetic examples',()=>{
  it('generates four engine-produced, independently checked projects and restores without training',()=>{
    const all=buildExamples();expect(Object.keys(all)).toHaveLength(4);
    const r=all.regression.project.analyses[1].regression!.models.find(m=>m.kind==='linear')!;
    expect(r.status).toBe('completed');if(r.status==='completed'){expect(r.metrics.rmse).toBeLessThan(1e-9);if(r.model.kind==='linear'){expect(r.model.intercept).toBeCloseTo(3,8);expect(r.model.coefficients[0]).toBeCloseTo(2,8);expect(r.model.coefficients[1]).toBeCloseTo(-4,8);}}
    const c=all.clustering.project.analyses[0].clustering!.candidates.find(c=>c.k===2)!;
    expect(c.sse).toBeCloseTo(1,10);expect(c.silhouette!.mean).toBeCloseTo((17/19+15/17)/2,10);
    const a=all.association.project.analyses[0].association!,names=new Map(a.prepared.items.map(i=>[i.id,i.label]));
    const rule=a.rules.find(r=>r.antecedent.map(id=>names.get(id)).sort().join('')==='AB'&&r.consequent.map(id=>names.get(id)).sort().join('')==='CD')!;
    expect([rule.n,rule.countA,rule.countB,rule.countUnion,rule.lift]).toEqual([6,3,2,2,2]);expect(rule.confidence).toBe(2/3);
    const d=all.dates.project.datasets.find(d=>d.name==='가상 월별 합계')!.versions[0];expect(d.rows.map(r=>r.values[d.columns[1].id]).sort((a,b)=>Number(a)-Number(b))).toEqual([6,10]);
    for(const [name,state]of Object.entries(all)){
      const text=JSON.stringify(makeBackup(state));expect(()=>readBackup(text)).not.toThrow();
      const copy=restoreAsCopy(state);expect(copy.project.id).not.toBe(state.project.id);expect(copy.project.analyses).toEqual(state.project.analyses);
      expect(copy.project.interpretations.filter(i=>i.target.kind==='project').every(i=>i.target.id===copy.project.id)).toBe(true);
      if(process.env.GENERATE_EXAMPLES==='1'){mkdirSync('public/examples',{recursive:true});writeFileSync(`public/examples/${name}.json`,text);}
    }
  });
});
