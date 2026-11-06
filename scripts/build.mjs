/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractThemes } from './themes.mjs';
import { output, root, source, tooling, tsconfig, upstream } from './paths.mjs';
import { verifyUpstream } from './upstream.mjs';

const require = createRequire(import.meta.url);
export { root, output } from './paths.mjs';
export const appDirectory = join(output, 'app');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function run(executable, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, { stdio: 'inherit', ...options });
		child.on('error', reject);
		child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${executable} exited with code ${code}`)));
	});
}

/** Copy only native runtime dependencies, following their actual installed dependency graph. */
async function copyRuntimeDependency(name, from = require, copied = new Set()) {
	if (copied.has(name)) {
		return;
	}
	copied.add(name);
	const packagePath = from.resolve(`${name}/package.json`);
	const directory = dirname(packagePath);
	const dependency = JSON.parse(await readFile(packagePath, 'utf8'));
	await cp(directory, join(appDirectory, 'node_modules', name), {
		recursive: true,
		dereference: true,
		filter: path => {
			const location = relative(directory, path).replaceAll('\\', '/');
			if (/(?:^|[/\\])(?:node_modules|test|tests|src|obj|obj\.target|third_party|\.git)(?:[/\\]|$)/.test(location)) {
				return false;
			}
			if (location.startsWith('build/') && location !== 'build/Release' && !location.startsWith('build/Release/')) {
				return false;
			}
			const prebuild = location.match(/^prebuilds[/\\]([^/\\]+)/);
			return !prebuild || prebuild[1] === `${process.platform}-${process.arch}`;
		}
	});
	for (const dependencyName of Object.keys(dependency.dependencies || {})) {
		await copyRuntimeDependency(dependencyName, createRequire(packagePath), copied);
	}
}

export async function buildApp() {
	const pin = await verifyUpstream();
	await mkdir(output, { recursive: true });
	// This directory contains generated terminal artifacts only.
	await rm(appDirectory, { recursive: true, force: true });
	await mkdir(appDirectory, { recursive: true });
	const themes = await extractThemes(upstream);
	const base = {
		absWorkingDir: root,
		bundle: true,
		minify: true,
		metafile: true,
		nodePaths: [tooling],
		target: 'es2024',
		legalComments: 'eof',
		tsconfig,
		logLevel: 'warning'
	};
	const results = await Promise.all([
		build({ ...base, entryPoints: { main: join(source, 'electron-main/main.ts'), terminalHost: join(source, 'node/terminalHost.ts') }, outdir: appDirectory, outExtension: { '.js': '.cjs' }, platform: 'node', format: 'cjs', external: ['electron', 'node-pty', '@vscode/windows-process-tree', '@vscode/windows-registry'], banner: { js: "globalThis._VSCODE_FILE_ROOT = __dirname + '/assets';" } }),
		build({ ...base, entryPoints: [join(source, 'electron-sandbox/preload.ts')], outfile: join(appDirectory, 'preload.cjs'), platform: 'node', format: 'cjs', external: ['electron'] }),
		build({ ...base, entryPoints: { renderer: join(source, 'browser/terminalApp.ts') }, outdir: appDirectory, platform: 'browser', format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]', loader: { '.ttf': 'file' }, plugins: [{ name: 'terminal-themes', setup(build) {
			build.onResolve({ filter: /themes\.generated\.js$/ }, () => ({ path: 'themes', namespace: 'terminal-themes' }));
			build.onLoad({ filter: /.*/, namespace: 'terminal-themes' }, () => ({ contents: `export const themes = ${JSON.stringify(themes)};`, loader: 'js' }));
		} }] })
	]);
	await cp(join(source, 'browser/index.html'), join(appDirectory, 'index.html'));
	await cp(join(upstream, 'src/vs/workbench/contrib/terminal/common/scripts'), join(appDirectory, 'assets/vs/workbench/contrib/terminal/common/scripts'), { recursive: true });
	await mkdir(join(appDirectory, 'assets/vs/base/node'), { recursive: true });
	for (const script of ['ps.sh', 'cpuUsage.sh']) {
		await cp(join(upstream, 'src/vs/base/node', script), join(appDirectory, 'assets/vs/base/node', script));
	}
	await cp(join(root, 'LICENSE.txt'), join(appDirectory, 'LICENSE.txt'));
	await cp(join(upstream, 'LICENSE.txt'), join(appDirectory, 'VSCode-LICENSE.txt'));
	const notices = [];
	for (const name of ['@xterm/xterm', '@xterm/addon-search', '@xterm/addon-unicode11', '@xterm/addon-webgl']) {
		const license = await readFile(join(tooling, name, 'LICENSE'), 'utf8');
		notices.push(`${name} (${manifest.dependencies[name]})\n\n${license}`);
	}
	await writeFile(join(appDirectory, 'ThirdPartyNotices.txt'), notices.join('\n\n----------------------------------------\n\n'));
	await copyRuntimeDependency('node-pty');
	if (process.platform === 'win32') {
		await copyRuntimeDependency('@vscode/windows-process-tree');
		await copyRuntimeDependency('@vscode/windows-registry');
	}
	const nativeDependencies = Object.fromEntries(['node-pty', ...(process.platform === 'win32' ? ['@vscode/windows-process-tree', '@vscode/windows-registry'] : [])].map(name => [name, manifest.dependencies[name] || manifest.optionalDependencies[name]]));
	await writeFile(join(appDirectory, 'package.json'), JSON.stringify({ name: 'terminal-oss', productName: 'Terminal OSS', version: manifest.version, private: true, main: 'main.cjs', license: 'MIT', dependencies: nativeDependencies, vscodeVersion: pin.version, vscodeCommit: pin.commit }, null, '\t') + '\n');
	const inputs = [...new Set(results.flatMap(result => Object.keys(result.metafile.inputs)))].sort();
	const forbidden = inputs.filter(input => /^vendor\/vscode\/src\/vs\/(?:workbench|editor|sessions)\//.test(input) || /\/agentHost\//.test(input));
	if (forbidden.length) {
		throw new Error(`Terminal build included unrelated workbench components:\n${forbidden.join('\n')}`);
	}
	const report = {
		vscodeVersion: pin.version,
		vscodeCommit: pin.commit,
		vscodeRepository: pin.repository,
		electronVersion: manifest.devDependencies.electron,
		platform: process.platform,
		arch: process.arch,
		bundles: results.flatMap(result => Object.entries(result.metafile.outputs).map(([file, info]) => ({ file, bytes: info.bytes }))),
		upstreamInputs: inputs.filter(input => input.startsWith('vendor/vscode/src/')),
		forbiddenInputs: forbidden
	};
	await writeFile(join(output, 'build-report.json'), JSON.stringify(report, null, '\t') + '\n');
	console.log(`Built Terminal OSS: ${(report.bundles.reduce((sum, bundle) => sum + bundle.bytes, 0) / 1024 / 1024).toFixed(2)} MiB of bundled JS/CSS; no editor, extension host, or agent host entry points.`);
	return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await buildApp();
	if (process.argv.includes('--test')) {
		const tests = join(output, 'tests');
		await mkdir(tests, { recursive: true });
		const testDirectory = join(root, 'test');
		const entryPoints = (await readdir(testDirectory)).filter(name => name.endsWith('.test.ts') && name !== 'companion.test.ts').map(name => join(testDirectory, name));
		await build({ absWorkingDir: root, entryPoints, outdir: tests, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, nodePaths: [tooling], tsconfig });
		const scriptTests = (await readdir(testDirectory)).filter(name => name.endsWith('.test.mjs')).map(name => join(testDirectory, name));
		await run(process.execPath, ['--test', ...entryPoints.map(file => join(tests, `${basename(file, '.ts')}.cjs`)), ...scriptTests]);
	}
	if (process.argv.includes('--launch')) {
		const separator = process.argv.indexOf('--');
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		await run(require('electron'), [appDirectory, ...(separator >= 0 ? process.argv.slice(separator + 1) : [])], { env });
	}
}
