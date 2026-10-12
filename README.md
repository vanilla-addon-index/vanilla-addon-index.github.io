# Vanilla Addon Index

**[vanilla-addon-index.github.io](https://vanilla-addon-index.github.io)** is a community list of addons for the 1.12.1 client of World of Warcraft. Anyone can browse it; anyone with an account can post addons and edit or delete their own. The site's [about page](https://vanilla-addon-index.github.io/about) says who runs it and what it stores.

This repository is the whole site: its code, its database and the jobs that keep it running. It costs nothing to run.

- **Site:** static SvelteKit app on GitHub Pages
- **Accounts and data:** Supabase (free plan), protected by row-level security
- **Snapshot:** every deploy writes the whole list to `addons.json`. Visitors read the list from it, and it stands in if the database is unreachable. The latest one is kept on the `snapshot` branch, as a single commit that replaces the one before, so `main` only ever holds your own commits and no deleted addon stays readable there
- **Backup:** a full, encrypted copy of the database is taken every night and kept for 90 days; see [Backups](#backups)

## Setting it up from nothing

In this order. Steps 1 to 4 are done once in Supabase, 5 to 8 once on GitHub, and 9 after the site is up.

1. **Supabase project:** create one, in the region you want the data kept in.
2. **Config:** in [src/lib/config.ts](src/lib/config.ts), set the project's URL and public key, the site's address and the repository's address. The project's id also appears as `--project-ref` in [deploy.yml](.github/workflows/deploy.yml) and [backup.yml](.github/workflows/backup.yml). The [about page](src/routes/about/+page.svelte) names who runs the site and where the data is kept.
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
| `npm test` | What each kind of account may and may not do, against the real database rules: posting, editing, groups, bans, the log, the trash, the import queue, deleting an account. Also the wiki parser, on small cases and a saved copy of the page | Nothing: a throwaway Postgres runs inside Node |
| `npm run test:e2e` | The site in a real browser as a visitor, a member, an admin and the owner. Fails if the page's Content-Security-Policy refused anything | Docker, for the local backend, which it wipes and refills first |

Neither touches the hosted database.

### How a change goes out

`main` is protected: a change reaches it through a pull request, and only once both jobs of the [CI workflow](.github/workflows/ci.yml) have passed.

| Workflow | Runs | Does |
|---|---|---|
| [CI](.github/workflows/ci.yml) | on every pull request | the database rule tests, the type check and a build; and the site in a real browser against a throwaway backend |
| [Deploy](.github/workflows/deploy.yml) | on every change to `main`, after Nightly, or by hand | five jobs in turn: rule tests and type check again; pending migrations; a fresh snapshot and the build; the publish; saving the snapshot. Only the migrations job is given the database password, and it installs nothing but the Supabase tool. Only the build job installs the site's dependencies, and it can read no secret and write nowhere |
| [Nightly](.github/workflows/nightly.yml) | once a day | keeps GitHub from switching the daily timers off, reads the wiki into the import queue, trims the log and the trash, and asks GitHub about every repository, then runs Deploy |
| [Backup](.github/workflows/backup.yml) | once a day | an encrypted copy of the database; see [Backups](#backups) |

Deploy and Nightly only touch the hosted database and the site when they run on `main`. Started by hand on another branch, they run the checks and stop there.

The snapshot is not replaced by a list less than half as long as the last one: that is more likely a database that answered wrongly than a list that shrank, and the run says so on its page. If the list really is that much shorter, delete the `snapshot` branch on GitHub and deploy again.

An addon posted between two deploys has no page of its own until the next one. It shows normally to anyone who opens it; only link previews and search engines wait.

## Keeping it running

### The daily timers

Nightly and Backup run on a timer, and GitHub switches the timers of a public repository off when it has had no activity for 60 days. Nothing commits to `main` by itself, so Nightly starts each run by marking both workflows as enabled, which starts the 60 days again.

GitHub does not promise that this keeps working. It sends an email before it switches a timer off, so make sure notifications for this repository reach an inbox that is read. If it happens: Actions → the workflow → "Enable workflow". With the timers off there are no backups, imports or deploys, and Supabase pauses the project after about a week without use; it is restored from the Supabase dashboard.

### When something is waiting for an admin

The site sends no email. When a report nobody has closed, or a member's suggestion nobody has decided, is waiting, the Nightly workflow opens an issue in this repository named "Waiting for an admin" and assigns it to the people named as `TELL` in [nightly.yml](.github/workflows/nightly.yml), whom GitHub then emails. It adds a comment when more arrives and closes the issue when nothing is left. A new addon, an edit or anything else that needs no admin never causes one. Issues are public, so it holds the two numbers and nothing else. The address it links to is `ADMIN_PAGE` in the same file.

### What members may link to

Nobody reviews an addon before it is listed, so a member's link must be on a site known for hosting code, and their screenshots on a site known for hosting code or pictures. A screenshot is only ever shown as a picture, so what its address ends in does not matter: one that is not a picture shows nothing. The two lists are `LINK_HOSTS` and `IMAGE_HOSTS` in [src/lib/config.ts](src/lib/config.ts) and `allowed_hosts()` in the database; a test fails if they differ, and adding a site takes a new migration. An entry such as `octowow.st/git` allows that part of a site and nothing else on it. Admins are not held to the lists, which is how an addon kept anywhere else gets listed, and how the wiki's entries keep the links they have.

### The nightly import

The [Nightly workflow](.github/workflows/nightly.yml) reads the Turtle WoW wiki's addon list into the import queue for an admin to review, trims the log and the trash of what is older than 90 days, and asks GitHub about every repository. It signs in like any visitor and holds a token of its own, which is good for those few database calls and nothing else: it cannot post, edit, delete, or make anyone an admin.

```sh
npm run nightly:token   # makes a token, and prints where its two halves go
```

The token goes to GitHub as the `NIGHTLY_TOKEN` secret, and its hash into the database with the one statement the command prints. Doing it again replaces the token; the old one stops working at once. Until the secret exists the import skips itself and the site still deploys.

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

The nightly copies exist only on GitHub, in this repository. Run `npm run db:backup:fetch` now and then to keep one somewhere else as well; it stays encrypted, so it can be stored anywhere.

To recover from losing the hosted database: create a new project, `npx supabase link` it, build its tables with `npm run db:push`, then load the backup file into it with `psql`. Without the passphrase the nightly copies cannot be opened.
