/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { basename } from 'path';
import { OS } from '@vscode-source/base/common/platform.js';
import { getSystemShell } from '@vscode-source/base/node/shell.js';
import { findExecutable } from '@vscode-source/base/node/processes.js';
import { TerminalProfile, TerminalSettings } from '../common/terminalApp.js';

/** Discover local shells without loading workspace or extension services. */
export async function getProfiles(settings: TerminalSettings): Promise<TerminalProfile[]> {
	const shell = await getSystemShell(OS, process.env);
	const candidates = new Set([shell]);
	if (process.platform === 'win32') {
		candidates.add('pwsh.exe');
		candidates.add(process.env.ComSpec || 'cmd.exe');
	} else {
		try {
			for (const line of (await fs.readFile('/etc/shells', 'utf8')).split('\n')) {
				if (line.startsWith('/') && !line.endsWith('/false') && !line.endsWith('/nologin')) {
					candidates.add(line.trim());
				}
			}
		} catch { /* The system shell remains available if /etc/shells does not exist. */ }
	}
	const profiles = new Map<string, TerminalProfile>();
	for (const candidate of candidates) {
		const executable = await findExecutable(candidate);
		if (executable) {
			const name = basename(executable).replace(/\.exe$/i, '');
			if (!profiles.has(name)) {
				profiles.set(name, { name, path: executable, args: process.platform === 'darwin' ? ['-l'] : undefined });
			}
		}
	}
	for (const profile of settings.profiles) {
		profiles.set(profile.name, profile);
	}
	return [...profiles.values()];
}
