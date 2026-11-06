/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type PaneLayout = { type: 'terminal'; id: string } | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: PaneLayout; second: PaneLayout };

export function splitPane(layout: PaneLayout, id: string, newId: string, direction: 'horizontal' | 'vertical'): PaneLayout {
	if (layout.type === 'terminal') {
		return layout.id === id ? { type: 'split', direction, ratio: 0.5, first: layout, second: { type: 'terminal', id: newId } } : layout;
	}
	return { ...layout, first: splitPane(layout.first, id, newId, direction), second: splitPane(layout.second, id, newId, direction) };
}

/** Remove a leaf and collapse its parent without changing the surviving shell's identity. */
export function removePane(layout: PaneLayout, id: string): PaneLayout | undefined {
	if (layout.type === 'terminal') {
		return layout.id === id ? undefined : layout;
	}
	const first = removePane(layout.first, id);
	const second = removePane(layout.second, id);
	return first && second ? { ...layout, first, second } : first || second;
}

export function paneIds(layout: PaneLayout): string[] {
	return layout.type === 'terminal' ? [layout.id] : [...paneIds(layout.first), ...paneIds(layout.second)];
}
