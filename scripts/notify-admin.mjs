import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function waitingCounts(values) {
 const counts={};
 for(const key of ['reports','suggestions','imports']) {
  const value=String(values[key] ?? '');
  if(!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Missing or invalid ${key} count.`);
  counts[key]=Number(value);
 }
 return counts;
}

export function notifyAdmin({ repo, tell, counts }, gh=(args)=>execFileSync('gh',args,{encoding:'utf8'})) {
 counts=waitingCounts(counts);
 const title=`Waiting for an admin: ${counts.reports} reports, ${counts.suggestions} suggestions, ${counts.imports} imports`;
 const base='https://vanilla-addon-index.github.io/admin';
 const body=`Waiting on the site:\n\n- ${counts.reports} reports: ${base}/reports\n- ${counts.suggestions} suggestions and edit proposals: ${base}/groups and ${base}/edits\n- ${counts.imports} imports: ${base}/import\n\nNightly updates this issue and closes it when nothing remains. Only counts are public.`;
 const run=(args)=>gh([...args,'--repo',repo]);
 run(['label','create','needs-admin','--color','d93f0b','--description','Something on the site is waiting for an admin','--force']);
 const [open]=JSON.parse(run(['issue','list','--label','needs-admin','--state','open','--limit','1','--json','number,title']));
 if(!Object.values(counts).some(Boolean)) {
  if(open) run(['issue','close',String(open.number),'--comment','Nothing is waiting any more.']);
  return;
 }
 if(!open) { run(['issue','create','--title',title,'--body',body,'--label','needs-admin','--assignee',tell]); return; }
 if(open.title===title) return;
 run(['issue','edit',String(open.number),'--title',title,'--body',body]);
 // Compare categories independently: new imports still notify while reports decrease.
 const increased=Object.entries(counts).some(([key,value])=>value>Number(new RegExp(`(\\d+) ${key}`).exec(open.title)?.[1] ?? 0));
 if(increased) run(['issue','comment',String(open.number),'--body',`More is waiting now.\n\n${body}`]);
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 notifyAdmin({repo:process.env.GITHUB_REPOSITORY,tell:process.env.TELL,counts:{reports:process.env.REPORTS,suggestions:process.env.SUGGESTIONS,imports:process.env.IMPORTS}});
}
