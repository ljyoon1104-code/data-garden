# 보안 수정 통합 검토와 배포 준비

검토일: 2026-11-11. 현재 작업 트리를 새로 검사한 로컬 기록이다. Git 스테이징·커밋·푸시·배포·원격 설정 변경은 하지 않았다.

## 판단

누적 보안 수정 사이에서 추가로 수정할 앱 결함은 발견하지 못했다. 아래 자동 검사와 새 브라우저 실행으로 로컬 통합 동작을 확인했다. 이번에 보강한 것은 검증 도구의 출처 표시다. 예제 생성 소스의 해시와 실제 제공 빌드의 해시를 분리하고 HTTP 응답까지 대조한다.

**로컬 검증 완료와 실제 공개 배포 준비 완료는 다르다.** 전용 호스트·관리 계정·도메인이 미확정이다. 현재 GitHub Pages 경로만 분리한 상태를 다른 앱과의 출처 격리로 간주할 수 없다. 실제 학생 자료를 사용하는 공개 전환 전에는 전용 출처와 이전 절차를 확정하고 실제 HTTPS 환경을 검증해야 한다.

## 검사 대상과 빌드 출처

- 시작·종료 기준 HEAD: `4230593079849ed03d540ae602d6e72637efc15c`, `main`. 기존 미커밋 변경을 포함한 현재 파일을 검사했다.
- 시작 시 관리 대상 파일 180개의 해시와 Git 상태를 기록했다. 이번 검토는 기존 파일의 삭제·이동·사용자 변경 되돌리기를 하지 않았다.
- 기존 서버가 사용하는 루트 `dist` 29개 파일은 그대로 보존했다. 검증용 사본은 `tmp/security-release-GuvFVH/app`이다. 설치 라이브러리만 기존 `node_modules`에 연결하고, 테스트 파일은 사본에서 제외했다. 전체 테스트와 타입 검사는 원래 작업 폴더에서 실행했다.
- 빌드 입력 101개의 경로·내용 해시를 `source-manifest.json`에 기록했다. 집계 SHA-256: `fb4b5211c76192fc675e80ae38b3d91a0dc11ba3384193517068cd90b3d9de4b`. 방법은 명시된 `sourceHashes`를 JSON 직렬화한 SHA-256이다. 앱 소스·public·패키지·빌드 설정·서버·검사 스크립트·워크플로를 포함하며 테스트와 문서는 제외한다.
- 새 빌드 실행: UTC `2026-11-11T02:41:46.626Z`~`02:42:47.018Z`. 캐시 검사 실행: `02:42:47.020Z`~`02:42:54.311Z`. 한국 시각은 각각 9시간을 더한다.

| 실제 제공 산출물 | SHA-256 또는 식별자 |
| --- | --- |
| `index.html` | `b066f48d3b5f21b2c5deb1ba7b5096f7f68b4e5d60f5c62766d19659766484c5` |
| `assets/index-LAvnWLGp.js` | `829953b93eb582fda5d39e5db3fcf1c26bb6a025ed5c87f01ca2da57528d3b51` |
| `sw.js` | `f549b397ecb5f6f65481db1a928b3c0097a5eef463fc25866c950f52abb45d0f` |
| SW 캐시 버전 | `d0c180cf955a2ac2` |

빌드와 `check:build` 모두 사본을 작업 경로로 실행했다. `check-build.mjs`는 해당 작업 경로의 `dist`를 읽는다. 워크플로의 정확한 인라인 산출물 검사도 같은 사본의 `dist`에서 실행했다. 루트의 이전 산출물을 검사한 결과로 바꾸어 보고하지 않는다. 브라우저가 받은 index/main/SW의 HTTP 응답 해시도 위 파일과 대조했다.

## 통합 연결 검토

