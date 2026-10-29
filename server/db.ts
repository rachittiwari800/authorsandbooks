import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from './config.js';

const dbPath = config.databaseUrl.startsWith('.') || config.databaseUrl.startsWith('/') ? path.resolve(config.databaseUrl) : config.databaseUrl;
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

type AuthorRow = {
  id: string;
  external_id: string;
  name: string;
  email: string;
  phone: string | null;
  city: string | null;
  country: string | null;
  package_name: string | null;
};

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      city TEXT,
      country TEXT,
      package_name TEXT,
      joined_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      title TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES authors(id),
      isbn TEXT,
      genre TEXT,
      publication_date TEXT,
      publication_status TEXT,
      source_status TEXT,
      mrp REAL,
      total_copies_sold INTEGER DEFAULT 0,
      total_royalty_earned REAL DEFAULT 0,
      royalty_paid REAL DEFAULT 0,
      royalty_pending REAL DEFAULT 0,
      print_partner TEXT,
      distribution_platforms TEXT,
      production_stage TEXT,
      author_royalty_per_copy REAL,
      last_royalty_payout_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('author','admin')),
      author_id TEXT REFERENCES authors(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES authors(id),
      book_id TEXT REFERENCES books(id),
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      ai_category TEXT,
      ai_priority TEXT,
      ai_category_confidence REAL,
      ai_priority_confidence REAL,
      final_category TEXT,
      final_priority TEXT,
      category_needs_review INTEGER NOT NULL DEFAULT 0,
      priority_needs_review INTEGER NOT NULL DEFAULT 0,
      category_override_by TEXT REFERENCES users(id),
      category_overridden_at TEXT,
      priority_override_by TEXT REFERENCES users(id),
      priority_overridden_at TEXT,
      ai_classified_at TEXT,
      ai_priority_assessed_at TEXT,
      ai_draft_generated_at TEXT,
      assigned_admin_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_assignments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      admin_user_id TEXT NOT NULL REFERENCES users(id),
      assigned_by TEXT NOT NULL REFERENCES users(id),
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES tickets(id),
      sender_user_id TEXT REFERENCES users(id),
      sender_role TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_author ON tickets(author_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_type_created ON ticket_messages(ticket_id, message_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_assignments_ticket ON ticket_assignments(ticket_id, assigned_at);
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);
  const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all() as Array<{ name: string }>;
  const existingColumns = new Set(ticketColumns.map((column) => column.name));
  for (const [name, definition] of [
    ['category_override_by', 'TEXT REFERENCES users(id)'],
    ['category_overridden_at', 'TEXT'],
    ['priority_override_by', 'TEXT REFERENCES users(id)'],
    ['priority_overridden_at', 'TEXT'],
    ['ai_classified_at', 'TEXT'],
    ['ai_priority_assessed_at', 'TEXT'],
    ['ai_draft_generated_at', 'TEXT'],
    ['category_needs_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['priority_needs_review', 'INTEGER NOT NULL DEFAULT 0'],
    ['ai_category_confidence', 'REAL'],
    ['ai_priority_confidence', 'REAL'],
  ]) {
    if (!existingColumns.has(name)) db.exec(`ALTER TABLE tickets ADD COLUMN ${name} ${definition}`);
  }
  const addMissingColumns = (table: string, columns: Array<[string, string]>) => {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, definition] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  addMissingColumns('authors', [['joined_date', 'TEXT'], ['is_active', 'INTEGER NOT NULL DEFAULT 1']]);
  addMissingColumns('books', [
    ['author_royalty_per_copy', 'REAL'],
    ['last_royalty_payout_date', 'TEXT'],
    ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['source_status', 'TEXT'],
  ]);
  addMissingColumns('users', [['is_active', 'INTEGER NOT NULL DEFAULT 1']]);
}

export function initializeDatabase() {
  ensureSchema();
  seedSampleData();
}

export function getUserByEmail(email: string) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
}

export function getUserById(id: string) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
}

export function listAuthors() {
  return db.prepare('SELECT * FROM authors WHERE is_active = 1 ORDER BY name').all() as AuthorRow[];
}

