# Vanilla Addon Index

**[vanilla-addon-index.github.io](https://vanilla-addon-index.github.io)** is a community list of addons for the 1.12.1 client of World of Warcraft. Anyone can browse it; anyone with an account can post addons and edit or delete their own. The site's [about page](https://vanilla-addon-index.github.io/about) says who runs it and what it stores.

This repository is the whole site: its code, its database and the jobs that keep it running. It costs nothing to run.

- **Site:** static SvelteKit app on GitHub Pages
- **Accounts and data:** Supabase (free plan), protected by row-level security
- **Snapshot:** every deploy writes the whole list to `addons.json`. Visitors and members read the list from it and ask the database only for what was posted or edited since, so a new addon shows for everyone at once while the database is spared the whole list; only admins are sent the list exactly as it is, deletions included; the file also stands in if the database is unreachable. The latest one is kept on the `snapshot` branch, as a single commit that replaces the one before, so `main` only ever holds your own commits and no deleted addon stays readable there
- **Backup:** a full, encrypted copy of the database is taken every night and kept for 90 days; see [Backups](#backups)

## Setting it up from nothing

In this order. Steps 1 to 4 are done once in Supabase, 5 to 8 once on GitHub, and 9 after the site is up.

1. **Supabase project:** create one, in the region you want the data kept in.
2. **Config:** in [src/lib/config.ts](src/lib/config.ts), set the project's URL and public key, the site's address and the repository's address. The project's id also appears as `--project-ref` in [prepare.yml](.github/workflows/prepare.yml) and [backup.yml](.github/workflows/backup.yml). The [about page](src/routes/about/+page.svelte) names who runs the site and where the data is kept.
3. **Login providers:** in Supabase under Authentication → Sign In / Providers, enable Discord and GitHub with an OAuth app from each, and turn the Email provider off.
4. **Auth URLs:** in Supabase under Authentication → URL Configuration, set the site URL to the site's address and add `http://localhost:5173` as a redirect URL.
5. **Repository:** it must be named `<organization>.github.io`. Under Settings → Pages, set Source to "GitHub Actions".
6. **Secrets:** under Settings → Environments, create an environment named `database`, limit its deployment branches to `main`, untick "Allow administrators to bypass", and add the four secrets in the table below to it as environment secrets. Do not add them as repository secrets: those are given to a workflow on any branch. Each workflow skips the part that needs a secret it does not have, so the site deploys before they are all there.
7. **First deploy:** push to `main`. The deploy builds the database from [supabase/migrations](supabase/migrations) and publishes the site.
8. **Protect `main`:** under Settings → Branches, require a pull request and the two checks of the CI workflow, "Tests, types and build" and "Browser tests", for admins too. From here on a change goes out as described under [How a change goes out](#how-a-change-goes-out).
9. **Owner:** log in on the site once, then run this in Supabase's SQL editor: `update public.profiles set is_owner = true where username = 'your-username';`. The owner appoints the admins, can suspend them and empty the trash, and is the one account that cannot be deleted.

**Admins** are appointed by the owner: on the Users page of the admin panel, or on an account's own page there, "Make admin" and "Remove admin". It takes effect at once, works whichever way the account logs in, and is written to the log. Nobody else can do it, and nothing outside the site has a say in it.

### Secrets

| Secret | What it is | Used by |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | A Supabase access token scoped to this one project, with Read on Project Settings, API Keys, API Key Secrets and Connection Pooling, and nothing else | Deploy (migrations) and Backup, to find the database |
| `SUPABASE_DB_PASSWORD` | The database password, from the project's database settings | Deploy (migrations) and Backup |
| `NIGHTLY_TOKEN` | Made by `npm run nightly:token`; see [The nightly import](#the-nightly-import) | Nightly |
| `BACKUP_PASSPHRASE` | Any long passphrase of your own. Keep a copy somewhere other than GitHub | Backup |

The secrets live in the `database` environment, which only `main` may use, so a workflow changed on another branch is not given them. The database password is only ever given to jobs that install nothing but the Supabase tool. The project's secret key is not used anywhere.

## Working on it

```sh
npm install
npm run local       # a copy of the whole backend on this computer; needs Docker
npm run dev:local   # the site against it, on http://localhost:5174
npm run local:stop  # stop it
```

The local copy is built from the migrations and filled with test addons, a full import queue and one account of each kind. On that address the login page offers those accounts, one click each: the owner, two admins, members and a banned member. `npm run local` again wipes and refills it.

`npm run dev` runs the site against the **hosted** database instead, on port 5173. Everything done there is real.

`npm run check` type-checks, `npm run build` writes the static site to `build/`, and `npm run snapshot` fetches the current addon list for a build on your computer.

### Tests

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | What each kind of account may and may not do, against the real database rules: posting, editing, groups, bans, the log, the trash, the import queue, deleting an account. Also the wiki parser, on small cases and a saved copy of the page | A throwaway Postgres runs inside Node; publication shell checks also need Git, Bash and jq (Git Bash on Windows) |
| `npm run test:e2e` | The site in a real browser as a visitor, a member, an admin and the owner. Fails if the page's Content-Security-Policy refused anything | Docker, for the local backend, which it wipes and refills first |

Neither touches the hosted database.

### How a change goes out

`main` is protected: a change reaches it through a pull request, and only once both jobs of the [CI workflow](.github/workflows/ci.yml) have passed.

| Workflow | Runs | Does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | on every pull request | the database rule tests, the type check and a build; and the site in a real browser against a throwaway backend |
| [Deploy](.github/workflows/deploy.yml) | on every change to `main`, after Nightly, or by hand | five jobs in turn: rule tests and type checks, or an exact prior validation match; pending migrations; a fresh snapshot comparison and a build when publication is needed; the publish; saving the snapshot and its publication record. Only the migrations job is given the database password, and it installs nothing but the Supabase tool. Only the build job installs the site's dependencies, and it can read no secret and write nowhere |
| [Nightly](.github/workflows/nightly.yml) | once a day | keeps GitHub from switching the daily timers off, reads the wiki into the import queue, trims the log and the trash, and asks GitHub, GitLab, Codeberg and gitea.com about every repository kept there, then runs Deploy |
| [Refresh](.github/workflows/refresh.yml) | every hour | compares the complete public snapshot and application commit with the confirmed Pages publication, then calls Publish if needed; most runs end after that one look |
| [Backup](.github/workflows/backup.yml) | once a day | an encrypted copy of the database; see [Backups](#backups) |

Deploy, Nightly and Refresh share [Publish](.github/workflows/publish.yml). Each calling job holds the same `publication` lock through preparation, snapshot export, build, publishing and snapshot saving. Waiting publications are retained; running publications are never automatically cancelled. Nightly's import and Refresh's initial comparison stay outside this lock. Immediately before publishing, the build's commit must still match `main`; a stale build skips both publishing and snapshot saving, and a failed freshness check stops the job. Snapshot saving follows only a successful publication, even if `main` moves afterwards, so the saved list matches the site that went out. GitHub does not guarantee dispatch order, so freshness does not depend on queue order. To retry a publication, choose **Re-run all jobs**: partial reruns cannot republish or save an artifact from an earlier attempt.

Deploy and Nightly only touch the hosted database and the site when they run on `main`. Started by hand on another branch, they run the checks and stop there.

The snapshot is not replaced by a list less than half as long as the last one: that is more likely a database that answered wrongly than a list that shrank, and the run says so on its page. If the list really is that much shorter, delete the `snapshot` branch on GitHub and deploy again.

An addon posted between two deploys shows in the list and in search for everyone at once, and opens normally. Until the next deploy it has no page of its own, so link previews and search engines wait; and an addon deleted or regrouped in that time still shows as it was to everyone but admins and whoever deleted it. With Refresh looking every hour that is seldom long.

## Keeping it running

Addon pages show **Last code update**, the latest commit on the primary link's branch and, when present, addon folder. Nightly reads this from GitHub, GitLab, Codeberg and gitea.com; each fork and branch keeps its own date. The date and link to commit history are included in `addons.json`, so visitors can read them from the snapshot. Failed checks retain the last known date; links with no known commit date show **Unknown**. Repository activity such as issues or pushes to other branches never supplies this public date. Listing posts and edits remain in History, without an entry for each automatic repository check.

After first deploying the code-update migration, run Nightly on `main` to populate the dates and refresh the snapshot. Existing repository activity dates are not used as a substitute for verified commit dates.

### The daily timers

Nightly, Refresh and Backup run on a timer, and GitHub switches the timers of a public repository off when it has had no activity for 60 days. Nothing commits to `main` by itself, so Nightly starts each run by marking all three workflows as enabled, which starts the 60 days again.

GitHub also runs these timers late, often by hours; nothing here depends on the exact time. Refresh looks every hour, and most of those runs are one short job that finds nothing changed; that is far inside what GitHub allows a public repository, which pays nothing for them. The three workflows start at different minutes of the hour. Nightly and Refresh each prevent overlapping runs of their own kind, while the shared publication lock keeps their builds, deployments and saved snapshots together.

GitHub does not promise that this keeps working. It sends an email before it switches a timer off, so make sure notifications for this repository reach an inbox that is read. If it happens: Actions → the workflow → "Enable workflow". With the timers off there are no backups, imports or deploys, and Supabase pauses the project after about a week without use; it is restored from the Supabase dashboard.

### When something is waiting for an admin

The site sends no email. When a report nobody has closed, or a member's suggestion nobody has decided, is waiting, the Nightly workflow opens an issue in this repository named "Waiting for an admin" and assigns it to the people named as `TELL` in [nightly.yml](.github/workflows/nightly.yml), whom GitHub then emails. It adds a comment when more arrives and closes the issue when nothing is left. A new addon, an edit or anything else that needs no admin never causes one. Issues are public, so it holds the two numbers and nothing else. The address it links to is `ADMIN_PAGE` in the same file.

### What members may link to

Nobody reviews an addon before it is listed, so a member's link must be on a site known for hosting code, and their screenshots on a site known for hosting code or pictures. A screenshot is only ever shown as a picture, so what its address ends in does not matter: one that is not a picture shows nothing. The two lists are `LINK_HOSTS` and `IMAGE_HOSTS` in [src/lib/config.ts](src/lib/config.ts) and `allowed_hosts()` in the database; a test fails if they differ, and adding a site takes a new migration. An entry such as `octowow.st/git` allows that part of a site and nothing else on it. Admins are not held to the lists, which is how an addon kept anywhere else gets listed, and how the wiki's entries keep the links they have.

### The nightly import

The [Nightly workflow](.github/workflows/nightly.yml) reads the Turtle WoW wiki's addon list into the import queue for an admin to review, trims the log and the trash of what is older than 90 days, and asks GitHub, GitLab, Codeberg and gitea.com about every repository kept there: stars, last update, and the game version its `.toc` declares. GitHub is asked with the workflow's own token; the others are asked without a login, as any visitor may. A site that does not answer a script, as octowow.st does not while it is fending off attacks, is left alone. It signs in like any visitor and holds a token of its own, which is good for those few database calls and nothing else: it cannot post, edit, delete, or make anyone an admin.

```sh
npm run nightly:token   # makes a token, and prints where its two halves go
```

The token goes to GitHub as the `NIGHTLY_TOKEN` secret, and its hash into the database with the one statement the command prints. Doing it again replaces the token; the old one stops working at once. Missing nightly tokens fail the import explicitly rather than reporting a successful skipped run.

Nightly first validates the code and applies pending migrations through [Prepare](.github/workflows/prepare.yml), then imports and deploys. A preparation failure stops the import and publication. The same preparation is shared with ordinary deployments; dependency installation and tests run separately from the database credentials. Nightly reuses its successful preparation for the deployment in that run.

On `main`, Prepare remembers successful tests and type checks in a small validation receipt. Deploy, Nightly and Refresh can reuse it only for the exact commit, Node and npm versions, operating system, architecture and runner image version. The commit covers all tracked inputs, including the dependency lockfile, migrations, tests and workflow action pins. New code or dependencies and changed runtime inputs require fresh validation; unidentified runners, cache misses, cache errors and malformed receipts also run the checks. Only a fresh success on `main` writes a receipt, and only an exact main cache hit with matching receipt contents may skip dependency installation, tests and type checks. PR validation always runs in full. This follows [GitHub cache branch isolation and exact-match semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching). Receipts certify code checks only: migrations still run separately on every preparation, and each publication attempt still exports its snapshot before deciding whether a build is needed. Clearing the validation cache forces fresh checks; eviction simply loses the optimization.

Before installing build dependencies, Publish compares the complete exported snapshot and exact application commit with `publication.json` on the `snapshot` branch. It skips the build, artifact uploads, deployment and snapshot saving only when those fingerprints match and GitHub confirms that the record still identifies the latest successful `github-pages` deployment. The full snapshot includes commit dates and every other public field; private queue or statistics changes alone do not trigger publication. Any application commit change requires a publication even when the public data is identical. Missing or malformed records and deployment API failures require publication. The first run after introducing this record therefore publishes once.

Refresh uses the same comparison as an early check, and Publish repeats it while holding the shared publication lock. A queued Refresh can then skip output Nightly already published. Only a successful deployment in the current run attempt may save its fingerprint, and the saved record includes the deployment identity: a successful deployment followed by a failed snapshot save cannot make an older snapshot look current. The snapshot branch still has a single root commit with no historical addon data. Existing freshness checks, full rerun requirements and previous-snapshot fallback remain in place; new application code can still publish using that fallback during a database outage.

Completed checks are saved after each GitHub batch and each completed other-host repository, in database requests of at most 50 records. Statistics, commit dates and screenshots save independently; one failed save marks the run as failed while the remaining saves and checks continue. Metadata is saved before the `.toc` pass with its game-version check marked incomplete, preserving the previous version until a complete file check replaces it. Completed screenshot checks are recorded immediately and skipped on subsequent runs. Daily repository checks still run each time; commit dates and file results can be reused only after their branch commit is confirmed unchanged.

GitHub retains its sequential GraphQL batches while GitLab, Codeberg and gitea.com run alongside it. Each of those three hosts has two repository workers (at most six other-host checks altogether); a free worker takes the next link without waiting for a fixed wave. Requests within a repository remain sequential, and shared requests, bounded retries and host-specific rate-limit waits still apply. Checkpoint writes use one shared serial writer; a failed save or host does not stop independent hosts from completing.

The Nightly log reports progress after every batch and includes aggregate diagnostics at exit, also shown in the Actions job summary. Timings cover the wiki, screenshots, GitHub metadata, commit history and directory follow-ups, `.toc` files, READMEs, other hosts, and database reads and writes. Request counts include actual HTTP attempts, retries, failed attempts, rate limits and retry waits. Separate counters track incomplete field checks, successful and failed saves, and links whose dates were left unchanged (a previous date is retained when present; otherwise it stays unknown). Cache hits count reused history, directories, file checks, REST shared requests and validated unchanged metadata; one link may produce several hits. Separate counters report saved GraphQL repository fields. Phase times include checkpoint writes, and concurrent request times can overlap, so the timing columns are not additive. GitHub metadata resolves the branch first; history and directory follow-ups share a separate request when needed. The metadata phase includes these follow-ups, so its elapsed time also overlaps their row. Abrupt termination may prevent the final summary; earlier batch progress and completed database saves remain available.

Write diagnostics distinguish checkpoint payloads from database changes. `stats_facts_written` and `stats_facts_unchanged` count accepted unique review keys; `stats_checks_written` counts separate last-check timestamp rows. Unchanged facts stay untouched in `repo_stats`, whose timestamp now records the last facts write. The admin queue reads the same row format through the admin-only `repo_stats_current` view, which combines those facts with the latest successful check time from `repo_stats_checks`. The original table and columns remain available for local seeding and older data-only backups. New or changed facts write both a facts row and a timestamp row; unchanged facts write only the smaller timestamp row. Every repository is still checked on every Nightly run. These counters measure row activity, not disk I/O or runtime savings; submitted/saved record counters continue to describe checkpoint payloads.

Identical private cache saves are database no-ops, including retries after a lost response. `cache_rows_written` reports actual cache changes. Once per import, the narrow Nightly token may remove cache entries whose exact URL is no longer in any published version or pending entry; `cache_entries_pruned` reports that count. A pruning failure is reported while repository checks and independent saves continue. Repository facts used for rename matching and commit-date records are retained; the existing guard still avoids public addon updates when their commit dates are unchanged.

Nightly stores completed immutable checks in a private database cache keyed by each original full URL. GitHub, GitLab, Codeberg and gitea.com still check availability, stars, archive status, fork parent, current address and the selected branch commit daily. An unchanged commit reuses completed directory, game-version and commit-history checks; changed branches refresh history, and unchanged file or subtree identifiers can still reuse a `.toc` result. Follow-up reads use the checked commit instead of the moving branch. Separate branches, folders and forks never share a cached result just because they share a review key. Repository replacement, a rename or a parser-version change invalidates reuse.

Repository-wide facts are fetched once per normalized repository address in each run. GitHub groups stars, archive status, fork parent and identity under one repository field, with separate branch-head fields where needed. Equivalent links share immutable history, directory, `.toc` and README reads, while each original URL retains its own saved date and cache record. REST hosts share in-flight and completed requests to the same endpoint, including a bounded failed result, so a second link does not restart the same retries.

For REST repository metadata, Nightly stores an ETag or Last-Modified validator and only the public response fields it uses, within the existing private cache. A later request sends the matching conditional header; `304 Not Modified` reuses the stored fields after server validation. A changed response replaces them, a confirmed 404 removes them, and a failed request never silently supplies the old body as a new success. Missing or malformed cached responses cause an ordinary fetch, with one unconditional retry for an unexpected 304. Validators are restricted to their exact metadata endpoint and are separate from GitHub GraphQL and branch/file caching. Metadata persistence also works for repositories without a branch; no additional database permissions or migration are needed.

Each successful phase checkpoints its cache independently. Failed or incomplete history, directory, file and README reads remain retryable, and a cached date is resubmitted if its earlier public-date save failed. Cache-save failures do not block the other result saves. Cache records are bounded to 64 KiB and accessible only through the nightly-token functions, never through public addon responses or snapshots. Long other-host READMEs are not cached. Cold runs and changed branches may make an extra lightweight request; the reduction applies to subsequent unchanged checks. Bump `CHECK_CACHE_VERSION` in [nightly-cache.ts](src/lib/nightly-cache.ts) when file-selection or parsing rules change, even if repository commits have not.

Network requests have deadlines covering both connection and response reading, with bounded backoff for temporary failures. Rate-limit waits honour the server's headers; long waits stop requests to that host for the rest of its reset period rather than repeatedly hitting it. Failed directory, `.toc`, README or image checks retain known information and leave unfinished screenshot reviews eligible for the next run. A successful check that confirms something is absent can still clear that detail.

The wiki page is hand-written, so the import guards against reading it badly: a page that lists far fewer addons than it did the last time is refused whole, and the run fails so that it is noticed. If the wiki really has shrunk by more than a fifth, run `delete from public.wiki_listing;` in Supabase's SQL editor once and the next page is taken as it is. [tests/wiki.test.mjs](tests/wiki.test.mjs) pins what the parser makes of a saved copy of the page. `node scripts/wiki-import.mjs` shows what it makes of the page as it is now: a dry run that writes a report to `wiki-import/` and changes nothing.

### Changing the database

The database is described by the numbered files in [supabase/migrations](supabase/migrations). Each one is applied once, in order, and Supabase remembers which have run, so nothing is pasted into the SQL editor by hand and no file is ever run twice.

```sh
npm run db:new -- add_something   # a new, empty migration to write the change in
npm run local                     # rebuilds the local backend from all migrations
npm test && npm run test:e2e      # the rules, and the site in a browser, against it
```

A migration that has reached the hosted database is never edited again: a later change goes in a new one. The deploy applies pending migrations itself before the site goes out, and stops if one fails, so the site is never ahead of its database.

`npm run db:status` shows which migrations the hosted database has had, and `npm run db:push` applies the rest by hand. Both need `npx supabase login` and `npx supabase link --project-ref <the project's id>` to have been run once on this computer.

### Backups

The free Supabase plan keeps no backups, so the [Backup workflow](.github/workflows/backup.yml) takes a full copy of the hosted database every night: every table of the site, and the accounts. Because the copy holds private data and this repository is public, it is encrypted with the `BACKUP_PASSPHRASE` secret before GitHub stores it, and kept for 90 days. The table structure is not in it; the migrations are that.

```sh
npm run db:backup                       # a copy on this computer, in vanilla-addon-index-backups/ in your home folder
npm run db:backup:check -- <file>       # loads a copy into the local backend, to show it restores
npm run db:backup:fetch                 # downloads the latest nightly copy, still encrypted, to that same folder
gpg --decrypt backup.sql.gpg > backup.sql   # opens a nightly copy downloaded from GitHub
```

Every night's copy is also tried out: the workflow opens the stored file with the passphrase and loads it into a throwaway database, and the run fails if that does not work or the copy holds no accounts.

The last seven copies are also kept on the `backups` branch, as a single commit that replaces the one before, once each has been shown to restore. A mirror of this repository on another server picks that branch up by itself, which is how the copies get somewhere that is not GitHub without anyone doing anything. They are public there and of no use without the passphrase, so the passphrase must be long and used nowhere else. `npm run db:backup:fetch` still downloads the latest one to this computer.

To recover from losing the hosted database: create a new project, `npx supabase link` it, build its tables with `npm run db:push`, then load the backup file into it with `psql`. Without the passphrase the nightly copies cannot be opened.
