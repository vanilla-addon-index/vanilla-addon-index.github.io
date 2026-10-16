/** Bounded prose for category matching, never a replacement public description. */
export function readmeCategoryText(text: string): string {
	const prose = text.slice(0, 32000)
		.replace(/```[^]*?```|~~~[^]*?~~~/g, '')
		.replace(/<!--[^]*?-->/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/https?:\/\/\S+/g, '')
		.replace(/<[^>]*>/g, '');
	const kept: string[] = [];
	let skippedDepth = 0;
	for (const line of prose.split(/\r?\n/)) {
		const heading = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			if (skippedDepth && heading[1].length <= skippedDepth) skippedDepth = 0;
			if (/^(?:install(?:ation|ing)?|setup|dependencies|requirements|change\s*log|changes|credits|licen[cs]e|contributing|downloads?)(?:\b|:)/i.test(heading[2])) skippedDepth ||= heading[1].length;
		}
		if (!skippedDepth) kept.push(line);
	}
	return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
}

export function tocCategoryText(text: string): string {
	return [...text.matchAll(/^##\s*Notes(?:-[a-zA-Z]+)?:\s*(.+)$/gm)]
		.map(match => match[1].trim()).join(' ').slice(0, 2000);
}

export function categoryDescription(item: { description: string; category_context?: Record<string, string> }): string {
	return [item.description, ...Object.values(item.category_context ?? {})].filter(Boolean).join('\n');
}
