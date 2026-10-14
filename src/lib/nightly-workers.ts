/** Keep a small queue moving as each worker finishes. Unexpected failures are
 * reported after all remaining items have had a chance to complete. */
export async function runWorkers<T>(items: readonly T[], limit: number, check: (item: T) => Promise<void>): Promise<void> {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Worker limit must be a positive integer.');
	let next = 0;
	const errors: unknown[] = [];
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			try { await check(item); }
			catch (error) { errors.push(error); }
		}
	}));
	if (errors.length) throw new AggregateError(errors, `${errors.length} repository checks failed unexpectedly.`);
}
