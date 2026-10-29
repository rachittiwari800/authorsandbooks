import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import session from 'express-session';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from './config.js';
import { SQLiteSessionStore } from './sessionStore.js';
import { db, getDashboardMetrics, getAdminDashboardMetrics, getRecentTicketActivity, getUserByEmail, getUserById, getAuthorByEmail, getBooksForAuthor, getAllBooks, initializeDatabase, createTicket, getTicketById, getTicketsForAuthorByUser, getAllTickets, getPublicTicketMessages, addTicketMessage, getTicketMessages, saveTicketDraft } from './db.js';
import { assessPriority, classifyTicket, generateAIDraft, TICKET_CATEGORIES, TICKET_PRIORITIES } from './ai.js';

export const app = express();
if (config.nodeEnv === 'production') app.set('trust proxy', 1);

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(session({
  secret: config.sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    maxAge: 1000 * 60 * 60 * 8,
  },
}));

const asString = (value: unknown) => Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next).catch(next); };
const ticketStatuses = ['Open', 'In Progress', 'Resolved', 'Closed'] as const;
const aiRegenerationIntervalMs = 30_000;
const ticketInputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  bookId: z.string().trim().max(100).nullable().optional(),
});
const messageInputSchema = z.object({ content: z.string().trim().min(1).max(5000) });
const ticketPatchSchema = z.object({
  status: z.enum(ticketStatuses).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assignedAdminId: z.string().max(100).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one update is required.');
const cooldownSeconds = (lastRun: unknown) => {
  if (typeof lastRun !== 'string') return 0;
  const remainingMs = Date.parse(lastRun) + aiRegenerationIntervalMs - Date.now();
  return Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0;
};
const getVerifiedBookContext = (bookId: string | null, authorId: string) => {
  if (!bookId) return undefined;
  const book = db.prepare(`SELECT title, isbn, genre, source_status, publication_date, mrp, author_royalty_per_copy,
    total_copies_sold, total_royalty_earned, royalty_paid, royalty_pending, print_partner, distribution_platforms
    FROM books WHERE id = ? AND author_id = ? AND is_active = 1`).get(bookId, authorId) as Record<string, unknown> | undefined;
  if (!book) return undefined;
  return {
    ...book,
    distribution_platforms: typeof book.distribution_platforms === 'string'
      ? JSON.parse(book.distribution_platforms)
      : book.distribution_platforms,
  };
};
const rateWindows = new Map<string, { count: number; resetAt: number }>();
const rateLimit = (limit: number, windowMs: number, keyFor: (req: Request) => string) =>
  (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyFor(req);
    const current = rateWindows.get(key);
    if (!current || current.resetAt <= now) {
      rateWindows.set(key, { count: 1, resetAt: now + windowMs });
      if (rateWindows.size > 2000) {
        for (const [entryKey, value] of rateWindows) {
          if (value.resetAt <= now) rateWindows.delete(entryKey);
        }
      }
      return next();
    }
    if (current.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      return res.set('Retry-After', String(retryAfter)).status(429).json({
        message: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: retryAfter,
      });
    }
    current.count += 1;
    return next();
  };
const aiRateLimit = rateLimit(12, 60_000, (req) => req.session.userId ?? req.ip ?? 'unknown');

const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  const user = getUserById(req.session.userId as string);
  if (!user || !user.is_active) {
    return res.status(401).json({ message: 'This account is no longer active.' });
  }
  next();
};

const requireRole = (role: 'author' | 'admin') => (req: Request, res: Response, next: NextFunction) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  const user = getUserById(req.session.userId as string);
  if (!user || !user.is_active || user.role !== role) {
    return res.status(403).json({ message: 'You do not have access to this resource.' });
  }
  next();
};

app.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true, service: 'bookleaf-api' });
});

app.post('/api/auth/login', rateLimit(10, 15 * 60_000, (req) => `${req.ip ?? 'unknown'}:${asString(req.body?.email).trim().toLowerCase()}`), asyncHandler(async (req, res, next) => {
  const email = asString(req.body?.email).trim().toLowerCase();
  const password = asString(req.body?.password);
  const user = getUserByEmail(email);
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Invalid email or password.' });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    return next(error);
  }
  req.session.userId = user.id;
  req.session.save((error) => {
    if (error) return next(error);
    return res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });
}));

