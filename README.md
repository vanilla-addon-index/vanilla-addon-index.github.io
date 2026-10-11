# Vanilla Addon Index

A community list of addons for the 1.12.1 client. Anyone can browse; anyone with an account can post addons and edit or delete their own.

- **Site:** static SvelteKit app on GitHub Pages
- **Accounts and data:** Supabase (free plan), protected by row-level security
- **Backup:** `static/addons.json` is refreshed daily by the deploy workflow and served as a fallback if the database is unreachable

## Setup

1. **Supabase:** create a project, then build its database from the migrations in [supabase/migrations](supabase/migrations): `npx supabase login`, `npx supabase link --project-ref <your project>`, `npm run db:push`.
2. **Config:** put the project URL and anon key in [src/lib/config.ts](src/lib/config.ts).
3. **Login providers:** in Supabase under Authentication → Sign In / Providers, enable Discord and GitHub with an OAuth app from each, and turn the Email provider off.
4. **Auth URLs:** in Supabase under Authentication → URL Configuration, set the site URL to `https://vanilla-addon-index.github.io` and add `http://localhost:5173` as a redirect URL.
5. **GitHub Pages:** push to a repository named `vanilla-addon-index.github.io` and set Settings → Pages → Source to "GitHub Actions".
6. **Owner:** after your first login, run `update public.profiles set is_owner = true where username = 'your-username';`. The owner can suspend admins and empty the trash.
7. **Admins:** anyone who is a *public* member of the GitHub organization and logs in with GitHub can edit or delete any addon. To make someone else an admin, tick `is_admin` on their row in Table Editor → `profiles`.

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