| 영역 | 현재 코드에서 확인한 연결과 보호 |
| --- | --- |
| CSV 수식과 출력 | 열 이름·모든 문자열에 공통 보호를 적용한다. 실제 숫자는 유지한다. 대체 구분자·줄바꿈 뒤 위험 셀이 생길 수 있으면 안전 CSV를 거절하고 명시적 자료형 XLSX를 안내한다. 완성 문자열을 만들기 전에 출력 바이트를 계산한다. |
| CSV/XLSX/JSON 입력 | CSV 청크 파싱 중 행·열·보정 셀·문자열 제한, XLSX ZIP 실제 해제량·선택 시트 XML 검사, JSON 엄격 UTF-8·파싱 전 제한이 실제 Worker 진입점에 연결돼 있다. |
| 복원 공용 예산 | 가공·회귀·군집·연관·히스토그램 검증이 같은 프로젝트 예산을 사용한다. 백업뿐 아니라 IndexedDB 저장본의 로드도 Worker 검증을 거친다. |
| 취소와 이전 응답 | JobGate 무효화와 Worker 종료를 연결한다. 세션 식별·삭제 세대·화면 재생성으로 취소 뒤 늦은 파싱·복원·분석·준비 출력을 적용하지 않는다. |
| 저장·삭제·출력 | 저장·개별 삭제·전체 삭제는 같은 DB 트랜잭션에서 삭제 세대를 확인한다. JSON/CSV/XLSX/PNG/HTML/인쇄 모두 출력 시작 직전에 현재 세대를 확인한다. |
| DB2와 구버전 | 연결 버전 2의 비파괴 이행으로 명시적 버전 1 클라이언트를 차단한다. 연결 지연은 10초 타이머와 초기 실패의 쓰기 잠금 해제로 처리한다. 실패 뒤 지연 이행을 중단한다. 프로젝트 스키마 6·백업 형식 1과 DB 버전은 별개다. |
| Windows 로컬 실행 | loopback 수신, Host 검사, 원시 URL의 경로 검증, 링크·정션·실제 경로와 파일 식별자 재확인을 적용한다. 실행 배치는 서버의 실제 수신 성공 뒤 브라우저를 열고 점유 포트를 재사용하지 않는다. |
| Actions | 빌드와 배포 권한을 분리하고 저장소·main·이벤트 조건을 확인한다. checkout 인증을 유지하지 않는다. 고정 SHA의 공식 액션을 사용하고, 검사 후 허용된 `dist`만 업로드한다. |

새 라이브러리 pako 2.1.0, saxes 6.0.0, 전이 의존성 xmlchars 2.2.0의 잠금 파일과 라이선스 3개를 확인했다. `@types/pako`는 개발용이다. 런타임 코드는 로컬 번들에 포함되고 라이선스는 사전 캐시와 워크플로 허용 목록에 연결된다. 새 라이브러리를 런타임 CDN에서 받지 않는다.

검증 도구 `verify-security-browser.mjs`는 `reportVersion: 2`와 `fixtureSourceHash`를 사용한다. 이전 `sourceHash` 필드와 혼동하지 않도록 실제 작업 경로·배포 폴더·파일 시각·index/main/SW 해시 및 HTTP 대조를 추가했다. CLI 인수와 환경변수 사용법은 유지되지만 검증 JSON 소비자는 필드명 변경을 반영해야 한다. 앱의 프로젝트 백업 형식은 바꾸지 않았다. 생성 소스의 해시만으로 소스와 빌드의 대응을 입증하지 않는다는 한계도 도구에 명시했다.

## 이번에 새로 실행한 검사