app.post('/api/auth/logout', (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ message: 'Not authenticated' });
  const user = getUserById(req.session.userId as string);
  if (!user || !user.is_active) return res.status(401).json({ message: 'Session invalid' });
  return res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.get('/api/author/dashboard', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId as string);
  if (!user || !user.is_active || user.role !== 'author') {
    return res.status(403).json({ message: 'Author access required.' });
  }
  const author = db.prepare('SELECT * FROM authors WHERE id = ? AND is_active = 1').get(user.author_id) as any;
  if (!author) return res.status(403).json({ message: 'Author access required.' });
  const books = getBooksForAuthor(author.id);
  const totals = getDashboardMetrics(author.id);
  return res.json({
    totals,
    books,
    author: {
      id: author.id,
      externalId: author.external_id,
      name: author.name,
      email: author.email,
      phone: author.phone,
      city: author.city,
      joinedDate: author.joined_date,
      packageName: author.package_name,
    },
  });
});

app.get('/api/admin/dashboard', requireRole('admin'), (_req, res) => {
  const totals = getDashboardMetrics();
  const books = getAllBooks();
  return res.json({ totals, ticketMetrics: getAdminDashboardMetrics(), recentActivity: getRecentTicketActivity(), books });
});

app.get('/api/author/books', requireRole('author'), (req, res) => {
  const user = getUserById(req.session.userId as string);
  if (!user?.author_id) return res.status(403).json({ message: 'Author access required.' });
  return res.json({ books: getBooksForAuthor(user.author_id) });
});

app.post('/api/author/tickets', requireAuth, rateLimit(10, 60_000, (req) => req.session.userId ?? req.ip ?? 'unknown'), asyncHandler(async (req, res) => {
  const user = getUserById(req.session.userId as string);
  if (!user || user.role !== 'author') {
    return res.status(403).json({ message: 'Author access required.' });
  }
  const validation = ticketInputSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ message: 'Enter a subject (up to 200 characters) and description (up to 5,000 characters).' });
  const { subject, description } = validation.data;
  const bookId = validation.data.bookId || null;
  let verifiedBookContext: Record<string, unknown> | undefined;
  if (bookId) {
    const book = getVerifiedBookContext(bookId, user.author_id);
    if (!book) {
      return res.status(400).json({ message: 'Selected book does not belong to your account.' });
    }
    verifiedBookContext = book;
  }
  const ticketId = db.transaction(() => {
    const created = createTicket({
      authorId: user.author_id,
      bookId,
      subject,
      description,
      category: 'General Inquiry',
      priority: 'Medium',
      status: 'Open',
    });
    addTicketMessage({ ticketId: created.id, userId: user.id, senderRole: 'author', messageType: 'public', content: description });
    return created.id;
  })();
  let aiResult: Awaited<ReturnType<typeof classifyTicket>> = {
    category: 'General Inquiry', confidence: 0, source: 'fallback', usedFallback: true, needsHumanReview: true,
  };
  let priorityResult: Awaited<ReturnType<typeof assessPriority>> = {
    priority: 'Medium', confidence: 0, source: 'fallback', usedFallback: true, needsHumanReview: true,
  };
  try {
    aiResult = await classifyTicket({ subject, description, verifiedContext: verifiedBookContext });
    priorityResult = await assessPriority({ subject, description, category: aiResult.category, verifiedContext: verifiedBookContext });
  } catch (error) {
    console.error('Ticket AI triage failed; ticket remains available for manual review.');
  }
  db.prepare('UPDATE tickets SET category = ?, priority = ?, ai_category = ?, ai_priority = ?, final_category = ?, final_priority = ?, updated_at = ? WHERE id = ?')
    .run(aiResult.category, priorityResult.priority, aiResult.category, priorityResult.priority, aiResult.category, priorityResult.priority, new Date().toISOString(), ticketId);
  db.prepare(`UPDATE tickets SET category_needs_review = ?, priority_needs_review = ?,
    ai_category_confidence = ?, ai_priority_confidence = ? WHERE id = ?`)
    .run(aiResult.needsHumanReview ? 1 : 0, priorityResult.needsHumanReview ? 1 : 0,
      aiResult.confidence, priorityResult.confidence, ticketId);
  const ticket = getTicketById(ticketId);
  return res.status(201).json({
    message: 'Ticket created successfully.',
    ticket,
    ai: {
      available: !aiResult.usedFallback && !priorityResult.usedFallback,
      classificationSource: aiResult.source,
      prioritySource: priorityResult.source,
      categoryConfidence: aiResult.confidence,
      priorityConfidence: priorityResult.confidence,
    },
  });
}));

