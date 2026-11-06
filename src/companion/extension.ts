/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { claimRequest, isCompanionProfile, profileEnvironmentKey, WindowReady, writeState } from './protocol.js';

/** Only this small adapter uses the public API; the installed Code owns rendering and all PTYs. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const profile = process.env[profileEnvironmentKey];
	if (!profile || !isAbsolute(profile) || !(await isCompanionProfile(profile))) {
		return;
	}
	await vscode.commands.executeCommand('setContext', 'terminalOssCompanion', true);
	const initialized = context.workspaceState.get<boolean>('terminalOss.windowInitialized', false);
	const request = initialized ? undefined : await claimRequest(profile);
	const cwd = request?.cwd || homedir();
	context.subscriptions.push(vscode.commands.registerCommand('terminalOss.newTerminal', () => {
		const activeCwd = vscode.window.activeTerminal?.shellIntegration?.cwd;
		vscode.window.createTerminal({ cwd: activeCwd?.scheme === 'file' ? activeCwd : cwd }).show();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('terminalOss.newWindow', async () => {
		await vscode.commands.executeCommand('workbench.action.newWindow');
	}));
	const ready: WindowReady | undefined = request && request.waitForReady !== false ? { id: request.id, vscodeVersion: vscode.version } : undefined;
	try {
		await vscode.commands.executeCommand('workbench.action.closeSidebar');
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		// Terminals belong to the workbench, not this extension's subscriptions. Reloading the
		// extension host must not dispose a user's shell.
		const terminal = vscode.window.activeTerminal || vscode.window.terminals[0] || vscode.window.createTerminal({ cwd });
		terminal.show();
		await context.workspaceState.update('terminalOss.windowInitialized', true);
		if (ready) {
			ready.terminalPid = await terminal.processId;
		}
	} catch (error) {
		if (ready) { ready.error = error instanceof Error ? error.message : String(error); }
		void vscode.window.showErrorMessage(vscode.l10n.t('Terminal OSS could not open a terminal: {0}', String(error)));
	} finally {
		if (ready) {
			await writeState(join(profile, 'companion/ready'), ready.id, ready);
		}
	}
}
