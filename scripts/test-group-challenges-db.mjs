// Regression test for supabase/migrations/0007_group_challenges.sql.
//
// Group challenges is the first genuinely multi-user, shared-visibility
// feature in this app, and its RLS is built around a SECURITY DEFINER
// membership check plus SECURITY DEFINER RPC functions for every mutation
// (see 0007's own comments for why). That is exactly the kind of thing
// that looks right on a read-through and is wrong in a way you only find
// by actually running it as more than one simulated user. This spins up a
// throwaway Postgres database, applies every real migration in order
// unmodified (never edited or mocked for the test), runs
// test-group-challenges-db.sql (which exercises RLS isolation and the
// shared streak arithmetic as several different simulated users via
// test-group-challenges-stub.sql's auth.uid() stand in), and fails loudly
// on the first thing that does not match, then drops the scratch database
// whether it passed or not.
//
// Requires a real Postgres server reachable via psql/createdb/dropdb with
// the ordinary PG* environment variables (PGHOST, PGPORT, PGUSER,
// PGPASSWORD) — this is not something node alone can fake, unlike
// test-mpesa-parser.mjs. If you don't have a local Postgres, install one
// (the postgresql package on most systems) and make sure the current user
// can create databases (createuser --createdb, or run as a role that can).
//
// Run with: node scripts/test-group-challenges-db.mjs

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'supabase', 'migrations');
const stubSqlPath = join(__dirname, 'test-group-challenges-stub.sql');
const testSqlPath = join(__dirname, 'test-group-challenges-db.sql');
const dbName = `savelock_challenge_test_${randomBytes(4).toString('hex')}`;

const MIGRATIONS = [
  '0001_init.sql',
  '0002_google_auth.sql',
  '0003_mpesa_transactions.sql',
  '0004_owner_flag.sql',
  '0005_mpesa_functions.sql',
  '0006_goal_balance_readable.sql',
  '0007_group_challenges.sql',
];

// Guards against a run that aborted early (e.g. a raised exception not
// caught by any DO block above) from reporting a false all clear just
// because zero of the checks that did run happened to fail.
const MIN_EXPECTED_CHECKS = 22;

function psqlFile(database, filePath) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-d', database, '-f', filePath], { encoding: 'utf8' });
}

try {
  execFileSync('psql', ['--version'], { stdio: 'ignore' });
} catch {
  console.error("psql is not on PATH. This test needs a real local Postgres server; see this file's own header.");
  process.exit(1);
}

let created = false;
try {
  execFileSync('createdb', [dbName], { stdio: 'inherit' });
  created = true;

  psqlFile(dbName, stubSqlPath);
  for (const m of MIGRATIONS) {
    psqlFile(dbName, join(migrationsDir, m));
  }

  const output = psqlFile(dbName, testSqlPath);

  const results = [];
  for (const line of output.split('\n')) {
    const idx = line.indexOf('RESULT|');
    if (idx === -1) continue;
    const [status, ...descParts] = line.slice(idx + 'RESULT|'.length).split('|');
    results.push({ status, desc: descParts.join('|') });
  }

  for (const r of results) {
    console.log(`${r.status === 'PASS' ? 'PASS' : 'FAIL'}  ${r.desc}`);
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  if (results.length < MIN_EXPECTED_CHECKS) {
    console.log(`\nOnly ${results.length} checks ran (expected at least ${MIN_EXPECTED_CHECKS}) — the script likely aborted early.`);
    process.exitCode = 1;
  } else {
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  }
} catch (err) {
  console.error('Test run failed:', err.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      execFileSync('dropdb', [dbName], { stdio: 'ignore' });
    } catch {
      console.error(`Could not drop scratch database ${dbName}, you may need to drop it by hand.`);
    }
  }
}