export function getAuthorByExternalId(externalId: string) {
  return db.prepare('SELECT * FROM authors WHERE external_id = ? AND is_active = 1').get(externalId) as any;
}

export function getAuthorByEmail(email: string) {
  return db.prepare('SELECT * FROM authors WHERE email = ? AND is_active = 1').get(email) as any;
}

export function getBooksForAuthor(authorId: string) {
  return db.prepare(`
    SELECT
      id,
      external_id AS externalId,
      title,
      author_id AS authorId,
      isbn,
      genre,
      publication_date AS publicationDate,
      publication_status AS publicationStatus,
      source_status AS sourceStatus,
      mrp,
      total_copies_sold AS totalCopiesSold,
      total_royalty_earned AS totalRoyaltyEarned,
      royalty_paid AS royaltyPaid,
      royalty_pending AS royaltyPending,
      print_partner AS printPartner,
      distribution_platforms AS distributionPlatforms,
      production_stage AS productionStage,
      author_royalty_per_copy AS authorRoyaltyPerCopy,
      last_royalty_payout_date AS lastRoyaltyPayoutDate
    FROM books
    WHERE author_id = ? AND is_active = 1
    ORDER BY title
  `).all(authorId).map(mapBookRow);
}

export function getAllBooks() {
  return db.prepare(`
    SELECT
      id,
      external_id AS externalId,
      title,
      author_id AS authorId,
      isbn,
      genre,
      publication_date AS publicationDate,
      publication_status AS publicationStatus,
      source_status AS sourceStatus,
      mrp,
      total_copies_sold AS totalCopiesSold,
      total_royalty_earned AS totalRoyaltyEarned,
      royalty_paid AS royaltyPaid,
      royalty_pending AS royaltyPending,
      print_partner AS printPartner,
      distribution_platforms AS distributionPlatforms,
      production_stage AS productionStage,
      author_royalty_per_copy AS authorRoyaltyPerCopy,
      last_royalty_payout_date AS lastRoyaltyPayoutDate
    FROM books
    WHERE is_active = 1
    ORDER BY title
  `).all().map(mapBookRow);
}

function mapBookRow(value: unknown) {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid book row returned from database.');
  }
  const row = value as Record<string, unknown>;
  let distributionPlatforms: string[] | null = null;
  if (typeof row.distributionPlatforms === 'string') {
    const parsed: unknown = JSON.parse(row.distributionPlatforms);
    if (!Array.isArray(parsed) || !parsed.every((platform) => typeof platform === 'string')) {
      throw new Error('Invalid distribution platforms stored for book.');
    }
    distributionPlatforms = parsed;
  }

  return { ...row, distributionPlatforms };
}

export function getBooksForAuthorExternal(authorExternalId: string) {
  const author = getAuthorByExternalId(authorExternalId);
  if (!author) return [];
  return getBooksForAuthor(author.id);
}

