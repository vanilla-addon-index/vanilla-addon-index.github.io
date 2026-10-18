# Architecture

[← README](../README.md) · [Development](development.md) · [Operations](operations.md)

## Site and permissions

The site is a static [SvelteKit app](../src/routes) hosted on GitHub Pages. Supabase
provides PostgreSQL, authentication and the data API. The public URL and key in
[config.ts](../src/lib/config.ts) ship to the browser; SQL grants, row-level security
and narrow database functions enforce access.

Visitors can browse. Members can post addons and edit or delete their own entries
directly until they become shared pages. Original owners and contributors can
propose edits to shared pages for admin review and immediately remove only their
own submitted links. A matching name adds a repository link immediately,
without approval or changes to the existing description, images, author or category.
Admins review wiki imports, handle reports and manage content. The owner appoints
or removes admins and has the final account-management permissions. These rules
are tested against the actual [database migrations](../supabase/migrations).

Names match without case, spaces or punctuation. Matching submissions and imports
use atomic database functions, with locks and a unique canonical-name index to
prevent duplicate pages. A second link permanently makes a page shared: direct content edits require an admin. Links sort by
their latest known commit date, unknown dates last; an admin pin overrides the
leading link and the page's code date. Admins can separate an unrelated link into
an explicit name-collision exception. Shared status is permanent, including when
all links are removed: the page keeps its address, description and history, has
an unknown code date, and invites contributors to add a link. Existing merged addresses remain aliases,
and removed entries are retained in the normal trash for 90 days.

Link provenance is private. Link additions are logged as reversible edits;
reverting an addition removes only those links, preserving later contributions.
Account rollback preserves shared pages and other contributors' links. Permanent
participation is stored separately from active links, so removing a link does not
revoke proposal access. Proposals are private to their author and admins; authors
can revise or withdraw a pending proposal. Admins see current/proposed values,
choose fields to accept, and cannot overwrite a field changed since submission.
Accepted edits use the normal reversible audit path. Restore recovers contributor
access and link ownership too; deleting an account removes its participation and
private proposals. Banned accounts cannot propose, withdraw or remove links.

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
repository link on GitHub, GitLab, Codeberg, gitea.com and OctoWoW. Old and inactive
repositories keep the same daily coverage while published or pending.

When an admin opens the import queue, pending wiki articles are read in the background
for repository links in download/source sections. Successful reads replace the waiting
article with ordinary repository import entries, retaining the article as provenance.
Admins approve and group these with the normal controls. Wiki recommendations are
pinned on approval, including when that link is approved after other versions. Existing
queue decisions are preserved. Failed or empty reads leave the article waiting, with
retry and manual paste controls. Expanded source records do not count as published
addons. Resolved articles are not automatically monitored for subsequent changes.

After saving successful checks, Nightly files confirmed missing repositories under
**Decided → Dead links**. These are not admin rejections and require no decision.
Only explicit missing answers from the current run qualify for live removal; timeouts,
rate limits, unsupported hosts and other unanswered checks preserve existing entries.
Archived repositories remain available and are not removed. Dead links are removed
individually from multi-link addons; only an addon with no remaining links leaves the
live list. Each removed link retains a full addon snapshot in the private queue, and
deleted addons also enter the normal trash. Filed dead links are not automatically
republished or rechecked once they are no longer published or pending.

Owner rejections can only be returned to the import queue by the owner. Admins can
restore rejections made by other admins. The database enforces this for both individual
and batch actions, and the review page disables the restore action for owner rejections.

Import categories are selected manually by an admin or the owner before publishing a new
addon page. New and existing queued imports start with no category selected. Links added
to an existing page inherit that page’s category. Buttons and keyboard shortcuts require
a category for new pages; the database also rejects an empty published category.

When a submitted link matches a pending import's normalized key, the database
resolves that candidate as `submitted` and records its live addon and submitting
account. It preserves the member's details and ownership. This is separate from
admin approval, so undoing an import approval cannot remove that submission.

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
can clear a detail. Wiki content is parsed each run, so parser fixes
apply even when its revision has not changed.

## Private maintenance data

`addon_favorites` stores private per-account addon bookmarks. Row-level policies
allow only their owner to read, add or remove them; account or addon deletion
removes associated bookmarks. Favorites are managed from addon pages and listed
on the account page with current public code-update dates, newest first. They
are excluded from the public snapshot.

The import queue, review facts and repository caches do not enter the public
snapshot. Successful checks save in independent checkpoints of at most 50
records, so a failed save does not discard other completed result types.

Unchanged review facts avoid full-row updates. `repo_stats_checks` records check
times, and the admin-only `repo_stats_current` view combines them with `repo_stats`.
Unused private cache URLs are pruned only after they have no pending or published
reference. Rename-matching facts and commit-date records are retained.

See [operations](operations.md) for deployment guards, diagnostics and recovery.

OctoWoW checks use its public Gitea API under `/git/api/v1`, one repository at a
time, using Node's default User-Agent because the site's protection challenges
the custom `vanilla-addon-index` agent. Its DDoS protection can still return an HTML challenge instead of API data; these
responses count as unavailable checks and previously known data is kept. Access
from a local machine does not establish access from GitHub Actions.
