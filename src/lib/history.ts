export const visibleHistoryFields = (fields: string[]) => fields.filter(field => !['unavailable_links','slug','aliases','link_code_updates'].includes(field));
export const HISTORY_LABELS: Record<string,string> = {name:'Name',description:'Description',category:'Category',author:'Author',unavailable_links:'Unavailable download links',versions:'Download links',images:'Screenshots',shared:'Shared page',pinned_link:'Main download link',separate_name:'Separate addon name'};
export const fieldLabel = (field: string) => HISTORY_LABELS[field] ?? field.replaceAll('_',' ');
export const safeHistoryUrl = (value: unknown) => typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value) ? value : undefined;
export function textParts(value: string, other: string) {
 const a=value.split(/(\s+)/), b=other.split(/(\s+)/);
 let start=0,end=0;
 while(start<a.length && start<b.length && a[start]===b[start]) start++;
 while(end<a.length-start && end<b.length-start && a[a.length-1-end]===b[b.length-1-end]) end++;
 return [{text:a.slice(0,start).join(''),changed:false},{text:a.slice(start,a.length-end).join(''),changed:true},{text:end?a.slice(a.length-end).join(''):'',changed:false}].filter(p=>p.text);
}
export function changeSummary(fields: string[], before: Record<string,unknown>, after?: Record<string,unknown>) {
 return visibleHistoryFields(fields).map(field=>{
  if (field==='category' && typeof before[field]==='string' && typeof after?.[field]==='string') return `Category: ${before[field]} → ${after[field]}`;
  if(field==='versions' && Array.isArray(before[field]) && Array.isArray(after?.[field])) {
   const old=before[field] as {url:string}[], next=after[field] as {url:string}[];
   const added=next.filter(v=>!old.some(o=>o.url===v.url)).length, removed=old.filter(v=>!next.some(n=>n.url===v.url)).length;
   return `Download links${added?`: ${added} added`:''}${removed?`${added?', ':': '}${removed} removed`:''}${!added&&!removed?' edited':''}`;
  }
  return `${fieldLabel(field)} edited`;
 }).join(' · ');
}
