# 데이터뜰 1.0 — 탐구·해석·출력

고등학생과 교사의 데이터 과학 탐구를 위한 React·TypeScript·Vite 정적 PWA입니다. 데이터 / 정리 / 시각화 / 분석 / 결과를 자유롭게 이동합니다. 파일과 프로젝트는 기기 안에서 처리하며 업로드 서버·로그인·동기화·외부 폰트·런타임 CDN을 사용하지 않습니다.

- 저장소: https://github.com/ljyoon1104-code/data-garden (main)
- 배포 주소: https://ljyoon1104-code.github.io/data-garden/ (배포 검증 결과는 docs/stage-10-verification.md)
- 2026-10-16 실제 Pages 배포·HTTPS 실행 확인. 타입 검사·273개 테스트·빌드·캐시 검증 통과. PDF 저장·독립 HTML 열기·실제 HTTPS 오프라인/OS 설치 등 남은 수동 검증은 [검증 기록](docs/stage-10-verification.md)에 명시했습니다.
- 이전 단계의 처리 기준과 상세 기능: [1–9단계 기록](docs/stages-1-9.md). 해당 문서의 ‘배포 전’ 문구는 당시 기록입니다.

## 실행

Node.js 24 LTS 권장(22.12 이상 지원).

~~~sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run check:build
npm run serve:production -- 4173
~~~

개발: http://127.0.0.1:5173/ · 프로덕션: http://127.0.0.1:4173/data-garden/ · 임의 하위 경로: http://127.0.0.1:4173/verification-10/ . 개발 모드에서는 Service Worker를 등록하지 않습니다. 빌드는 dist만 정적 서버에 배포합니다.

Windows 제한된 실행 환경에서 Vitest 임시 경로 ENOENT가 발생하면 프로젝트의 tmp 폴더를 만들고 현재 터미널의 TEMP와 TMP를 해당 절대 경로로 지정한 뒤 재실행하세요. 앱 코드 검증 실패와 구분합니다.

## 사용

1. 데이터: CSV(UTF-8/BOM/EUC-KR) 또는 XLSX를 미리 보고 불러옵니다. 값·속성을 확정 편집하며 원본과 과거 버전은 유지합니다.
2. 정리: 결측·중복·이상값·스케일, 계산 열·날짜·결합·집계를 미리 보고 확정합니다.
3. 시각화: 산점도·히스토그램·상자·막대·선·원·영역·열지도 8종과 계산 근거를 확인합니다.
4. 분석: 회귀(선형·트리·이웃), K-means 군집, 연관 규칙을 저장 조건·행·전처리·분할·seed와 함께 탐구합니다.
5. 결과: 전체 저장 결과를 종류·자료·조건으로 찾고, 당시 상세·비교·해석·표 출력·보고서를 엽니다. 최신 여부는 해당 결과 자료의 활성 버전과 저장 분석 조건으로 판정합니다.

해석은 프로젝트·그래프·분석에 작성하고 명시적으로 저장/취소합니다. 예제 해석은 별도 표시합니다. 자료 수정은 되돌리기/다시 실행과 연결되며, 해석·출력은 원자료나 모델을 변경하지 않습니다.

## 내보내기와 보고서

- 자료 CSV/XLSX: 전체·필터·선택 행, 전체·선택 열, 현재 정렬 적용을 선택합니다. 페이지에 보이는 행만 출력하지 않습니다. CSV는 UTF-8 BOM과 조건 정보 JSON, XLSX는 여러 표와 정보 시트입니다.
- CSV 안전 처리 기본값: 수식처럼 보이는 **문자열** 앞에 작은따옴표를 추가하고 개수를 기록합니다. 실제 숫자 음수는 유지합니다. XLSX는 명시적 숫자/문자/불리언 셀이며 수식 셀을 만들지 않습니다.
- 날짜는 시간대 변환 없는 ISO 문자열, 식별자 앞자리 0은 문자로 보존합니다. CSV의 빈 문자열과 null, 표 도구의 자동 형변환·숫자 정밀도에는 제한이 있습니다. 완전한 프로젝트 복원은 JSON 백업을 사용하세요.
- 분석 표: 회귀 평가·평가 행·제외 행, 군집 k·행·거리·SSE·특성 통계·실루엣 방식, 연관 규칙·후보·분자/분모·선택적 변환 거래. 검색 규칙 출력은 모든 일치 페이지입니다.
- PNG: 화면과 같은 ECharts 설정으로 너비 1600px·흰 배경·제목·당시 버전·범위·표본 설명을 포함합니다. 각 집단 버튼은 해당 패널만, 보고서는 모든 집단을 포함합니다.
- 보고서: 결과 선택/순서·질문·해석·표 수록 범위를 정하고 생성 시점에 고정합니다. 그림·스타일을 내장한 단일 HTML이며 외부 스크립트가 없습니다. 인쇄용 화면에서 브라우저의 **PDF로 저장**을 이용합니다. 자동 PDF 파일 생성 기능은 아닙니다.
- 한도: 표 출력 100만 셀·20만 행·32MiB, 보고서 20결과·20그림·12,000표 행·24MiB. 이미지 설명은 5,000자와 높이 제한을 적용합니다. 한도 초과 시 줄일 항목을 안내하고 조용히 잘라서 성공 처리하지 않습니다. 요약 표는 전체/수록 행을 표시합니다.