export function seedSampleData() {
  const jsonPath = path.resolve(process.cwd(), 'bookleaf_sample_data.json');
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Required sample dataset not found: ${jsonPath}`);
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('authors' in parsed) || !Array.isArray(parsed.authors)) {
    throw new Error('Sample dataset must contain an authors array.');
  }
  const source = parsed as { authors: Array<Record<string, any>>; books?: Array<Record<string, any>> };
  const nestedBooks = source.authors.some((author) => Array.isArray(author.books));
  if (!nestedBooks && !Array.isArray(source.books)) {
    throw new Error('Sample dataset must contain a books array or books nested under authors.');
  }
  const authors = source.authors.map((author) => ({
    externalId: String(author.author_id ?? author.id ?? ''),
    name: String(author.name ?? ''),
    email: String(author.email ?? ''),
    phone: author.phone ?? null,
    city: author.city ?? null,
    country: author.country ?? null,
    packageName: author.package ?? null,
    joinedDate: author.joined_date ?? null,
  }));
  const books = nestedBooks
    ? source.authors.flatMap((author) => (author.books ?? []).map((book: Record<string, any>) => ({
      ...book,
      externalId: String(book.book_id ?? book.id ?? ''),
      authorExternalId: String(author.author_id ?? author.id ?? ''),
      publicationDate: book.publication_date ?? book.publicationDate ?? null,
      publicationStatus: book.publicationStatus ?? book.status ?? 'In Production',
      sourceStatus: book.status ?? book.sourceStatus ?? book.publicationStatus ?? 'In Production',
      totalCopiesSold: book.total_copies_sold ?? book.totalCopiesSold ?? 0,
      totalRoyaltyEarned: book.total_royalty_earned ?? book.totalRoyaltyEarned ?? 0,
      royaltyPaid: book.royalty_paid ?? book.royaltyPaid ?? 0,
      royaltyPending: book.royalty_pending ?? book.royaltyPending ?? 0,
      printPartner: book.print_partner ?? book.printPartner ?? null,
      distributionPlatforms: book.available_on ?? book.distributionPlatforms ?? null,
      productionStage: book.productionStage ?? null,
      authorRoyaltyPerCopy: book.author_royalty_per_copy ?? null,
      lastRoyaltyPayoutDate: book.last_royalty_payout_date ?? null,
    })))
    : (source.books ?? []).map((book) => ({
      ...book,
      externalId: String(book.id ?? ''),
      authorExternalId: String(book.authorId ?? ''),
      publicationDate: book.publicationDate ?? null,
      publicationStatus: book.publicationStatus ?? 'In Production',
      sourceStatus: book.sourceStatus ?? book.publicationStatus ?? 'In Production',
      totalCopiesSold: book.totalCopiesSold ?? 0,
      totalRoyaltyEarned: book.totalRoyaltyEarned ?? 0,
      royaltyPaid: book.royaltyPaid ?? 0,
      royaltyPending: book.royaltyPending ?? 0,
      printPartner: book.printPartner ?? null,
      distributionPlatforms: book.distributionPlatforms ?? null,
      productionStage: book.productionStage ?? null,
      authorRoyaltyPerCopy: book.authorRoyaltyPerCopy ?? null,
      lastRoyaltyPayoutDate: book.lastRoyaltyPayoutDate ?? null,
    }));

  if (authors.some((author) => !author.externalId || !author.name || !author.email)
    || books.some((book) => !book.externalId || !book.title || !book.authorExternalId)) {
    throw new Error('Sample dataset contains an author or book missing its required ID, name, title, or relationship.');
  }

  const legacyAuthorIds = Array.from({ length: 10 }, (_, index) => `AUTH-${1001 + index}`);
  const legacyBookIds = Array.from({ length: 20 }, (_, index) => `BK-${2001 + index}`);
  const retireLegacySeed = db.transaction(() => {
    const authorPlaceholders = legacyAuthorIds.map(() => '?').join(', ');
    const bookPlaceholders = legacyBookIds.map(() => '?').join(', ');
    db.prepare(`UPDATE authors SET is_active = 0 WHERE external_id IN (${authorPlaceholders})`).run(...legacyAuthorIds);
    db.prepare(`UPDATE books SET is_active = 0 WHERE external_id IN (${bookPlaceholders})`).run(...legacyBookIds);
    db.prepare(`UPDATE users SET is_active = 0 WHERE author_id IN (SELECT id FROM authors WHERE is_active = 0) AND role = 'author'`).run();
  });
  retireLegacySeed();

  const authorInsert = db.prepare(`
    INSERT INTO authors (id, external_id, name, email, phone, city, country, package_name, joined_date, is_active)
    VALUES (@id, @external_id, @name, @email, @phone, @city, @country, @package_name, @joined_date, 1)
    ON CONFLICT(external_id) DO UPDATE SET
      name = excluded.name, email = excluded.email, phone = excluded.phone, city = excluded.city,
      country = excluded.country, package_name = excluded.package_name, joined_date = excluded.joined_date, is_active = 1
  `);
  const userInsert = db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, author_id, is_active)
    VALUES (@id, @email, @password_hash, @name, 'author', @author_id, 1)
    ON CONFLICT(email) DO UPDATE SET
      password_hash = excluded.password_hash, name = excluded.name, role = 'author',
      author_id = excluded.author_id, is_active = 1
  `);
  const bookInsert = db.prepare(`
    INSERT INTO books (
      id, external_id, title, author_id, isbn, genre, publication_date, publication_status, mrp,
      source_status,
      total_copies_sold, total_royalty_earned, royalty_paid, royalty_pending, print_partner,
      distribution_platforms, production_stage, author_royalty_per_copy, last_royalty_payout_date, is_active
    ) VALUES (
      @id, @external_id, @title, @author_id, @isbn, @genre, @publication_date, @publication_status, @mrp,
      @source_status,
      @total_copies_sold, @total_royalty_earned, @royalty_paid, @royalty_pending, @print_partner,
      @distribution_platforms, @production_stage, @author_royalty_per_copy, @last_royalty_payout_date, 1
    )
    ON CONFLICT(external_id) DO UPDATE SET
      title = excluded.title, author_id = excluded.author_id, isbn = excluded.isbn, genre = excluded.genre,
      publication_date = excluded.publication_date, publication_status = excluded.publication_status, mrp = excluded.mrp,
      source_status = excluded.source_status,
      total_copies_sold = excluded.total_copies_sold, total_royalty_earned = excluded.total_royalty_earned,
      royalty_paid = excluded.royalty_paid, royalty_pending = excluded.royalty_pending, print_partner = excluded.print_partner,
      distribution_platforms = excluded.distribution_platforms, production_stage = excluded.production_stage,
      author_royalty_per_copy = excluded.author_royalty_per_copy, last_royalty_payout_date = excluded.last_royalty_payout_date,
      is_active = 1
  `);
  const passwordHash = config.enableDemoAccounts ? bcrypt.hashSync(config.seedPassword, 10) : '';
  const authorIdByExternalId = new Map<string, string>();

  for (const author of authors) {
    const authorId = `author_${author.externalId}`;
    authorIdByExternalId.set(author.externalId, authorId);
    authorInsert.run({
      id: authorId,
      external_id: author.externalId,
      name: author.name,
      email: author.email,
      phone: author.phone,
      city: author.city,
      country: author.country,
      package_name: author.packageName,
      joined_date: author.joinedDate,
    });

    if (config.enableDemoAccounts) {
      userInsert.run({
        id: `user_${author.externalId}`,
        email: author.email,
        password_hash: passwordHash,
        name: author.name,
        author_id: authorId,
      });
    }
  }

  if (config.enableDemoAccounts) {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, author_id, is_active)
      VALUES ('user_admin', 'admin@bookleaf.local', ?, 'BookLeaf Admin', 'admin', NULL, 1)
      ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, is_active = 1
    `).run(passwordHash);
  }

  // Operator-provisioned accounts (for production, where demo accounts are disabled).
  // Set ADMIN_EMAIL + ADMIN_PASSWORD (and optionally AUTHOR_EMAIL + AUTHOR_PASSWORD) as environment variables.
  if (!config.enableDemoAccounts) {
    const provisionAdminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const provisionAdminPassword = process.env.ADMIN_PASSWORD || '';
    if (provisionAdminEmail && provisionAdminPassword) {
      if (provisionAdminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
      db.prepare(`
        INSERT INTO users (id, email, password_hash, name, role, author_id, is_active)
        VALUES ('user_admin_provisioned', ?, ?, 'BookLeaf Admin', 'admin', NULL, 1)
        ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', is_active = 1
      `).run(provisionAdminEmail, bcrypt.hashSync(provisionAdminPassword, 10));
    }

    const provisionAuthorEmail = (process.env.AUTHOR_EMAIL || '').trim().toLowerCase();
    const provisionAuthorPassword = process.env.AUTHOR_PASSWORD || '';
    if (provisionAuthorEmail && provisionAuthorPassword) {
      if (provisionAuthorPassword.length < 12) throw new Error('AUTHOR_PASSWORD must be at least 12 characters.');
      const match = authors.find((author) => author.email.trim().toLowerCase() === provisionAuthorEmail);
      if (!match) throw new Error('AUTHOR_EMAIL does not match any author in the dataset.');
      userInsert.run({
        id: `user_${match.externalId}`,
        email: provisionAuthorEmail,
        password_hash: bcrypt.hashSync(provisionAuthorPassword, 10),
        name: match.name,
        author_id: authorIdByExternalId.get(match.externalId),
      });
    }
  }

  for (const book of books) {
    const authorId = authorIdByExternalId.get(book.authorExternalId);
    if (!authorId) throw new Error(`Book ${book.externalId} references an unknown author: ${book.authorExternalId}`);
    const rawStatus = String(book.publicationStatus);
    const inProduction = rawStatus.startsWith('In Production');
    const publicationStatus = inProduction ? 'In Production'
      : rawStatus === 'Published & Live' ? 'Published' : rawStatus;
    const productionStage = inProduction
      ? rawStatus.replace(/^In Production(?:\s*-\s*)?/, '') || book.productionStage || null
      : book.productionStage ?? (publicationStatus === 'Published' ? 'Published & Live' : null);
    const platforms = Array.isArray(book.distributionPlatforms) ? book.distributionPlatforms : null;
    bookInsert.run({
      id: `book_${book.externalId}`,
      external_id: book.externalId,
      title: book.title,
      author_id: authorId,
      isbn: book.isbn ?? null,
      genre: book.genre ?? null,
      publication_date: book.publicationDate ?? null,
      publication_status: publicationStatus,
      source_status: rawStatus,
      mrp: book.mrp ?? null,
      total_copies_sold: Number(book.totalCopiesSold ?? 0),
      total_royalty_earned: Number(book.totalRoyaltyEarned ?? 0),
      royalty_paid: Number(book.royaltyPaid ?? 0),
      royalty_pending: Number(book.royaltyPending ?? 0),
      print_partner: book.printPartner ?? null,
      distribution_platforms: platforms === null ? null : JSON.stringify(platforms),
      production_stage: productionStage,
      author_royalty_per_copy: book.authorRoyaltyPerCopy ?? null,
      last_royalty_payout_date: book.lastRoyaltyPayoutDate ?? null,
    });
  }
}

export function createTicket(input: {
  authorId: string;
  bookId?: string | null;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
}) {
  const id = `ticket_${randomUUID()}`;
  const stmt = db.prepare(`
    INSERT INTO tickets (id, author_id, book_id, subject, description, category, priority, status, ai_category, ai_priority, final_category, final_priority)
    VALUES (@id, @authorId, @bookId, @subject, @description, @category, @priority, @status, @aiCategory, @aiPriority, @finalCategory, @finalPriority)
  `);
  stmt.run({
    id,
    authorId: input.authorId,
    bookId: input.bookId ?? null,
    subject: input.subject,
    description: input.description,
    category: input.category,
    priority: input.priority,
    status: input.status,
    aiCategory: input.category,
    aiPriority: input.priority,
    finalCategory: input.category,
    finalPriority: input.priority,
  });
  return getTicketById(id);
}

export function getTicketById(id: string) {
  return db.prepare(`
    SELECT t.*, a.name AS author_name, a.email AS author_email, a.phone AS author_phone,
      a.city AS author_city, a.joined_date AS author_joined_date,
      b.title AS book_title, b.external_id AS book_external_id, b.isbn AS book_isbn, b.genre AS book_genre,
      b.source_status AS book_source_status, b.publication_date AS book_publication_date, b.mrp AS book_mrp,
      b.author_royalty_per_copy AS book_royalty_per_copy, b.total_copies_sold AS book_total_copies_sold,
      b.total_royalty_earned AS book_total_royalty_earned, b.royalty_paid AS book_royalty_paid,
      b.royalty_pending AS book_royalty_pending, b.print_partner AS book_print_partner,
      u.name AS assigned_admin_name,
      category_admin.name AS category_override_name,
      priority_admin.name AS priority_override_name,
      COALESCE(t.final_category, t.category) AS category,
      COALESCE(t.final_priority, t.priority) AS priority
    FROM tickets t
    LEFT JOIN authors a ON a.id = t.author_id
    LEFT JOIN books b ON b.id = t.book_id
    LEFT JOIN users u ON u.id = t.assigned_admin_id
    LEFT JOIN users category_admin ON category_admin.id = t.category_override_by
    LEFT JOIN users priority_admin ON priority_admin.id = t.priority_override_by
    WHERE t.id = ?
  `).get(id) as any;
}

export function getTicketsForAuthorByUser(userId: string) {
  const user = getUserById(userId) as any;
  if (!user || !user.author_id) return [];
  return db.prepare(`
    SELECT t.*, b.title AS book_title,
      COALESCE(t.final_category, t.category) AS category,
      COALESCE(t.final_priority, t.priority) AS priority
    FROM tickets t
    LEFT JOIN books b ON b.id = t.book_id
    WHERE t.author_id = ?
    ORDER BY t.created_at DESC
  `).all(user.author_id) as any[];
}

export function getAllTickets() {
  return db.prepare(`
    SELECT t.*, a.name AS author_name, b.title AS book_title,
      u.name AS assigned_admin_name,
      COALESCE(t.final_category, t.category) AS category,
      COALESCE(t.final_priority, t.priority) AS priority
    FROM tickets t
    LEFT JOIN authors a ON a.id = t.author_id
    LEFT JOIN books b ON b.id = t.book_id
    LEFT JOIN users u ON u.id = t.assigned_admin_id
    ORDER BY
      CASE t.status WHEN 'Resolved' THEN 1 WHEN 'Closed' THEN 1 ELSE 0 END ASC,
      CASE COALESCE(t.final_priority, t.priority)
        WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3
      END ASC,
      t.created_at ASC
  `).all() as any[];
}

export function getPublicTicketMessages(ticketId: string) {
  return db.prepare(`
    SELECT tm.id, tm.ticket_id, tm.sender_role, tm.message_type, tm.content, tm.created_at, u.name AS sender_name
    FROM ticket_messages tm
    LEFT JOIN users u ON u.id = tm.sender_user_id
    WHERE tm.ticket_id = ? AND tm.message_type = 'public'
    ORDER BY tm.created_at ASC
  `).all(ticketId) as any[];
}

export function addTicketMessage(input: { ticketId: string; userId: string | null; senderRole: string; messageType: string; content: string }) {
  const id = `message_${randomUUID()}`;
  db.prepare(`
    INSERT INTO ticket_messages (id, ticket_id, sender_user_id, sender_role, message_type, content)
    VALUES (@id, @ticketId, @senderUserId, @senderRole, @messageType, @content)
  `).run({
    id,
    ticketId: input.ticketId,
    senderUserId: input.userId ?? null,
    senderRole: input.senderRole,
    messageType: input.messageType,
    content: input.content,
  });
}

export function saveTicketDraft(ticketId: string, userId: string, content: string) {
  db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM ticket_messages
      WHERE ticket_id = ? AND message_type = 'draft'
      ORDER BY created_at DESC LIMIT 1
    `).get(ticketId) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE ticket_messages SET content = ?, sender_user_id = ?, created_at = ? WHERE id = ?')
        .run(content, userId, new Date().toISOString(), existing.id);
    } else {
      addTicketMessage({ ticketId, userId, senderRole: 'ai', messageType: 'draft', content });
    }
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), ticketId);
  })();
}

