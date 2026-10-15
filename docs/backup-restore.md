# Restore an encrypted nightly backup

Decrypt and extract the archive in a private directory outside the repository:

```sh
gpg --decrypt backup.tar.gz.gpg > backup.tar.gz
mkdir recovery
tar -xzf backup.tar.gz -C recovery
cd recovery
```

The archive holds private database data in `backup.sql`, its matching
`supabase/migrations`, local backend configuration, package and lock files,
the restore-check script, and public configuration needed by that script.
`manifest.json` records the source commit, workflow run, creation time, and
actual Node and Supabase CLI versions. It contains no deployment credentials.

Install the Supabase CLI version recorded in the manifest and use the recorded
Node version. Docker is required for the local check. Set `SUPABASE_CLI` to
`supabase` so the script uses that installed CLI without installing application
dependencies.

## Verify locally

This resets the local backend named `vanilla-addon-index`; stop any development
session using it first. The resulting local database contains real private data.

```sh
export SUPABASE_CLI=supabase
supabase start -x realtime,storage-api,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
node scripts/backup.mjs check backup.sql
```

## Recover a hosted database

Use a new, empty Supabase project. From this extracted directory, authenticate,
link the replacement project, and apply the bundled migrations:

```sh
supabase login
supabase link --project-ref <replacement-project-id>
supabase db push --linked
psql "$REPLACEMENT_DATABASE_URL" -v ON_ERROR_STOP=1 -f backup.sql
```

Use the replacement project's database connection string for
`REPLACEMENT_DATABASE_URL`. Restore the data before applying migrations from
newer application versions. Coordinate the application version and database
upgrade, then update the site's public configuration and deployment secrets.
Verify logins, permissions and addon data before resuming imports and publication.

Keep the passphrase outside GitHub. Delete decrypted files and local databases
when recovery work is finished. Older `.sql.gpg` copies contain only SQL: recover
those with the migrations from their original workflow commit.
