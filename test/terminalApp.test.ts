/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { paneIds, PaneLayout, removePane, splitPane } from '../src/common/layout.js';
import { defaultSettings, parseSettings } from '../src/common/settings.js';
import { isTerminalRequest } from '../src/common/terminalApp.js';

describe('Standalone terminal boundaries', () => {
	test('accepts valid terminal messages and rejects malformed native operations', () => {
		const messages = [
			{ type: 'create', id: 'session-1', profile: 'zsh', nonce: 'nonce-1', cols: 80, rows: 24 },
			{ type: 'input', id: 'session-1', data: '\x03你好\r' },
			{ type: 'resize', id: 'session-1', cols: 120, rows: 40 },
			{ type: 'acknowledge', id: 'session-1', count: 4096 },
			{ type: 'close', id: 'session-1' },
			{ type: 'create', id: 'session-1', profile: 'zsh', nonce: '', cols: 80, rows: 24 },
			{ type: 'resize', id: 'session-1', cols: Infinity, rows: 24 },
			{ type: 'resize', id: 'session-1', cols: 80, rows: -1 },
			{ type: 'acknowledge', id: 'session-1', count: -100 },
			{ type: 'acknowledge', id: 'session-1', count: Number.MAX_SAFE_INTEGER },
			{ type: 'input', id: 'session-1', data: 'x'.repeat(1024 * 1024 + 1) },
			{ type: 'close', id: '../another-window' },
			{ type: 'execute', id: 'session-1', command: 'unexpected' },
			null
		];
		assert.deepStrictEqual(messages.map(isTerminalRequest), [true, true, true, true, true, false, false, false, false, false, false, false, false, false]);
	});

	test('bounds persistent settings and preserves explicit shell environments', () => {
		const settings = parseSettings({ fontSize: 16, scrollback: 0, unrelated: true, profiles: [{ name: 'Clean Shell', path: '/bin/zsh', args: ['-l'], env: { REMOVE: null, CUSTOM: 'value' } }] });
		assert.deepStrictEqual(settings, { ...defaultSettings, fontSize: 16, scrollback: 0, profiles: [{ name: 'Clean Shell', path: '/bin/zsh', args: ['-l'], env: { REMOVE: null, CUSTOM: 'value' }, cwd: undefined }] });
	});

	test('rejects invalid profiles and settings before persistence or shell startup', () => {
		const invalid = [
			{ scrollback: 1000000 },
			{ fontSize: '14' },
			{ gpuAcceleration: 'true' },
			{ theme: 'unknown' },
			{ profiles: [{ name: 'bad', path: '/bin/zsh\0' }] },
			{ profiles: [{ name: 'bad', path: '/bin/zsh', env: { BAD: 42 } }] },
			{ profiles: [{ name: 'bad', path: '/bin/zsh', env: { 'BAD=KEY': 'value' } }] },
			{ profiles: [{ name: 'duplicate', path: '/bin/zsh' }, { name: 'duplicate', path: '/bin/bash' }] }
		];
		assert.deepStrictEqual(invalid.map(value => {
			try {
				parseSettings(value);
				return false;
			} catch {
				return true;
			}
		}), invalid.map(() => true));
	});
});

describe('Standalone terminal split layout', () => {
	test('nested splits collapse without replacing surviving terminal identities', () => {
		const original: PaneLayout = { type: 'terminal', id: 'first' };
		const split = splitPane(splitPane(original, 'first', 'second', 'horizontal'), 'second', 'third', 'vertical');
		const collapsed = removePane(split, 'second')!;
		assert.deepStrictEqual({ original, ids: paneIds(split), collapsed, last: removePane(removePane(collapsed, 'first')!, 'third') }, {
			original: { type: 'terminal', id: 'first' },
			ids: ['first', 'second', 'third'],
			collapsed: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'terminal', id: 'first' }, second: { type: 'terminal', id: 'third' } },
			last: undefined
		});
	});
});