| 검사 | 이번 실행 결과 |
| --- | --- |
| 원래 작업 폴더의 `npm run typecheck` | 종료 0 |
| `npm test -- --maxWorkers=2` | 종료 0, 25개 파일·376개 통과·1개 건너뜀 |
| `node scripts/create-fixtures.mjs --check` | 종료 0, 기존 자료 26개 일치·0개 실패, 파일 쓰기 없음 |
| 사본의 `npm run build` | 종료 0, 새 `dist` 29개 파일 |
| 사본의 `npm run check:build` | 종료 0, 캐시 28개·Worker/자산·루트/저장소/임의 하위 경로 확인 |
| 현재 워크플로 문법·구조 | actionlint 1.7.12 종료 0, YAML 2.9.1 구조 24개·실행 문맥 14개 통과 |
| 실제 워크플로 인라인 산출물 검사 | 사본의 `dist` 대상 13/13개 기대 결과 일치, 건너뜀 0 |
| 액션과 라이선스 출처 | 공식 액션 태그 5개를 새로 조회해 고정 SHA 대조, 라이선스 3개 확인 |
| 새 가상 보안 자료 | 22개 생성·helper 판정 18개, 생성 후·브라우저 후 `--check` 22/22 일치 |
| 검증 도구 보강 | `node --check`와 별도 HTTP 출처 대조 통과 |
| `git diff --check` | 종료 0, 새 파일 공백 검사도 통과 |

전체 테스트의 동시 실행 수만 2개로 지정했다. 테스트별 시간 제한이나 기대 결과를 완화하지 않았다. 기존 검증 자료 26개와 그 안내 README의 시작·종료 해시는 모두 같았다.

마지막 파일 대조에서 후보 54개와 실제 Git 변경 목록이 일치했고 중복·누락·추가가 없었다. 빌드 입력 101개는 현재 파일·사본과 모두 일치했으며 루트 `dist` 29개와 검증 사본의 산출물도 각 기록과 일치했다. 관련 문서 상대 링크 97개에 누락이 없었다. 시작 시 해시를 기록한 180개 중 이번에 내용이 바뀐 것은 README와 검증 도구뿐이며 새 readiness 문서 1개를 추가했다. 기존 보안·사용자 변경은 그대로 보존됐다. 후보의 파일별 크기·해시는 로컬 `tmp/security-release-GuvFVH/commit-candidates.json`, 최종 보존 검사는 `final-checks.json`에 기록했다.

건너뛴 시험은 `Windows production server boundary > refuses a file symlink when the host permits creating one`이다. 이 Windows 계정은 파일 심볼릭 링크를 만들 권한이 없어 EPERM/EACCES 경로에서 건너뛴다. 디렉터리 정션·루트 링크·하드링크와 경로 경계 검사는 별도로 실행됐다. actionlint의 외부 ShellCheck·Pyflakes는 설치되지 않아 실행하지 않았다. 실제 Linux runner 실행 결과는 아직 없다.

### 새 실제 브라우저 범위

별도 Edge 157.0.4341.42 프로필/컨텍스트와 미사용 loopback 포트를 사용했다. 기존 사용자 탭·공개 앱·실행 중 서버를 사용하지 않았다.

- 정상 통합 흐름: CSV와 XLSX 입력, 실제 셀 편집, 회귀 세 모델 실행, JSON 백업 다운로드, 새 ID 사본 복원과 내용 비교, 새로고침, 전체 삭제 후 빈 DB·선택 상태, 새 프로젝트 저장과 다시 열기를 확인했다.
- 이전 자료: 합성한 스키마 1~5 백업을 각각 실제 UI에서 복원했다. 가상 기존 DB 연결 버전 1에서 최종 앱이 버전 2로 이행할 때 프로젝트와 메타데이터의 보존을 비교했다. 합성 자료를 모든 실제 과거 백업의 호환성 보증으로 넓히지 않는다.
- 보안 입력·출력: `http://127.0.0.1:59640/`에서 18/18단계, 종료 0. UTC `02:49:58.103Z`~`02:50:52.606Z` 실행이다. CSV 정상/EUC-KR/한도, XLSX 선택 처리와 오류, JSON 이전 백업과 한도, 취소와 실제 늦은 응답 재주입, 안전 출력, 오프라인 CSV/XLSX/JSON을 확인했다. Worker 85개 모두 종료됐고 취소·늦은 응답 증거 7개를 기록했다. 콘솔 오류·예상 밖 실패·외부 요청은 각각 0개였다.

