import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionAccounts } from '../server/provisionAccounts.js';

describe('production account provisioning', () => {
  let database: Database.Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('creates a different strong password for each author and the admin', () => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE authors (
        id TEXT PRIMARY KEY, external_id TEXT UNIQUE, name TEXT, email TEXT, is_active INTEGER
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT,
        role TEXT, author_id TEXT, is_active INTEGER
      );
      INSERT INTO authors VALUES
        ('author_AUTH001', 'AUTH001', 'Priya Sharma', 'priya.sharma@email.com', 1),
        ('author_AUTH003', 'AUTH003', 'Ananya Reddy', 'ananya.reddy@email.com', 1);
    `);

    const passwords = [
      'author-one-unique-password-0001',
      'author-three-unique-password-03',
      'admin-separate-unique-password-0001',
    ];
    const accounts = provisionAccounts(database, false, () => passwords.shift() ?? '');

    expect(accounts).toHaveLength(3);
    expect(new Set(accounts.map((account) => account.password)).size).toBe(3);
    expect(accounts.find((account) => account.role === 'admin')?.email).toBe('admin@bookleaf.local');
    for (const account of accounts) {
      const saved = database.prepare('SELECT password_hash, role, is_active FROM users WHERE email = ?')
        .get(account.email) as { password_hash: string; role: string; is_active: number };
      expect(saved.role).toBe(account.role);
      expect(saved.is_active).toBe(1);
      expect(bcrypt.compareSync(account.password, saved.password_hash)).toBe(true);
    }

    const hashesBeforeRefusal = database.prepare('SELECT email, password_hash FROM users ORDER BY email').all();
    expect(() => provisionAccounts(database!)).toThrow('--reset-existing');
    expect(database.prepare('SELECT email, password_hash FROM users ORDER BY email').all()).toEqual(hashesBeforeRefusal);

    const replacementPasswords = [
      'replacement-author-password-00001',
      'replacement-author-password-00003',
      'replacement-admin-password-000001',
    ];
    const replacements = provisionAccounts(database, true, () => replacementPasswords.shift() ?? '');
    expect(new Set(replacements.map((account) => account.password)).size).toBe(3);
    for (const account of replacements) {
      expect(account.password).not.toBe(accounts.find((previous) => previous.email === account.email)?.password);
      const saved = database.prepare('SELECT password_hash FROM users WHERE email = ?')
        .get(account.email) as { password_hash: string };
      expect(bcrypt.compareSync(account.password, saved.password_hash)).toBe(true);
    }
  }, 30_000);

  it('requires active authors and distinct long passwords before writing accounts', () => {
    database = new Database(':memory:');
    database.exec(`
      CREATE TABLE authors (
        id TEXT PRIMARY KEY, external_id TEXT UNIQUE, name TEXT, email TEXT, is_active INTEGER
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT,
        role TEXT, author_id TEXT, is_active INTEGER
      );
    `);
    expect(() => provisionAccounts(database!)).toThrow('No active authors');

    database.prepare('INSERT INTO authors VALUES (?, ?, ?, ?, 1)')
      .run('author_AUTH001', 'AUTH001', 'Priya Sharma', 'priya.sharma@email.com');
    const existingUsers = database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    expect(() => provisionAccounts(database!, false, () => 'same-password-value-for-all')).toThrow('distinct password');
    expect((database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(existingUsers.count);
  });
});
