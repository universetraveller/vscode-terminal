/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appDirectory, buildApp, output } from './build.mjs';

const require = createRequire(import.meta.url);
const packagedIndex = process.argv.indexOf('--packaged');
const packagedExecutable = packagedIndex >= 0 ? process.argv[packagedIndex + 1] : undefined;
const benchmark = process.argv.includes('--benchmark');
const gpuAcceleration = benchmark || process.argv.includes('--gpu');
if (!packagedExecutable) {
	await buildApp();
}
const profile = await mkdtemp(join(output, 'smoke-profile-'));
const evidence = join(output, 'evidence');
await mkdir(evidence, { recursive: true });
await rm(join(evidence, 'failure.png'), { force: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.GIT_CONFIG_COUNT;
delete env.GIT_CONFIG_PARAMETERS;
const customProfiles = process.platform === 'win32' ? [] : [
	{ name: 'Smoke Shell', path: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', env: { ZDOTDIR: profile, HISTFILE: '/dev/null' } },
	{ name: 'Smoke Bash', path: '/bin/bash', env: { HISTFILE: '/dev/null' } }
];
await writeFile(join(profile, 'settings.json'), JSON.stringify({ gpuAcceleration, theme: 'dark', confirmOnClose: false, profiles: customProfiles, defaultProfile: customProfiles[0]?.name || '' }));

const start = performance.now();
const electron = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: [...(packagedExecutable ? [] : [appDirectory]), `--user-data-dir=${profile}`, `--cwd=${profile}`], env, timeout: 30000 });
const errors = [];
let lastPage;
try {
	const page = await electron.firstWindow();
	page.setDefaultTimeout(15000);
	lastPage = page;
	page.on('pageerror', error => errors.push(error.message));
	await page.locator('.terminal-pane[data-pid]').waitFor();
	const startupMs = performance.now() - start;
	const firstId = await page.locator('.terminal-pane').getAttribute('data-session-id');
	const firstPid = await page.locator('.terminal-pane').getAttribute('data-pid');
	await page.screenshot({ path: join(evidence, 'initial.png') });
	console.log(JSON.stringify({ stage: 'launched', startupMs: Math.round(startupMs), firstPid }));
	if (process.argv.includes('--inspect-ui')) {
		await writeFile(join(evidence, 'initial-layout.json'), JSON.stringify(await page.locator('.xterm').evaluate(element => [...element.querySelectorAll('*')].map(node => {
			const style = getComputedStyle(node);
			const bounds = node.getBoundingClientRect();
			return { className: node.className, background: style.backgroundColor, border: style.border, width: bounds.width, height: bounds.height };
		}).filter(node => node.background === 'rgb(0, 0, 0)' || node.border.includes('solid'))), null, 2));
		console.log('Initial screenshot is ready in .build/terminal/evidence/initial.png. Press Enter to continue the smoke checks.');
		await new Promise(resolve => process.stdin.once('data', resolve));
		process.stdin.pause();
	}

	async function sendCommand(target, command, id) {
		await target.evaluate(({ command, id }) => {
			const session = id || document.querySelector('.terminal-pane.focused')?.getAttribute('data-session-id');
			return window.terminalApp.send({ type: 'input', id: session, data: command + '\r' });
		}, { command, id });
	}
	async function waitForFile(name, expected) {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			try {
				const content = await readFile(join(profile, name), 'utf8');
				if (content === expected) {
					return;
				}
			} catch { /* The shell has not written the marker yet. */ }
			await delay(100);
		}
		throw new Error(`Shell did not produce the expected marker: ${name}`);
	}
	async function waitForProcessExit(pid) {
		assert.ok(Number.isSafeInteger(Number(pid)) && Number(pid) > 0, 'Expected a real shell process id');
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			try {
				process.kill(Number(pid), 0);
			} catch (error) {
				if (error.code === 'ESRCH') {
					return;
				}
				throw error;
			}
			await delay(50);
		}
		throw new Error(`Closed terminal retained its shell process: ${pid}`);
	}
	const unix = process.platform !== 'win32';
	await page.locator('.xterm-helper-textarea').focus();
	await page.keyboard.insertText(unix ? "printf 'keyboard-ok' > keyboard.txt" : 'echo keyboard-ok> keyboard.txt');
	await page.keyboard.press('Enter');
	await waitForFile('keyboard.txt', unix ? 'keyboard-ok' : 'keyboard-ok\r\n');
	if (unix) {
		await page.waitForFunction(() => Number(document.querySelector('.terminal-pane')?.getAttribute('data-shell-integration')) === 2);
		await sendCommand(page, "printf 'Unicode: 你好 🌍\\n'; printf '\\033[31mANSI colors\\033[0m\\n'; printf done > output.txt");
		await waitForFile('output.txt', 'done');
		await page.getByRole('button', { name: 'Find', exact: true }).click();
		await page.getByRole('searchbox').fill('a-match-that-does-not-exist');
		await page.waitForFunction(() => document.querySelector('.status-message')?.textContent === 'No matches');
		await page.getByRole('searchbox').fill('Unicode');
		await page.waitForFunction(() => document.querySelector('.status-message')?.textContent === '');
		await page.getByRole('button', { name: 'Next', exact: true }).click();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
	}
	await page.getByRole('button', { name: 'Split Right', exact: true }).click();
	await page.locator('.terminal-pane[data-pid]').nth(1).waitFor();
	assert.equal(await page.locator('.terminal-pane').count(), 2);
	await page.getByRole('button', { name: 'Split Down', exact: true }).click();
	await page.locator('.terminal-pane[data-pid]').nth(2).waitFor();
	await page.screenshot({ path: join(evidence, 'split-panes.png') });
	await page.getByRole('button', { name: 'New', exact: true }).click();
	await page.locator('.terminal-pane.focused[data-pid]').waitFor();
	assert.equal(await page.getByRole('tab').count(), 2);
	await page.getByRole('tab').first().click();
	assert.equal(await page.locator(`[data-session-id="${firstId}"]`).getAttribute('data-pid'), firstPid);
	if (unix) {
		// Bash sources the integration script directly; it must remain a real file in packaged apps.
		await page.getByRole('combobox', { name: 'Shell Profile', exact: true }).selectOption('Smoke Bash');
		await page.getByRole('button', { name: 'New', exact: true }).click();
		await page.locator('.terminal-pane.focused[data-pid]').waitFor();
		const bashPid = await page.locator('.terminal-pane.focused').getAttribute('data-pid');
		await page.waitForFunction(() => Number(document.querySelector('.terminal-pane.focused')?.getAttribute('data-shell-integration')) === 2);
		await sendCommand(page, "printf bash-ok > bash.txt");
		await waitForFile('bash.txt', 'bash-ok');
		await page.getByRole('button', { name: 'Close Terminal Tab', exact: true }).last().click();
		await waitForProcessExit(bashPid);
		await page.getByRole('combobox', { name: 'Shell Profile', exact: true }).selectOption('Smoke Shell');
	}
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await page.getByLabel('Font Size', { exact: true }).fill('16');
	await page.getByLabel('Theme', { exact: true }).selectOption('light');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
	await page.screenshot({ path: join(evidence, 'light-theme.png') });
	const savedSettings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
	assert.equal(savedSettings.fontSize, 16);

	const newWindow = electron.waitForEvent('window');
	await page.evaluate(() => window.terminalApp.newWindow());
	const second = await newWindow;
	second.setDefaultTimeout(15000);
	lastPage = second;
	second.on('pageerror', error => errors.push(error.message));
	await second.locator('.terminal-pane[data-pid]').waitFor();
	const secondId = await second.locator('.terminal-pane').getAttribute('data-session-id');
	const secondPid = await second.locator('.terminal-pane').getAttribute('data-pid');
	// A session id from another connection must not let this window write to that shell.
	await sendCommand(second, unix ? "printf 'wrong-owner' > ownership.txt" : 'echo wrong-owner> ownership.txt', firstId);
	await delay(200);
	await assert.rejects(readFile(join(profile, 'ownership.txt')));
	if (unix) {
		// Keep the same shell alive while its sibling window closes, including a running child command.
		await sendCommand(second, "sleep 1; printf 'survived' > survived.txt");
	}
	const closingWindowPids = await page.locator('.terminal-pane[data-pid]').evaluateAll(elements => elements.map(element => element.getAttribute('data-pid')));
	await page.close();
	await Promise.all(closingWindowPids.map(waitForProcessExit));
	await sendCommand(second, unix ? "printf 'independent' > independent.txt" : 'echo independent> independent.txt', secondId);
	await waitForFile('independent.txt', unix ? 'independent' : 'independent\r\n');
	if (unix) {
		await waitForFile('survived.txt', 'survived');
	}
	assert.equal(await second.locator('.terminal-pane').getAttribute('data-pid'), secondPid);
	await second.screenshot({ path: join(evidence, 'independent-window.png') });
	if (unix) {
		// Exceed scrollback in an inactive tab so marker disposal and several pause/resume cycles run.
		await second.getByRole('button', { name: 'New', exact: true }).click();
		await second.locator('.terminal-pane.focused[data-pid]').waitFor();
		const temporaryPid = await second.locator('.terminal-pane.focused').getAttribute('data-pid');
		await sendCommand(second, "awk 'BEGIN { for (i = 0; i < 10000; i++) print \"scrollback output \" i }'; printf done > flow.txt", secondId);
		await waitForFile('flow.txt', 'done');
		await second.getByRole('button', { name: 'Close Terminal Tab', exact: true }).last().click();
		await waitForProcessExit(temporaryPid);
	}

	// Warm up before sampling idle app processes. Shell workload is separate from Electron metrics.
	await delay(2000);
	await electron.evaluate(({ app }) => app.getAppMetrics());
	await delay(2000);
	const metrics = await electron.evaluate(({ app }) => app.getAppMetrics());
	assert.equal(metrics.filter(metric => metric.name === 'Terminal PTY Host').length, 1);
	assert.equal(metrics.some(metric => /extension.?host|agent.?host/i.test(metric.name || '')), false);
	const samples = [{ terminals: 1, workingSetKiB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0), idleCpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0) }];
	let backgroundOutputMs;
	if (benchmark) {
		for (let index = 0; index < 9; index++) {
			await second.getByRole('button', { name: 'New', exact: true }).click();
			await second.locator('.terminal-pane.focused[data-pid]').waitFor();
		}
		if (unix) {
			const throughputStart = performance.now();
			await sendCommand(second, "awk 'BEGIN { for (i = 0; i < 100000; i++) print \"background output \" i }'; printf done > throughput.txt", secondId);
			await waitForFile('throughput.txt', 'done');
			backgroundOutputMs = Math.round(performance.now() - throughputStart);
		}
		await delay(2000);
		await electron.evaluate(({ app }) => app.getAppMetrics());
		await delay(2000);
		const multiple = await electron.evaluate(({ app }) => app.getAppMetrics());
		assert.equal(multiple.filter(metric => metric.name === 'Terminal PTY Host').length, 1);
		assert.equal(multiple.filter(metric => metric.type === 'Tab').length, 1);
		samples.push({ terminals: 10, workingSetKiB: multiple.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0), idleCpuPercent: multiple.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0) });
		const closingPids = [];
		for (let index = 0; index < 9; index++) {
			closingPids.push(await second.locator('.terminal-group:not([hidden]) .terminal-pane').getAttribute('data-pid'));
			await second.getByRole('button', { name: 'Close Terminal Tab', exact: true }).last().click();
		}
		await Promise.all(closingPids.map(waitForProcessExit));
		assert.equal(await second.getByRole('tab').count(), 1);
		await second.screenshot({ path: join(evidence, 'after-closing-tabs.png') });
	}
	const report = {
		platform: process.platform,
		arch: process.arch,
		runtime: 'Electron',
		packaged: !!packagedExecutable,
		gpuAcceleration,
		automationEnabled: true,
		memoryNotes: 'Electron working sets include shared resident pages counted in each process and exclude shell/command processes. Measurements include Playwright automation.',
		startupMs: Math.round(startupMs),
		idleCpuPercent: metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0),
		electronWorkingSetKiB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0),
		samples,
		backgroundOutputMs,
		processes: metrics.map(metric => ({ type: metric.type, name: metric.name, workingSetKiB: metric.memory.workingSetSize, cpuPercent: metric.cpu.percentCPUUsage })),
		checks: ['keyboard input', ...(unix ? ['shell integration', 'Bash integration scripts accessible to shell', 'Unicode and ANSI output', 'search', 'background output past scrollback limit'] : []), 'nested splits', 'tab switching', 'settings persistence', 'window session isolation', 'closed terminals terminate their shells', 'same shell survives sibling window closure', 'one shared PTY host', ...(benchmark ? ['ten tabs share one renderer and PTY host', 'close nine tabs and terminate their shells', ...(unix ? ['background output flow control'] : [])] : [])],
		rendererErrors: errors
	};
	assert.deepStrictEqual(errors, []);
	await writeFile(join(output, benchmark ? 'benchmark-report.json' : 'smoke-report.json'), JSON.stringify(report, null, '\t') + '\n');
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.error('Renderer errors:', errors);
	if (lastPage && !lastPage.isClosed()) {
		await lastPage.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
		console.error(await lastPage.locator('body').innerText().catch(() => 'No renderer text'));
	}
	throw error;
} finally {
	await electron.close();
	await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
