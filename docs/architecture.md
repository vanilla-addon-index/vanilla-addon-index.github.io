# Architecture

[← README](../README.md) · [Development](development.md) · [Operations](operations.md)

## Site and permissions

The site is a static [SvelteKit app](../src/routes) hosted on GitHub Pages. Supabase
provides PostgreSQL, authentication and the data API. The public URL and key in
[config.ts](../src/lib/config.ts) ship to the browser; SQL grants, row-level security
and narrow database functions enforce access.

Visitors can browse. Members can post addons and edit or delete their own entries.
Admins review wiki imports, handle reports and manage content. The owner appoints
or removes admins and has the final account-management permissions. These rules
are tested against the actual [database migrations](../supabase/migrations).

## Reading the addon list

```text
Public database rows → export → addons.json → static site and browser
Public database changes ───────────────────→ browser updates
```

[export.mjs](../scripts/export.mjs) writes only public addon fields to
`addons.json`. Visitors and ordinary members load that snapshot, then fetch newer
posts and edits. Members also receive the ownership information needed to manage
their own entries. Admins read the current database list directly.

This reduces database traffic and provides a browsing fallback during outages.
New posts can appear before the next deployment, but their generated pages and
link previews wait for a new build. Deletions and regrouping may remain visible
in other visitors' snapshots until publication; admins see the current state, and
a member's own deletion is remembered in that browser.

The `snapshot` branch holds the last published list and its publication record.
Each update replaces it with a single root commit, retaining no snapshot history.
Refresh checks hourly for changes; scheduled jobs can start late, so this is not a
guaranteed deletion or publication deadline.

## Wiki imports and repository checks

[Nightly](../.github/workflows/nightly.yml) reads the Turtle WoW wiki into a pending
queue for admin review. It then checks every supported published and pending
repository link on GitHub, GitLab, Codeberg and gitea.com. Old, inactive and
previously missing repositories keep the same daily coverage.

Repository facts include availability, current address, stars, archive status,
fork parent and the `.toc` game version. **Last code update** comes from the
selected branch's latest commit, restricted to the addon folder when the link
names one. It is distinct from repository activity and listing edits; separate
branches, folders and forks retain separate dates. Unknown dates stay unknown,
and failed requests retain the last verified facts.

Checks use shared requests, sequential GitHub batches and two workers per other
host. Completed file and history results are reused only after validating the
branch commit or file identifiers. REST metadata can use server-validated ETags
or Last-Modified responses. Incomplete checks remain retryable; confirmed absence
can clear a detail. Wiki content is parsed each run, so parser and category fixes
apply even when its revision has not changed.

## Private maintenance data

The import queue, review facts and repository caches do not enter the public
snapshot. Successful checks save in independent checkpoints of at most 50
records, so a failed save does not discard other completed result types.

Unchanged review facts avoid full-row updates. `repo_stats_checks` records check
times, and the admin-only `repo_stats_current` view combines them with `repo_stats`.
Unused private cache URLs are pruned only after they have no pending or published
reference. Rename-matching facts and commit-date records are retained.

See [operations](operations.md) for deployment guards, diagnostics and recovery.
