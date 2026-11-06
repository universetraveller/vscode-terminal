@echo off
rem Copyright (c) Microsoft Corporation. All rights reserved.
rem Licensed under the MIT License. See License.txt in the project root for license information.
setlocal
set "TERMINAL_OSS_BINARY=%TERMINAL_OSS_VSCODE%"
if not defined TERMINAL_OSS_BINARY set "TERMINAL_OSS_BINARY=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not exist "%TERMINAL_OSS_BINARY%" set "TERMINAL_OSS_BINARY=%ProgramFiles%\Microsoft VS Code\Code.exe"
if exist "%TERMINAL_OSS_BINARY%\Code.exe" set "TERMINAL_OSS_BINARY=%TERMINAL_OSS_BINARY%\Code.exe"
if not exist "%TERMINAL_OSS_BINARY%" (
	echo VS Code was not found. Set TERMINAL_OSS_VSCODE to Code.exe. 1>&2
	exit /b 1
)
set "NODE_OPTIONS="
set "NODE_REPL_EXTERNAL_MODULE="
set "VSCODE_PORTABLE="
set "ELECTRON_RUN_AS_NODE=1"
"%TERMINAL_OSS_BINARY%" "%~dp0launcher.cjs" %*
