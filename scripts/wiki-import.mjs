// Dry run of the wiki import: reads the Turtle WoW wiki's addon list and writes a report
// and the parsed candidates to wiki-import/. It touches nothing else.
//
//   node scripts/wiki-import.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { WIKI, WIKI_PAGE, readWiki } from '../src/lib/wiki.ts';

const OUT = 'wiki-import';

const { revision, candidates, problems, fromTables, repeated } = await readWiki();

const count = (items, of) => {
	const totals = new Map();
	for (const item of items) totals.set(of(item), (totals.get(of(item)) ?? 0) + 1);
	return [...totals].sort((a, b) => b[1] - a[1]);
};
const table = (rows) => rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n');
const sample = (items, n) =>
	items.filter((_, i) => i % Math.max(1, Math.floor(items.length / n)) === 0).slice(0, n);
const sameName = count(candidates, (e) => e.name.toLowerCase()).filter(([, n]) => n > 1);

const report = `# Wiki import dry run

Source: ${WIKI}/wiki/${WIKI_PAGE} (revision ${revision}), read ${new Date().toISOString()}.
Nothing was written to the database.

## Totals

| | |
|---|---|
| Candidates | ${candidates.length} |
| Of those, only in the SuperWoW and ClassicAPI tables | ${fromTables} |
| Same link listed twice (merged) | ${repeated} |
| Could not be parsed | ${problems.length} |
| With a description | ${candidates.filter((e) => e.description).length} |
| Description shorter than 15 characters | ${candidates.filter((e) => e.description.length < 15).length} |
| With at least one screenshot | ${candidates.filter((e) => e.images.length).length} |
| With other versions ("Alt") | ${candidates.filter((e) => e.alts.length).length} |
| Marked obsolete | ${candidates.filter((e) => e.obsolete).length} |
| Extensions of another addon (nested) | ${candidates.filter((e) => e.parent).length} |
| Names used by more than one candidate | ${sameName.length} |

## Where the links point

| Host | Candidates |
|---|---|
${table(count(candidates, (e) => e.key.split('/')[0]).slice(0, 12))}

## Guessed categories

| Category | Candidates |
|---|---|
${table(count(candidates, (e) => e.category))}

## Names used by more than one candidate

${sameName.map(([name, n]) => `- ${name} (${n}): ${candidates.filter((e) => e.name.toLowerCase() === name).map((e) => e.key).join(', ')}`).join('\n') || 'None.'}

## Sample candidates

${sample(candidates, 25)
	.map(
		(e) =>
			`- **${e.name}** [${e.category}]${e.obsolete ? ' (obsolete)' : ''}${e.parent ? ` (extension of ${e.parent})` : ''}\n  - ${e.url}\n  - ${e.description || '(no description)'}\n  - screenshots: ${e.images.length}, other versions: ${e.alts.length}`
	)
	.join('\n')}

## Could not be parsed

${problems.map((p) => `- ${p.problem}: \`${p.line.slice(0, 200).replace(/`/g, "'")}\``).join('\n') || 'None.'}
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/report.md`, report);
writeFileSync(`${OUT}/candidates.json`, JSON.stringify(candidates, null, '\t') + '\n');
console.log(`${candidates.length} candidates, ${problems.length} unparsed. See ${OUT}/report.md`);
