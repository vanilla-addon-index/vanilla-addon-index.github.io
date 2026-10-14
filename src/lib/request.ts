/** Bounded requests for scheduled jobs. The deadline includes reading the response body. */
export class RequestFailure extends Error {
	readonly retryable: boolean;
	readonly retryAfterMs: number;
	readonly rateLimited: boolean;
	constructor(message: string, retryable = false, retryAfterMs = 0, rateLimited = false) {
		super(message);
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
		this.rateLimited = rateLimited;
	}
}

export function rateLimitFailure(response: Response, message = 'API rate limit reached', now = Date.now()): RequestFailure {
	const retry = response.headers.get('retry-after');
	const seconds = retry === null ? NaN : Number(retry);
	const after = retry === null ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - now;
	const reset = response.headers.get('x-ratelimit-remaining') === '0'
		? Number(response.headers.get('x-ratelimit-reset')) * 1000 - now + 1000 : 0;
	return new RequestFailure(message, true, Math.max(after || 0, reset || 0, after || reset ? 0 : 60_000), true);
}

export interface RequestMetrics {
	attempts: number;
	failedAttempts: number;
	retries: number;
	failed: boolean;
	rateLimited: boolean;
	durationMs: number;
	retryDelayMs: number;
}

interface Options<T> {
	/** Aggregate diagnostics only: never includes the URL, credentials or response body. */
	observe?: (metrics: RequestMetrics) => void;
	init?: RequestInit;
	read: (response: Response) => Promise<T>;
	/** Optional safe diagnostic, for APIs such as PostgREST with useful JSON errors. */
	errorMessage?: (response: Response) => Promise<string>;
	timeoutMs?: number;
	attempts?: number;
	/** Non-success statuses that the caller can interpret, such as a confirmed 404. */
	accept?: number[];
}

export function createRequester({
	fetcher = (url: string, init: RequestInit) => fetch(url, init),
	sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	random = () => Math.random(),
	maxRetryDelayMs = 60_000
} = {}) {
	// A long reset must also stop later batches from immediately hitting the same host.
	const blockedUntil = new Map<string, number>();
	return async function request<T>(url: string, { init = {}, read, errorMessage, observe, timeoutMs = 30_000, attempts = 3, accept = [] }: Options<T>): Promise<T> {
		const host = new URL(url).origin;
		const started = now();
		const metrics: RequestMetrics = { attempts: 0, retries: 0, failedAttempts: 0, failed: true, rateLimited: false, durationMs: 0, retryDelayMs: 0 };
		try {
			for (let attempt = 1; ; attempt++) {
				const blocked = (blockedUntil.get(host) ?? 0) - now();
				if (blocked > maxRetryDelayMs) {
					metrics.rateLimited = true;
					throw new RequestFailure(`${host} is rate limited beyond this request's retry budget.`);
				}
				if (blocked > 0) {
					metrics.retryDelayMs += blocked;
					await sleep(blocked);
				}
				metrics.attempts++;
				metrics.retries = Math.max(0, metrics.attempts - 1);
				const controller = new AbortController();
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const deadline = new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							reject(new RequestFailure(`Request to ${host} timed out.`, true));
						}, timeoutMs);
					});
					const result = await Promise.race([deadline, (async () => {
						const response = await fetcher(url, {
							...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
						});
						if (!response.ok && !accept.includes(response.status)) {
							const message = response.status === 403 ? await response.text() : '';
							if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0' ||
								(response.status === 403 && (response.headers.has('retry-after') || /rate limit|secondary limit|abuse detection/i.test(message)))) {
								if (!response.bodyUsed) await response.body?.cancel();
								throw rateLimitFailure(response, `Rate limit from ${host}.`, now());
							}
							const detail = errorMessage && !response.bodyUsed ? await errorMessage(response) : '';
							if (!response.bodyUsed) await response.body?.cancel();
							throw new RequestFailure(`HTTP ${response.status} from ${host}.${detail ? ` ${detail.slice(0, 400)}` : ''}`, response.status === 408 || response.status >= 500,
								response.headers.has('retry-after') ? rateLimitFailure(response, '', now()).retryAfterMs : 0);
						}
						return read(response);
					})()]);
					metrics.failed = false;
					return result;
				} catch (error) {
					metrics.failedAttempts++;
					clearTimeout(timer);
					const failure = error instanceof RequestFailure ? error :
						error instanceof TypeError || error instanceof SyntaxError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
							? new RequestFailure(`Could not read response from ${host}.`, true) : null;
					if (failure?.rateLimited) {
						metrics.rateLimited = true;
						blockedUntil.set(host, now() + failure.retryAfterMs);
					}
					if (!failure?.retryable || attempt >= attempts || init.signal?.aborted) throw error;
					const delay = Math.max(1000 * 2 ** (attempt - 1) + random() * 250,
						failure.retryAfterMs * (failure.rateLimited ? 2 ** (attempt - 1) : 1));
					if (delay > maxRetryDelayMs) throw new RequestFailure(`${failure.message} Required retry delay exceeds the request budget.`);
					metrics.retryDelayMs += delay;
					await sleep(delay);
				} finally {
					clearTimeout(timer);
				}
			}
		} finally {
			metrics.durationMs = Math.max(0, now() - started);
			observe?.(metrics);
		}
	};
}

export const request = createRequester();
