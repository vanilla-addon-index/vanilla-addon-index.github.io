# Tests

Tests are grouped by the behavior they cover. Small suites are welcome when they
have a clear responsibility; there is no target file count.

| Folder | What belongs here |
| --- | --- |
| `app/` | List filtering and sorting, visitor data merging, import suggestions, and wiki parsing. |
| `database/` | Database permissions, migrations, posting, moderation, recovery, imports, and nightly storage. |
| `nightly/` | Importer execution, repository hosts, requests, caching, workers, and metrics. |
| `publication/` | Publication workflows, deployment validation, snapshot saving, and backup recovery. |
| `e2e/` | Browser journeys against the local Supabase backend. |
| `helpers/` | Shared database setup and executable child-process helpers. |
| `fixtures/` | Saved input data, including the wiki page sample. |

## Running tests

Use the Node version required by `package.json` and install dependencies with
`npm ci`.

```sh
npm test
node --test "tests/database/*.test.mjs"
node --test tests/app/addon-list.test.mjs
npm run check
npm run build
```

`npm test` discovers `*.test.mjs` recursively under `tests/`. Helper scripts and
browser specs are excluded. Node suites use local fixtures, mocked network
responses, temporary directories, or PGlite; they do not write to hosted services.
Some publication and backup tests execute Bash and command-line tools. On Windows
they use Git for Windows' Bash; `jq` must also be available on its PATH for the
snapshot-saving test.

Browser tests require Docker, the local Supabase services, and Playwright Chromium:

```sh
npx playwright install chromium
npm run test:e2e
```

**`npm run test:e2e` resets and seeds the local backend before running.** It does
not reset the hosted database. Stop the local services afterward with
`npm run local:stop` when they are no longer needed.

To run one browser file against an already prepared local backend:

```sh
npx playwright test tests/e2e/1-visitor.spec.ts
```

Individual browser files may require state created by earlier files. Use the full
suite for reliable verification.

## Isolation and ordering

Database tests use `helpers/db.mjs`, which applies the real migrations to PGlite
and creates a fresh database from a cached schema for each test. The split rules
suites use `helpers/rules-context.mjs` to create the same five accounts and common
query helpers. Keep setup and cleanup hooks intact, including nested hooks that
create subject-specific data. Close each database after use.

Browser tests share one seeded database and run with one worker in numbered file
order: visitor, member, admin, contributor edits, imports, then UI category.
For example, the admin suite handles a report created by the member suite.
The combined import suite preserves the original order: member submission,
screenshots, then fork and similar-name approval. Each test still gets its own
browser page and the shared Content Security Policy check from `e2e/test.ts`.
Do not enable parallel browser execution or change this order without first
removing those shared-state dependencies.

## Adding coverage

Add tests to the subject they exercise. Keep database storage checks in
`database/` even when the caller is Nightly; keep importer orchestration in
`nightly/`. Keep browser coverage for behavior that needs the real UI.

Extract helpers only when setup is actually shared. Keep saved inputs in
`fixtures/` and executable helpers in `helpers/`. Resolve files relative to
`import.meta.url` so suites can run independently of the working directory.
Avoid merging independent suites simply because one is short.
