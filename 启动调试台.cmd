@echo off
rem ==========================================================
rem  Yachiyo 骨架调试台 · 本地静态服务器
rem
rem  *** 这个文件必须是 GBK 编码 + CRLF 换行 ***
rem  为什么、以及为什么不用 Cherry 那个 node，
rem  见「启动八千代.cmd」开头的长注释。
rem
rem  这里要跑一个 .cjs（不是 Electron 应用），所以拿
rem  Electron 二进制当 node 用：设 ELECTRON_RUN_AS_NODE=1，
rem  它就会老老实实当 node 跑。
rem ==========================================================
title Yachiyo dev server
cd /d "%~dp0"

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" goto :nofound

echo.
echo   Yachiyo 骨架调试台
echo   ------------------------------------------
echo   正在起本地服务器，两秒后自动开浏览器...
echo.
echo   浏览器里会出现调试台。
echo   「这个黑窗口」关掉 = 服务器停掉。
echo.

rem 开一个新窗口跑服务器；主窗口两秒后开浏览器然后自己退掉。
rem 末尾那个点是故意的：%~dp0 自带结尾反斜杠，直接引起来会被当成转义引号。
set "ELECTRON_RUN_AS_NODE=1"
start "Yachiyo dev server" "%ELECTRON_EXE%" "%~dp0scripts\serve.cjs"
set "ELECTRON_RUN_AS_NODE="

%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
start "" "http://127.0.0.1:7788/rig-debug.html"

echo   好了，去浏览器里调吧。
%SystemRoot%\System32\timeout.exe /t 3 /nobreak >nul
exit /b 0

:nofound
echo.
echo   [起不来] 找不到 electron：
echo     %ELECTRON_EXE%
echo   多半是 node_modules 没装，在这个目录里跑一次 npm install。
echo.
pause
exit /b 1
