# Full Nightly repository checks

Decision for optimization-list item 12, confirmed on 15 October 2026: retain full
repository coverage on every Nightly run. Reduced check frequency is declined.

Every run checks all supported repository links from published addons and pending
queue entries. Repository age, queue age, low activity, previous missing results
and repeated failures must not put a link on a slower schedule. Availability,
identity, stars, archive status, fork parent and the selected branch commit remain
part of the daily checks. Branches, folders and forks retain their separate dates.

The existing optimizations keep this coverage: batching, shared repository
requests, bounded host concurrency and conditional REST metadata requests.
Completed immutable file and history results can still be reused after confirming
the selected branch commit or relevant file identifiers. This checks current
repository state without downloading unchanged content again. Completed one-time
screenshot checks remain complete; incomplete checks are retried.

A failed request retains the last known facts and is retried on a later run.
Timeouts, rate limits and partial responses must not count as confirmed absence or
as a reason to reduce future coverage. Workflow delays and host failures can delay
an observation, but they do not change the intended daily schedule.

Future performance work should preserve this coverage and freshness. Use request
sharing, validated cache reuse, bounded concurrency and measured reductions in
unnecessary work. Item 12 is closed with full daily checks retained, rather than
waiting for measurements to introduce a slower schedule.
