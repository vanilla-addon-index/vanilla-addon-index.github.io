# Set up an instance

[← README](../README.md) · [Development](development.md) · [Operations](operations.md)

This guide covers a hosted instance. For a development copy, use the
[local environment](development.md#local-environment).

## Supabase

1. Create a project in the region where you want its data stored.
2. Update the public Supabase URL/key, site URL and repository URL in
   [config.ts](../src/lib/config.ts). Replace the project reference in
   [prepare.yml](../.github/workflows/prepare.yml) and
   [backup.yml](../.github/workflows/backup.yml). Update the site's
   [about page](../src/routes/about/+page.svelte) with the operator and data location.
3. Enable Discord and GitHub under Authentication → Sign In / Providers, using
   OAuth apps for this instance. Disable the Email provider.
4. Under Authentication → URL Configuration, set the hosted site URL. Add
   `http://localhost:5173` as a redirect URL if you intend to use development mode
   against that hosted project. The separate local backend uses port 5174.

## GitHub

Use an organization/user Pages repository named `<owner>.github.io`. In Settings →
Pages, select **GitHub Actions** as the source.

Create a `database` environment restricted to `main`, disable administrator
bypass, and put the following secrets there rather than at repository scope:

| Secret | Purpose |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI access for migrations and backups |
| `SUPABASE_DB_PASSWORD` | Database access for migrations and backups |
| `NIGHTLY_TOKEN` | Narrow import and repository-maintenance calls |
| `BACKUP_PASSPHRASE` | Encrypts backups; keep a separate recovery copy |

Scope the Supabase access token to this project and the permissions needed for
the CLI to discover its database connection. The application does not use a
Supabase secret/service-role key. Jobs with database credentials do not install
the site's dependencies.

Generate the Nightly token with:

```sh
npm run nightly:token
```

Save the token as the environment secret and run the printed hash-storage SQL in
Supabase. Repeating this command and replacing the stored hash rotates the token;
the previous token then stops working.

Push the configured code to `main` to apply migrations and deploy. Missing
migration credentials stop preparation; missing Nightly tokens fail the import.
Backup skips its work until all required backup secrets are configured.

Protect `main` with required PRs and both CI checks: **Tests, types and build** and
**Browser tests**, including for admins. Restrict the `github-pages` deployment
environment to `main` as well.

## Assign the owner

Sign in once, then run this in Supabase's SQL editor with the account's username:

```sql
update public.profiles set is_owner = true where username = 'your-username';
```

The owner manages admins through the Users page. Role changes take effect
immediately and are logged. Run Nightly on `main` to populate repository facts and
verified code-update dates, then confirm that Backup succeeds and its recovery
passphrase is stored outside GitHub.
