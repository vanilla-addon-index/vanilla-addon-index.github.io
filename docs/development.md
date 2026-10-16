# Development

[← README](../README.md) · [Architecture](architecture.md) · [Operations](operations.md)

## Local environment

Use Node.js 24, Git and Docker. The package supports Node 22.18 and newer;
production workflows use Node 24.

```sh
npm ci
npm run local
npm run dev:local
```

The site opens at http://localhost:5174 against a local Supabase backend. Migrations
create the schema, and the seed supplies addons, an import queue and accounts for
testing member, admin and owner behavior. The local login page offers the
test accounts directly. `npm run local` wipes and reseeds the local backend each
time; `npm run local:stop` stops it.

`npm run dev` uses the hosted database on port 5173. Use `dev:local` for experiments.

## Checks

| Command | Purpose | Requirements |
|---|---|---|
| `npm test` | Database permissions, parsers, importer and workflow behavior | Git, Bash and jq; database tests use Postgres inside Node |
| `npm run check` | Svelte and TypeScript checks | Installed dependencies |
| `npm run build` | Production static build | Installed dependencies |
| `npm run test:e2e` | Browser tests against a reset local backend | Docker and Playwright Chromium |

On Windows, shell tests use Git Bash from a standard Git installation; put jq on
`PATH`. Install the browser before the first browser-test run:

```sh
npx playwright install chromium
npm run test:e2e
```

On Linux, Playwright may also need its system dependencies; CI uses
`npx playwright install --with-deps chromium`. The test suites do not write to the
hosted database. Browser tests reset the local backend.

## Database changes

Add a migration rather than editing one that has already been applied:

```sh
npm run db:new -- describe_the_change
npm run local
npm test
npm run test:e2e
```

Files in [supabase/migrations](../supabase/migrations) run once, in order. Test both
the rule change and the user flow it affects. Deployment applies pending
migrations before publishing code that depends on them.

See the [database guide](../supabase/README.md) for the table map, migration entry
points, local configuration and instructions for inspecting the current schema.

## Useful entry points

- [src/routes](../src/routes): pages and forms.
- [src/lib](../src/lib): shared UI, account state and data access.
- [src/lib/config.ts](../src/lib/config.ts): public configuration, categories and allowed hosts.
- [tests/README.md](../tests/README.md): test organization, commands and browser ordering constraints.
- [scripts](../scripts): local backend, importer, snapshot and backup tools.

For wiki-parser work, `node scripts/wiki-import.mjs` reads the current wiki and
writes a dry-run report to `wiki-import/` without changing the database. The saved
wiki fixture and its expected categories live in [wiki.test.mjs](../tests/app/wiki.test.mjs).

Member link rules are defined in `LINK_HOSTS` and `IMAGE_HOSTS` in the public config
and `allowed_hosts()` in SQL. Change both together; a test checks they agree.
