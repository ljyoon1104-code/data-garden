@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title 데이터뜰 실행

pushd "%~dp0"
if errorlevel 1 (
    echo [오류] 프로그램 폴더를 열 수 없습니다.
    pause
    exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node

if exist "node_modules\.bin\vite.cmd" goto build
echo [1/3] 처음 실행에 필요한 패키지를 설치합니다. 인터넷 연결이 필요합니다.
call npm.cmd ci
if errorlevel 1 goto failed

:build
echo [2/3] 데이터뜰을 빌드합니다. 잠시 기다려 주세요.
call npm.cmd run build
if errorlevel 1 goto failed

echo [3/3] 로컬 서버를 실행합니다.
echo 실행에 성공하면 http://127.0.0.1:4211/data-garden/ 을 엽니다.
echo 서버를 종료하려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.
echo 새 버전 안내가 나오면 앱에서 저장 후 업데이트를 적용하세요.
echo.

rem The server opens the browser only after binding its own loopback listener.
rem Set DATA_GARDEN_NO_BROWSER=1 to run without opening a browser.
call npm.cmd run serve:production -- 4211 --open
if errorlevel 1 goto failed
goto done

:missing_node
echo [오류] Node.js 또는 npm을 찾을 수 없습니다.
echo Node.js와 npm을 설치한 뒤 이 파일을 다시 실행하세요.
goto failed

:failed
echo.
echo 실행하지 못했습니다. 위 오류 내용을 확인하세요.
popd
pause
exit /b 1

:done
popd
exit /b 0