app.get('/api/author/tickets', requireAuth, (req, res) => {
  const user = getUserById(req.session.userId as string);
  if (!user || user.role !== 'author') return res.status(403).json({ message: 'Author access required.' });
  const tickets = getTicketsForAuthorByUser(user.id);
  return res.json({ tickets });
});

app.get('/api/author/tickets/:id', requireRole('author'), (req, res) => {
  const user = getUserById(req.session.userId as string);
  const ticket = getTicketById(asString(req.params.id));
  if (!ticket || ticket.author_id !== user.author_id) return res.status(404).json({ message: 'Ticket not found.' });
  return res.json({ ticket: { ...ticket, messages: getPublicTicketMessages(ticket.id) } });
});

app.get('/api/admin/dashboard/metrics', requireRole('admin'), (_req, res) => {
  return res.json({ metrics: getAdminDashboardMetrics() });
});

app.get('/api/admin/administrators', requireRole('admin'), (_req, res) => {
  const administrators = db.prepare("SELECT id, name, email FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY name").all();
  return res.json({ administrators });
});

app.get('/api/admin/tickets', requireRole('admin'), (req, res) => {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return res.status(400).json({ message: 'Page must be a positive integer and page size must be between 1 and 100.' });
  }
  let tickets = getAllTickets();
  const status = asString(req.query.status);
  const category = asString(req.query.category);
  const priority = asString(req.query.priority);
  const author = asString(req.query.author).trim().toLowerCase();
  const search = asString(req.query.search).trim().toLowerCase();
  const assignedAdmin = asString(req.query.assignedAdmin);
  const createdFrom = asString(req.query.createdFrom);
  const createdTo = asString(req.query.createdTo);
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (status && !ticketStatuses.includes(status as (typeof ticketStatuses)[number])) return res.status(400).json({ message: 'Invalid ticket status filter.' });
  if (category && !TICKET_CATEGORIES.includes(category as (typeof TICKET_CATEGORIES)[number])) return res.status(400).json({ message: 'Invalid ticket category filter.' });
  if (priority && !TICKET_PRIORITIES.includes(priority as (typeof TICKET_PRIORITIES)[number])) return res.status(400).json({ message: 'Invalid ticket priority filter.' });
  if ((createdFrom && !validDate(createdFrom)) || (createdTo && !validDate(createdTo))) return res.status(400).json({ message: 'Creation date filters must use YYYY-MM-DD.' });
  if (createdFrom && createdTo && createdFrom > createdTo) return res.status(400).json({ message: 'Creation date range is invalid.' });
  if (assignedAdmin && assignedAdmin !== 'unassigned' && assignedAdmin !== 'me') {
    const admin = getUserById(assignedAdmin);
    if (!admin || admin.role !== 'admin' || !admin.is_active) return res.status(400).json({ message: 'Assigned administrator filter is invalid.' });
  }
  if (status) tickets = tickets.filter((ticket) => ticket.status === status);
  if (category) tickets = tickets.filter((ticket) => ticket.category === category);
  if (priority) tickets = tickets.filter((ticket) => ticket.priority === priority);
  if (author) tickets = tickets.filter((ticket) => String(ticket.author_name ?? '').toLowerCase().includes(author));
  if (search) tickets = tickets.filter((ticket) => `${ticket.id} ${ticket.subject}`.toLowerCase().includes(search));
  if (assignedAdmin === 'unassigned') tickets = tickets.filter((ticket) => !ticket.assigned_admin_id);
  else if (assignedAdmin) tickets = tickets.filter((ticket) => ticket.assigned_admin_id === assignedAdmin);
  if (createdFrom) tickets = tickets.filter((ticket) => String(ticket.created_at).slice(0, 10) >= createdFrom);
  if (createdTo) tickets = tickets.filter((ticket) => String(ticket.created_at).slice(0, 10) <= createdTo);
  const total = tickets.length;
  return res.json({ tickets: tickets.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total });
});

app.get('/api/admin/tickets/:id', requireRole('admin'), (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  const messages = getTicketMessages(ticket.id);
  return res.json({ ticket: { ...ticket, messages } });
});

