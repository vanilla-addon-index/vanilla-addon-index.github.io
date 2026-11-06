export const CLIENT_KINDS = ['Util', 'DLL', 'MPQ'] as const;

/** Older snapshots still carry addon categories for client mods. */
export function clientKind(category: string): string {
	return (CLIENT_KINDS as readonly string[]).includes(category) ? category : 'DLL';
}
