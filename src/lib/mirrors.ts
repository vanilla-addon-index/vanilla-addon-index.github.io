// Match repository roots only. General-purpose link keys can collapse a branch
// or folder into its repository, which is unsafe for mirror suppression.
export function repositoryRoot(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /^https:\/\/(github\.com|gitlab\.com|codeberg\.org|gitea\.com|octowow\.st)\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/?$/.exec(value);
	if (!match || match[0] !== value) return null;
	const [, host, path] = match;
	const parts = path.replace(/\.git$/, '').split('/');
	if (parts.some(part => !part || part === '.' || part === '..' || part === '-')) return null;
	if (host === 'octowow.st' ? parts.length !== 3 || parts[0] !== 'git'
		: host !== 'gitlab.com' && parts.length !== 2) return null;
	return `https://${host}/${parts.join('/')}`;
}

export function declaredMirrorSource(flag: unknown, source: unknown): string | null | undefined {
	if (flag === true) return repositoryRoot(source);
	if (flag === false) return null;
	return undefined;
}
