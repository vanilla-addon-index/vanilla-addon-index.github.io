import { hostAllowed } from './hosts.ts';
import { linkError } from './link-validation.ts';

/** A local suggestion from a supported repository URL, without fetching the repository. */
export function repositoryName(value: string): string {
	const link = value.trim();
	if (linkError(link) || !hostAllowed(link, 'link')) return '';
	const url = new URL(link);
	const host = url.hostname.replace(/^www\./i, '').toLowerCase();
	const parts = url.pathname.split('/').filter(Boolean);
	if (host === 'octowow.st') parts.shift();
	if (parts.length < 2) return '';
	let name = parts[1];
	if (host === 'github.com' && ['tree', 'blob'].includes(parts[2])) {
		const folders = parts.slice(4);
		if (parts[2] === 'blob') folders.pop();
		name = folders.at(-1) || name;
	} else if (host === 'gitlab.com') {
		// GitLab supports nested namespaces; page routes start with /-/.
		const separator = parts.indexOf('-');
		name = separator >= 0 ? parts[separator - 1] : parts.at(-1)!;
	}
	try { name = decodeURIComponent(name).replace(/\.git$/i, ''); }
	catch { return ''; }
	return name.length >= 2 && name.length <= 60 && /^[^\s/\\?#]+$/.test(name) && /[a-z0-9]/i.test(name) ? name : '';
}
