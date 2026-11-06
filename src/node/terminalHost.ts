/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { MessagePortMain } from 'electron';
import { homedir } from 'os';
import { Disposable, DisposableStore, toDisposable } from '@vscode-source/base/common/lifecycle.js';
import { NullLogService } from '@vscode-source/platform/log/common/log.js';
import type { IProductService } from '@vscode-source/platform/product/common/productService.js';
import upstreamProduct from '@vscode-source/platform/product/common/product.js';
import { ProcessPropertyType } from '@vscode-source/platform/terminal/common/terminal.js';
import { TerminalDataBufferer } from '@vscode-source/platform/terminal/common/terminalDataBuffering.js';
import { TerminalProcess } from '@vscode-source/platform/terminal/node/terminalProcess.js';
import { isTerminalRequest, TerminalConfiguration, TerminalEvent, TerminalRequest } from '../common/terminalApp.js';
import { localize } from '@vscode-source/nls.js';
import { VSBuffer } from '@vscode-source/base/common/buffer.js';

interface ConnectionMessage {
	type: 'connect';
	windowId: number;
	configuration: TerminalConfiguration;
	nativeWindowHandle?: Uint8Array;
}

interface Session {
	process: TerminalProcess;
	disposables: DisposableStore;
	bufferId: number;
	starting: boolean;
	closed: boolean;
	finalized: boolean;
	unacknowledged: number;
}

const product: IProductService = {
	...upstreamProduct,
	_serviceBrand: undefined,
	version: '0.1.0',
	nameShort: 'Terminal OSS',
	nameLong: 'Terminal OSS',
	applicationName: 'terminal-oss',
	dataFolderName: '.terminal-oss',
	sharedDataFolderName: '.terminal-oss-shared',
	serverApplicationName: 'terminal-oss-server',
	urlProtocol: 'terminal-oss'
};

/** One connection owns its sessions; ids from another window never grant access. */
class TerminalHostConnection extends Disposable {
	private readonly sessions = new Map<string, Session>();
	private bufferId = 0;
	private readonly logService = this._register(new NullLogService());
	private readonly bufferer = this._register(new TerminalDataBufferer((bufferId, data) => {
		for (const [id, session] of this.sessions) {
			if (session.bufferId === bufferId && !session.closed) {
				session.unacknowledged += data.length;
				this.send({ type: 'data', id, data });
				return;
			}
		}
	}));

	constructor(
		readonly windowId: number,
		private readonly port: MessagePortMain,
		public configuration: TerminalConfiguration,
		private readonly nativeWindowHandle?: Uint8Array
	) {
		super();
		port.on('message', event => {
			if (isTerminalRequest(event.data)) {
				this.handleRequest(event.data).catch(error => this.send({ type: 'error', id: event.data.id, message: error instanceof Error ? error.message : String(error) }));
			}
		});
		port.on('close', () => this.dispose());
		this._register(toDisposable(() => {
			for (const [id, session] of this.sessions) {
				this.closeSession(id, session);
			}
			port.removeAllListeners();
			port.close();
		}));
		port.start();
	}

	private send(event: TerminalEvent): void {
		if (!this._store.isDisposed) {
			this.port.postMessage(event);
		}
	}

	private async handleRequest(request: TerminalRequest): Promise<void> {
		if (request.type === 'create') {
			await this.createSession(request);
			return;
		}
		const session = this.sessions.get(request.id);
		if (!session || session.closed) {
			return;
		}
		switch (request.type) {
			case 'input': session.process.input(request.data); break;
			case 'resize': session.process.resize(request.cols, request.rows); break;
			case 'acknowledge': {
				const count = Math.min(request.count, session.unacknowledged);
				session.unacknowledged -= count;
				session.process.acknowledgeDataEvent(count);
				break;
			}
			case 'close': this.closeSession(request.id, session); break;
		}
	}

