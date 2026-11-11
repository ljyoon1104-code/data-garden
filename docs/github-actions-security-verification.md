# GitHub Actions 배포 권한 검증

검증일: 2026-11-11. 이번 변경은 워크플로와 관련 문서의 로컬 수정이다. 커밋·푸시·워크플로 실행·배포·원격 권한 설정 변경은 하지 않았다.

## 확인한 원격 상태

- [최근 실행 39378985696](https://github.com/ljyoon1104-code/data-garden/actions/runs/39378985696)은 2026-10-20의 main push, SHA `4230593079849ed03d540ae602d6e72637efc15c`이며 성공했다. 최근 실행 목록과 작업·단계도 읽기 전용으로 확인했다. 이번 로컬 수정의 실행 결과가 아니다.
- 기존 단일 deploy 작업의 실제 로그에서 `Contents: read`, `Metadata: read`, `Pages: write`를 확인했다. OIDC 쓰기는 기존 YAML의 공통 권한에 선언돼 있다. 원시 토큰이나 비밀 정보 값은 출력하거나 문서에 기록하지 않았다.
- [main 브랜치 API](https://api.github.com/repos/ljyoon1104-code/data-garden/branches/main)는 `protected: false`, 보호 활성화 false를 반환했다. [rulesets API](https://api.github.com/repos/ljyoon1104-code/data-garden/rulesets)는 빈 목록을 반환했다. 보호 규칙을 추가하거나 변경하지 않았다.
- 기존 실행의 artifact API는 빈 목록을 반환했다. 과거 업로드 ZIP·tar 내부의 직접 재검사는 할 수 없었다.
- 저장소의 기본 토큰 권한, 환경 github-pages의 승인자·배포 브랜치 제한, 조직/계정의 액션 허용 정책과 OIDC 관련 관리 설정은 확인하지 못했다. 연결 도구가 제공하는 읽기 범위와 YAML만으로 해당 설정이 없다고 판단하지 않았다.

## 발견 사항과 최소 수정

| 항목 | 위험·발생 조건과 기존 보호책 | 로컬 수정 |
| --- | --- | --- |
| 빌드에 배포 권한 적용 | 기존 공통 Pages·OIDC 권한이 npm ci·테스트·빌드에도 적용됐다. npm 코드가 침해될 경우 배포 권한을 악용할 여지가 있다. 기존 액션 SHA 고정과 main push 제한은 유지돼 있었다. | 기본 권한은 빈 맵, build는 contents: read만 사용한다. deploy는 needs: build로 분리하고 pages: write·id-token: write만 부여한다. |
| 수동 실행 분기 | push는 main만 허용했지만 수동 실행의 선택 ref에 대한 조건이 없었다. 기존 PR·pull_request_target 트리거는 없었다. | build/deploy 모두 저장소·refs/heads/main·push/workflow_dispatch를 확인한다. 실패·취소·생략된 빌드에서는 배포하지 않는다. |
| checkout 인증 유지 | 기존 checkout은 기본 인증 유지 동작을 사용했다. YAML에 명시적인 secrets 참조나 비밀 환경변수는 없었다. 모든 저장소 비밀이 npm에 노출된다고 판단하지 않는다. | persist-credentials: false. 읽기용 작업 토큰 자체가 없어지는 것은 아니다. 배포 작업에는 checkout이나 npm·저장소 스크립트 실행을 넣지 않는다. |
| 업로드 경계 | path: dist는 이미 고정돼 있었다. 하지만 Git 제외 규칙은 artifact 업로드를 제어하지 않는다. 기존 검사에 가상 백업 파일을 추가해도 성공하는 것을 로컬에서 재현했다. 고정 upload 액션도 tar의 링크 역참조 옵션을 사용한다. | 기존 검사 뒤, 업로드 전에 루트·내부 링크·하드링크·비정규 파일·허용 목록 밖 경로를 거절한다. 필요한 예제·라이선스·해시 자산과 사전 캐시 전체 일치를 검사한다. |

배포 작업의 configure-pages는 enablement: false를 명시해 기존 Pages 메타데이터만 사용하며 사이트를 자동 생성하지 않는다. 새 PR 트리거나 사용자 입력을 shell에 삽입하는 경로는 추가하지 않았다. npm 캐시를 사용하는 작업도 빌드뿐이다.

main 조건은 해당 워크플로의 실행 조건이며, 워크플로를 수정할 권한을 가진 사람에 대한 독립 보안 경계는 아니다. 브랜치 보호와 환경 승인·배포 브랜치 제한은 별도로 검토해야 한다. 파일 허용 목록도 정상 이름의 JS나 예제에 악성 내용·실제 자료를 넣는 것까지 판별하지는 못한다.

## 액션의 공식 릴리스·SHA 대조

SHA는 바꾸지 않고 릴리스 주석을 정확하게 보완했다.

| 공식 액션·릴리스 | 고정 SHA |
| --- | --- |
| [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | `820762786026740c76f36085b0efc47a31fe5020` |
| [actions/configure-pages v6.0.0](https://github.com/actions/configure-pages/releases/tag/v6.0.0) | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` |
| [actions/upload-pages-artifact v5.0.0](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0) | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
| [actions/deploy-pages v5.0.1](https://github.com/actions/deploy-pages/releases/tag/v5.0.1) | `368f82528645a54fb793d4d04e342629a3f51346` |

근거는 [Pages 공식 문서](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [권한 문법](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions), [수동 실행 문서](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)와 각 고정 버전의 소스로 확인했다.

## 로컬 검증

- actionlint 1.7.12의 YAML·액션·표현식·작업 의존성 검사: 종료 코드 0. 공식 릴리스의 Windows ZIP과 체크섬을 대조하고 임시 폴더에서만 사용했다. ShellCheck·Pyflakes는 설치돼 있지 않아 해당 외부 검사만 비활성화했다.
- 임시 YAML 1.2 파서 yaml 2.9.1에서 중복 키 없이 파싱했다. 권한, needs, 검사 순서, 고정 SHA, 인증 유지, artifact 경로 등 구조 조건 24개를 확인했다.
- main push·수동 실행, 다른 브랜치·태그, PR·workflow_run, 포크, 빌드 실패·취소·생략을 포함한 문맥 14개가 기대 결과와 일치했다.
- 기존 캐시 검사 다음에 정확한 인라인 검사를 실행하는 실제 순서로 산출물 사례 13개가 모두 기대대로 통과했다. 정상 산출물은 허용하고, 가상 JSON·소스·캐시·백업·숨김 파일, 정션, 링크인 루트, 하드링크, 자산 누락, 사전 캐시·manifest 범위 불일치는 거절했다. 원본 dist는 변경하지 않았다.
- 기존 검증 자료 26개 일치와 git diff --check를 확인했다. 프로젝트 의존성은 추가·변경하지 않았다. 앱 기능을 바꾸지 않아 전체 앱 테스트나 빌드는 이번에 다시 실행하지 않았다.

임시 검사 도구·기록은 Git에서 제외되는 tmp/actionlint-1.7.12-150a9fe2e43f43ecaf7f809693922d9f 및 tmp/workflow-artifact-audit-AGcdEq에 있다. 실제 Ubuntu runner의 토큰 발급·artifact 업로드·환경 승인·Pages 배포는 로컬 검사로 대신할 수 없다.

## 향후 승인된 반영 후 확인

1. 현재 보안 수정·라이선스 파일과 워크플로를 함께 검토해 승인된 커밋으로 반영한다. 새 허용 목록은 현재 수정본의 pako·saxes·xmlchars 라이선스도 요구하므로 워크플로만 이전 코드에 반영하면 배포를 차단한다.
2. main 실행에서 build에 Pages·OIDC 권한이 없는지 실제 로그·토큰 발급 조건을 확인한다. 토큰 값은 출력하지 않는다.
3. build 성공 뒤에만 deploy가 시작되고, 산출물과 배포 SHA가 승인된 커밋에 해당하는지 확인한다.
4. 배포 환경의 승인·분기 제한과 저장소 보호 정책은 별도 승인 범위에서 확인한다. 로컬 조건문으로 원격 보호 설정까지 적용됐다고 보고하지 않는다.
5. 업로드된 실제 archive의 경로·링크·파일 목록과 공개 앱 실행을 확인한다. 이번 작업에서는 어떠한 원격 실행도 시작하지 않았다.
