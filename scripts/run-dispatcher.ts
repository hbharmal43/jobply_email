// Run the recommendation dispatcher locally with your AWS credentials.
//
//   npm run dispatch:local -- --user <uuid> [--user <uuid>] [--dry-run]
//
// --dry-run builds and prints each user's digest payload and writes nothing.
// Without it this sends REAL Customer.io events: only use your own user id.

async function main() {
  process.env.SUPABASE_SECRET_ID ??= 'jobply-email/development/supabase';
  process.env.ENVIRONMENT ??= 'production';

  const args = process.argv.slice(2);
  const userIds = args.flatMap((arg, i) => (arg === '--user' && args[i + 1] ? [args[i + 1]] : []));
  const dryRun = args.includes('--dry-run');
  if (userIds.length === 0) {
    console.error('pass at least one --user <uuid>');
    process.exit(2);
  }
  if (!dryRun) process.env.PRODUCTION_MODE = 'true';

  // Imported after the env is set: the handler reads PRODUCTION_MODE at load time.
  const { handler } = await import('../lambdas/recommendation-dispatcher/handler.js');
  await handler({ dryRun, userIds }, {});
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