	private async createSession(request: Extract<TerminalRequest, { type: 'create' }>): Promise<void> {
		if (this.sessions.has(request.id) || this.sessions.size >= 256 || this._store.isDisposed) {
			throw new Error(localize('terminalApp.sessionLimit', "Cannot create another terminal in this window."));
		}
		const profile = this.configuration.profiles.find(profile => profile.name === request.profile);
		if (!profile) {
			throw new Error(localize('terminalApp.missingProfile', "Shell profile '{0}' is unavailable.", request.profile));
		}
		const env: NodeJS.ProcessEnv = { ...process.env, TERM_PROGRAM: 'terminal-oss', TERM_PROGRAM_VERSION: product.version, COLORTERM: 'truecolor' };
		// Do not inherit a parent VS Code instance's CLI or extension integration endpoints.
		for (const key of Object.keys(env)) {
			if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_')) {
				delete env[key];
			}
		}
		for (const [key, value] of Object.entries(profile.env || {})) {
			if (value === null) {
				delete env[key];
			} else {
				env[key] = value;
			}
		}
		const cwd = request.cwd || profile.cwd || this.configuration.cwd || homedir();
		const disposables = new DisposableStore();
		const terminal = disposables.add(new TerminalProcess({ executable: profile.path, args: profile.args?.slice(), cwd }, cwd, request.cols, request.rows, env, env, {
			shellIntegration: { enabled: this.configuration.settings.shellIntegration, suggestEnabled: false, nonce: request.nonce },
			windowsUseConptyDll: true,
			environmentVariableCollections: undefined,
			workspaceFolder: undefined,
			isScreenReaderOptimized: false
		}, this.logService, product));
		if (this.nativeWindowHandle) {
			terminal.setParentWindow(VSBuffer.wrap(this.nativeWindowHandle));
		}
		const session: Session = { process: terminal, disposables, bufferId: ++this.bufferId, starting: true, closed: false, finalized: false, unacknowledged: 0 };
		this.sessions.set(request.id, session);
		disposables.add(this.bufferer.startBuffering(session.bufferId, terminal.onProcessData));
		disposables.add(terminal.onProcessReady(event => {
			this.send({ type: 'ready', id: request.id, pid: event.pid, cwd: event.cwd, windowsPty: event.windowsPty });
			this.reportSession(request.id, terminal.hasChildProcesses);
		}));
		disposables.add(terminal.onDidChangeProperty(event => {
			if (event.type === ProcessPropertyType.Title && typeof event.value === 'string') {
				this.send({ type: 'title', id: request.id, title: event.value });
			} else if (event.type === ProcessPropertyType.HasChildProcesses) {
				this.reportSession(request.id, event.value === true);
			}
		}));
		disposables.add(terminal.onProcessExit(code => {
			this.bufferer.flushBuffer(session.bufferId);
			this.send({ type: 'exit', id: request.id, code });
			this.finalizeSession(request.id, session);
		}));
		try {
			const result = await terminal.start();
			if (result && 'message' in result) {
				throw new Error(result.message);
			}
		} catch (error) {
			session.closed = true;
			throw error;
		} finally {
			session.starting = false;
			if (session.closed || this._store.isDisposed) {
				this.closeSession(request.id, session);
			}
		}
	}

	private reportSession(id: string, busy: boolean): void {
		process.parentPort.postMessage({ type: 'session', windowId: this.windowId, id, busy });
	}

	private closeSession(id: string, session: Session): void {
		if (session.finalized) {
			return;
		}
		session.closed = true;
		// A close can race asynchronous shell validation. Finish startup before disposing its owner.
		if (session.starting) {
			return;
		}
		this.sessions.delete(id);
		this.bufferer.stopBuffering(session.bufferId);
		// shutdown starts an asynchronous kill. Retain its owner until onProcessExit so disposal
		// cannot cancel the kill before it has reached the native PTY.
		session.process.shutdown(true);
	}

	private finalizeSession(id: string, session: Session): void {
		if (session.finalized) {
			return;
		}
		session.finalized = true;
		session.closed = true;
		this.sessions.delete(id);
		this.bufferer.stopBuffering(session.bufferId);
		session.disposables.dispose();
		process.parentPort.postMessage({ type: 'closed', windowId: this.windowId, id });
	}
}

const connections = new Map<number, TerminalHostConnection>();
process.parentPort.on('message', event => {
	const message = event.data as ConnectionMessage | { type: 'disconnect'; windowId: number } | { type: 'configuration'; configuration: TerminalConfiguration };
	if (message.type === 'connect' && event.ports[0]) {
		connections.get(message.windowId)?.dispose();
		connections.set(message.windowId, new TerminalHostConnection(message.windowId, event.ports[0], message.configuration, message.nativeWindowHandle));
	} else if (message.type === 'disconnect') {
		connections.get(message.windowId)?.dispose();
		connections.delete(message.windowId);
	} else if (message.type === 'configuration') {
		for (const connection of connections.values()) {
			connection.configuration = message.configuration;
		}
	}
});
