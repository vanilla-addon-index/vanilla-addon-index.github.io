import type { RequestMetrics } from './request.ts';

export const NIGHTLY_PHASES = [
	'Wiki', 'Screenshots', 'GitHub metadata', 'GitHub history + files', 'GitHub .toc', 'GitHub README',
	'Other hosts', 'GitLab', 'Codeberg', 'Gitea', 'Database reads', 'Database writes'
] as const;
export type NightlyPhase = typeof NIGHTLY_PHASES[number];
type PhaseMetrics = {
	wallMs: number; requestMs: number; requests: number; attempts: number; retries: number;
	failedRequests: number; failedAttempts: number; rateLimited: number; retryDelayMs: number;
};

/** Diagnostics contain only fixed phase names, timings and counts, never request data. */
export class NightlyMetrics {
	private now: () => number;
	private log: (line: string) => void;
	private started: number;
	private active = new Set<{ name: NightlyPhase; started: number }>();
	private rows = new Map<NightlyPhase, PhaseMetrics>(NIGHTLY_PHASES.map((name) => [name, {
		wallMs: 0, requestMs: 0, requests: 0, attempts: 0, retries: 0,
		failedRequests: 0, failedAttempts: 0, rateLimited: 0, retryDelayMs: 0
	}]));
	private counters: Record<string, number> = { cache_hits: 0 };

	constructor({ now = () => performance.now(), log = (line: string) => console.log(line) } = {}) {
		this.now = now;
		this.log = log;
		this.started = now();
	}

	count(name: string, amount = 1): void {
		this.counters[name] = (this.counters[name] ?? 0) + amount;
	}

	observe(name: NightlyPhase): (metrics: RequestMetrics) => void {
		return (metrics) => {
			const row = this.rows.get(name)!;
			row.requests++;
			row.requestMs += metrics.durationMs;
			row.attempts += metrics.attempts;
			row.retries += metrics.retries;
			row.failedRequests += Number(metrics.failed);
			row.failedAttempts += metrics.failedAttempts;
			row.rateLimited += Number(metrics.rateLimited);
			row.retryDelayMs += metrics.retryDelayMs;
		};
	}

	start(name: NightlyPhase, announce = true): () => void {
		const phase = { name, started: this.now() };
		this.active.add(phase);
		return () => {
			if (!this.active.delete(phase)) return;
			this.rows.get(name)!.wallMs += this.now() - phase.started;
			if (announce) this.progress(name);
		};
	}

	progress(name: NightlyPhase, completed?: number, total?: number): void {
		const row = this.snapshot().phases[name];
		this.log(`[Nightly] ${name}${completed === undefined ? '' : ` ${completed}/${total}`}: ${(row.wallMs / 1000).toFixed(1)}s elapsed, ${row.attempts} HTTP attempts, ${row.retries} retries, ${row.failedRequests} failed requests.`);
	}

	snapshot() {
		const phases = Object.fromEntries([...this.rows].map(([name, row]) => [name, { ...row }])) as Record<NightlyPhase, PhaseMetrics>;
		for (const phase of this.active) phases[phase.name].wallMs += this.now() - phase.started;
		return { elapsedMs: Math.max(0, this.now() - this.started), phases, counters: { ...this.counters } };
	}

	markdown(): string {
		const { elapsedMs, phases, counters } = this.snapshot();
		return [
			'## Nightly import diagnostics', '',
			`Total elapsed: ${(elapsedMs / 1000).toFixed(1)}s.`, '',
			'| Phase | Phase seconds | Request seconds | HTTP attempts | Retries | Failed requests | Failed attempts | Rate limited | Retry wait seconds |',
			'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
			...NIGHTLY_PHASES.map((name) => {
				const r = phases[name];
				return `| ${name} | ${(r.wallMs / 1000).toFixed(1)} | ${(r.requestMs / 1000).toFixed(1)} | ${r.attempts} | ${r.retries} | ${r.failedRequests} | ${r.failedAttempts} | ${r.rateLimited} | ${(r.retryDelayMs / 1000).toFixed(1)} |`;
			}), '',
			'Phase times include checkpoint writes. Request seconds include retries and waits; parallel requests can overlap. Host rows show request cost inside Other hosts. Times are not additive. GitHub metadata resolves the branch commit first; history and directory follow-ups share a separate request when needed.', '',
			'| Check | Count |', '|---|---:|',
			...Object.entries(counters).map(([name, count]) => `| ${name} | ${count} |`), '',
			'Cache hits count reused history, directories, file checks and host results; one link can produce several hits. Dates left unchanged retain a previous date when one exists; otherwise they remain unknown.', ''
		].join('\n');
	}
}
