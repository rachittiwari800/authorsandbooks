import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initializeDatabase } from './db.js';

export type ProvisionedAccount = {
  email: string;
  name: string;
  role: 'author' | 'admin';
  password: string;
};

export function provisionAccounts(
  database: Database.Database,
  resetExisting = false,
  generatePassword: () => string = () => randomBytes(24).toString('hex'),
  adminEmail = 'admin@bookleaf.local',
): ProvisionedAccount[] {
  const authors = database.prepare(`
    SELECT id, external_id AS externalId, name, email
    FROM authors
    WHERE is_active = 1
    ORDER BY external_id
  `).all() as Array<{ id: string; externalId: string; name: string; email: string }>;
  if (authors.length === 0) {
    throw new Error('No active authors are present. Seed the publishing dataset before provisioning accounts.');
  }

  const activeUsers = database.prepare('SELECT COUNT(*) AS count FROM users WHERE is_active = 1')
    .get() as { count: number };
  if (activeUsers.count > 0 && !resetExisting) {
    throw new Error('Active accounts already exist. Use --reset-existing only when intentionally replacing all author and admin passwords.');
  }

  const emails = new Set<string>();
  const generated: Array<{
    id: string;
    authorId: string | null;
    email: string;
    name: string;
    role: 'author' | 'admin';
    password: string;
  }> = authors.map((author) => {
    const email = author.email.trim().toLowerCase();
    if (!email || emails.has(email)) throw new Error('Author records contain a missing or duplicate email address.');
    emails.add(email);
    return {
      id: `user_${author.externalId}`,
      authorId: author.id,
      email,
      name: author.name,
      role: 'author' as const,
      password: generatePassword(),
    };
  });
  const normalizedAdminEmail = adminEmail.trim().toLowerCase();
  if (!normalizedAdminEmail || emails.has(normalizedAdminEmail)) {
    throw new Error('The admin login email conflicts with an author email.');
  }
  generated.push({
    id: 'user_admin',
    authorId: null,
    email: normalizedAdminEmail,
    name: 'BookLeaf Admin',
    role: 'admin',
    password: generatePassword(),
  });

  const passwords = new Set(generated.map((account) => account.password));
  if (passwords.size !== generated.length || generated.some((account) => account.password.length < 24)) {
    throw new Error('Password generator must return a distinct password of at least 24 characters for every account.');
  }

  const insertUser = database.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, author_id, is_active)
    VALUES (@id, @email, @passwordHash, @name, @role, @authorId, 1)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash,
      name = excluded.name,
      role = excluded.role,
      author_id = excluded.author_id,
      is_active = 1
  `);
  const saveAccounts = database.transaction(() => {
    for (const account of generated) {
      insertUser.run({
        ...account,
        passwordHash: bcrypt.hashSync(account.password, 12),
        authorId: account.authorId,
      });
    }
  });
  saveAccounts();

  return generated.map(({ email, name, role, password }) => ({ email, name, role, password }));
}

function writeCredentialsFile(accounts: ProvisionedAccount[]) {
  const directory = path.join(tmpdir(), `bookleaf-credentials-${randomBytes(8).toString('hex')}`);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = path.join(directory, 'accounts.json');
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify({ generatedAt: new Date().toISOString(), accounts }, null, 2)}\n`);
    chmodSync(file, 0o600);
  } finally {
    closeSync(descriptor);
  }
  return file;
}

function run() {
  const resetExisting = process.argv.includes('--reset-existing');
  initializeDatabase();
  try {
    const accounts = provisionAccounts(db, resetExisting, undefined, process.env.ADMIN_EMAIL || 'admin@bookleaf.local');
    const credentialsFile = writeCredentialsFile(accounts);
    console.log(`Provisioned ${accounts.length - 1} author accounts and one admin account with separate random passwords.`);
    console.log(`Credentials are in the owner-only file: ${credentialsFile}`);
    console.log('Retrieve it in this private shell, securely deliver each password, then delete the file. Do not commit or publish it.');
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run();
}
