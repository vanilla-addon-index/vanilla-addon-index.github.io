# Operations

[← README](../README.md) · [Architecture](architecture.md) · [Setup](setup.md)

## Workflows

| Workflow | When | Responsibility |
|---|---|---|
| [CI](../.github/workflows/ci.yml) | Every PR | Tests, type checks, build and browser tests against a local backend |
| [Deploy](../.github/workflows/deploy.yml) | `main` changes or manual runs | Prepare and publish the application |
| [Nightly](../.github/workflows/nightly.yml) | Daily or manual runs | Wiki import, full repository checks, admin notifications and publication |
| [Refresh](../.github/workflows/refresh.yml) | Hourly or manual runs | Compare public output and publish changes |
| [Backup](../.github/workflows/backup.yml) | Daily or manual runs | Encrypt, verify and retain database backups |

Hosted imports, migrations and publication run only from `main`. Database
credentials live in its restricted `database` environment; the dependency-install
and build jobs do not receive them. Snapshot export uses the public database key.
Nightly also trims activity-log and trash entries older than 90 days.

### Publication safety

[Prepare](../.github/workflows/prepare.yml) validates code before applying
migrations, including a preflight production build using the last published
snapshot when available. A failed build stops preparation before migrations or
imports can start. Successful tests, type checks and preflight build can be reused only for the exact
`main` commit, Node/npm versions and runner image identity. Missing or invalid
validation receipts run fresh checks. PR CI always runs in full; migrations run
on every preparation regardless of receipt reuse.

Publication builds again with fresh data after migrations and imports. This can
still fail because of new data or an infrastructure outage. Migrations must remain
compatible with the deployed application until its replacement is published;
the preflight build does not provide a database rollback.

Deploy, Nightly and Refresh call [Publish](../.github/workflows/publish.yml) under
one lock covering preparation, comparison, build, publication and snapshot saving.
Nightly's import and Refresh's early comparison happen outside that lock. Publish
compares again inside it, avoiding duplicate work from queued runs.

An unchanged application commit and complete public snapshot can skip the build
and deployment only when their saved record matches GitHub's latest successful
Pages deployment. Missing records or uncertain API responses require publication.
Immediately before publishing, `main` must still match the build commit. A stale
run skips publication and snapshot saving; a failed freshness check stops it.
Only a successful publication from that run attempt can save the snapshot record.

**Retry publications with “Re-run all jobs”.** Partial reruns cannot publish or
save an artifact from an earlier attempt. Clearing the validation cache forces
fresh validation if needed.

## Nightly diagnostics

The Actions log and job summary report phase timings, HTTP attempts, retries,
rate limits, cache hits and incomplete checks. Timings can overlap and are not
additive. Earlier checkpoints survive a later failure; pruning or saving one
result type does not stop independent work.

Submitted/saved counters describe checkpoint payloads. `stats_facts_written`,
`stats_facts_unchanged` and `stats_checks_written` describe database row activity;
new or changed facts write both facts and timestamp rows. `cache_rows_written`
counts changed cache rows, and `cache_entries_pruned` counts unreferenced URLs
removed. These are not disk-I/O or runtime benchmarks.

When changing repository file parsing or selection, bump `CHECK_CACHE_VERSION` in
[nightly-cache.ts](../src/lib/nightly-cache.ts). Unchanged commits must still pick
up changed rules. Cache records are private, bounded to 64 KiB and maintained only
through Nightly-token functions. Long other-host README text is not cached.

Reports and member suggestions trigger a public “Waiting for an admin” issue with
counts only. `TELL` and `ADMIN_PAGE` in Nightly configure recipients and the admin
link. Ordinary wiki candidates do not trigger that issue.

## Recovery checks

| Symptom | What to check |
|---|---|
| Preparation fails | Required environment secrets and migration logs; fix forward with a new migration |
| Repository facts remain old | Host failures or rate limits in Nightly; failed checks intentionally retain known values |
| Snapshot export is refused | An unexpectedly short database response; the previous snapshot remains the build fallback |
| Wiki import is refused | Parser errors or a sudden drop in listed entries; repository checks still continue |
| Scheduled work stops | Actions workflow enablement and repository notification emails |

If the public list really has shrunk below the export guard, delete the `snapshot`
branch and redeploy so it has no previous list to compare. The guard applies when
the old snapshot has at least 20 entries and the new list is less than half its size.
Do this only after verifying that the smaller result is intentional.

If the wiki really has shrunk by more than a fifth, clear its stored comparison
with `delete from public.wiki_listing;` in the SQL editor. Investigate parser or
source failures before resetting either guard.

If GitHub disables a schedule, open Actions → the workflow → **Enable workflow**.
Nightly tries to keep the schedules enabled, but notification emails remain the
backstop. A paused Supabase project must be restored from its dashboard.

## Database administration

Migrations are append-only once applied. For manual hosted administration, first
authenticate and link the intended project:

```sh
npx supabase login
npx supabase link --project-ref <project-id>
npm run db:status
npm run db:push
```

These commands target the hosted project. For schema development, use the
[local migration workflow](development.md#database-changes).

## Backups and restore

Backups contain private account and site data. Nightly copies are encrypted with
`BACKUP_PASSPHRASE`, retained as Actions artifacts for 90 days, and tested by loading
them into a throwaway database. The latest seven verified copies also live on
the `backups` branch as one replacement commit. Repository mirrors can copy that
branch; its files remain encrypted. Keep the passphrase somewhere outside GitHub.
Each new encrypted archive also includes the matching migrations, backend
configuration, recovery script, package lockfile, and a manifest recording its
source commit and actual tool versions. The restore check uses these bundled
files after decrypting the archive.

```sh
npm run db:backup                    # unencrypted local copy, outside the repository
npm run db:backup:fetch              # download the latest encrypted nightly copy
gpg --decrypt backup.tar.gz.gpg > backup.tar.gz
mkdir recovery
tar -xzf backup.tar.gz -C recovery
# Follow recovery/README.md for verification and hosted recovery.
```

Keep decrypted files outside the repository. The default local backup directory
is `vanilla-addon-index-backups/` in your home folder. A restore check replaces
local test data with real backup data; run `npm run local` afterwards to reseed.

For a lost hosted database, follow the [bundled recovery instructions](backup-restore.md).
Use the archive's migrations and recorded CLI version to prepare an empty
replacement project, then load its SQL data before applying newer migrations.
Older `.sql.gpg` copies contain only data: obtain the matching migrations from
the original workflow commit before restoring them. Update the public
configuration and deployment secrets for the replacement project before resuming
imports and deployments. Encrypted backups cannot be recovered without their
passphrase.
