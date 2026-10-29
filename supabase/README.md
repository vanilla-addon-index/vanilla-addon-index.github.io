# Database

Supabase provides PostgreSQL, authentication and the Data API. The browser talks
directly to that API, so SQL grants, row-level security policies and narrow
database functions enforce the application's permissions.

[`migrations/`](migrations/) is the source of truth. Apply the files in timestamp
order to build the database. Later migrations can replace earlier functions,
change policies and transform existing data; an early definition is not
necessarily the current behavior.

## Folder contents

| Path | Purpose |
| --- | --- |
| `migrations/` | Versioned schema, permissions, functions and data upgrades. |
| `config.toml` | Local CLI configuration, ports and authentication settings. |
| `.temp/`, `.branches/` | Ignored CLI state; do not move into source control. |
| `snippets/` | Ignored local SQL snippets, not an application or deployment input. |

Test accounts and sample data come from [`scripts/local.mjs`](../scripts/local.mjs),
not `seed.sql`. Automatic SQL seeding is disabled in the configuration.

## Database map

All objects below are in the `public` schema. Supabase manages the separate
`auth` schema; its user records are linked to application profiles.

| Area | Tables or views | Main responsibilities |
| --- | --- | --- |
| Catalog | `addons`, `profiles` | Published pages, repository links and public account identity. Role flags have separate access rules. |
| Contributions | `addon_link_contributions`, `addon_contributors` | Private ownership of active links and participation that survives link removal. |
| Edit reviews | `addon_edit_requests` | Private proposals, original values, reviewed fields and decisions. |
| Moderation | `reports`, `group_suggestions` | Reports and suggested grouping awaiting admin decisions. |
| Recovery | `activity_log`, `addon_trash` | Reversible edits, deleted pages and moderation history. |
| Account safeguards | `banned_identities`, `left_posts` | Ban continuity and posting limits after account deletion. |
| Imports | `import_queue`, `wiki_listing` | Wiki candidates, decisions and the guard against unexpectedly short wiki results. |
| Repository facts | `repo_stats`, `repo_stats_checks`, `repo_missing_since`, `repo_stats_current` (view) | Private repository facts, check times and missing-link grace periods; facts and check times are combined for admin reads. |
| Code dates | `repo_code_updates` | Commit dates for exact repository, branch or folder URLs; derived public dates live on `addons`. |
| Check cache | `repo_check_cache` | Private reusable repository checks, maintained by Nightly. |
| Nightly authentication | `nightly_token` | Hash of the dedicated maintenance token; not readable through the application API. |

Visitors receive public catalog fields. Members can submit content and manage
their permitted contributions. Shared pages require reviewed member edits.
Admins review imports, reports and proposals; the owner appoints admins.
Policies and functions enforce the details, including bans, rate limits and
field-level access. Do not infer permissions from a table name or a single GRANT.

Nightly calls token-checked functions such as `queue_imports`, `nightly_links`,
`store_repo_stats`, `store_code_updates`, `store_queue_images` and
`store_repo_check_cache`. Its dedicated token does not grant general account
administration. See [`docs/architecture.md`](../docs/architecture.md) for the
application flows and [`docs/operations.md`](../docs/operations.md) for maintenance
and recovery.

## Finding the relevant SQL

These are useful entry points, not standalone schemas or a list of every later
replacement. Search subsequent migrations for the function being changed,
including overloads and `DROP FUNCTION` statements.