정상 통합 흐름은 `http://127.0.0.1:58504/data-garden/`에서 UTC `02:51:01.763Z`~`02:51:54.198Z`의 새 실행으로 앱 단계 6/6을 통과했다. CSV 24행·XLSX 3행을 불러오고 점수 첫 행을 13→14로 편집했으며 원본은 보존됐다. 세 회귀 모델은 학습 16행·평가 8행을 사용했다. 실제 JSON 백업은 58,530바이트, SHA-256 `8fffbd51d3f3358dae26ea238ed8ddad869758b7e4b6e320e47be8bd6cbd4c1a`다. 복원은 새 프로젝트 ID로 만들고 허용된 사본 정보 외 내용이 같았다. 전체 삭제 후 프로젝트 0개·자료 없는 meta 표시 2개·선택 없음, 새 프로젝트 저장 후 그 프로젝트만 1개인 상태를 확인했다.

스키마 1~5 자료는 현재 UI에서 만든 유효 백업의 공통 필드로 합성했다. 스키마 1은 이행 코드에 맞게 activeVersions/history를 생략했고 2~5는 이력을 유지했다. 별도 프로필의 DB1에는 공개 가상 날짜 예제의 스키마 6 자료를 넣고 최종 앱을 처음 열었다. DB2 이행 전후 프로젝트·메타데이터를 깊이 비교해 4개 자료·7개 버전의 보존을 확인했다. 첫 탐색에만 브라우저의 정확한 부트스트랩 URL 응답을 빈 HTML로 대체해 DB1을 준비했고, 실제 앱·자산 응답은 대체하지 않았다. 회귀 원본·삭제 후 빈 표·DB 이행 화면을 직접 확인했으며, 사본은 실제 UI 조작과 DB 내용 비교로 확인했다.

도구 실패도 보존했다. 최초 DB 준비용 txt URL이 다운로드된 탐색 가정 오류는 새 실행에서 브라우저 라우팅으로 바로잡았다. 정상 앱 6단계가 모두 통과한 새 실행의 마지막 총괄 검사에서는 Edge 내부 다운로드 화면 요청 43건을 외부 네트워크로 잘못 세어 종료 1이 됐다. 그 원본 결과를 바꾸지 않고 원본 SHA-256을 고정한 후속 검사에서 HTTP(S) 요청 100건을 별도로 대조해 종료 0을 확인했다. 외부 HTTP 요청·본문 전송·실패·콘솔 오류·페이지 오류는 모두 0개였다. 내부 브라우저 요청은 삭제하거나 앱 네트워크 요청으로 합산하지 않았다.

정상 흐름 증거는 `tmp/security-release-GuvFVH/browser-20261111025100591-ffc730`의 원본 `results.json`, `summary.json`, 후속 `network-validation.json`에 있다. 보안 18단계와 새 자료는 `tmp/security-audit-20261111T024837199Z-11a3c49e`에 있다. 인프라의 새 실행은 `tmp/release-infra-r9755g/infra-results.json`에 기록했다. 이 경로들은 Git에서 제외되는 로컬 증거이며 배포 자산이나 커밋 후보가 아니다. 모든 검증용 서버·브라우저는 종료했다.

보안 자료의 `fixtureSourceHash`는 `a3609f7ab72db655a54a8fa8af1e990cb04e0f3b6ca1ce938ea925bbaa40ee80`이다. 이 해시는 생성기가 포함한 파일 집합의 해시이며 위 빌드 입력 101개 집계와 방법·범위가 다르다. 직접 같은 값이어야 한다고 비교하지 않는다. 실제 제공 빌드는 별도 manifest의 파일별 대조와 HTTP 해시로 확인했다.

### 과거 검증과 이번 미실행 범위

아래 결과는 과거 날짜의 실제 검증이며 이번 실행 횟수에 넣지 않는다.

