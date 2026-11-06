/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { githubApi, planUpdate } from '../scripts/upstream-update.mjs';

const repository = 'owner/terminal';
const pin = { repository: 'https://github.com/microsoft/vscode.git', commit: 'a'.repeat(40), version: '1.146.0' };
const target = 'b'.repeat(40);
const branch = `automation/vscode-${target.slice(0, 12)}`;
const context = { repository, pin };

describe('Low-cost upstream synchronization', () => {
	test('unchanged revisions stop after metadata requests', async () => {
		const calls = [];
		const api = async path => {
			calls.push(path);
			if (path.includes('/pulls?')) { return []; }
			if (path.endsWith('/commits/main')) { return { sha: pin.commit }; }
			throw new Error('Unexpected request');
		};
		const plan = await planUpdate({ ...context, api });
		assert.deepStrictEqual({ mode: plan.mode, calls: calls.length }, { mode: 'skip', calls: 2 });
	});

	test('an owned update PR prevents new source downloads and preserves maintainer fixes', async () => {
		let calls = 0;
		const api = async () => {
			assert.equal(++calls, 1);
			return [{ head: { repo: { full_name: repository }, ref: branch }, body: '<!-- terminal-oss-upstream-update -->', html_url: 'https://github.com/owner/terminal/pull/1' }];
		};
		assert.equal((await planUpdate({ ...context, api })).mode, 'skip');
	});

	test('new revisions produce a unique candidate and encode tag refs as data', async () => {
		const calls = [];
		const api = async path => {
			calls.push(path);
			if (path.includes('/pulls?')) { return []; }
			if (path.includes('/commits/')) { return { sha: target }; }
			if (path.includes('/contents/')) { return undefined; }
			throw new Error('Unexpected request');
		};
		const plan = await planUpdate({ ...context, ref: 'refs/tags/1.147.0', api });
		assert.deepStrictEqual({ mode: plan.mode, commit: plan.commit, branch: plan.branch, encoded: calls.includes('/repos/microsoft/vscode/commits/refs%2Ftags%2F1.147.0') }, { mode: 'prepare', commit: target, branch, encoded: true });
	});

	test('closed candidates are not recreated every week', async () => {
		const api = async path => {
			if (path.includes('state=open')) { return []; }
			if (path.includes('/commits/')) { return { sha: target }; }
			if (path.includes('state=all')) { return [{ state: 'closed', html_url: 'https://github.com/owner/terminal/pull/2' }]; }
			throw new Error('Should not fetch source or branch contents');
		};
		assert.equal((await planUpdate({ ...context, api })).mode, 'skip');
	});

	test('retries reuse an already pushed candidate without overwriting its commits', async () => {
		const candidate = { ...pin, commit: target };
		const api = async path => path.includes('/pulls?') ? [] : path.includes('/commits/') ? { sha: target } : { content: Buffer.from(JSON.stringify(candidate)).toString('base64') };
		const plan = await planUpdate({ ...context, api });
		assert.deepStrictEqual({ mode: plan.mode, branch: plan.branch, pin: plan.pin }, { mode: 'reuse', branch, pin: candidate });
		const conflicting = async path => path.includes('/pulls?') ? [] : path.includes('/commits/') ? { sha: target } : { content: Buffer.from(JSON.stringify(pin)).toString('base64') };
		await assert.rejects(planUpdate({ ...context, api: conflicting }), /unexpected source pin/);
	});

	test('API errors omit credentials and successful empty responses are supported', async () => {
		const secret = 'unit-test-token';
		const denied = githubApi(secret, async () => ({ ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) }));
		await assert.rejects(denied('/repos/owner/terminal/pulls'), error => error.message.includes('403') && !error.message.includes(secret));
		const empty = githubApi(secret, async () => ({ ok: true, status: 204 }));
		assert.equal(await empty('/repos/owner/terminal/actions/workflows/terminal.yml/dispatches', { method: 'POST', body: { ref: branch } }), undefined);
	});
});
