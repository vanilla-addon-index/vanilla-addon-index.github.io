// Discovery preview only: no database reads or writes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { readOctowow } from '../src/lib/octowow.ts';

const candidates = await readOctowow();
mkdirSync('octowow-import', { recursive: true });
writeFileSync('octowow-import/candidates.json', JSON.stringify(candidates, null, '\t') + '\n');
console.log(`${candidates.length} review candidates. See octowow-import/candidates.json. Nothing was queued or published.`);