- [입출력·Excel 기록](security-verification.md): 2026-11-10, Excel 16.0.10417.20228 x64/한국어/쉼표에서 현대식 CSV 27개·줄바꿈 없는 구형 마법사 CSV 24개·명시적 XLSX 53개를 열기·저장·닫기·재열기했다. 수식 셀 0개, 보호 문자열·실제 숫자와 XLSX 줄바꿈 보존을 확인했다. **이번 통합 작업에서 Excel은 다시 실행하지 않았다.**
- 구형 Excel 마법사는 인용된 단독 LF를 완전하게 읽지 못했다. 여러 줄 자료는 현대식 가져오기 또는 XLSX를 사용한다. SheetJS 재읽기의 CRLF→LF 정규화와 실제 Excel 셀 값을 구분한다. 다른 Excel 버전·지역 설정·LibreOffice는 미검증이다.
- [구버전 혼용 기록](mixed-version-reset-verification.md)의 별도 Edge 4개 흐름·30단계와 [공용 PC 삭제 기록](public-pc-reset-verification.md)의 탭 전환·알림 지연/누락·실패 시험은 앞선 실제 실행이다. 이번 전체 회귀 검사에 해당 자동 시험은 포함됐지만, 이번 정상 통합 브라우저를 혼용 30단계 재실행으로 표기하지 않는다.
- [출처 이전 기록](hosting-migration-verification.md)의 로컬 두 출처와 공개 주소에서 내려받은 가상 백업 이전은 앞선 실행이다. 이번에 공개 앱에 새 자료를 넣거나 전용 공개 호스트를 검증하지 않았다.

## 커밋 후보와 권장 구분

현재 보안 수정에 필요한 후보는 **54개: 기존 파일 수정 28개·새 파일 26개**다. 아래는 목록이며 스테이징 지시나 실행 기록이 아니다. 핵심 42개는 형식 검사·Worker·화면·저장소가 연결되므로 한 묶음을 권장한다. 이후 서버 3개, Actions 1개, 문서 8개로 나눈다. 각 중간 커밋 상태를 별도로 빌드한 것은 아니며 이번 검사는 전체 합본에 대한 것이다.

Actions 허용 목록은 새 라이선스를 요구하므로 핵심 수정보다 먼저 단독 반영하면 검사에서 막힐 수 있다. 향후 승인된 반영에서는 중간 상태를 main에 따로 푸시하지 말고 전체 승인 상태를 기준으로 검증한다.

### 1. 입력·출력·복원·저장소 핵심 42개

