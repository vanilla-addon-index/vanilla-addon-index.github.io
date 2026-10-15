# Vanilla Addon Index

[Vanilla Addon Index](https://vanilla-addon-index.github.io) is a community directory
of World of Warcraft addons for the **1.12.1 client**.
Browse and search the list, find alternate versions, or sign in to post addons
and manage your own entries.

## How it works

- **SvelteKit on GitHub Pages** serves the site and a public addon snapshot.
- **Supabase** handles accounts and live data. PostgreSQL rules enforce permissions;
  the browser receives a public key, not database credentials.
- **GitHub Actions** imports wiki candidates for admin review, checks repositories
  daily, refreshes the published site when needed, and makes encrypted backups.

The snapshot keeps browsing fast and available during database outages. Recent
posts and edits are fetched separately. See [the architecture guide](docs/architecture.md)
for the data flow and freshness limits.

## Run locally

Use Node.js 24 and a running Docker installation.

```sh
npm ci
npm run local
npm run dev:local
```

Open **http://localhost:5174**. The local backend includes sample addons and test
accounts for each role. Running `npm run local` again resets that local data;
`npm run local:stop` stops the backend.

`npm run dev` connects to the **hosted database** instead. Changes made there are real.

Before opening a PR, run `npm test`, `npm run check` and `npm run build`.
The [development guide](docs/development.md) covers test prerequisites, browser
tests and database migrations.

## Developer guides

| I want to… | Start here |
|---|---|
| Develop or test a change | [Development](docs/development.md) |
| Understand the site and its data | [Architecture](docs/architecture.md) |
| Set up another instance | [Setup](docs/setup.md) |
| Deploy, troubleshoot or restore a backup | [Operations](docs/operations.md) |

Changes reach `main` through pull requests that pass both CI jobs. Production
deployment runs after merging.

## License

[MIT](LICENSE).
