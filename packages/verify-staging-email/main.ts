import { execFileSync } from 'node:child_process';

export function verificationLink(html: string): string | undefined {
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    const href = match[2].replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name: string) => {
      if (name.startsWith('#')) {
        const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
      }
      return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name.toLowerCase()] ?? entity;
    });
    if (/[\x00-\x20\x7f-\x9f]/.test(href)) continue;
    try {
      const url = new URL(href);
      if (url.protocol === 'https:' && url.pathname === '/authentication/verify-email') return href;
    } catch { /* Ignore other email links. */ }
  }
}

function secret(field: string): string {
  return execFileSync('op', ['read', '--account', 'elephantcompany.1password.com',
    `op://Engineering/Staging Env/Supabase/${field}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000,
    // macOS can block op's automatic detection of the desktop integration setting.
    env: { ...process.env, OP_BIOMETRIC_UNLOCK_ENABLED: 'true' },
  }).trim();
}

export function main(args: string[]): void {
  if (args.length !== 1 || !/^[^\s\x00-\x1f\x7f-\x9f@]+@[^\s\x00-\x1f\x7f-\x9f@]+$/.test(args[0])) {
    throw new Error('Usage: verify-staging-email <email>');
  }
  const email = args[0];
  const project = secret('Project ID');
  if (!/^[a-z0-9]+$/.test(project)) throw new Error('Invalid staging Supabase project ID');
  const result = execFileSync('psql', ['-X', '--no-password', '--quiet', '--tuples-only', '--no-align',
    '--set', 'ON_ERROR_STOP=1', '--set', `recipient=${email}`], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PGHOST: `db.${project}.supabase.co`, PGPORT: '5432',
      PGDATABASE: 'postgres', PGUSER: 'postgres', PGPASSWORD: secret('DB Password'),
      PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=10000' },
    input: `SELECT json_build_object('html', html) FROM public.test_emails
      WHERE recipient = :'recipient' AND html LIKE '%/authentication/verify-email%'
      ORDER BY created_at DESC, id DESC LIMIT 1;\n`,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
  if (!result) throw new Error(`No verification email found for ${email}`);
  const link = verificationLink(JSON.parse(result).html ?? '');
  if (!link) throw new Error(`No verification link found for ${email}`);
  execFileSync('/usr/bin/pbcopy', [], { input: link, timeout: 10_000 });
  process.stdout.write(`${email}\n`);
}

if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not retrieve staging verification email');
    process.exitCode = 1;
  }
}
