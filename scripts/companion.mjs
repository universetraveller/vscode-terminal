/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { build } from 'esbuild';
import { chmod, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { root, source as appSource, tsconfig } from './paths.mjs';
import { verifyUpstream } from './upstream.mjs';

export const companionOutput = join(root, '.build/terminal/companion');
const source = join(appSource, 'companion');

/** Build only the launcher and API adapter; no Electron, PTY, xterm, or workbench is copied. */
export async function buildCompanion() {
	await verifyUpstream();
	await mkdir(join(companionOutput, 'extension'), { recursive: true });
	const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, legalComments: 'eof', metafile: true, logLevel: 'warning', tsconfig };
	const results = await Promise.all([
		build({ ...options, entryPoints: [join(source, 'companionMain.ts')], outfile: join(companionOutput, 'launcher.cjs') }),
		build({ ...options, entryPoints: [join(source, 'extension.ts')], outfile: join(companionOutput, 'extension/extension.cjs'), external: ['vscode'] })
	]);
	await cp(new URL('../companion/extension/', import.meta.url), join(companionOutput, 'extension'), { recursive: true });
	await cp(join(root, 'LICENSE.txt'), join(companionOutput, 'extension/LICENSE.txt'));
	await cp(join(root, 'LICENSE.txt'), join(companionOutput, 'LICENSE.txt'));
	for (const [template, name] of [['bootstrap.sh', 'terminal-oss'], ['bootstrap.cmd', 'terminal-oss.cmd']]) {
		await cp(new URL(`../companion/${template}`, import.meta.url), join(companionOutput, name));
	}
	await chmod(join(companionOutput, 'terminal-oss'), 0o755);
	const inputs = [...new Set(results.flatMap(result => Object.keys(result.metafile.inputs)))].sort();
	const unexpectedInputs = inputs.filter(input => !input.startsWith('src/companion/') && input !== 'vendor/vscode/src/vs/nls.ts' && input !== 'vendor/vscode/src/vs/nls.messages.ts');
	if (unexpectedInputs.length) {
		throw new Error(`Companion unexpectedly bundled runtime modules: ${unexpectedInputs.join(', ')}`);
	}
	const files = ['launcher.cjs', 'LICENSE.txt', 'terminal-oss', 'terminal-oss.cmd', ...(await readdir(join(companionOutput, 'extension'))).map(name => `extension/${name}`)];
	const bytes = (await Promise.all(files.map(async name => (await stat(join(companionOutput, name))).size))).reduce((sum, size) => sum + size, 0);
	const report = { payloadBytes: bytes, copiedRuntimeFiles: 0, bundledInputs: inputs, requiresInstalledVSCode: '>=1.141.0', files };
	await writeFile(join(companionOutput, '../companion-build-report.json'), JSON.stringify(report, null, '\t') + '\n');
	console.log(`Built Terminal OSS companion: ${(bytes / 1024).toFixed(1)} KiB; uses installed VS Code.`);
	return report;
}

/** Package a small macOS launcher bundle. The installed VS Code still owns its windows and Dock identity. */
async function packageCompanion() {
	if (process.platform !== 'darwin') {
		console.log(`Portable launcher files: ${companionOutput}`);
		return;
	}
	const app = join(companionOutput, 'Terminal OSS (VS Code).app');
	const resources = join(app, 'Contents/Resources');
	await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
	await mkdir(resources, { recursive: true });
	for (const name of ['launcher.cjs', 'extension', 'LICENSE.txt']) {
		await cp(join(companionOutput, name), join(resources, name), { recursive: true });
	}
	await cp(new URL('../companion/bootstrap.sh', import.meta.url), join(app, 'Contents/MacOS/terminal-oss'));
	await chmod(join(app, 'Contents/MacOS/terminal-oss'), 0o755);
	await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>terminal-oss</string>
<key>CFBundleIdentifier</key><string>org.terminaloss.companion</string>
<key>CFBundleName</key><string>Terminal OSS (VS Code)</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
	console.log(`Packaged ${app}`);
}

/** Run focused Node tests without importing VS Code's Mocha suites or compiling the workbench. */
async function testCompanion() {
	const outfile = join(companionOutput, '../tests/companion.test.cjs');
	await mkdir(dirname(outfile), { recursive: true });
	await build({ absWorkingDir: root, entryPoints: [join(root, 'test/companion.test.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning', tsconfig });
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Companion tests exited with ${code}`)));
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await buildCompanion();
	if (process.argv.includes('--test')) { await testCompanion(); }
	if (process.argv.includes('--package')) { await packageCompanion(); }
	if (process.argv.includes('--launch')) {
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [join(companionOutput, 'launcher.cjs'), ...process.argv.slice(process.argv.indexOf('--launch') + 1).filter(argument => argument !== '--')], { stdio: 'inherit' });
			child.once('error', reject);
			child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Companion launcher exited with ${code}`)));
		});
	}
}
