import {useEffect,useRef,useState} from 'react';
import type {ProjectLibrary} from '../persistence/useProjects';
import {useTask} from '../workers/useTask';
import {ErrorNotice,TaskStatus} from './DataControls';
const examples=[['dates','날짜·정리·가공·결합·집계','결측 평균 대체, 월 분리, 계산 열, 장소 결합, 월별 합계와 그래프'],['regression','회귀 세 모델 비교','단순/다중 입력, 선형·트리·이웃, 같은 분할과 평가 근거'],['clustering','여러 속성의 군집과 중심 이동','k=2·3, SSE·정확 실루엣, 할당과 평균 갱신 과정'],['association','빈 거래와 복합 연관 규칙','N=6, 빈 거래 2개, 양쪽 복합 규칙과 2×2 표']];
const help=[
 ['파일·자료형·ID·결측','CSV는 인코딩·구분자·머리글을 확인하고, XLSX는 시트와 실제 값/표시 형식을 확인합니다. 저장 자료형과 의미 유형은 다릅니다. 001 같은 코드는 문자열 ID로 유지하세요. 기본 결측은 null·빈 문자열이며 NA·0·false는 임의로 결측 처리하지 않습니다.'],
 ['전처리·가공·통합','정리 메뉴에서 결측·중복·이상값·정규화를 미리보고 확정합니다. 계산 열·날짜 분리·구간화·인코딩·결합·집계를 지원합니다. 다대다 결합은 행 증가를 확인해야 합니다. 원본과 기존 버전은 보존됩니다.'],
 ['그래프·집계·분모','시각화에서 8종 그래프를 선택하고 축·집단·집계·범위를 지정하세요. 행 수와 유효값 수, 합계와 평균은 다른 질문입니다. 비율의 분모·제외 행·표시 표본은 집계표에서 확인합니다. 집단 패널 PNG는 현재 패널이며 보고서는 선택 그래프의 모든 패널을 포함합니다.'],
 ['학습·평가와 전처리','회귀는 seed 기반으로 관측 단위를 분리합니다. 대체·정규화 기준은 학습 자료에서 구하고 평가에 적용합니다. 목표값을 입력 속성으로 사용하지 않습니다. 결과의 당시 조건에서 실제 분할 행과 전처리 기준을 확인하세요.'],
 ['회귀 지표·계수·트리·이웃','MAE는 절대 오차 평균, MSE는 제곱 오차 평균, RMSE는 MSE의 제곱근입니다. R²가 음수이면 평가 자료의 평균을 사용하는 기준보다 제곱 오차가 큽니다. 평가 목표값이 일정하면 R²는 계산 불가입니다. 상세에서 선형 기여·트리 경로·이웃 거리와 가중치를 확인합니다.'],
 ['K-means·SSE·실루엣','SSE는 최종 중심까지의 제곱 거리 합입니다. 차원·정규화가 다르면 직접 비교에 주의하세요. 실루엣은 점과 실제 구성원 간 거리로 계산합니다. 표본 평가는 평가점만 뽑으며 거리 기준은 군집 전체입니다. 표시 축·표시점 표본은 학습 차원·평가 표본과 다릅니다. 미수렴 중심은 최종 구성원의 평균과 다를 수 있습니다.'],
 ['연관 지지도·신뢰도·향상도','지지도는 A와 B 동시 발생 거래/N, 신뢰도는 동시 발생/A 거래, 향상도는 신뢰도/B 발생률입니다. 빈 거래는 기본 N에 포함합니다. 세로 자료는 선택 ID의 전체 행을 모읍니다. 복합 규칙은 선행·후행 각각의 모든 항목을 포함해야 충족합니다. 인과관계나 예측 정확도가 아닙니다.'],
 ['표준편차 기준','데이터 확인의 기술통계는 표본 표준편차 n−1이며 유효값 2개 미만은 계산 불가입니다. Z점수 정규화는 해당 적합 범위의 모집단 표준편차 n을 사용합니다. 표시 반올림으로 계산하거나 0으로 대신하지 않습니다.'],
 ['버전·재분석·되돌리기','자료 편집·가공은 새 버전을 만듭니다. 결과는 당시 버전·조건으로 남습니다. 결과가 참조하는 자료의 활성 버전과 같은 분석 종류 설정이 바뀌면 사유를 표시합니다. 다른 자료를 화면에서 고르는 것과 구분합니다. 데이터 되돌리기는 해석·분석 기록 삭제와 독립입니다.'],
 ['저장·백업·읽기 전용·공용 PC','확정 자료는 현재 브라우저·배포 경로에 자동 저장됩니다. 중요한 작업은 JSON 백업을 내려받으세요. 다른 탭은 읽기 전용으로 조회·출력이 가능합니다. 공용 PC는 프로젝트 관리에서 저장 목록 확인, 선택 삭제 또는 전체 초기화를 하세요. 다른 배포 경로의 자료는 지우지 않습니다.'],
 ['설치·오프라인·업데이트·주소 이동','처음 온라인에서 오프라인 준비 완료를 확인하세요. 설치는 브라우저 지원에 따르며, 새 버전은 저장 후 사용자가 적용합니다. 강제 수업 중 새로고침은 하지 않습니다. 주소·브라우저·배포 경로를 옮기면 자료가 자동 이동하지 않습니다. 기존 주소에서 JSON 백업 → 새 주소에서 사본 복원을 사용하세요.'],
 ['해석·출력·보고서','결과 메뉴에서 질문·발견·근거·한계·추가 분석을 직접 기록합니다. CSV는 한 표와 조건 정보 JSON, XLSX는 여러 표와 파일 정보 시트를 제공합니다. CSV의 수식 안전 처리는 문자열에 작은따옴표를 추가할 수 있습니다. 정확한 타입·null 복원은 JSON 백업의 역할입니다. 보고서는 선택 시점의 결과와 해석을 고정한 단일 HTML이며, 인쇄 대화상자에서 PDF로 저장합니다.']
];
export function LearningPanel({library,draft,busy,setBusy}:{library:ProjectLibrary;draft:boolean;busy:boolean;setBusy:(v:boolean)=>void}){
  const [open,setOpen]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const task=useTask('example-restore'),controller=useRef<AbortController|null>(null),generation=useRef(0);
  const cancel=()=>{generation.current++;controller.current?.abort();task.cancel();setLoading(false);setBusy(false);};
  useEffect(()=>()=>{generation.current++;controller.current?.abort();task.cancel();},[task.cancel]);
  const load=async(id:string)=>{
    if(draft||busy||!library.writable){setError('미확정 편집·출력을 확정하거나 취소한 뒤 쓰기 가능한 탭에서 여세요.');return;}
    const gen=++generation.current,abort=new AbortController();controller.current=abort;setLoading(true);setBusy(true);setError('');
    try{const response=await fetch(new URL(`examples/${id}.json`,document.baseURI),{signal:abort.signal});if(!response.ok)throw new Error('예제 파일을 읽지 못했습니다. 오프라인 준비 상태와 연결을 확인하세요.');const blob=await response.blob();if(gen!==generation.current)return;
      task.run({kind:'restore',file:new File([blob],id+'.json',{type:'application/json'})},async result=>{
        if(result.kind!=='restore'||gen!==generation.current)return;
        try{await library.add(result.workspace);}catch(e){setError(String(e));}finally{if(gen===generation.current){setLoading(false);setBusy(false);}}
      });
    }catch(e){if(!abort.signal.aborted)setError(String(e));if(gen===generation.current){setLoading(false);setBusy(false);}}
  };
  useEffect(()=>{if(task.error){setLoading(false);setBusy(false);}},[task.error,setBusy]);
  return <section className="learning-panel"><button aria-expanded={open} onClick={()=>setOpen(!open)}>도움말 · 가상 예제</button>{open&&<div><h2>필요한 때 골라 보는 탐구 안내</h2><p>순서를 강제하지 않습니다. 각 분석 상세 화면에서 계산 근거를 확인할 수 있습니다.</p>{help.map(([title,text])=><details key={title}><summary>{title}</summary><p>{text}</p></details>)}<button disabled={draft||busy} onClick={()=>library.dispatch({type:'menu',menu:'results'})}>저장 결과와 계산 근거 보기</button><h3>새 프로젝트 사본으로 열기</h3><p>아래 자료는 직접 생성한 가상 자료(CC0)입니다. 현재 프로젝트를 덮어쓰지 않습니다. 저장 결과는 현재 엔진으로 미리 생성·검증했으며 열 때 다시 학습하지 않습니다. 예시 해석과 사용자 해석을 구분합니다.</p><div className="result-cards">{examples.map(([id,name,description])=><article key={id}><h4>{name}</h4><p>{description}</p><button disabled={busy||draft||!library.writable} onClick={()=>void load(id)}>{name} 예제 열기</button></article>)}</div>{loading&&<p role="status">예제 사본을 읽고 검증 중…<button onClick={cancel}>예제 열기 취소</button></p>}<TaskStatus {...task} cancel={cancel}/><ErrorNotice error={task.error}/>{error&&<p role="alert">{error}</p>}</div>}</section>;
}
