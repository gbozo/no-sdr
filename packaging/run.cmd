@echo off
setlocal
set "DIR=%~dp0"
if not defined CONFIG_PATH set "CONFIG_PATH=%DIR%config\config.yaml"
if not defined STATIC_DIR set "STATIC_DIR=%DIR%static"
"%DIR%serverrs.exe" %*
