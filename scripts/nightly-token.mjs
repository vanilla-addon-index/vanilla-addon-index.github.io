// Makes a new token for the nightly job and says where its two halves go.
//
//   npm run nightly:token
//
// The token itself goes to GitHub, as the NIGHTLY_TOKEN secret. The database only gets
// its SHA-256, so reading the database does not give the token away. Running this again
// and following the steps replaces the old token, which stops working at once.
import { createHash, randomBytes } from 'node:crypto';

const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');

console.log(`1. On GitHub, under Settings -> Secrets and variables -> Actions, set NIGHTLY_TOKEN to:

${token}

2. In Supabase, run this in the SQL editor:

insert into public.nightly_token (hash) values ('${hash}')
on conflict (id) do update set hash = excluded.hash, set_at = now();
`);
