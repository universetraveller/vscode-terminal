/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';

/** Read upstream theme data at build time without shipping its registries or editor services. */
export async function extractThemes(root) {
	async function readTheme(file) {
		const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, 'utf8'));
		if (parsed.error) {
			throw new Error(`Could not parse upstream theme: ${file}`);
		}
		const theme = parsed.config;
		return { ...(theme.include ? await readTheme(resolve(dirname(file), theme.include)) : {}), ...theme.colors };
	}
	const file = resolve(root, 'src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts');
	const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
	let colorMap;
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			colorMap ??= statement.declarationList.declarations.find(declaration => declaration.name.getText(source) === 'ansiColorMap')?.initializer;
		}
	}
	if (!colorMap || !ts.isObjectLiteralExpression(colorMap) || colorMap.properties.length !== 16) {
		throw new Error('Upstream ANSI color definitions changed; update the terminal theme adapter.');
	}
	const result = {};
	for (const name of ['dark', 'light']) {
		const colors = await readTheme(resolve(root, `extensions/theme-defaults/themes/${name}_modern.json`));
		const terminal = {
			background: colors['terminal.background'] || colors['editor.background'],
			foreground: colors['terminal.foreground'] || colors['editor.foreground'],
			cursor: colors['terminalCursor.foreground'] || colors['terminal.foreground'],
			selectionBackground: colors['terminal.selectionBackground'] || colors['editor.selectionBackground'],
			selectionInactiveBackground: colors['terminal.inactiveSelectionBackground']
		};
		for (const property of colorMap.properties) {
			const id = property.name.text;
			const defaults = property.initializer.properties.find(property => property.name.getText(source) === 'defaults')?.initializer;
			const value = defaults?.properties.find(property => property.name.getText(source) === name)?.initializer;
			if (!value || !ts.isStringLiteral(value)) {
				throw new Error(`Upstream ANSI default changed: ${id}/${name}`);
			}
			const key = id.replace('terminal.ansi', '');
			terminal[key[0].toLowerCase() + key.slice(1)] = colors[id] || value.text;
		}
		result[name] = { colors, terminal };
	}
	return result;
}
