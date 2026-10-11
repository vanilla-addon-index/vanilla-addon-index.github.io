# Vanilla Addon Index

A community list of addons for the 1.12.1 client. Anyone can browse; anyone with an account can post addons and edit or delete their own.

- **Site:** static SvelteKit app on GitHub Pages
- **Accounts and data:** Supabase (free plan), protected by row-level security
- **Snapshot:** the deploy workflow writes the whole list to `addons.json` daily; visitors read the list from it, and it stands in if the database is unreachable. Its history is on the `snapshot` branch, so `main` only ever holds your own commits. `npm run snapshot` fetches one for a build on your computer
- **Backup:** a full, encrypted copy of the database is taken every night and kept for 90 days; see [Backups](#backups)

## Setup

1. **Supabase:** create a project, then build its database from the migrations in [supabase/migrations](supabase/migrations): `npx supabase login`, `npx supabase link --project-ref <your project>`, `npm run db:push`.
2. **Config:** put the project URL and anon key in [src/lib/config.ts](src/lib/config.ts).
3. **Login providers:** in Supabase under Authentication → Sign In / Providers, enable Discord and GitHub with an OAuth app from each, and turn the Email provider off.
4. **Auth URLs:** in Supabase under Authentication → URL Configuration, set the site URL to `https://vanilla-addon-index.github.io` and add `http://localhost:5173` as a redirect URL.
5. **GitHub Pages:** push to a repository named `vanilla-addon-index.github.io` and set Settings → Pages → Source to "GitHub Actions".
6. **Owner:** after your first login, run `update public.profiles set is_owner = true where username = 'your-username';`. The owner can suspend admins and empty the trash.
7. **Admins:** anyone who is a *public* member of the GitHub organization and logs in with GitHub can edit or delete any addon. To make someone else an admin, tick `is_admin` on their row in Table Editor → `profiles`.

## How a change goes out

`main` is protected: a change reaches it through a pull request, and only once both jobs of the [CI workflow](.github/workflows/ci.yml) have passed.

| Workflow | Runs | Does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | on every pull request | the database rule tests, the type check and a build; and the site in a real browser against a throwaway backend |
| [Deploy](.github/workflows/deploy.yml) | on every change to `main`, after Nightly, or by hand | rule tests and type check again, pending migrations, a fresh snapshot, then builds and publishes the site |
| [Nightly](.github/workflows/nightly.yml) | once a day | reads the wiki into the import queue and asks GitHub about every repository, then runs Deploy |
| [Backup](.github/workflows/backup.yml) | once a day | an encrypted copy of the database; see [Backups](#backups) |

## The nightly import

The [Nightly workflow](.github/workflows/nightly.yml) reads the wiki into the import queue and asks GitHub about every repository. It signs in like any visitor and holds a token of its own, which is good for those few database calls and nothing else; the project's secret key is not used anywhere.

```sh
npm run nightly:token   # makes a token, and prints where its two halves go
```

The token goes to GitHub as the `NIGHTLY_TOKEN` secret, and its hash into the database with the one statement the command prints. Doing it again replaces the token; the old one stops working at once. Until the secret exists the import skips itself and the site still deploys.

## Changing the database

The database is described by the numbered files in [supabase/migrations](supabase/migrations). Each one is applied once, in order, and Supabase remembers which have run, so nothing is pasted into the SQL editor by hand and no file is ever run twice.

```sh
npm run db:new -- add_something   # a new, empty migration to write the change in
npm run local                     # rebuilds the local backend from all migrations
npm test && npm run test:e2e      # the rules, and the site in a browser, against it
npm run db:status                 # which migrations the hosted database has had
npm run db:push                   # applies the ones it has not
```

A migration that has reached the hosted database is never edited again: a later change goes in a new one. With the `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` secrets set on the repository, the deploy applies pending migrations itself before the site goes out, and stops if one fails.

## Backups

The free Supabase plan keeps no backups, so the [Backup workflow](.github/workflows/backup.yml) takes a full copy of the hosted database every night: every table of the site, and the accounts. Because the copy holds private data and this repository is public, it is encrypted with the `BACKUP_PASSPHRASE` secret before GitHub stores it, and kept for 90 days. The table structure is not in it; the migrations are that.

```sh
npm run db:backup                       # a copy on this computer, in backups/ (ignored by git)
npm run db:backup:check -- <file>       # loads a copy into the local backend, to show it restores
gpg --decrypt backup.sql.gpg > backup.sql   # opens a nightly copy downloaded from GitHub
```

To recover from losing the hosted database: create a new project, `npx supabase link` it, build its tables with `npm run db:push`, then load the backup file into it with `psql`. Keep the passphrase somewhere other than GitHub: without it the nightly copies cannot be opened.

## Development

```sh
npm install
npm run dev
```

`npm run check` type-checks, `npm run build` writes the static site to `build/`.

## Tests

`npm test` checks what each kind of account may and may not do: posting, editing, merging, bans, the log, the trash and the import queue. It applies the migrations to a throwaway Postgres running inside Node, with dummy owner, admin and member accounts, and never touches the hosted database.

### Browser tests and a local copy of the backend

`npm run test:e2e` drives the real site in a real browser as a visitor, a member, an admin and the owner: posting, the import review, reports, limits, and undoing things from the log. It needs Docker running. It starts a copy of the whole backend on this computer (Postgres, the API and the login service), builds it from the migrations, fills it with test addons, a full import queue and one account of each kind, and runs the tests in `tests/e2e/` against it. The hosted database is never involved.

The same copy is there for trying things out by hand:

```sh
npm run local       # start it, or wipe and refill it
npm run dev:local   # the site against it, on http://localhost:5174
npm run local:stop  # stop it
```

On that address the login page offers the test accounts, one click each: the owner, two admins, two members and a banned member. `npm run dev` still uses the hosted database, where everything you do is real.

## Wiki import

`node scripts/wiki-import.mjs` reads the addon list from the Turtle WoW wiki and writes a report and the parsed candidates to `wiki-import/`. It is a dry run and changes nothing in the database.
