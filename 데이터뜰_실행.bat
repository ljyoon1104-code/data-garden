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

set "DATA_GARDEN_URL=http://127.0.0.1:4211/data-garden/"

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

rem Exit codes: 0 = this app is running, 1 = port is free, 2 = another service.
node.exe -e "const http=require('node:http'),fs=require('node:fs');const title=fs.readFileSync('dist/index.html','utf8').match(/<title>[\s\S]*?<\/title>/i)?.[0];setTimeout(()=>process.exit(2),2000);const req=http.get(process.env.DATA_GARDEN_URL,res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>process.exit(res.statusCode===200&&title&&body.includes(title)?0:2));});req.on('error',error=>process.exit(error.code==='ECONNREFUSED'?1:2));" >nul 2>&1
set "DATA_GARDEN_PORT_STATUS=%errorlevel%"
if "%DATA_GARDEN_PORT_STATUS%"=="0" goto already_running
if not "%DATA_GARDEN_PORT_STATUS%"=="1" goto port_busy

echo [3/3] 서버를 실행하고 브라우저를 엽니다.
echo.
echo 실행 주소: %DATA_GARDEN_URL%
echo 서버를 종료하려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.
echo 새 버전 안내가 나오면 앱에서 저장 후 업데이트를 적용하세요.
echo.

rem The browser helper waits until the server responds, then exits.
rem Set DATA_GARDEN_NO_BROWSER=1 to run without opening a browser.
if not defined DATA_GARDEN_NO_BROWSER start "" powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "$taskUrl=$env:DATA_GARDEN_URL; for($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++){try{$taskResponse=Invoke-WebRequest -UseBasicParsing -Uri $taskUrl -TimeoutSec 1; if($taskResponse.StatusCode -eq 200){Start-Process -FilePath $taskUrl; exit 0}}catch{}; Start-Sleep -Milliseconds 500}"
call npm.cmd run serve:production -- 4211
if errorlevel 1 goto failed
goto done

:already_running
echo [3/3] 이미 실행 중인 데이터뜰을 엽니다.
echo 실행 주소: %DATA_GARDEN_URL%
echo 새 버전 안내가 나오면 앱에서 저장 후 업데이트를 적용하세요.
if not defined DATA_GARDEN_NO_BROWSER start "" "%DATA_GARDEN_URL%"
goto done

:missing_node
echo [오류] Node.js 또는 npm을 찾을 수 없습니다.
echo Node.js와 npm을 설치한 뒤 이 파일을 다시 실행하세요.
goto failed

:port_busy
echo [오류] 4211 포트를 다른 프로그램이 사용 중이거나 응답하지 않습니다.
echo 해당 프로그램을 종료한 뒤 다시 실행하세요.
echo 기존에 저장한 자료를 유지하기 위해 실행 주소는 변경하지 않습니다.
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