| Subject | Migration entry points |
| --- | --- |
| Base tables and signup | [Initial schema](migrations/20261011000001_schema.sql) |
| Moderation, history and trash | [Moderation](migrations/20261011000005_moderation.sql), [restoration](migrations/20261012000003_restore_as_it_was.sql) |
| Roles and admin appointment | [Owner-appointed admins](migrations/20261012000009_owner_appoints_admins.sql) |
| Allowed repository and image hosts | [Host validation](migrations/20261012000010_allowed_hosts.sql), [SourceForge removal](migrations/20261014000002_drop_sourceforge.sql), [Bitbucket removal](migrations/20261014000003_drop_bitbucket.sql) |
| Shared pages and link contributions | [Shared addon links](migrations/20261015000002_shared_addon_links.sql) |
| Contributor proposals and decisions | [Edit reviews](migrations/20261015000003_contributor_edit_reviews.sql) |
| Submitted links resolving imports | [Submitted imports](migrations/20261015000005_submitted_imports.sql) |
| Import screenshots | [Screenshot approval](migrations/20261016000001_import_screenshots.sql) |
| Category compatibility | [UI & Appearance](migrations/20261016000002_ui_appearance_category.sql) |
| Code dates and link ordering | [Code updates](migrations/20261014000004_code_updates.sql), [link dates](migrations/20261015000004_link_code_updates.sql) |
| Repository caching and write accounting | [Check cache](migrations/20261014000006_repo_check_cache.sql), [write accounting](migrations/20261015000001_nightly_write_accounting.sql) |
| Nightly token | [Token functions](migrations/20261011000013_nightly_token.sql) |

For example, from the repository root:

```sh
rg -n 'function public\.approve_imports|drop function.*approve_imports' supabase/migrations --glob '*.sql'
```

## Local configuration and startup

Run these commands from the repository root with Docker available:

```sh
npm run local
npm run dev:local
```

**`npm run local` resets and seeds the local database every time.** It writes
`.env.localdb` for the app and creates the dummy accounts used by browser tests.
It does not reset the hosted project. `npm run dev` uses the hosted backend;
use `dev:local` for experiments. Stop the local services with `npm run local:stop`.

| Local endpoint | Address |
| --- | --- |
| Application and Auth site URL | `http://localhost:5174` |
| Additional allowed Auth redirect origin | `http://127.0.0.1:5174` |
| Data API | `http://127.0.0.1:54321` |
| PostgreSQL | Port `54322` (PostgreSQL 17) |
| Schema diff shadow database | Port `54320` |
| Studio | `http://127.0.0.1:54323` |

The config retains the existing CLI service settings. The supported startup
script excludes Realtime, Storage, image processing, the mail viewer, Edge
Runtime, analytics/logging and the connection pooler. Those services are not
needed for the site's local test workflow. Starting Supabase directly can start
more services than `npm run local`.

Local accounts use password login. Hosted GitHub/Discord OAuth providers and
their redirect settings are configured separately; this file is not a complete
description of hosted authentication. After changing local startup or Auth
settings, restart the local services so the containers receive the new values.
See the [Supabase CLI configuration reference](https://supabase.com/docs/guides/local-development/cli/config)
and [redirect URL documentation](https://supabase.com/docs/guides/auth/redirect-urls).

## Making a database change

1. Create a migration with `npm run db:new -- describe_the_change`.
2. Add only the SQL needed for that change. Preserve already applied files and
   timestamps; fix mistakes through a new migration.
3. Use consistent SQL formatting, explicit schema names and explicit grants.
   For privileged functions, follow the existing `SECURITY DEFINER` and empty
   `search_path` pattern, checking authorization inside the function.
4. Update the relevant tests in [`tests/database/`](../tests/database/) and browser
   journeys when the UI is affected. Cover refused access and existing-data
   upgrades as well as fresh inserts where relevant.
5. Run `npm test`, `npm run check`, `npm run build` and `npm run test:e2e`.
   The browser command rebuilds the real local backend from the migrations;
   Node database tests use PGlite with the same SQL files.

Keep migrations compatible with the currently deployed site: deployment applies
them before publishing the replacement application. Do not make schema changes
only in the hosted SQL editor. The normal deployment workflow applies migrations
from `main`; manual hosted operations are documented in
[`docs/operations.md`](../docs/operations.md#database-administration).

## Inspecting the current schema

Use local Studio to inspect the rebuilt database. For a searchable schema-only
reference, first run `npm run local` to ensure all current migrations are applied,
then export from the repository root:

```sh
mkdir -p backups
npx supabase db dump --local --schema public --file backups/schema-reference.sql
```

In PowerShell, replace the first command with
`New-Item -ItemType Directory -Force backups`. The dump command exports schema
definitions, not table rows. `backups/` and SQL dumps are ignored by Git. Regenerate
this reference after migration changes; do not edit it or deploy it as a migration.
Keeping it local avoids a second committed schema that can drift from the history.
This reference is not a data backup; follow the documented backup and recovery
process for recovery copies.