app.patch('/api/admin/tickets/:id', requireRole('admin'), (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  const validation = ticketPatchSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ message: 'Provide valid ticket fields to update.' });
  const updates: Record<string, string> = {};
  const adminId = req.session.userId as string;
  if (validation.data.status !== undefined) updates.status = validation.data.status;
  if (validation.data.category !== undefined) {
    const category = validation.data.category;
    updates.category = category;
    updates.final_category = category;
    updates.category_needs_review = '0';
    updates.category_override_by = adminId;
    updates.category_overridden_at = new Date().toISOString();
  }
  if (validation.data.priority !== undefined) {
    const priority = validation.data.priority;
    updates.priority = priority;
    updates.final_priority = priority;
    updates.priority_needs_review = '0';
    updates.priority_override_by = adminId;
    updates.priority_overridden_at = new Date().toISOString();
  }
  if (validation.data.assignedAdminId !== undefined) {
    const assignedAdminId = validation.data.assignedAdminId;
    const assignedAdmin = assignedAdminId ? getUserById(assignedAdminId) : null;
    if (assignedAdminId && (!assignedAdmin || assignedAdmin.role !== 'admin' || !assignedAdmin.is_active)) return res.status(400).json({ message: 'Assigned user must be an active administrator.' });
    updates.assigned_admin_id = assignedAdminId;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'No valid updates provided.' });

  const setClauses = Object.keys(updates).map((key) => `${key} = @${key}`).join(', ');
  const stmt = db.prepare(`UPDATE tickets SET ${setClauses}, updated_at = @updatedAt WHERE id = @id`);
  db.transaction(() => {
    stmt.run({ ...updates, updatedAt: new Date().toISOString(), id: ticket.id });
    if (validation.data.assignedAdminId) {
      db.prepare('INSERT INTO ticket_assignments (id, ticket_id, admin_user_id, assigned_by) VALUES (?, ?, ?, ?)')
        .run(`assignment_${randomUUID()}`, ticket.id, validation.data.assignedAdminId, adminId);
    }
  })();

  const ticketUpdated = getTicketById(ticket.id);
  return res.json({ message: 'Ticket updated successfully.', ticket: ticketUpdated });
});

app.post('/api/admin/tickets/:id/notes', requireRole('admin'), (req, res) => {
  const admin = getUserById(req.session.userId as string);
  const validation = messageInputSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ message: 'Internal note must contain 1 to 5,000 characters.' });
  const content = validation.data.content;
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  db.transaction(() => {
    addTicketMessage({ ticketId: ticket.id, userId: admin.id, senderRole: 'admin', messageType: 'internal_note', content });
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), ticket.id);
  })();
  return res.json({ message: 'Internal note added successfully.' });
});

app.post('/api/admin/tickets/:id/assign', requireRole('admin'), (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  db.transaction(() => {
    db.prepare('UPDATE tickets SET assigned_admin_id = ?, updated_at = ? WHERE id = ?')
      .run(req.session.userId, new Date().toISOString(), ticket.id);
    db.prepare('INSERT INTO ticket_assignments (id, ticket_id, admin_user_id, assigned_by) VALUES (?, ?, ?, ?)')
      .run(`assignment_${randomUUID()}`, ticket.id, req.session.userId, req.session.userId);
  })();
  return res.json({ message: 'Ticket assigned to you.', ticket: getTicketById(ticket.id) });
});

app.post('/api/admin/tickets/:id/replies', requireRole('admin'), (req, res) => {
  const admin = getUserById(req.session.userId as string);
  const validation = messageInputSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ message: 'Public reply must contain 1 to 5,000 characters.' });
  const content = validation.data.content;
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  db.transaction(() => {
    addTicketMessage({ ticketId: ticket.id, userId: admin.id, senderRole: 'admin', messageType: 'public', content });
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), ticket.id);
  })();
  return res.json({ message: 'Public reply sent.', ticket: getTicketById(ticket.id) });
});

app.post('/api/admin/tickets/:id/ai/classify', requireRole('admin'), aiRateLimit, asyncHandler(async (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  const retryAfterSeconds = cooldownSeconds(ticket.ai_classified_at);
  if (retryAfterSeconds) return res.status(429).json({ message: 'Classification was run recently. Please wait before retrying.', retryAfterSeconds });
  const runAt = new Date().toISOString();
  db.prepare('UPDATE tickets SET ai_classified_at = ? WHERE id = ?').run(runAt, ticket.id);
  const result = await classifyTicket({
    subject: ticket.subject,
    description: ticket.description,
    verifiedContext: getVerifiedBookContext(ticket.book_id, ticket.author_id),
  });
  const updateFinal = ticket.category_override_by ? '' : ', final_category = ?';
  db.prepare(`UPDATE tickets SET ai_category = ?, ai_category_confidence = ?, category_needs_review = ?${updateFinal}, updated_at = ? WHERE id = ?`)
    .run(result.category, result.confidence, ticket.category_override_by ? 0 : result.needsHumanReview ? 1 : 0,
      ...(ticket.category_override_by ? [runAt, ticket.id] : [result.category, runAt, ticket.id]));
  return res.json({ message: 'AI classification processed.', category: result.category, confidence: result.confidence, source: result.source, usedFallback: result.usedFallback, needsHumanReview: result.needsHumanReview });
}));

