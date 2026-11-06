#!/bin/sh
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

set -eu
launcher_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$launcher_directory/../Resources/launcher.cjs" ]; then
	launcher_directory=$(CDPATH= cd -- "$launcher_directory/../Resources" && pwd)
fi
code_candidate=${TERMINAL_OSS_VSCODE:-}
next_is_code=false
for argument in "$@"; do
	if [ "$next_is_code" = true ]; then
		code_candidate=$argument
		next_is_code=false
	fi
	case "$argument" in
		--vscode) next_is_code=true ;;
		--vscode=*) code_candidate=${argument#--vscode=} ;;
	esac
done
if [ -z "$code_candidate" ]; then
	if [ "$(uname -s)" = Darwin ]; then
		for candidate in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app" "/Applications/Visual Studio Code - Insiders.app"; do
			if [ -d "$candidate" ]; then
				code_candidate=$candidate
				break
			fi
		done
	else
		code_candidate=$(command -v code || true)
	fi
fi
case "$code_candidate" in
	*.app)
		code_name=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$code_candidate/Contents/Info.plist")
		code_binary=$code_candidate/Contents/MacOS/$code_name
		;;
	*)
		code_binary=$code_candidate
		if [ -n "$code_binary" ] && [ "$(uname -s)" != Darwin ]; then
			code_binary=$(readlink -f -- "$code_binary")
			if [ -x "$(dirname -- "$code_binary")/../code" ]; then
				code_binary=$(dirname -- "$code_binary")/../code
			elif [ -d "$code_binary/resources/app" ]; then
				code_binary=$code_binary/code
			fi
		fi
		;;
esac
if [ ! -x "$code_binary" ] || [ -d "$code_binary" ]; then
	printf '%s\n' 'VS Code was not found. Set TERMINAL_OSS_VSCODE to its application path.' >&2
	exit 1
fi
# Use the installed runtime to run our small launcher. No system Node is needed.
unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE VSCODE_PORTABLE
ELECTRON_RUN_AS_NODE=1 exec "$code_binary" "$launcher_directory/launcher.cjs" "$@"
