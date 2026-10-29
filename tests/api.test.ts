import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { app } from '../server/index.js';
import { db, seedSampleData } from '../server/db.js';
import { config } from '../server/config.js';
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from '../server/ai.js';

describe('BookLeaf API', () => {
  const generatedTicketIds: string[] = [];
  const password = config.seedPassword;

  beforeAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('uses the exact canonical ticket categories and priorities', () => {
    expect(TICKET_CATEGORIES).toEqual([
      'Royalty & Payments',
      'ISBN & Metadata Issues',
      'Printing & Quality',
      'Distribution & Availability',
      'Book Status & Production Updates',
      'General Inquiry',
    ]);
    expect(TICKET_PRIORITIES).toEqual(['Critical', 'High', 'Medium', 'Low']);
  });

  afterAll(() => {
    const cleanup = db.transaction(() => {
      for (const id of generatedTicketIds) {
        db.prepare('DELETE FROM ticket_messages WHERE ticket_id = ?').run(id);
        db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      }
    });
    cleanup();
  });

  it('seeds the supplied ten authors and eighteen books idempotently', () => {
    const authorsBefore = (db.prepare('SELECT COUNT(*) AS count FROM authors WHERE is_active = 1').get() as { count: number }).count;
    const booksBefore = (db.prepare('SELECT COUNT(*) AS count FROM books WHERE is_active = 1').get() as { count: number }).count;
    seedSampleData();
    expect(authorsBefore).toBe(10);
    expect(booksBefore).toBe(18);
    expect((db.prepare('SELECT COUNT(*) AS count FROM authors WHERE is_active = 1').get() as { count: number }).count).toBe(10);
    expect((db.prepare('SELECT COUNT(*) AS count FROM books WHERE is_active = 1').get() as { count: number }).count).toBe(18);
    expect((db.prepare("SELECT COUNT(*) AS count FROM authors WHERE name IN ('Priya Sharma', 'Diya Chatterjee') AND is_active = 1").get() as { count: number }).count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM authors WHERE email LIKE '%@bookleaf.local' AND is_active = 1").get() as { count: number }).count).toBe(0);
  });

  it('preserves every supplied author and book field without duplicate source IDs', () => {
    const source = JSON.parse(readFileSync(resolve(process.cwd(), 'bookleaf_sample_data.json'), 'utf8')) as {
      authors: Array<Record<string, any>>;
    };
    expect(source.authors).toHaveLength(10);
    expect(new Set(source.authors.map((author) => author.author_id)).size).toBe(10);
    const expectedBooks = source.authors.flatMap((author) => author.books.map((book: Record<string, any>) => ({ author, book })));
    expect(expectedBooks).toHaveLength(18);
    expect(new Set(expectedBooks.map(({ book }) => book.book_id)).size).toBe(18);
    for (const { author, book } of expectedBooks) {
      const authorRow = db.prepare('SELECT external_id, name, email, phone, city, joined_date FROM authors WHERE external_id = ? AND is_active = 1').get(author.author_id) as Record<string, unknown>;
      expect(authorRow).toMatchObject({
        external_id: author.author_id, name: author.name, email: author.email, phone: author.phone,
        city: author.city, joined_date: author.joined_date,
      });
      const bookRow = db.prepare('SELECT * FROM books WHERE external_id = ? AND is_active = 1').get(book.book_id) as Record<string, unknown>;
      expect(bookRow).toMatchObject({
        title: book.title, author_id: `author_${author.author_id}`, isbn: book.isbn, genre: book.genre,
        source_status: book.status, publication_date: book.publication_date, mrp: book.mrp,
        author_royalty_per_copy: book.author_royalty_per_copy, total_copies_sold: book.total_copies_sold,
        total_royalty_earned: book.total_royalty_earned, royalty_paid: book.royalty_paid,
        royalty_pending: book.royalty_pending, last_royalty_payout_date: book.last_royalty_payout_date,
        print_partner: book.print_partner,
      });
      expect(JSON.parse(String(bookRow.distribution_platforms))).toEqual(book.available_on);
    }
  });

  it('logs in with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('priya.sharma@email.com');
    expect(res.body.user.role).toBe('author');
  });

  it('rejects invalid login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password: 'wrong' });

    expect(res.status).toBe(401);
  });

  it('retires old sample logins without deleting existing records', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'aarav.mehta@bookleaf.local', password });
    expect(res.status).toBe(401);
    expect((db.prepare("SELECT COUNT(*) AS count FROM authors WHERE external_id = 'AUTH-1001'").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT is_active FROM authors WHERE external_id = 'AUTH-1001'").get() as { is_active: number }).is_active).toBe(0);
  });

  it('requires auth for dashboard', async () => {
    const res = await request(app).get('/api/author/dashboard');
    expect(res.status).toBe(401);
  });

  it('enforces author/admin route separation and destroys sessions on logout', async () => {
    const authorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });
    const authorCookie = authorLogin.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/api/admin/dashboard').set('Cookie', authorCookie)).status).toBe(403);

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@bookleaf.local', password });
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).get('/api/author/dashboard').set('Cookie', adminCookie)).status).toBe(403);

    await request(app).post('/api/auth/logout').set('Cookie', authorCookie).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', authorCookie).expect(401);
  });

  it('lists books for a valid author', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });

    const res = await request(app)
      .get('/api/author/dashboard')
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0]);

    expect(res.status).toBe(200);
    expect(res.body.books.length).toBeGreaterThan(0);
    expect(res.body.author.name).toBe('Priya Sharma');
    expect(res.body.author.city).toBe('Mumbai');
    expect(res.body.books).toHaveLength(2);
    expect(res.body.books.map((book: { title: string }) => book.title)).toContain('Whispers of the Ganges');
    expect(res.body.books[0]).toHaveProperty('authorRoyaltyPerCopy');
  });

  it('shows the provided in-production stage and null publishing values accurately', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'kavita.deshmukh@email.com', password });
    const res = await request(app)
      .get('/api/author/dashboard')
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0]);
    expect(res.status).toBe(200);
    const productionBook = res.body.books.find((book: { title: string }) => book.title === 'Raising Roots');
    expect(productionBook.publicationStatus).toBe('In Production');
    expect(productionBook.sourceStatus).toBe('In Production - Typesetting');
    expect(productionBook.productionStage).toBe('Typesetting');
    expect(productionBook.publicationDate).toBeNull();
    expect(productionBook.mrp).toBeNull();
    expect(productionBook.authorRoyaltyPerCopy).toBeNull();
    expect(productionBook.distributionPlatforms).toEqual([]);
    expect(res.body.books[0]).toHaveProperty('totalRoyaltyEarned');
    expect(res.body.books[0]).toHaveProperty('publicationStatus');
    expect(Array.isArray(res.body.books[0].distributionPlatforms)).toBe(true);

    const otherAuthorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohit.kapoor@email.com', password });
    const otherAuthorBooks = await request(app)
      .get('/api/author/books')
      .set('Cookie', otherAuthorLogin.headers['set-cookie'][0].split(';')[0]);
    expect(otherAuthorBooks.body.books).toHaveLength(2);
    expect(otherAuthorBooks.body.books.every((book: { id: string }) => ['book_BK003', 'book_BK004'].includes(book.id))).toBe(true);
  });

  it('allows admin dashboard access with admin credentials', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@bookleaf.local', password });

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', login.headers['set-cookie'][0].split(';')[0]);
    const adminCookie = login.headers['set-cookie'][0].split(';')[0];

    expect(res.status).toBe(200);
    expect(res.body.totals.totalBooks).toBeGreaterThan(0);
    expect(res.body.books.length).toBe(18);
    expect(res.body.books[0]).toHaveProperty('totalRoyaltyEarned');
    const administrators = await request(app).get('/api/admin/administrators').set('Cookie', adminCookie);
    expect(administrators.body.administrators).toEqual([
      { id: 'user_admin', name: 'BookLeaf Admin', email: 'admin@bookleaf.local' },
    ]);

    const source = JSON.parse(readFileSync(resolve(process.cwd(), 'bookleaf_sample_data.json'), 'utf8')) as {
      authors: Array<Record<string, any>>;
    };
    const sourceBooks = source.authors.flatMap((author) => author.books.map((book: Record<string, any>) => ({ author, book })));
    const apiBooks = new Map(res.body.books.map((book: Record<string, any>) => [book.externalId, book]));
    expect(apiBooks.size).toBe(18);
    for (const { author, book } of sourceBooks) {
      const actual = apiBooks.get(book.book_id) as Record<string, any>;
      expect(actual).toMatchObject({
        externalId: book.book_id,
        title: book.title,
        authorId: `author_${author.author_id}`,
        isbn: book.isbn,
        genre: book.genre,
        publicationDate: book.publication_date,
        sourceStatus: book.status,
        mrp: book.mrp,
        authorRoyaltyPerCopy: book.author_royalty_per_copy,
        totalCopiesSold: book.total_copies_sold,
        totalRoyaltyEarned: book.total_royalty_earned,
        royaltyPaid: book.royalty_paid,
        royaltyPending: book.royalty_pending,
        lastRoyaltyPayoutDate: book.last_royalty_payout_date,
        printPartner: book.print_partner,
        distributionPlatforms: book.available_on,
      });
    }
  });

  it('creates author tickets, enforces ownership, and keeps internal notes private', async () => {
    const authorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });
    const authorCookie = authorLogin.headers['set-cookie'][0].split(';')[0];

    const created = await request(app)
      .post('/api/author/tickets')
      .set('Cookie', authorCookie)
      .send({ subject: 'Wrong ISBN on my book', description: 'The ISBN appears to be linked to the wrong book.', bookId: 'book_BK001' });
    expect(created.status).toBe(201);
    expect(created.body.ai.available).toBe(false);
    expect(created.body.ai.categoryConfidence).toBe(0);
    expect(created.body.ai.priorityConfidence).toBe(0.35);
    generatedTicketIds.push(created.body.ticket.id);
    expect(created.body.ticket.category_needs_review).toBe(1);
    const originalAiCategory = created.body.ticket.ai_category;
    expect(['Royalty & Payments', 'ISBN & Metadata Issues', 'Printing & Quality', 'Distribution & Availability', 'Book Status & Production Updates', 'General Inquiry']).toContain(originalAiCategory);
    const ticketId = created.body.ticket.id;

    const otherAuthorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rohit.kapoor@email.com', password });
    const crossAuthor = await request(app)
      .get(`/api/author/tickets/${ticketId}`)
      .set('Cookie', otherAuthorLogin.headers['set-cookie'][0].split(';')[0]);
    expect(crossAuthor.status).toBe(404);

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@bookleaf.local', password });
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    await request(app).post(`/api/admin/tickets/${ticketId}/notes`).set('Cookie', adminCookie).send({ content: 'Staff-only verification note.' }).expect(200);
    await request(app).post(`/api/admin/tickets/${ticketId}/replies`).set('Cookie', adminCookie).send({ content: 'We are reviewing the ISBN details.' }).expect(200);
    await request(app).patch(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie).send({ status: 'In Progress', category: 'General Inquiry', priority: 'High' }).expect(200);
    const rerunClassification = await request(app).post(`/api/admin/tickets/${ticketId}/ai/classify`).set('Cookie', adminCookie).send({});
    expect(rerunClassification.status).toBe(200);
    const afterRerun = await request(app).get(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie);
    expect(afterRerun.body.ticket.category).toBe('General Inquiry');
    expect(afterRerun.body.ticket.category_override_by).toBe('user_admin');
    expect(afterRerun.body.ticket.category_needs_review).toBe(0);
    expect(afterRerun.body.ticket.book_external_id).toBe('BK001');
    expect(afterRerun.body.ticket.book_isbn).toBe('978-93-5XXXX-01-1');
    const draftResponse = await request(app).post(`/api/admin/tickets/${ticketId}/ai/draft`).set('Cookie', adminCookie).send({});
    expect(draftResponse.status).toBe(200);
    expect(draftResponse.body.draft).toContain('BookLeaf');
    await request(app).post(`/api/admin/tickets/${ticketId}/ai/draft`).set('Cookie', adminCookie).send({}).expect(429);
    await request(app).post(`/api/admin/tickets/${ticketId}/draft`).set('Cookie', adminCookie).send({ content: 'Edited draft, still unsent.' }).expect(200);

    const authorView = await request(app).get(`/api/author/tickets/${ticketId}`).set('Cookie', authorCookie);
    expect(authorView.status).toBe(200);
    expect(authorView.body.ticket.status).toBe('In Progress');
    expect(authorView.body.ticket.category).toBe('General Inquiry');
    expect(authorView.body.ticket.priority).toBe('High');
    expect(authorView.body.ticket.ai_category).toBe(originalAiCategory);
    expect(authorView.body.ticket.messages.map((message: { content: string }) => message.content)).toContain('We are reviewing the ISBN details.');
    expect(JSON.stringify(authorView.body)).not.toContain('Staff-only verification note.');
    expect(JSON.stringify(authorView.body)).not.toContain('Edited draft, still unsent.');

    const adminView = await request(app).get(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie);
    expect(adminView.body.ticket.messages.some((message: { message_type: string }) => message.message_type === 'internal_note')).toBe(true);
    expect(adminView.body.ticket.messages.some((message: { content: string }) => message.content === 'Edited draft, still unsent.')).toBe(true);
    await request(app).post(`/api/admin/tickets/${ticketId}/assign`).set('Cookie', adminCookie).expect(200);
    expect((db.prepare('SELECT COUNT(*) AS count FROM ticket_assignments WHERE ticket_id = ?').get(ticketId) as { count: number }).count).toBe(1);

    for (const priority of TICKET_PRIORITIES) {
      const update = await request(app).patch(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie).send({ priority });
      expect(update.status).toBe(200);
      expect(update.body.ticket.priority).toBe(priority);
    }
    for (const category of TICKET_CATEGORIES) {
      const update = await request(app).patch(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie).send({ category });
      expect(update.status).toBe(200);
      expect(update.body.ticket.category).toBe(category);
    }
    for (const status of ['Open', 'In Progress', 'Resolved', 'Closed']) {
      const update = await request(app).patch(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie).send({ status });
      expect(update.status).toBe(200);
      expect(update.body.ticket.status).toBe(status);
    }

    const authorFilter = await request(app).get('/api/admin/tickets?author=Priya').set('Cookie', adminCookie);
    expect(authorFilter.body.tickets.some((ticket: { id: string }) => ticket.id === ticketId)).toBe(true);
  });

  it('rejects invalid ticket fields and category values', async () => {
    const authorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });
    const authorCookie = authorLogin.headers['set-cookie'][0].split(';')[0];
    await request(app).post('/api/author/tickets').set('Cookie', authorCookie).send({ subject: '', description: '' }).expect(400);

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@bookleaf.local', password });
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    const tickets = await request(app).get('/api/admin/tickets').set('Cookie', adminCookie);
    const ticketId = tickets.body.tickets[0]?.id;
    if (ticketId) {
      await request(app).patch(`/api/admin/tickets/${ticketId}`).set('Cookie', adminCookie).send({ category: 'Made up category' }).expect(400);
    }
    await request(app).get('/api/admin/tickets?page=0').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/admin/tickets?status=SomethingElse').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/admin/tickets?createdFrom=2025-02-31').set('Cookie', adminCookie).expect(400);
    await request(app).get('/api/admin/administrators').expect(401);
  });

  it('orders active tickets by priority and age before closed tickets', async () => {
    const authorLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'priya.sharma@email.com', password });
    const authorCookie = authorLogin.headers['set-cookie'][0].split(';')[0];
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@bookleaf.local', password });
    const adminCookie = adminLogin.headers['set-cookie'][0].split(';')[0];
    const prefix = 'Queue sort audit exact 7c74';
    const cases = [
      { suffix: 'critical-open', status: 'Open', priority: 'Critical', createdAt: '2025-01-01T00:00:00.000Z' },
      { suffix: 'high-oldest', status: 'Open', priority: 'High', createdAt: '2020-01-01T00:00:00.000Z' },
      { suffix: 'high-newer', status: 'Open', priority: 'High', createdAt: '2022-01-01T00:00:00.000Z' },
      { suffix: 'low-open', status: 'Open', priority: 'Low', createdAt: '2021-01-01T00:00:00.000Z' },
      { suffix: 'critical-closed', status: 'Closed', priority: 'Critical', createdAt: '2019-01-01T00:00:00.000Z' },
    ];
    const ids: string[] = [];

    for (const testCase of cases) {
      const created = await request(app)
        .post('/api/author/tickets')
        .set('Cookie', authorCookie)
        .send({ subject: `${prefix} ${testCase.suffix}`, description: 'Queue ordering verification.' })
        .expect(201);
      const id = created.body.ticket.id as string;
      generatedTicketIds.push(id);
      ids.push(id);
      await request(app).patch(`/api/admin/tickets/${id}`)
        .set('Cookie', adminCookie)
        .send({ status: testCase.status, priority: testCase.priority })
        .expect(200);
      db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(testCase.createdAt, id);
    }

    const response = await request(app)
      .get(`/api/admin/tickets?search=${encodeURIComponent(prefix)}`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(response.body.total).toBe(cases.length);
    expect(response.body.tickets.map((ticket: { id: string }) => ticket.id)).toEqual([
      ids[0],
      ids[1],
      ids[2],
      ids[3],
      ids[4],
    ]);
  });

  it('rate limits repeated login attempts', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app).post('/api/auth/login')
        .send({ email: 'rate-limit-check@example.invalid', password: 'bad' })
        .expect(401);
    }
    const limited = await request(app).post('/api/auth/login')
      .send({ email: 'rate-limit-check@example.invalid', password: 'bad' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});
