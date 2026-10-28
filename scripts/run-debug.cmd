@echo off
rem 临时脚本：清除 ELECTRON_RUN_AS_NODE 后启动调试实例（验证后可删）
cd /d "%~dp0.."
set "ELECTRON_RUN_AS_NODE="
start "RedisDesktop-debug" "node_modules\electron\dist\electron.exe" . --rd-debug