app.post('/api/admin/tickets/:id/ai/priority', requireRole('admin'), aiRateLimit, asyncHandler(async (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  const retryAfterSeconds = cooldownSeconds(ticket.ai_priority_assessed_at);
  if (retryAfterSeconds) return res.status(429).json({ message: 'Priority was assessed recently. Please wait before retrying.', retryAfterSeconds });
  const runAt = new Date().toISOString();
  db.prepare('UPDATE tickets SET ai_priority_assessed_at = ? WHERE id = ?').run(runAt, ticket.id);
  const result = await assessPriority({
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    verifiedContext: getVerifiedBookContext(ticket.book_id, ticket.author_id),
  });
  const updateFinal = ticket.priority_override_by ? '' : ', final_priority = ?';
  db.prepare(`UPDATE tickets SET ai_priority = ?, ai_priority_confidence = ?, priority_needs_review = ?${updateFinal}, updated_at = ? WHERE id = ?`)
    .run(result.priority, result.confidence, ticket.priority_override_by ? 0 : result.needsHumanReview ? 1 : 0,
      ...(ticket.priority_override_by ? [runAt, ticket.id] : [result.priority, runAt, ticket.id]));
  return res.json({ message: 'AI priority processed.', priority: result.priority, confidence: result.confidence, source: result.source, usedFallback: result.usedFallback, needsHumanReview: result.needsHumanReview });
}));

app.post('/api/admin/tickets/:id/ai/draft', requireRole('admin'), aiRateLimit, asyncHandler(async (req, res) => {
  const id = asString(req.params.id);
  const ticket = getTicketById(id);
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  const retryAfterSeconds = cooldownSeconds(ticket.ai_draft_generated_at);
  if (retryAfterSeconds) return res.status(429).json({ message: 'A draft was generated recently. Please wait before generating another.', retryAfterSeconds });
  const runAt = new Date().toISOString();
  db.prepare('UPDATE tickets SET ai_draft_generated_at = ?, updated_at = ? WHERE id = ?').run(runAt, runAt, ticket.id);
  const book = ticket.book_id
    ? db.prepare('SELECT title, isbn, source_status, production_stage, total_royalty_earned, royalty_paid, royalty_pending, last_royalty_payout_date FROM books WHERE id = ? AND author_id = ?').get(ticket.book_id, ticket.author_id) as Record<string, unknown> | undefined
    : undefined;
  const publicHistory = getPublicTicketMessages(ticket.id).slice(-5)
    .map((message) => `${message.sender_role}: ${String(message.content).slice(0, 500)}`)
    .join('\n');
  const context = {
    author: { name: ticket.author_name },
    book: book ?? null,
    recentPublicConversation: publicHistory,
  };
  const draft = await generateAIDraft({ subject: ticket.subject, description: ticket.description, category: ticket.category, priority: ticket.priority }, context);
  saveTicketDraft(ticket.id, req.session.userId as string, draft.draft);
  return res.json({ message: 'AI draft generated.', draft: draft.draft, source: draft.source, usedFallback: draft.usedFallback });
}));

app.post('/api/admin/tickets/:id/draft', requireRole('admin'), (req, res) => {
  const validation = messageInputSchema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ message: 'Draft must contain 1 to 5,000 characters.' });
  const ticket = getTicketById(asString(req.params.id));
  if (!ticket) return res.status(404).json({ message: 'Ticket not found.' });
  saveTicketDraft(ticket.id, req.session.userId as string, validation.data.content);
  return res.json({ message: 'Draft saved. It has not been sent to the author.' });
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled API error.');
  res.status(500).json({ message: 'An unexpected server error occurred.' });
});

initializeDatabase();

if (process.env.NODE_ENV !== 'test') {
  const port = config.port;
  app.listen(port, () => {
    console.log(`BookLeaf API listening on http://localhost:${port}`);
  });
}
