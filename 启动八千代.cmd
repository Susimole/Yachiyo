@echo off
rem ==========================================================
rem  八千代 · 启动
rem
rem  *** 这个文件必须是 GBK 编码 + CRLF 换行 ***
rem
rem  ① 为什么不能用 UTF-8：
rem     cmd.exe 读批处理是按【文件字节偏移】走的，遇到多字节字符
rem     （一个汉字 3 字节）偏移会跑偏，于是它从半行中间开始执行 ——
rem     症状是「echo 那一行被当成命令」、中文变乱码，而前面几行
rem     看着又是好的。只把 LF 改成 CRLF 能好一大半，但还会漏行。
rem     => GBK（本机 ANSI 码页 936）+ CRLF，而且【不要】写 chcp。
rem
rem  ② 为什么不叫 node：
rem     Cherry 那个 mise shim（...\Toolchain\mise\shims\node.exe）
rem     要能找到 mise.exe 才行，而 mise.exe 在 C:\Users\Susim\.cherrystudio\bin
rem     —— 那个目录【只在 Cherry 自己的进程里】才在 PATH 上。
rem     双击启动是干净环境，shim 找不到 mise，直接报：
rem         mise-shim: failed to execute mise: program not found
rem     而且 PATH 里 shim 排在系统 node 前面，所以连 `node` 这个词
rem     在他机器上都是废的。
rem     => 干脆不碰 node，直接用工程里自带的 electron。
rem
rem  ③ 那两行 set "X=" 是把变量【删掉】：
rem     Electron 见到 ELECTRON_RUN_AS_NODE 会把自己当成 node 用，
rem     主进程第一行就炸。清掉它，从哪启动都稳。
rem ==========================================================
title 八千代
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" goto :nofound

echo.
echo   八千代 -- 启动中...
echo   ------------------------------------------
echo   她会从屏幕右下角出来。
echo.
echo   左键点她 = 站住，响一声
echo   双击她   = 弹个小输入框，问完就收，回话冒在气泡上
echo   右键点她 = 菜单（聊天 / 设置 / API 接入）
echo   拖她     = 只能在任务栏那条线上左右挪
echo.
echo   「这个黑窗口」关掉 = 她也跟着关掉。
echo   出问题的时候，报错会打在这个窗口里。
echo.

rem 末尾这个点是故意的：%~dp0 自带结尾的反斜杠，
rem 写成 "%~dp0" 的话 Windows 的 argv 解析会把 \" 当成转义引号，路径就废了。
"%ELECTRON_EXE%" "%~dp0."

echo.
echo   八千代已经关掉了。
pause
exit /b 0

:nofound
echo.
echo   [起不来] 找不到 electron：
echo     %ELECTRON_EXE%
echo.
echo   多半是 node_modules 没装。在这个目录里跑一次 npm install：
echo     cd /d "%~dp0"
echo     npm install
echo.
echo   （npm 在 C:\Program Files\nodejs\ 里，那个是好的，
echo     别用 Cherry 托管的那份 node。）
echo.
pause
exit /b 1
