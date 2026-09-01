@echo off
rem 快照自动更新（抓取 + 部署），供 Windows 计划任务调用
rem 计划任务示例（工作日 12:00 / 15:15）：
rem   schtasks /Create /F /TN "AShareSnapNoon"  /TR "%~dp0run-snapshot.cmd" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 12:00
rem   schtasks /Create /F /TN "AShareSnapClose" /TR "%~dp0run-snapshot.cmd" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 15:15
rem 删除计划任务：schtasks /Delete /TN "AShareSnapNoon" /F

set NODE=C:\Users\20248\.workbuddy\binaries\node\versions\22.22.2-2\node.exe
set DIR=%~dp0..

if "%GH_TOKEN%"=="" (
  echo [%date% %time%] ERROR: 缺少 GH_TOKEN 环境变量，请先执行: setx GH_TOKEN "ghp_你的token"
  exit /b 1
)

cd /d "%DIR%"
echo [%date% %time%] start snapshot task

"%NODE%" scripts\fetch-snapshot.js
if errorlevel 1 (
  echo [%date% %time%] fetch FAILED
  exit /b 1
)

"%NODE%" scripts\deploy-snapshot.js
if errorlevel 1 (
  echo [%date% %time%] deploy FAILED
  exit /b 1
)

echo [%date% %time%] snapshot task done