- [package-lock.json](../package-lock.json)
- [package.json](../package.json)
- [public/licenses/pako-LICENSE.txt](../public/licenses/pako-LICENSE.txt)
- [public/licenses/saxes-LICENSE.txt](../public/licenses/saxes-LICENSE.txt)
- [public/licenses/xmlchars-LICENSE.txt](../public/licenses/xmlchars-LICENSE.txt)
- [scripts/security-fixtures.mjs](../scripts/security-fixtures.mjs)
- [scripts/verify-security-browser.mjs](../scripts/verify-security-browser.mjs)
- [src/App.tsx](../src/App.tsx)
- [src/components/ChartDownload.tsx](../src/components/ChartDownload.tsx)
- [src/components/ImportPanel.tsx](../src/components/ImportPanel.tsx)
- [src/components/OutputPanel.tsx](../src/components/OutputPanel.tsx)
- [src/components/ProjectManager.tsx](../src/components/ProjectManager.tsx)
- [src/components/ReportPanel.tsx](../src/components/ReportPanel.tsx)
- [src/data/csv-input.test.ts](../src/data/csv-input.test.ts)
- [src/data/csv-input.ts](../src/data/csv-input.ts)
- [src/data/import-diagnostics.test.ts](../src/data/import-diagnostics.test.ts)
- [src/data/import.test.ts](../src/data/import.test.ts)
- [src/data/import.ts](../src/data/import.ts)
- [src/data/xlsx-import.test.ts](../src/data/xlsx-import.test.ts)
- [src/data/xlsx-import.ts](../src/data/xlsx-import.ts)
- [src/data/xlsx-zip.ts](../src/data/xlsx-zip.ts)
- [src/domain/association-validation.ts](../src/domain/association-validation.ts)
- [src/domain/clustering-validation.ts](../src/domain/clustering-validation.ts)
- [src/domain/clustering.ts](../src/domain/clustering.ts)
- [src/domain/export.ts](../src/domain/export.ts)
- [src/domain/output.test.ts](../src/domain/output.test.ts)
- [src/domain/preprocessing.ts](../src/domain/preprocessing.ts)
- [src/domain/regression-validation.ts](../src/domain/regression-validation.ts)
- [src/domain/regression.ts](../src/domain/regression.ts)
- [src/persistence/analysis-budget.test.ts](../src/persistence/analysis-budget.test.ts)
- [src/persistence/backup-limits.test.ts](../src/persistence/backup-limits.test.ts)
- [src/persistence/backup-limits.ts](../src/persistence/backup-limits.ts)
- [src/persistence/format.ts](../src/persistence/format.ts)
- [src/persistence/mixed-version.test.ts](../src/persistence/mixed-version.test.ts)
- [src/persistence/projectAccess.ts](../src/persistence/projectAccess.ts)
- [src/persistence/store.test.ts](../src/persistence/store.test.ts)
- [src/persistence/store.ts](../src/persistence/store.ts)
- [src/persistence/useProjects.ts](../src/persistence/useProjects.ts)
- [src/persistence/wrangling-work.test.ts](../src/persistence/wrangling-work.test.ts)
- [src/persistence/wrangling-work.ts](../src/persistence/wrangling-work.ts)
- [src/workers/data.worker.ts](../src/workers/data.worker.ts)
- [src/workers/protocol.ts](../src/workers/protocol.ts)

### 2. Windows 로컬 실행 3개

- [scripts/serve-production.mjs](../scripts/serve-production.mjs)
- [데이터뜰_실행.bat](../데이터뜰_실행.bat)
- [src/local-server.test.ts](../src/local-server.test.ts)

### 3. GitHub Actions 1개

- [.github/workflows/pages.yml](../.github/workflows/pages.yml)

### 4. 사용·검증·이전 문서 8개

- [README.md](../README.md)
- [docs/github-actions-security-verification.md](github-actions-security-verification.md)
- [docs/hosting-migration-verification.md](hosting-migration-verification.md)
- [docs/local-server-security-verification.md](local-server-security-verification.md)
- [docs/mixed-version-reset-verification.md](mixed-version-reset-verification.md)
- [docs/public-pc-reset-verification.md](public-pc-reset-verification.md)
- [docs/security-release-readiness.md](security-release-readiness.md)
- [docs/security-verification.md](security-verification.md)

### 제외 대상

`node_modules/`, `.npm-cache/`, `dist/`, `tmp/`, `artifacts/`, `coverage/`, 다운로드 폴더·백업, 브라우저 프로필, 검증용 CSV/XLSX/JSON/화면, 로그, `.env`·인증서·개인키와 실제 사용자 자료는 후보에 넣지 않는다. 기존 파일을 정리 목적으로 삭제·이동하지 않았다. `public/examples`와 `tests/fixtures`의 기존 가상 자료는 보존하며 이번 후보에는 새 사용자 자료를 추가하지 않는다.

명시적 후보 경로·내용에서 검사한 일반 인증 정보 패턴은 발견되지 않았다. 값은 출력하지 않았다. Git 무시 규칙만으로 배포 제외를 보장하지 않으며, 실제 산출물 허용 목록·링크·캐시 일치 검사도 통과했다. 정상 이름의 JS/예제 내용에 무엇이든 넣는 행위까지 파일명 검사가 판별하는 것은 아니다.

