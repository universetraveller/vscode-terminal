/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { buildCompanion, companionOutput } from './companion.mjs';

const execute = promisify(execFile);
if (process.platform === 'win32') {
	throw new Error('The installed VS Code GUI smoke harness currently supports macOS and Linux.');
}
await buildCompanion();
const profile = await mkdtemp(join(companionOutput, 'smoke-'));
const editorProfile = await mkdtemp(join(companionOutput, 'editor-'));
const evidence = join(companionOutput, '../evidence');
await mkdir(evidence, { recursive: true });
let browser;
let editorBrowser;
const testPids = new Set();
const terminalPids = new Set();
const packaged = process.argv.includes('--packaged');
const bootstrap = packaged && process.platform === 'darwin'
	? join(companionOutput, 'Terminal OSS (VS Code).app/Contents/MacOS/terminal-oss')
	: join(companionOutput, 'terminal-oss');
let codeExecutable;

/** Allocate a different local debugging port for each application instance. */
async function freePort() {
	const server = createServer();
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function until(action, message, timeout = 20_000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const result = await action();
		if (result) { return result; }
		await setTimeout(100);
	}
	throw new Error(message);
}

function alive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Only identify the application main process with this harness's exact private profile. */
async function mainPid(executable, userData) {
	const { stdout } = await execute('ps', ['-axo', 'pid=,command=']);
	const line = stdout.split('\n').find(line => {
		const command = line.trim().replace(/^\d+\s+/, '');
		return command.startsWith(`${executable} `) && command.includes(`--user-data-dir ${userData}`);
	});
	if (!line) { throw new Error(`Could not find isolated VS Code process: ${userData}`); }
	const pid = Number(line.trim().match(/^\d+/)[0]);
	testPids.add(pid);
	return pid;
}

async function connect(port) {
	return until(async () => {
		try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return undefined; }
	}, 'VS Code debugging endpoint did not open.');
}

function windows(connection) {
	return connection.contexts().flatMap(context => context.pages()).filter(page => page.url().includes('workbench'));
}

async function launch(port, cwd) {
	const explicit = process.env.TERMINAL_OSS_VSCODE ? ['--vscode', process.env.TERMINAL_OSS_VSCODE] : [];
	// Test the end-user bootstrap too: it runs using VS Code's Node, not this harness's Node.
	const { stdout } = await execute(bootstrap, ['--json', '--user-data-dir', profile, '--cwd', cwd, '--cdp-port', String(port), ...explicit], { timeout: 60_000 });
	const ready = JSON.parse(stdout.trim().split('\n').findLast(line => line.startsWith('{')));
	assert.ok(ready.terminalPid > 0, `No shell PID was acknowledged: ${stdout}`);
	terminalPids.add(ready.terminalPid);
	return ready;
}

