# Nightly refresh frequency

Decision for optimization-list item 12, assessed on 15 October 2026: keep daily
repository checks while measuring the cache and concurrency changes in production.
No slower schedule is enabled by this decision.

## Evidence available

The latest completed [Nightly run inspected](https://github.com/vanilla-addon-index/vanilla-addon-index.github.io/actions/runs/38572598970)
ran on 14 October 2026 at commit `ec6cadd96028c66bb0fe79b4936e1aacc68e91ba`.
Its import job took 5 minutes 10 seconds, including job setup. The log reported 990
repository check results, 37 confirmed missing results and 19 checks on other hosts.
These counts do not distinguish published links from pending-only entries and do
not establish how long a repository has been missing.

That run predates the branch/file cache in PR #54, shared requests in PR #55 and
host concurrency in PR #56. No completed Nightly run containing those changes was
available at assessment time. The old runtime therefore cannot establish their
remaining cost or justify a freshness reduction. Compare a cold-cache run with
several subsequent warm-cache runs before revisiting frequency.

## Current freshness policy

| Information | Current behavior | Reason to retain it |
|---|---|---|
| Published branch/folder commit dates | Check the selected branch daily; reuse completed immutable results only after confirming its commit | A recently changed addon should remain discoverable even if its repository was previously quiet |
| Newly queued entries and pending screenshot checks | Check daily; retry incomplete work and retain completed one-time checks | New candidates should be ready for review promptly |
| Availability, identity, stars, archive status and fork parent | Check daily, sharing repository metadata across links | These facts already share a request with information needed for branch validation |
| Game version and README results | Reuse completed checks on unchanged commits or matching file signatures | The cache already avoids repeatedly downloading unchanged files |
| Older pending and missing repositories | Continue daily checks | Age, published-link overlap and consecutive confirmed absence are not yet available for reliable scheduling |

This describes the intended daily cadence. Workflow delays, rate limits and failed
requests can delay a successful observation; failures retain known facts.

## What a reduced schedule would need

An old pending entry can also refer to a published addon. Classification must be by
the exact original URL, across all uses: a published use or newly queued use keeps
that link on the daily schedule. Branches, folders and forks keep their separate
dates and cache scopes.

The current [`nightly_links` result](../supabase/migrations/20261014000006_repo_check_cache.sql) includes a review key, original URL, pending
README flag, images when needed, and cached state. It does not include queue age,
all-use classification or a consecutive-missing history. Add those facts privately
before using them to skip work; do not infer queue age from the README flag.

`repo_check_cache.checked_at` is the last cache write, not the last successful
repository check. An unchanged GitHub cache may not be written at all, and an
incomplete check may still save other completed fields; see the
[importer's cache checkpoints](../scripts/nightly.mjs). It cannot safely decide
when a repository is due. Scheduling would need separate last-attempt,
last-success and confirmed-missing bookkeeping. A timeout, rate limit, permission
failure or partial GraphQL error must never count as confirmed absence.

Weekly checks for pending-only entries would permit changes and repository
restoration to wait roughly a week for discovery under normal scheduling. Daily
checks usually discover them sooner. Choose that freshness tradeoff explicitly
after measuring the affected cohort. A reduced schedule should spread due work
across days, include periodic full sweeps, immediately recheck edited or newly
published links, and retry incomplete work rather than treating failures as fresh.

Slowing stars alone would not remove the existing shared metadata request while
daily availability and branch checks still need it. Slowing compatibility checks
on unchanged code would duplicate the immutable cache's existing benefit. Measure
request savings, rather than counting omitted fields or cached files as saved
network calls.

## Evidence to collect next

Use the existing Nightly phase timings, actual HTTP attempts, retries, cache-hit
counters and incomplete-check counters to establish the warm-cache cost. Keep cold
and warm runs separate, and check that a fast run did not simply lose host access.
Before implementing a cadence, measure pending-only age groups and repeated
confirmed misses privately, including their share of actual requests. Aggregate
diagnostics must not expose queue URLs or addon content.

Revisit reduced frequency only if a remaining costly cohort can save meaningful
work while preserving daily published dates and new-entry freshness. Until then,
the current daily workflow and its freshness promises stay in place.