## 남은 제한과 배포 전 결정

1. **전용 출처 확정:** 호스트·관리 계정·도메인·운영 책임을 결정한다. 저장소 하위 경로와 DB 이름은 다른 앱의 동일 출처 코드에 대한 보안 경계가 아니다. 호스트의 독점 사용·인증서·도메인 갱신·설치 정체성을 실제 확인해야 한다.
2. **구버전 탭 종료:** DB2 이행 뒤 구버전 재저장은 막지만 이미 메모리에 읽힌 표와 JSON 백업은 회수할 수 없다. 새 SW의 제어만으로 실행 중인 JavaScript가 교체되지 않는다. 공용 PC를 떠나기 전에 모든 구버전 탭을 닫고 다운로드 파일을 별도로 처리하도록 안내한다. 구버전 쓰기 탭의 Web Lock도 DB 종료만으로 해제되지 않으므로 그 탭을 닫은 뒤 수정본을 새로고침한다.
3. **이전 한도와 실패 보존:** 지원 스키마라도 새 자원 한도를 넘으면 복원을 거절할 수 있다. 구 주소의 프로젝트와 원본 백업을 보존하고 필요한 사본을 나눠 확인한다. 조용히 잘라 성공 처리하지 않는다.
4. **원격 권한 확인:** 이번에 원격 설정을 변경하지 않았다. 앞선 [Actions 검증](github-actions-security-verification.md)의 main 보호 비활성·rulesets 빈 목록 기록과 미확인 환경 승인/배포 브랜치/기본 토큰 정책을 실제 반영 전에 다시 확인해야 한다. 로컬 YAML 조건만으로 원격 보호 설정이 적용됐다고 판단하지 않는다.
5. **실제 runner와 HTTPS:** 승인된 반영 뒤 실제 토큰 권한, 작업 의존성, 업로드 archive·배포 SHA와 파일 목록을 확인한다. 공개 주소의 HTTPS·하위 경로·JS/CSS/Worker/예제·SW 범위·오프라인 재접속·설치/업데이트·저장/복원을 확인한다. 이번 loopback 검증은 이 단계를 대신하지 않는다.
6. **남은 호환성·성능:** 파일 symlink 시험 1개와 외부 lint 도구 2개, 다른 브라우저·학교 PC·실제 터치·스크린리더 등은 위 범위 밖이다. 기존 500KB 초과 청크 경고도 남아 있다. 앱 자원 제한이 전체 JavaScript 힙이나 모든 학교 PC의 응답 시간을 보증하지는 않는다.

## 주소 이전 순서

**기존 주소 백업 → 새 주소 배포 → 복원·저장 확인 → 새 QR → 기존 주소 안내 정비** 순서를 유지한다.

1. 각 기기의 기존 주소에서 필요한 JSON 백업을 내려받고 보관한다. 구 앱·QR·백업 접근을 먼저 없애지 않는다.
2. 승인된 전용 호스트에 새 주소를 병행 배포한다. 이전을 마치기 전에 기존 주소를 일괄 리디렉션하지 않는다.
3. 새 주소에서 사본 복원, 자료·버전·분석·그래프·해석, 저장·새로고침·재접속·오프라인과 백업 재열기를 확인한다.
4. 확인한 새 HTTPS 주소의 QR을 만든 뒤 배포한다. 이 작업에서는 QR을 바꾸지 않았다.
5. 충분한 이전 기간과 사용자 확인 뒤 기존 주소 안내를 정비한다. 구 프로젝트·캐시를 자동 삭제하지 않는다. 자세한 절차는 [출처 이전 검증](hosting-migration-verification.md)을 따른다.

이번 로컬 검토는 코드와 커밋 후보를 검토할 근거를 제공한다. 전용 호스트 선택·원격 보호 설정 확인·승인된 실제 배포와 HTTPS 검증은 아직 남아 있다.
