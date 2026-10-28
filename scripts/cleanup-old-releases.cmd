@echo off
rem 清理 release 目录下的历史旧版产物（保留最新版）。
rem 用法：双击运行，或在命令行执行 scripts\cleanup-old-releases.cmd
rem
rem 背景：2026-10-17 清理时，39 个旧版目录里的 app.asar 被 WorkBuddy.exe
rem （Agent 宿主进程）以无 delete-share 方式锁定，在线删除失败。
rem 重启系统（或退出 WorkBuddy）后运行本脚本即可清掉全部残留。

cd /d "%~dp0.."

echo 将删除 release 目录下除 0.0.13-final 外的全部内容...
for /d %%D in ("release\*") do (
  if /i not "%%~nxD"=="0.0.13-final" (
    echo   删除 %%~nxD
    rd /s /q "%%D"
  )
)

rem 逐个文件删掉 release 下的散落文件（如有，目录循环不覆盖文件）
for %%F in ("release\*") do del /f /q "%%F"

echo.
echo 完成。剩余内容：
dir /b release
pause