export function getTicketMessages(ticketId: string) {
  return db.prepare(`
    SELECT tm.*, u.name AS sender_name
    FROM ticket_messages tm
    LEFT JOIN users u ON u.id = tm.sender_user_id
    WHERE tm.ticket_id = ?
    ORDER BY tm.created_at ASC
  `).all(ticketId) as any[];
}

export function getAdminDashboardMetrics() {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS inProgress,
      SUM(CASE WHEN status IN ('Resolved', 'Closed') THEN 1 ELSE 0 END) AS resolvedClosed,
      SUM(CASE WHEN COALESCE(final_priority, priority) IN ('Critical', 'High') THEN 1 ELSE 0 END) AS criticalHigh,
      SUM(CASE WHEN COALESCE(final_priority, priority) IN ('Critical', 'High') AND status NOT IN ('Resolved', 'Closed') THEN 1 ELSE 0 END) AS urgent,
      SUM(CASE
        WHEN status IN ('Open', 'In Progress')
          AND COALESCE((
            SELECT tm.sender_role
            FROM ticket_messages tm
            WHERE tm.ticket_id = tickets.id AND tm.message_type = 'public'
            ORDER BY tm.created_at DESC, tm.rowid DESC
            LIMIT 1
          ), 'author') = 'author'
        THEN 1 ELSE 0 END) AS awaitingResponse
    FROM tickets
  `).get() as Record<string, number | null>;
  return {
    totalTickets: counts.total ?? 0,
    openTickets: counts.open ?? 0,
    inProgressTickets: counts.inProgress ?? 0,
    resolvedClosedTickets: counts.resolvedClosed ?? 0,
    criticalHighTickets: counts.criticalHigh ?? 0,
    urgentTickets: counts.urgent ?? 0,
    awaitingResponse: counts.awaitingResponse ?? 0,
  };
}

export function getRecentTicketActivity(limit = 5) {
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(limit)));
  return db.prepare(`
    SELECT t.id, t.subject, t.status, t.updated_at, a.name AS author_name
    FROM tickets t
    JOIN authors a ON a.id = t.author_id
    ORDER BY t.updated_at DESC, t.created_at DESC
    LIMIT ?
  `).all(safeLimit) as any[];
}

export function getDashboardMetrics(authorId?: string) {
  if (authorId) {
    const rows = db.prepare('SELECT * FROM books WHERE author_id = ? AND is_active = 1').all(authorId) as any[];
    const totalBooks = rows.length;
    const publishedBooks = rows.filter((r) => r.publication_status === 'Published').length;
    const booksInProduction = rows.filter((r) => r.publication_status === 'In Production').length;
    const totalCopiesSold = rows.reduce((sum, r) => sum + Number(r.total_copies_sold || 0), 0);
    const totalRoyaltiesEarned = rows.reduce((sum, r) => sum + Number(r.total_royalty_earned || 0), 0);
    const totalRoyaltiesPaid = rows.reduce((sum, r) => sum + Number(r.royalty_paid || 0), 0);
    const totalPendingRoyalties = rows.reduce((sum, r) => sum + Number(r.royalty_pending || 0), 0);
    const unresolvedResult = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE author_id = ? AND status NOT IN ('Resolved', 'Closed')").get(authorId) as { count?: number } | undefined;
    const unresolvedTickets = unresolvedResult?.count ?? 0;
    return {
      totalBooks,
      publishedBooks,
      booksInProduction,
      totalCopiesSold,
      totalRoyaltiesEarned,
      totalRoyaltiesPaid,
      totalPendingRoyalties,
      unresolvedTickets,
    };
  }

  const rows = db.prepare('SELECT * FROM books WHERE is_active = 1').all() as any[];
  const unresolvedResult = db.prepare("SELECT COUNT(*) as count FROM tickets WHERE status NOT IN ('Resolved', 'Closed')").get() as { count?: number } | undefined;
  return {
    totalBooks: rows.length,
    publishedBooks: rows.filter((r) => r.publication_status === 'Published').length,
    booksInProduction: rows.filter((r) => r.publication_status === 'In Production').length,
    totalCopiesSold: rows.reduce((sum, r) => sum + Number(r.total_copies_sold || 0), 0),
    totalRoyaltiesEarned: rows.reduce((sum, r) => sum + Number(r.total_royalty_earned || 0), 0),
    totalRoyaltiesPaid: rows.reduce((sum, r) => sum + Number(r.royalty_paid || 0), 0),
    totalPendingRoyalties: rows.reduce((sum, r) => sum + Number(r.royalty_pending || 0), 0),
    unresolvedTickets: unresolvedResult?.count ?? 0,
  };
}
