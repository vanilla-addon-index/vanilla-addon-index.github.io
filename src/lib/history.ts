export const visibleHistoryFields = (fields: string[]) => fields.filter(field => field !== 'link_code_updates');

const HISTORY_LABELS: Record<string, string> = {
 name: 'Name', description: 'Description', similar_addons: 'Similar addons',
 entry_type: 'Type', category: 'Category', author: 'Author', versions: 'Download links',
 images: 'Screenshots', shared: 'Shared page', pinned_link: 'Pinned download link',
 separate_name: 'Separate addon name', slug: 'Page address', aliases: 'Previous page addresses',
 unavailable_links: 'Unavailable download links'
};
export const fieldLabel = (field: string) => HISTORY_LABELS[field] ?? field.replaceAll('_', ' ');
export const safeHistoryUrl = (value: unknown) => typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value) ? value : undefined;

export type PinChange = 'pinned' | 'unpinned' | 'repinned';

export function pinChange(before?: Record<string, unknown>, after?: Record<string, unknown>): PinChange | undefined {
 const old = before?.pinned_link;
 const next = after?.pinned_link;
 if (old === null && typeof next === 'string' && next) return 'pinned';
 if (typeof old === 'string' && old && next === null) return 'unpinned';
 if (typeof old === 'string' && old && typeof next === 'string' && next && old !== next) return 'repinned';
}

const PIN_SUMMARY: Record<PinChange, string> = {
 pinned: 'Pinned a download link',
 unpinned: 'Unpinned a download link',
 repinned: 'Changed which download link is pinned'
};

export function textParts(value: string, other: string) {
 const a = value.split(/(\s+)/), b = other.split(/(\s+)/);
 let start = 0, end = 0;
 while (start < a.length && start < b.length && a[start] === b[start]) start++;
 while (end < a.length-start && end < b.length-start && a[a.length-1-end] === b[b.length-1-end]) end++;
 return [
  { text: a.slice(0, start).join(''), changed: false },
  { text: a.slice(start, a.length-end).join(''), changed: true },
  { text: end ? a.slice(a.length-end).join('') : '', changed: false }
 ].filter(part => part.text);
}

type Version = { url: string; note?: string };

export function changeSummary(
 fields: string[], before?: Record<string, unknown>, after?: Record<string, unknown>, recordedPinChange?: PinChange
) {
 return visibleHistoryFields(fields).map(field => {
  if (field === 'pinned_link') {
   const change = recordedPinChange ?? pinChange(before, after);
   if (change && Object.hasOwn(PIN_SUMMARY, change)) return PIN_SUMMARY[change];
  }
  if (field === 'shared' && typeof after?.[field] === 'boolean') {
   return after[field] ? 'Enabled shared editing' : 'Disabled shared editing';
  }
  if (field === 'category' && typeof before?.[field] === 'string' && typeof after?.[field] === 'string') {
   return `Category: ${before[field]} → ${after[field]}`;
  }
  if (field === 'versions' && Array.isArray(before?.[field]) && Array.isArray(after?.[field])) {
   const old = before[field] as Version[], next = after[field] as Version[];
   const added = next.filter(v => !old.some(o => o.url === v.url)).length;
   const removed = old.filter(v => !next.some(n => n.url === v.url)).length;
   const edited = next.filter(v => old.some(o => o.url === v.url && (o.note ?? '') !== (v.note ?? ''))).length;
   const changes = [added && `${added} added`, removed && `${removed} removed`, edited && `${edited} note${edited === 1 ? '' : 's'} edited`].filter(Boolean);
   if (changes.length) return `Download links: ${changes.join(', ')}`;
   if (old.some((version, index) => version.url !== next[index]?.url)) return 'Download links reordered';
  }
  return `${fieldLabel(field)} edited`;
 }).join(' · ');
}