function quoteShell(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function runShell(page, command) {
	await page.bringToFront();
	const input = page.locator('.xterm-helper-textarea').last();
	await input.focus();
	// Key events keep exercising xterm input after a Command Palette focus transition.
	await page.keyboard.type(command);
	await page.keyboard.press('Enter');
}

async function command(page, title) {
	await page.bringToFront();
	await page.locator('.monaco-workbench').waitFor({ state: 'visible' });
	const input = page.locator('.quick-input-widget input');
	await until(async () => {
		if (await input.isVisible()) { return true; }
		await page.keyboard.press('F1');
		await setTimeout(100);
		return input.isVisible();
	}, `The Command Palette did not open for ${title}.`);
	await input.fill(`>${title}`);
	const result = page.locator('.quick-input-list .monaco-list-row').filter({ hasText: title }).first();
	await result.waitFor({ state: 'visible' });
	await result.click();
	if (!page.isClosed()) {
		await input.waitFor({ state: 'hidden' }).catch(error => { if (!page.isClosed()) { throw error; } });
	}
}

try {
	const discovery = await execute(bootstrap, ['--dry-run']);
	codeExecutable = JSON.parse(discovery.stdout).executable;
	const port = await freePort();
	const started = Date.now();
	const first = await launch(port, profile);
	const startupMs = Date.now() - started;
	const companionPid = await mainPid(first.executable, profile);
	browser = await connect(port);
	const page = await until(async () => windows(browser)[0], 'No companion workbench window.');
	await page.screenshot({ path: join(evidence, 'companion-initial.png') });
	console.log(`Initial screenshot: ${join(evidence, 'companion-initial.png')}`);
	if (process.argv.includes('--inspect-ui')) {
		console.log('Inspect the initial screenshot, then press Enter to continue.');
		await new Promise(resolve => process.stdin.once('data', resolve));
		process.stdin.pause();
	}
	await page.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' });
	const settingsPath = join(profile, 'User/settings.json');
	const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
	await writeFile(settingsPath, JSON.stringify({ ...settings, 'terminal.integrated.confirmOnExit': 'never', 'files.simpleDialog.enable': true }));
	const cwdFile = join(profile, 'cwd-result');
	await runShell(page, `printf '%s' "$PWD" > ${quoteShell(cwdFile)}`);
	await until(async () => (await readFile(cwdFile, 'utf8').catch(() => '')) === profile, 'Shell did not receive the requested working directory or input.');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+d');
	await until(async () => await page.locator('.xterm').count() === 2, 'Split terminal shortcut did not create another pane.');
	await page.screenshot({ path: join(evidence, 'companion-split.png') });
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+Shift+t');
	await until(async () => await page.locator('.xterm').count() === 3, 'New terminal shortcut did not create another terminal.');
	console.log('Verified shell input, working directory, split, and new terminal.');

	const second = await launch(port, editorProfile);
	await until(async () => windows(browser).length === 2, 'The launcher did not open a second normal window.');
	const secondPage = windows(browser).find(candidate => candidate !== page);
	const secondCwd = join(editorProfile, 'second-cwd');
	await runShell(secondPage, `printf '%s' "$PWD" > ${quoteShell(secondCwd)}`);
	await until(async () => (await readFile(secondCwd, 'utf8').catch(() => '')) === editorProfile, 'Second window used the wrong working directory.');
	assert.notEqual(first.terminalPid, second.terminalPid);
	await command(page, 'Close Window');
	await until(async () => page.isClosed(), 'First normal window did not close.');
	await until(async () => !alive(first.terminalPid), 'Closing the first terminal window left its shell running.');
	assert.ok(alive(second.terminalPid), 'Closing one normal window killed another window\'s shell.');
	console.log('Verified separate normal windows and shell survival after closing one.');

	// An ordinary editor instance in another throwaway profile stands in for the user's main editor.
	const editorPort = await freePort();
	await mkdir(join(editorProfile, 'User'), { recursive: true });
	await writeFile(join(editorProfile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'files.simpleDialog.enable': true, 'chat.disableAIFeatures': true }));
	const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
	for (const key of Object.keys(environment)) {
		if (key.startsWith('VSCODE_') || key.startsWith('TERMINAL_OSS_') || key === 'NODE_OPTIONS') { delete environment[key]; }
	}
	await execute(first.executable, [first.cli, '--new-window', '--user-data-dir', editorProfile, '--extensions-dir', join(editorProfile, 'extensions'), '--shared-data-dir', join(editorProfile, 'shared'), '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${editorPort}`], { env: environment, timeout: 30_000 });
	const editorPid = await mainPid(first.executable, editorProfile);
	assert.notEqual(editorPid, companionPid);
	editorBrowser = await connect(editorPort);
	const editorPage = await until(async () => windows(editorBrowser)[0], 'No control editor window.');
	await command(editorPage, 'Close Window');
	process.kill(editorPid, 'SIGTERM');
	await until(async () => !alive(editorPid), 'Control editor did not quit.');
	assert.ok(alive(second.terminalPid), 'Quitting the separate editor killed the companion shell.');
	const survivalFile = join(profile, 'survival-result');
	await runShell(secondPage, `printf 'still-running' > ${quoteShell(survivalFile)}`);
	await until(async () => (await readFile(survivalFile, 'utf8').catch(() => '')) === 'still-running', 'Companion stopped accepting input after the editor quit.');
	console.log('Verified the companion shell and input after quitting the separate editor.');
	await secondPage.screenshot({ path: join(evidence, 'companion-editor-closed.png') });
	await command(secondPage, 'Developer: Restart Extension Host');
	await setTimeout(4000);
	assert.ok(alive(second.terminalPid), 'Extension host restart killed the existing terminal.');
	await command(secondPage, 'Terminal: Focus Terminal');
	const reloadFile = join(profile, 'reload-result');
	await runShell(secondPage, `printf '%s' "$$" > ${quoteShell(reloadFile)}`);
	await until(async () => (await readFile(reloadFile, 'utf8').catch(() => '')) === String(second.terminalPid), 'Terminal was not usable after extension host restart.');
	const report = { vscodeVersion: first.vscodeVersion, platform: process.platform, arch: process.arch, startupMs, payloadBytes: (await buildCompanion()).payloadBytes, separateEditorMainProcess: true, shellSurvivesEditorQuit: true, shellSurvivesOtherWindowClose: true, shellSurvivesExtensionHostRestart: true, startingDirectories: true, splitsAndTabs: true, bootstrapUsesInstalledNode: true, packaged, shellPids: [...terminalPids] };
	await writeFile(join(companionOutput, '../companion-smoke-report.json'), JSON.stringify(report, null, '\t') + '\n');
	console.log(JSON.stringify(report, null, '\t'));
} catch (error) {
	const page = browser && windows(browser)[0];
	if (page && !page.isClosed()) {
		await page.screenshot({ path: join(evidence, 'companion-failure.png') }).catch(() => {});
		console.error(await page.locator('body').innerText().catch(() => ''));
	}
	throw error;
} finally {
	await Promise.all([browser?.close().catch(() => {}), editorBrowser?.close().catch(() => {})]);
	if (codeExecutable) {
		for (const directory of [profile, editorProfile]) {
			await mainPid(codeExecutable, directory).catch(() => {});
		}
	}
	for (const pid of testPids) {
		if (alive(pid)) { process.kill(pid, 'SIGTERM'); }
	}
	for (const pid of testPids) {
		await until(async () => !alive(pid), `Test application ${pid} did not terminate.`, 10_000);
	}
	for (const pid of terminalPids) {
		await until(async () => !alive(pid), `Test shell ${pid} did not terminate.`, 10_000);
	}
	await rm(profile, { recursive: true, force: true });
	await rm(editorProfile, { recursive: true, force: true });
}