## 도움말·예제

‘도움말 · 가상 예제’에서 필요한 설명만 열 수 있습니다. 가상 예제 4개는 현재 엔진으로 생성한 결과를 포함하며 새 프로젝트 사본으로 열립니다. 열 때 모델을 재학습하지 않습니다.

- 날짜/정리/계산/결합/집계: 월별 합계 6g·10g.
- 회귀 단순/다중 세 모델: 생성식 Y=3+2X−4Z, 다중 선형 회귀 계수 독립 검증.
- 군집 k=2·3: k=2 SSE=1, 정확 실루엣 독립 검증.
- 연관: 6거래 중 빈 거래 2개, 양쪽 복합 규칙의 개수·지표 검증.

재생성: npm run examples:generate. public/examples는 직접 만든 가상 교육 자료(CC0)이며 실제 학생 자료가 아닙니다. 의존성 라이선스는 public/licenses에 포함합니다. 앱 소스의 별도 라이선스는 지정하지 않았습니다.

## 저장·오프라인·공용 PC

IndexedDB에 확정 상태를 자동 저장합니다. JSON 백업은 별도 파일입니다. 읽기 전용 탭에서는 조회·출력만 가능하고 편집·실행은 막습니다. 업데이트는 저장 성공 후 명시적으로 적용하며 구 탭의 파일 캐시를 보호합니다. 사용자 자료는 Service Worker 캐시에 넣지 않습니다. 주소 경로별 저장소·캐시는 분리됩니다. 주소를 옮길 때 기존 주소에서 JSON 백업 후 새 주소에서 복원하세요. 공용 PC에서는 백업 후 프로젝트 관리에서 해당 앱 자료를 지우세요.

## 주요 파일

| 위치 | 역할 |
| --- | --- |
| src/components/ResultsHub.tsx, domain/results.ts | 통합 결과·해석·최신 여부·참조 검증 |
| src/components/OutputPanel.tsx, domain/export.ts | CSV/XLSX 범위·형식·분석 표 출력 |
| src/components/ReportPanel.tsx, domain/report.ts | 보고서 선택·고정 시점·HTML·인쇄 |
| src/components/chart-image.ts, report-images.tsx | 같은 차트 설정의 PNG·보고서 이미지 |
| src/components/LearningPanel.tsx, data/example-build.ts | 도움말·가상 예제 생성 |
| src/state/workspace.ts, persistence | 원자적 해석 참조·백업·복원·자동 저장 |
| src/workers | 취소·과거 응답 차단·출력 Worker |
| .github/workflows/pages.yml, vite.config.ts | 검증 후 dist 배포·상대 경로·오프라인 |

## 배포

GitHub Settings → Pages → Source를 GitHub Actions로 설정합니다. main push 또는 수동 실행 시 Node 24에서 npm ci → 타입 검사 → 전체 테스트 → 빌드 → 산출물 검증을 거쳐 dist만 Pages artifact로 배포합니다. Actions는 공식 SHA로 고정했습니다. 비밀키·실제 사용자 자료·백업·다운로드·node_modules·dist는 Git에서 제외합니다.

참고한 공식 문서: [Vite 정적 배포](https://vite.dev/guide/static-deploy.html), [GitHub Pages 사용자 정의 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [SheetJS 셀·배열](https://docs.sheetjs.com/docs/api/utilities/array/), [SheetJS 출력 옵션](https://docs.sheetjs.com/docs/api/write-options/).
