/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface TerminalProfile {
	name: string;
	path: string;
	args?: string[];
	env?: Record<string, string | null>;
	cwd?: string;
}

export interface TerminalSettings {
	fontFamily: string;
	fontSize: number;
	scrollback: number;
	theme: 'dark' | 'light' | 'system';
	gpuAcceleration: boolean;
	shellIntegration: boolean;
	confirmOnClose: boolean;
	defaultProfile: string;
	profiles: TerminalProfile[];
}

export interface TerminalConfiguration {
	settings: TerminalSettings;
	profiles: TerminalProfile[];
	platform: string;
	cwd: string;
	profile?: string;
}

export type TerminalAction = 'newTab' | 'splitRight' | 'splitDown' | 'closeTerminal' | 'find' | 'settings' | 'nextTab' | 'previousTab' | 'clear' | 'copy' | 'paste';

export type TerminalRequest =
	| { type: 'create'; id: string; cols: number; rows: number; profile: string; cwd?: string; nonce: string }
	| { type: 'input'; id: string; data: string }
	| { type: 'resize'; id: string; cols: number; rows: number }
	| { type: 'acknowledge'; id: string; count: number }
	| { type: 'close'; id: string };

export type TerminalEvent =
	| { type: 'data'; id: string; data: string }
	| { type: 'ready'; id: string; pid: number; cwd: string; windowsPty?: { backend: 'conpty'; buildNumber: number } }
	| { type: 'title'; id: string; title: string }
	| { type: 'exit'; id: string; code: number }
	| { type: 'error'; id: string; message: string };

export interface TerminalBridge {
	initialize(): Promise<TerminalConfiguration>;
	send(request: TerminalRequest): Promise<void>;
	onEvent(listener: (event: TerminalEvent) => void): () => void;
	onAction(listener: (action: TerminalAction) => void): () => void;
	onConfiguration(listener: (configuration: TerminalConfiguration) => void): () => void;
	saveSettings(settings: TerminalSettings): Promise<TerminalConfiguration>;
	newWindow(): Promise<void>;
	confirmClose(id: string): Promise<boolean>;
	openExternal(url: string): Promise<void>;
	readClipboard(): Promise<string>;
	writeClipboard(text: string): Promise<void>;
}

export const terminalChannels = {
	initialize: 'terminal:initialize',
	port: 'terminal:port',
	action: 'terminal:action',
	configuration: 'terminal:configuration',
	saveSettings: 'terminal:saveSettings',
	newWindow: 'terminal:newWindow',
	confirmClose: 'terminal:confirmClose',
	openExternal: 'terminal:openExternal',
	readClipboard: 'terminal:readClipboard',
	writeClipboard: 'terminal:writeClipboard'
} as const;

/** Reject malformed messages before they reach a native shell process. */
export function isTerminalRequest(value: unknown): value is TerminalRequest {
	if (!value || typeof value !== 'object' || !('type' in value) || !('id' in value) || typeof value.id !== 'string' || !/^[\w-]{1,64}$/.test(value.id)) {
		return false;
	}
	switch (value.type) {
		case 'create':
			return hasDimensions(value) && 'profile' in value && typeof value.profile === 'string' && value.profile.length <= 256 && 'nonce' in value && typeof value.nonce === 'string' && /^[\w-]{1,64}$/.test(value.nonce) && (!('cwd' in value) || value.cwd === undefined || typeof value.cwd === 'string' && value.cwd.length <= 32768);
		case 'resize':
			return hasDimensions(value);
		case 'input':
			return 'data' in value && typeof value.data === 'string' && value.data.length <= 1024 * 1024;
		case 'acknowledge':
			return 'count' in value && Number.isSafeInteger(value.count) && Number(value.count) > 0 && Number(value.count) <= 1024 * 1024;
		case 'close':
			return true;
		default:
			return false;
	}
}

function hasDimensions(value: object): boolean {
	return 'cols' in value && 'rows' in value && Number.isSafeInteger(value.cols) && Number.isSafeInteger(value.rows) && Number(value.cols) >= 2 && Number(value.cols) <= 1000 && Number(value.rows) >= 1 && Number(value.rows) <= 1000;
}
