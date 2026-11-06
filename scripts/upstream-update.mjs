/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './paths.mjs';

const branchPrefix = 'automation/vscode-';
const marker = '<!-- terminal-oss-upstream-update -->';

/** Keep API failures useful without logging request headers or credentials. */
export function githubApi(token, fetchRequest = fetch) {
	return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
		const response = await fetchRequest(`https://api.github.com${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'terminal-oss-upstream-sync', 'X-GitHub-Api-Version': '2026-03-10' },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000)
		});
		if (allowMissing && response.status === 404) { return undefined; }
		if (response.status === 204) { return undefined; }
		const result = await response.json();
		if (!response.ok) { throw new Error(`GitHub ${method} ${path.split('?')[0]} failed (${response.status}): ${result.message || 'Request failed'}`); }
		return result;
	};
}

/** Resolve a public GitHub source repository without forwarding the token to another host. */
function sourceRepository(pin) {
	const url = new URL(pin.repository);
	const repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
	if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
		throw new Error('Automatic updates require a GitHub HTTPS submodule URL.');
	}
	return repository;
}

/** Poll metadata before initializing VS Code or installing any packages. Only one update PR stays open. */
export async function planUpdate({ repository, pin, ref = 'main', api }) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(pin.commit) || !ref || /[\r\n\0]/.test(ref)) {
		throw new Error('Invalid repository, source pin, or upstream ref.');
	}
	for (let page = 1; ; page++) {
		const open = await api(`/repos/${repository}/pulls?state=open&per_page=100&page=${page}`);
		const pending = open.find(pr => pr.head?.repo?.full_name === repository && pr.head.ref.startsWith(branchPrefix) && pr.body?.includes(marker));
		if (pending) { return { mode: 'skip', message: `An upstream update already awaits review: ${pending.html_url}` }; }
		if (open.length < 100) { break; }
	}
	const target = await api(`/repos/${sourceRepository(pin)}/commits/${encodeURIComponent(ref)}`);
	if (!/^[a-f0-9]{40}$/.test(target.sha)) { throw new Error('GitHub returned an invalid upstream commit.'); }
	if (target.sha === pin.commit) { return { mode: 'skip', message: `Already pinned to ${target.sha}.` }; }
	const branch = `${branchPrefix}${target.sha.slice(0, 12)}`;
	const head = encodeURIComponent(`${repository.split('/')[0]}:${branch}`);
	const offered = await api(`/repos/${repository}/pulls?state=all&head=${head}&per_page=100`);
	if (offered.length) { return { mode: 'skip', message: `This revision was already offered: ${offered[0].html_url}` }; }
	// A previous run might have pushed its branch before failing to create the PR. Reuse it
	// without replacing any commits a maintainer may have added there.
	const contents = await api(`/repos/${repository}/contents/upstream.json?ref=${encodeURIComponent(branch)}`, { allowMissing: true });
	if (contents) {
		const existing = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
		if (existing.commit !== target.sha || existing.repository !== pin.repository) { throw new Error('The existing update branch has an unexpected source pin.'); }
		return { mode: 'reuse', commit: target.sha, branch, pin: existing, message: `Retrying the PR for existing branch ${branch}.` };
	}
	return { mode: 'prepare', commit: target.sha, branch, message: `Preparing VS Code revision ${target.sha}.` };
}

/** Run Git with argument arrays. Upstream refs and API strings never become shell commands. */
function git(args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

/** Require a branch derived from the selected SHA before any checkout, commit, or push. */
function selectedUpdate() {
	const commit = process.env.UPSTREAM_COMMIT || '';
	const branch = process.env.UPSTREAM_BRANCH || '';
	if (!/^[a-f0-9]{40}$/.test(commit) || branch !== `${branchPrefix}${commit.slice(0, 12)}`) { throw new Error('Invalid selected upstream update.'); }
	return { commit, branch };
}

async function main() {
	const command = process.argv[2];
	if (command === 'prepare') {
		const { commit } = selectedUpdate();
		git(['submodule', 'update', '--init', '--depth', '1', 'vendor/vscode']);
		const { verifyUpstream } = await import('./upstream.mjs');
		await verifyUpstream();
		git(['-C', 'vendor/vscode', 'fetch', '--depth', '1', '--no-tags', 'origin', commit]);
		git(['-C', 'vendor/vscode', 'checkout', '--detach', 'FETCH_HEAD']);
		console.log(`Selected ${commit}. Install vendor/vscode/.nvmrc's Node before synchronizing dependencies.`);
		return;
	}
	const repository = process.env.GITHUB_REPOSITORY || '';
	const token = process.env.GH_TOKEN;
	if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) { throw new Error('Run this helper in the Upstream Sync workflow with its repository-scoped token.'); }
	const api = githubApi(token);
	const previous = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
	if (command === 'detect') {
		const plan = await planUpdate({ repository, pin: previous, ref: process.env.UPSTREAM_REF || 'main', api });
		console.log(plan.message);
		if (process.env.GITHUB_OUTPUT) {
			await appendFile(process.env.GITHUB_OUTPUT, `mode=${plan.mode}\ncommit=${plan.commit || ''}\nbranch=${plan.branch || ''}\n`);
		}
		return;
	}
	if (command !== 'publish') { throw new Error('Expected detect, prepare, or publish.'); }
	const { commit, branch } = selectedUpdate();
	let pin;
	if (process.env.UPSTREAM_MODE === 'prepare') {
		const { verifyUpstream } = await import('./upstream.mjs');
		pin = await verifyUpstream();
		if (pin.commit !== commit) { throw new Error('The synchronized source does not match the selected update.'); }
		git(['add', '--', 'vendor/vscode', 'upstream.json', 'package.json', 'pnpm-lock.yaml', '.nvmrc']);
		git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `Update VS Code terminal source to ${pin.version} (${commit.slice(0, 8)})`]);
		// The branch is unique to this revision. Never overwrite main or a previous update branch.
		git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
	} else if (process.env.UPSTREAM_MODE === 'reuse') {
		const contents = await api(`/repos/${repository}/contents/upstream.json?ref=${encodeURIComponent(branch)}`);
		pin = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
		if (pin.commit !== commit || pin.repository !== previous.repository) { throw new Error('The retry branch has an unexpected source pin.'); }
	} else { throw new Error('Invalid update publication mode.'); }
	const base = process.env.UPSTREAM_BASE || 'main';
	const body = [
		`Updates the VS Code terminal source to **${pin.version}**, revision [${commit.slice(0, 12)}](https://github.com/${sourceRepository(pin)}/commit/${commit}).`,
		'Synchronizes the submodule pin, Electron/xterm/node-pty and shared tool versions, Node version, and the application dependency lockfile.',
		'The Terminal workflow is dispatched for focused Linux validation. Run it with **full platform validation** before release to exercise the macOS, Windows, and Linux GUI/package checks. Upstream API changes may need adapter fixes; this PR is not merged automatically.',
		marker
	].join('\n\n');
	// Dispatch before creating the PR. If dispatch fails, the next run can retry the
	// existing branch instead of finding an open PR with no validation requested.
	const dispatched = await api(`/repos/${repository}/actions/workflows/terminal.yml/dispatches`, { method: 'POST', body: { ref: branch, inputs: { full: false } } });
	const head = encodeURIComponent(`${repository.split('/')[0]}:${branch}`);
	const existing = await api(`/repos/${repository}/pulls?state=open&head=${head}`);
	const pr = existing[0] || await api(`/repos/${repository}/pulls`, { method: 'POST', body: { title: `Update VS Code terminal source to ${pin.version} (${commit.slice(0, 8)})`, head: branch, base, body, maintainer_can_modify: true } });
	console.log(`Upstream update: ${pr.html_url}`);
	if (dispatched?.html_url) { console.log(`Focused checks: ${dispatched.html_url}`); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
