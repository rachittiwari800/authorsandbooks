import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Role = 'author' | 'admin';
type Section = 'dashboard' | 'books' | 'tickets';
type User = { id: string; name: string; email: string; role: Role };
type Book = {
  id: string;
  externalId: string;
  title: string;
  authorId: string;
  isbn: string | null;
  genre: string | null;
  publicationDate: string | null;
  publicationStatus: string;
  sourceStatus: string;
  mrp: number | null;
  totalCopiesSold: number;
  totalRoyaltyEarned: number;
  royaltyPaid: number;
  royaltyPending: number;
  authorRoyaltyPerCopy: number | null;
  lastRoyaltyPayoutDate: string | null;
  printPartner: string | null;
  distributionPlatforms: string[] | null;
  productionStage: string | null;
};
type Administrator = { id: string; name: string; email: string };
type TicketMessage = {
  id: string;
  sender_role: string;
  message_type: string;
  content: string;
  created_at: string;
  sender_name: string | null;
};
type Ticket = {
  id: string;
  author_id: string;
  book_id: string | null;
  subject: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  ai_category: string | null;
  ai_priority: string | null;
  ai_category_confidence?: number | null;
  ai_priority_confidence?: number | null;
  final_category: string | null;
  final_priority: string | null;
  category_override_by: string | null;
  category_override_name?: string | null;
  category_overridden_at?: string | null;
  priority_override_by: string | null;
  priority_override_name?: string | null;
  priority_overridden_at?: string | null;
  category_needs_review?: number;
  priority_needs_review?: number;
  assigned_admin_id: string | null;
  assigned_admin_name: string | null;
  author_name: string | null;
  author_email: string | null;
  author_phone: string | null;
  author_city?: string | null;
  author_joined_date?: string | null;
  book_title: string | null;
  book_external_id?: string | null;
  book_isbn?: string | null;
  book_genre?: string | null;
  book_source_status?: string | null;
  book_publication_date?: string | null;
  book_mrp?: number | null;
  book_royalty_per_copy?: number | null;
  book_total_copies_sold?: number | null;
  book_total_royalty_earned?: number | null;
  book_royalty_paid?: number | null;
  book_royalty_pending?: number | null;
  book_print_partner?: string | null;
  created_at: string;
  updated_at: string;
  messages?: TicketMessage[];
};
type DashboardData = {
  totals: {
    totalBooks: number;
    publishedBooks: number;
    booksInProduction: number;
    totalCopiesSold: number;
    totalRoyaltiesEarned: number;
    totalRoyaltiesPaid: number;
    totalPendingRoyalties: number;
    unresolvedTickets: number;
  };
  ticketMetrics?: {
    totalTickets: number;
    openTickets: number;
    inProgressTickets: number;
    resolvedClosedTickets: number;
    criticalHighTickets: number;
    urgentTickets: number;
    awaitingResponse: number;
  };
  recentActivity?: Array<{ id: string; subject: string; author_name: string; status: string; updated_at: string }>;
  books: Book[];
  author?: {
    externalId: string;
    phone: string | null;
    city: string | null;
    joinedDate: string | null;
    packageName: string | null;
  };
};
type Notice = { type: 'success' | 'error' | 'info'; text: string };

const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const statuses = ['Open', 'In Progress', 'Resolved', 'Closed'];
const categories = [
  'Royalty & Payments',
  'ISBN & Metadata Issues',
  'Printing & Quality',
  'Distribution & Availability',
  'Book Status & Production Updates',
  'General Inquiry',
];
const priorities = ['Critical', 'High', 'Medium', 'Low'];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data as T;
}

function dateTime(value: string) {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function money(value: number | null | undefined) {
  return value == null ? '—' : `₹${Number(value).toLocaleString('en-IN')}`;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [section, setSection] = useState<Section>('dashboard');
  const [loginForm, setLoginForm] = useState({ email: '', password: '' });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [ticketTotal, setTicketTotal] = useState(0);
  const [ticketPage, setTicketPage] = useState(1);
  const [selectedTicketId, setSelectedTicketId] = useState('');
  const [ticketDetail, setTicketDetail] = useState<Ticket | null>(null);
  const [administrators, setAdministrators] = useState<Administrator[]>([]);
  const [ticketForm, setTicketForm] = useState({ subject: '', description: '', bookId: '' });
  const [attachmentName, setAttachmentName] = useState('');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState('');
  const [authorTicketSearch, setAuthorTicketSearch] = useState('');
  const [authorTicketStatus, setAuthorTicketStatus] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [assignmentFilter, setAssignmentFilter] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [reply, setReply] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [draft, setDraft] = useState('');
  const draftDirtyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const totals = dashboard?.totals;

  const loadDashboard = useCallback(async (role: Role) => {
    const data = await api<DashboardData>(role === 'admin' ? '/admin/dashboard' : '/author/dashboard');
    setDashboard(data);
    setBooks(data.books ?? []);
  }, []);

  const loadTicketList = useCallback(async (role: Role, page = 1) => {
    if (role === 'author') {
      const data = await api<{ tickets: Ticket[] }>('/author/tickets');
      setTickets(data.tickets);
      setTicketTotal(data.tickets.length);
    } else {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter) params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (authorFilter.trim()) params.set('author', authorFilter.trim());
      if (assignmentFilter) params.set('assignedAdmin', assignmentFilter === 'me' ? (user?.id ?? '') : assignmentFilter);
      if (createdFrom) params.set('createdFrom', createdFrom);
      if (createdTo) params.set('createdTo', createdTo);
      const data = await api<{ tickets: Ticket[]; total: number }>(`/admin/tickets?${params}`);
      setTickets(data.tickets);
      setTicketTotal(data.total);
    }
  }, [search, statusFilter, categoryFilter, priorityFilter, authorFilter, assignmentFilter, createdFrom, createdTo, user?.id]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void loadDashboard(user.role).catch((error) => setNotice({ type: 'error', text: error.message }));
    }, 20000);
    return () => window.clearInterval(timer);
  }, [user, loadDashboard]);

  useEffect(() => {
    if (!user || user.role !== 'admin' || section !== 'tickets') return;
    void api<{ administrators: Administrator[] }>('/admin/administrators')
      .then((data) => setAdministrators(data.administrators))
      .catch((error) => setNotice({ type: 'error', text: error.message }));
  }, [user, section]);

  const loadTicketDetail = useCallback(async (role: Role, id: string) => {
    if (!id) return;
    const path = role === 'admin' ? `/admin/tickets/${encodeURIComponent(id)}` : `/author/tickets/${encodeURIComponent(id)}`;
    const data = await api<{ ticket: Ticket }>(path);
    setTicketDetail(data.ticket);
    if (role === 'admin') {
      const latestDraft = data.ticket.messages?.find((item) => item.message_type === 'draft');
      if (latestDraft && !draftDirtyRef.current) setDraft(latestDraft.content);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void api<{ user: User }>('/auth/me')
      .then(async ({ user: current }) => {
        if (!active) return;
        setUser(current);
        await loadDashboard(current.role);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => { active = false; };
  }, [loadDashboard]);

  useEffect(() => {
    if (!user || section !== 'tickets') return;
    const refresh = () => {
      void loadTicketList(user.role, ticketPage).catch((error) => setNotice({ type: 'error', text: error.message }));
    };
    refresh();
    const timer = window.setInterval(refresh, user.role === 'author' ? 10000 : 20000);
    return () => window.clearInterval(timer);
  }, [user, section, ticketPage, loadTicketList]);

  useEffect(() => {
    if (!user || section !== 'tickets' || !selectedTicketId) return;
    const refresh = () => {
      void loadTicketDetail(user.role, selectedTicketId).catch((error) => setNotice({ type: 'error', text: error.message }));
    };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [user, section, selectedTicketId, loadTicketDetail]);

  useEffect(() => {
    if (!attachmentFile || !attachmentFile.type.startsWith('image/')) {
      setAttachmentPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(attachmentFile);
    setAttachmentPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachmentFile]);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api<{ user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginForm),
      });
      setUser(result.user);
      setSection('dashboard');
      await loadDashboard(result.user.role);
      setNotice({ type: 'success', text: `Welcome, ${result.user.name}.` });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Login failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' });
      setUser(null);
      setDashboard(null);
      setBooks([]);
      setTickets([]);
      setTicketDetail(null);
      setSelectedTicketId('');
      setNotice({ type: 'success', text: 'You have been logged out.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Logout failed.' });
    }
  }

  async function openSection(next: Section) {
    setSection(next);
    setNotice(null);
    if (!user) return;
    try {
      if (next === 'dashboard') await loadDashboard(user.role);
      if (next === 'books' && user.role === 'author') {
        const data = await api<{ books: Book[] }>('/author/books');
        setBooks(data.books);
      }
      if (next === 'tickets') await loadTicketList(user.role, ticketPage);
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not load this section.' });
    }
  }

  async function submitTicket(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<{ ticket: Ticket; ai: { available: boolean } }>('/author/tickets', {
        method: 'POST',
        body: JSON.stringify({ ...ticketForm, bookId: ticketForm.bookId || null }),
      });
      setTicketForm({ subject: '', description: '', bookId: '' });
      setAttachmentName('');
      setAttachmentFile(null);
      setSelectedTicketId(result.ticket.id);
      setSection('tickets');
      await loadTicketList('author');
      setNotice({
        type: result.ai.available ? 'success' : 'info',
        text: result.ai.available
          ? 'Your ticket was submitted and AI-assisted triage completed.'
          : 'Your ticket was saved. AI is unavailable, so support can review and classify it manually.',
      });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Could not submit ticket.' });
    } finally {
      setBusy(false);
    }
  }

  async function updateTicket(id: string, changes: Record<string, string>) {
    setBusy(true);
    try {
      await api(`/admin/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
      await loadTicketDetail('admin', id);
      await loadTicketList('admin', ticketPage);
      setNotice({ type: 'success', text: 'Ticket updated.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Ticket update failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function assignTicket() {
    if (!selectedTicketId) return;
    try {
      await api(`/admin/tickets/${encodeURIComponent(selectedTicketId)}/assign`, { method: 'POST' });
      await loadTicketDetail('admin', selectedTicketId);
      await loadTicketList('admin', ticketPage);
      setNotice({ type: 'success', text: 'Ticket assigned to you.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Assignment failed.' });
    }
  }

  async function sendAdminMessage(kind: 'reply' | 'note') {
    if (!selectedTicketId) return;
    const content = kind === 'reply' ? reply.trim() : internalNote.trim();
    if (!content) {
      setNotice({ type: 'error', text: kind === 'reply' ? 'Enter a public reply first.' : 'Enter an internal note first.' });
      return;
    }
    try {
      const suffix = kind === 'reply' ? 'replies' : 'notes';
      await api(`/admin/tickets/${encodeURIComponent(selectedTicketId)}/${suffix}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      if (kind === 'reply') setReply('');
      else setInternalNote('');
      await loadTicketDetail('admin', selectedTicketId);
      await loadTicketList('admin', ticketPage);
      setNotice({ type: 'success', text: kind === 'reply' ? 'Public reply sent to the author.' : 'Internal note saved for staff.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Message could not be saved.' });
    }
  }

  async function generateDraft() {
    if (!selectedTicketId) return;
    try {
      const result = await api<{ draft: string; source: string; usedFallback: boolean }>(
        `/admin/tickets/${encodeURIComponent(selectedTicketId)}/ai/draft`,
        { method: 'POST' },
      );
      setDraft(result.draft);
      draftDirtyRef.current = false;
      setNotice({
        type: result.usedFallback ? 'info' : 'success',
        text: result.usedFallback ? 'AI provider unavailable; a clearly marked manual-review draft is shown.' : 'AI draft generated. Review and edit it before sending.',
      });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Draft generation failed.' });
    }
  }

  async function rerunAI(kind: 'classify' | 'priority') {
    if (!selectedTicketId) return;
    try {
      const suffix = kind === 'classify' ? 'classify' : 'priority';
      const result = await api<{ source: string; usedFallback: boolean }>(
        `/admin/tickets/${encodeURIComponent(selectedTicketId)}/ai/${suffix}`,
        { method: 'POST' },
      );
      await loadTicketDetail('admin', selectedTicketId);
      await loadTicketList('admin', ticketPage);
      setNotice({
        type: result.usedFallback ? 'info' : 'success',
        text: result.usedFallback ? `AI ${kind} unavailable; a fallback recommendation is shown for manual review.` : `AI ${kind} recommendation updated. Review it before applying overrides.`,
      });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : `AI ${kind} failed.` });
    }
  }

  async function useDraft() {
    setReply(draft.trim());
    setNotice({ type: 'info', text: 'Draft copied to the public reply editor; it has not been sent.' });
  }

  async function saveDraft() {
    if (!selectedTicketId || !draft.trim()) return;
    try {
      await api(`/admin/tickets/${encodeURIComponent(selectedTicketId)}/draft`, {
        method: 'POST',
        body: JSON.stringify({ content: draft }),
      });
      await loadTicketDetail('admin', selectedTicketId);
      draftDirtyRef.current = false;
      setNotice({ type: 'success', text: 'Draft saved for staff review. It has not been sent.' });
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Draft could not be saved.' });
    }
  }

  const pageTitle = useMemo(() => {
    if (section === 'books') return 'My Books';
    if (section === 'tickets') return user?.role === 'admin' ? 'Support queue' : 'My Tickets';
    return user?.role === 'admin' ? 'Admin Dashboard' : 'Author Dashboard';
  }, [section, user]);
  const visibleAuthorTickets = useMemo(() => tickets.filter((ticket) => {
    const matchesSearch = `${ticket.id} ${ticket.subject} ${ticket.book_title ?? ''}`.toLowerCase().includes(authorTicketSearch.toLowerCase());
    return matchesSearch && (!authorTicketStatus || ticket.status === authorTicketStatus);
  }), [tickets, authorTicketSearch, authorTicketStatus]);

  if (!user) {
    return (
      <div className="app-shell">
        <header className="topbar"><div className="brand">BookLeaf <span>Author Portal</span></div></header>
        <main className="login-shell">
          <section className="card login-card">
            <div className="eyebrow">AUTHOR & SUPPORT PORTAL</div>
            <h1 className="page-title">Welcome back</h1>
            <p className="muted">Sign in to manage your books or support requests.</p>
            {notice && <div className={`alert ${notice.type}`}>{notice.text}</div>}
            <form className="form" onSubmit={login}>
              <label className="field"><span>Email</span><input type="email" autoComplete="username" required value={loginForm.email} onChange={(event) => setLoginForm({ ...loginForm, email: event.target.value })} placeholder="you@example.com" /></label>
              <label className="field"><span>Password</span><input type="password" autoComplete="current-password" required value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} placeholder="Password" /></label>
              <button className="btn" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
            <p className="muted small">Demo accounts and setup details are in the project README.</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">BookLeaf <span>{user.role === 'admin' ? 'Support Desk' : 'Author Portal'}</span></div>
        <div className="nav"><span className="user-name">{user.name}</span><button onClick={logout}>Sign out</button></div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="profile-block"><strong>{user.name}</strong><span>{user.email}</span><small>{user.role === 'admin' ? 'Support administrator' : dashboard?.author?.city ? `${dashboard.author.city} · Author account` : 'Author account'}</small>{user.role === 'author' && dashboard?.author?.joinedDate && <small>Joined {dashboard.author.joinedDate}</small>}</div>
          <nav aria-label="Main navigation">
            <button className={section === 'dashboard' ? 'active' : ''} onClick={() => void openSection('dashboard')}>Overview</button>
            {user.role === 'author' && <button className={section === 'books' ? 'active' : ''} onClick={() => void openSection('books')}>My Books</button>}
            <button className={section === 'tickets' ? 'active' : ''} onClick={() => void openSection('tickets')}>{user.role === 'admin' ? 'Ticket queue' : 'My Tickets'}</button>
          </nav>
          <div className="sidebar-foot">Publishing support for every step.</div>
        </aside>
        <main className="content">
          <div className="page-heading"><div><div className="eyebrow">{user.role === 'admin' ? 'BOOKLEAF SUPPORT' : 'YOUR PUBLISHING ACCOUNT'}</div><h1 className="page-title">{pageTitle}</h1></div>
            {user.role === 'author' && section === 'tickets' && <button className="btn" onClick={() => document.getElementById('new-ticket')?.scrollIntoView({ behavior: 'smooth' })}>New support request</button>}
          </div>
          {notice && <div className={`alert ${notice.type}`} role="status">{notice.text}<button className="alert-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

          {section === 'dashboard' && (
            <>
              {user.role === 'author' ? (
                <>
                  <section className="grid grid-3">
                    <Stat title="Total books" value={totals?.totalBooks ?? 0} />
                    <Stat title="Published" value={totals?.publishedBooks ?? 0} />
                    <Stat title="In production" value={totals?.booksInProduction ?? 0} />
                    <Stat title="Copies sold" value={(totals?.totalCopiesSold ?? 0).toLocaleString('en-IN')} />
                    <Stat title="Royalties earned" value={money(totals?.totalRoyaltiesEarned)} />
                    <Stat title="Royalties paid" value={money(totals?.totalRoyaltiesPaid)} />
                    <Stat title="Pending royalties" value={money(totals?.totalPendingRoyalties)} />
                    <Stat title="Unresolved tickets" value={totals?.unresolvedTickets ?? 0} />
                  </section>
                  <BookTable books={[...books].filter((book) => book.publicationStatus === 'Published')
                    .sort((a, b) => (b.publicationDate ?? '').localeCompare(a.publicationDate ?? '')).slice(0, 5)} compact />
                </>
              ) : (
                <section className="grid grid-3">
                  <Stat title="Total tickets" value={dashboard?.ticketMetrics?.totalTickets ?? 0} />
                  <Stat title="Open" value={dashboard?.ticketMetrics?.openTickets ?? 0} />
                  <Stat title="In progress" value={dashboard?.ticketMetrics?.inProgressTickets ?? 0} />
                  <Stat title="Resolved / closed" value={dashboard?.ticketMetrics?.resolvedClosedTickets ?? 0} />
                  <Stat title="Critical / high tickets" value={dashboard?.ticketMetrics?.criticalHighTickets ?? 0} />
                  <Stat title="Active critical / high" value={dashboard?.ticketMetrics?.urgentTickets ?? 0} />
                  <Stat title="Awaiting response" value={dashboard?.ticketMetrics?.awaitingResponse ?? 0} />
                  <div className="card panel action-panel"><h2>Support queue</h2><p className="muted">Active tickets are ordered by urgency, then age.</p><button className="btn" onClick={() => void openSection('tickets')}>Open ticket queue</button></div>
                  <div className="card panel recent-activity"><h2>Recent ticket activity</h2>{dashboard?.recentActivity?.length ? dashboard.recentActivity.map((item) => <div key={item.id} className="activity-row"><div><strong>{item.subject}</strong><small>{item.author_name} · {dateTime(item.updated_at)}</small></div><StatusBadge value={item.status} /></div>) : <p className="muted">No ticket activity yet.</p>}</div>
                </section>
              )}
            </>
          )}

          {section === 'books' && user.role === 'author' && <BookTable books={books} />}

          {section === 'tickets' && (
            user.role === 'author' ? (
              <div className="ticket-layout author-ticket-layout">
                <section className="card panel">
                  <div className="panel-heading"><div><h2>My support requests</h2><p className="muted">Replies refresh automatically while this page is open.</p></div><span className="count-pill">{tickets.length}</span></div>
                  <div className="filter-row author-ticket-filters"><input aria-label="Search my tickets" placeholder="Search subject, ticket ID, book" value={authorTicketSearch} onChange={(event) => setAuthorTicketSearch(event.target.value)} /><select aria-label="Filter my ticket status" value={authorTicketStatus} onChange={(event) => setAuthorTicketStatus(event.target.value)}><option value="">All statuses</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></div>
                  {visibleAuthorTickets.length === 0 ? <EmptyState title={tickets.length ? 'No matching tickets' : 'No tickets yet'} body={tickets.length ? 'Try another search or status filter.' : 'Submit a support request and the BookLeaf team will follow up here.'} /> : (
                    <div className="ticket-list">
                      {visibleAuthorTickets.map((ticket) => <button key={ticket.id} className={`ticket-list-item ${selectedTicketId === ticket.id ? 'selected' : ''}`} onClick={() => setSelectedTicketId(ticket.id)}>
                        <span className="ticket-item-top"><strong>{ticket.subject}</strong><StatusBadge value={ticket.status} /></span>
                        <span className="ticket-item-meta">{ticket.id} · {ticket.book_title ?? 'General / Account Level'}</span>
                        <span className="ticket-item-meta">{ticket.category} · {ticket.priority} priority</span>
                        <span className="ticket-item-meta">Created {dateTime(ticket.created_at)} · Updated {dateTime(ticket.updated_at)}</span>
                      </button>)}
                    </div>
                  )}
                  <form id="new-ticket" className="form new-ticket-form" onSubmit={submitTicket}>
                    <h2>Submit a support request</h2>
                    <label className="field"><span>Related book</span><select value={ticketForm.bookId} onChange={(event) => setTicketForm({ ...ticketForm, bookId: event.target.value })}><option value="">General / Account Level</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
                    <label className="field"><span>Subject</span><input required maxLength={200} value={ticketForm.subject} onChange={(event) => setTicketForm({ ...ticketForm, subject: event.target.value })} /></label>
                    <label className="field"><span>How can we help?</span><textarea required maxLength={5000} rows={5} value={ticketForm.description} onChange={(event) => setTicketForm({ ...ticketForm, description: event.target.value })} /></label>
                    <label className="field"><span>Optional attachment (not uploaded)</span><input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      if (file && file.size > 10 * 1024 * 1024) {
                        setNotice({ type: 'error', text: 'Choose a file smaller than 10 MB.' });
                        event.target.value = '';
                        return;
                      }
                      setAttachmentName(file?.name ?? '');
                      setAttachmentFile(file);
                    }} /><small className="muted">{attachmentName ? `${attachmentName} is selected locally; it is not uploaded or saved with the ticket.` : 'Select a PDF or image up to 10 MB for a local preview.'}</small>{attachmentPreviewUrl && <img className="attachment-preview" src={attachmentPreviewUrl} alt={`Local preview of ${attachmentName}`} />}</label>
                    <button className="btn" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button>
                  </form>
                </section>
                <section className="card panel conversation-panel">
                  {!ticketDetail ? <EmptyState title="Select a ticket" body="Choose a support request to review its details and replies." /> : <TicketConversation ticket={ticketDetail} />}
                </section>
              </div>
            ) : (
              <AdminTicketQueue
                tickets={tickets}
                administrators={administrators}
                total={ticketTotal}
                page={ticketPage}
                search={search}
                statusFilter={statusFilter}
                categoryFilter={categoryFilter}
                priorityFilter={priorityFilter}
                authorFilter={authorFilter}
                assignmentFilter={assignmentFilter}
                createdFrom={createdFrom}
                createdTo={createdTo}
                selectedTicketId={selectedTicketId}
                ticketDetail={ticketDetail}
                draft={draft}
                reply={reply}
                internalNote={internalNote}
                busy={busy}
                onSearch={(value) => { setSearch(value); setTicketPage(1); }}
                onStatusFilter={(value) => { setStatusFilter(value); setTicketPage(1); }}
                onCategoryFilter={(value) => { setCategoryFilter(value); setTicketPage(1); }}
                onPriorityFilter={(value) => { setPriorityFilter(value); setTicketPage(1); }}
                onAuthorFilter={(value) => { setAuthorFilter(value); setTicketPage(1); }}
                onAssignmentFilter={(value) => { setAssignmentFilter(value); setTicketPage(1); }}
                onCreatedFrom={(value) => { setCreatedFrom(value); setTicketPage(1); }}
                onCreatedTo={(value) => { setCreatedTo(value); setTicketPage(1); }}
                onSelect={(id) => { setSelectedTicketId(id); setDraft(''); draftDirtyRef.current = false; }}
                onPage={setTicketPage}
                onUpdate={updateTicket}
                onAssign={assignTicket}
                onReplyChange={setReply}
                onNoteChange={setInternalNote}
                onSendReply={() => void sendAdminMessage('reply')}
                onSaveNote={() => void sendAdminMessage('note')}
                onGenerateDraft={() => void generateDraft()}
                onClassify={() => void rerunAI('classify')}
                onAssessPriority={() => void rerunAI('priority')}
                onUseDraft={() => void useDraft()}
                onSaveDraft={() => void saveDraft()}
                onDraftChange={(value) => { setDraft(value); draftDirtyRef.current = true; }}
              />
            )
          )}
        </main>
      </div>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: string | number }) {
  return <div className="card stat"><span>{title}</span><strong>{value}</strong></div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><strong>{title}</strong><p>{body}</p></div>;
}

function StatusBadge({ value }: { value: string }) {
  return <span className={`status-badge status-${value.toLowerCase().replace(/\s+/g, '-')}`}>{value}</span>;
}

function BookTable({ books, compact = false }: { books: Book[]; compact?: boolean }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState(compact ? 'recent' : 'title');
  const filtered = books.filter((book) => {
    const matchesText = `${book.title} ${book.isbn ?? ''} ${book.genre ?? ''}`.toLowerCase().includes(query.toLowerCase());
    return matchesText && (!status || book.publicationStatus === status);
  });
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'recent') return (b.publicationDate ?? '').localeCompare(a.publicationDate ?? '');
    if (sortBy === 'publicationDate') return (a.publicationDate ?? '9999').localeCompare(b.publicationDate ?? '9999');
    if (sortBy === 'earned') return b.totalRoyaltyEarned - a.totalRoyaltyEarned;
    if (sortBy === 'pending') return b.royaltyPending - a.royaltyPending;
    return a.title.localeCompare(b.title);
  });
  return (
    <section className="card panel table-panel">
      <div className="panel-heading"><div><h2>{compact ? 'Recently published books' : 'Book catalogue'}</h2><p className="muted">Details and balances are read from your publishing records.</p></div></div>
      {!compact && <div className="filter-row">
        <input aria-label="Search books" placeholder="Search title, ISBN, genre" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Filter by publication status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option>Published</option><option>In Production</option></select>
        <select aria-label="Sort books by" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="title">Title</option><option value="publicationDate">Publication date</option><option value="earned">Royalty earned</option><option value="pending">Pending royalty</option></select>
      </div>}
      {filtered.length === 0 ? <EmptyState title="No books found" body="Try changing your search or status filter." /> : (
        <div className="table-scroll"><table className="table"><thead><tr><th>Title / ISBN</th><th>Genre</th><th>Status / stage</th><th>Publication date</th><th>MRP</th><th>Royalty / copy</th><th>Copies sold</th><th>Earned</th><th>Paid</th><th>Pending</th><th>Last payout</th><th>Print partner</th><th>Platforms</th></tr></thead>
          <tbody>{sorted.map((book) => <tr key={book.id}>
            <td><strong>{book.title}</strong><small>{book.externalId} · {book.isbn ?? 'ISBN unavailable'}</small>
              <details className="book-details"><summary>Full record</summary><div><span>Book ID: {book.externalId}</span><span>Status: {book.sourceStatus}</span><span>Production stage: {book.productionStage ?? '—'}</span><span>Print partner: {book.printPartner ?? '—'}</span><span>Platforms: {book.distributionPlatforms?.length ? book.distributionPlatforms.join(', ') : '—'}</span></div></details>
            </td>
            <td>{book.genre ?? '—'}</td>
            <td><StatusBadge value={book.sourceStatus || book.publicationStatus} /></td>
            <td>{book.publicationDate ?? 'Not published'}</td><td>{money(book.mrp)}</td><td>{money(book.authorRoyaltyPerCopy)}</td><td>{book.totalCopiesSold.toLocaleString('en-IN')}</td>
            <td>{money(book.totalRoyaltyEarned)}</td><td>{money(book.royaltyPaid)}</td><td>{money(book.royaltyPending)}</td><td>{book.lastRoyaltyPayoutDate ?? '—'}</td><td>{book.printPartner ?? '—'}</td><td>{book.distributionPlatforms?.length ? book.distributionPlatforms.join(', ') : '—'}</td>
          </tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

function TicketConversation({ ticket }: { ticket: Ticket }) {
  return <>
    <div className="panel-heading"><div><div className="eyebrow">{ticket.id}</div><h2>{ticket.subject}</h2></div><StatusBadge value={ticket.status} /></div>
    <div className="ticket-facts"><span><small>Category</small>{ticket.category}</span><span><small>Priority</small>{ticket.priority}</span><span><small>Related book</small>{ticket.book_title ?? 'General / Account Level'}</span><span><small>Created</small>{dateTime(ticket.created_at)}</span><span><small>Updated</small>{dateTime(ticket.updated_at)}</span></div>
    <div className="conversation">
      <MessageCard role="author" authorName="You" content={ticket.description} timestamp={ticket.created_at} />
      {(ticket.messages ?? []).filter((item) => item.message_type === 'public' && item.sender_role !== 'author').map((item) => <MessageCard key={item.id} role={item.sender_role} authorName={item.sender_name ?? item.sender_role} content={item.content} timestamp={item.created_at} />)}
      {(ticket.messages ?? []).filter((item) => item.message_type === 'public' && item.sender_role !== 'author').length === 0 && <p className="muted">No support replies yet. This conversation refreshes automatically.</p>}
    </div>
  </>;
}

function MessageCard({ role, authorName, content, timestamp }: { role: string; authorName: string; content: string; timestamp: string }) {
  return <article className={`message-card ${role === 'admin' ? 'staff-message' : ''}`}><div className="message-heading"><strong>{authorName}</strong><time>{dateTime(timestamp)}</time></div><p>{content}</p></article>;
}

function AdminTicketQueue(props: {
  tickets: Ticket[]; administrators: Administrator[]; total: number; page: number; search: string; statusFilter: string; categoryFilter: string; priorityFilter: string;
  authorFilter: string;
  assignmentFilter: string; createdFrom: string; createdTo: string;
  selectedTicketId: string; ticketDetail: Ticket | null; draft: string; reply: string; internalNote: string; busy: boolean;
  onSearch: (value: string) => void; onStatusFilter: (value: string) => void; onCategoryFilter: (value: string) => void; onPriorityFilter: (value: string) => void;
  onAuthorFilter: (value: string) => void;
  onAssignmentFilter: (value: string) => void; onCreatedFrom: (value: string) => void; onCreatedTo: (value: string) => void;
  onSelect: (id: string) => void; onPage: (page: number) => void; onUpdate: (id: string, changes: Record<string, string>) => void;
  onAssign: () => void; onReplyChange: (value: string) => void; onNoteChange: (value: string) => void; onSendReply: () => void; onSaveNote: () => void;
  onGenerateDraft: () => void; onClassify: () => void; onAssessPriority: () => void; onUseDraft: () => void; onSaveDraft: () => void; onDraftChange: (value: string) => void;
}) {
  const ticket = props.ticketDetail;
  const maxPage = Math.max(1, Math.ceil(props.total / 25));
  return <div className="ticket-layout admin-ticket-layout">
    <section className="card panel queue-panel">
      <div className="panel-heading"><div><h2>Ticket queue</h2><p className="muted">{props.total} matching ticket{props.total === 1 ? '' : 's'} · urgent and older unresolved cases first</p></div></div>
      <div className="filters-grid">
        <input aria-label="Search tickets" placeholder="Search ID or subject" value={props.search} onChange={(event) => props.onSearch(event.target.value)} />
        <input aria-label="Filter tickets by author" placeholder="Filter author name" value={props.authorFilter} onChange={(event) => props.onAuthorFilter(event.target.value)} />
        <select aria-label="Filter ticket status" value={props.statusFilter} onChange={(event) => props.onStatusFilter(event.target.value)}><option value="">All statuses</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select>
        <select aria-label="Filter ticket category" value={props.categoryFilter} onChange={(event) => props.onCategoryFilter(event.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select>
        <select aria-label="Filter ticket priority" value={props.priorityFilter} onChange={(event) => props.onPriorityFilter(event.target.value)}><option value="">All priorities</option>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select>
        <select aria-label="Filter ticket assignment" value={props.assignmentFilter} onChange={(event) => props.onAssignmentFilter(event.target.value)}><option value="">Any assignment</option><option value="unassigned">Unassigned</option><option value="me">Assigned to me</option>{props.administrators.filter((admin) => admin.id !== 'me').map((admin) => <option key={admin.id} value={admin.id}>{admin.name}</option>)}</select>
        <label className="date-filter"><span>From</span><input aria-label="Created from" type="date" value={props.createdFrom} onChange={(event) => props.onCreatedFrom(event.target.value)} /></label>
        <label className="date-filter"><span>To</span><input aria-label="Created to" type="date" value={props.createdTo} onChange={(event) => props.onCreatedTo(event.target.value)} /></label>
      </div>
      {props.tickets.length === 0 ? <EmptyState title="Queue is clear" body="No tickets match the selected filters." /> : <div className="ticket-list admin-ticket-list">
        {props.tickets.map((item) => <button key={item.id} className={`ticket-list-item ${props.selectedTicketId === item.id ? 'selected' : ''}`} onClick={() => props.onSelect(item.id)}>
          <span className="ticket-item-top"><strong>{item.subject}</strong><StatusBadge value={item.status} /></span>
          <span className="ticket-item-meta">{item.author_name} · {item.id}</span>
          <span className="ticket-item-meta">{item.category} · <strong className={`priority-${item.priority.toLowerCase()}`}>{item.priority}</strong> · {item.assigned_admin_name ?? 'Unassigned'}</span>
          <span className="ticket-item-meta">{dateTime(item.created_at)}</span>
        </button>)}
      </div>}
      <div className="pagination"><button className="btn secondary" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</button><span>Page {props.page} of {maxPage}</span><button className="btn secondary" disabled={props.page >= maxPage} onClick={() => props.onPage(props.page + 1)}>Next</button></div>
    </section>
    <section className="card panel admin-detail-panel">
      {!ticket ? <EmptyState title="Select a ticket" body="Open a request in the queue to review details and take action." /> : <>
        <div className="panel-heading"><div><div className="eyebrow">{ticket.id}</div><h2>{ticket.subject}</h2><p className="muted">{ticket.author_name} · {ticket.author_email} {ticket.author_phone ? `· ${ticket.author_phone}` : ''} {ticket.author_city ? `· ${ticket.author_city}` : ''} {ticket.author_joined_date ? `· Joined ${ticket.author_joined_date}` : ''}</p></div><button className="btn secondary" onClick={props.onAssign}>Assign to me</button></div>
        {ticket.book_title && <section className="book-ticket-summary"><h3>Related book record</h3><p><strong>{ticket.book_title}</strong> · {ticket.book_external_id}</p><p>ISBN: {ticket.book_isbn ?? '—'} · Genre: {ticket.book_genre ?? '—'} · Status: {ticket.book_source_status ?? '—'} · Publication date: {ticket.book_publication_date ?? '—'}</p><p>MRP: {money(ticket.book_mrp)} · Royalty/copy: {money(ticket.book_royalty_per_copy)} · Copies sold: {(ticket.book_total_copies_sold ?? 0).toLocaleString('en-IN')} · Earned: {money(ticket.book_total_royalty_earned)} · Paid: {money(ticket.book_royalty_paid)} · Pending: {money(ticket.book_royalty_pending)} · Print partner: {ticket.book_print_partner ?? '—'}</p></section>}
        <div className="ticket-facts"><span><small>Related book</small>{ticket.book_title ?? 'General / Account Level'}</span><span><small>Created</small>{dateTime(ticket.created_at)}</span><span><small>AI category</small>{ticket.ai_category ?? 'Unavailable'}{ticket.ai_category_confidence != null && <small>Confidence {Math.round(ticket.ai_category_confidence * 100)}%</small>}{Boolean(ticket.category_needs_review) && <small className="override-meta">Manual review required</small>}{ticket.category_override_by && <small className="override-meta">Final category overridden by {ticket.category_override_name ?? 'admin'} · {ticket.category_overridden_at ? dateTime(ticket.category_overridden_at) : ''}</small>}</span><span><small>AI priority</small>{ticket.ai_priority ?? 'Unavailable'}{ticket.ai_priority_confidence != null && <small>Confidence {Math.round(ticket.ai_priority_confidence * 100)}%</small>}{Boolean(ticket.priority_needs_review) && <small className="override-meta">Manual review required</small>}{ticket.priority_override_by && <small className="override-meta">Final priority overridden by {ticket.priority_override_name ?? 'admin'} · {ticket.priority_overridden_at ? dateTime(ticket.priority_overridden_at) : ''}</small>}</span><span><small>Assignment</small>{ticket.assigned_admin_name ?? 'Unassigned'}</span></div>
        <div className="admin-controls">
          <label className="field"><span>Status</span><select value={ticket.status} onChange={(event) => props.onUpdate(ticket.id, { status: event.target.value })}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label>
          <label className="field"><span>Final category</span><select value={ticket.category} onChange={(event) => props.onUpdate(ticket.id, { category: event.target.value })}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="field"><span>Final priority</span><select value={ticket.priority} onChange={(event) => props.onUpdate(ticket.id, { priority: event.target.value })}>{priorities.map((priority) => <option key={priority}>{priority}</option>)}</select></label>
        </div>
        <div className="ai-triage-actions"><button className="btn secondary" disabled={props.busy} onClick={props.onClassify}>Re-run AI classification</button><button className="btn secondary" disabled={props.busy} onClick={props.onAssessPriority}>Reassess AI priority</button></div>
        <div className="conversation admin-conversation">
          {(ticket.messages ?? []).map((item) => <article key={item.id} className={`message-card ${item.message_type === 'internal_note' ? 'internal-message' : item.sender_role === 'admin' ? 'staff-message' : ''}`}>
            <div className="message-heading"><strong>{item.message_type === 'internal_note' ? 'Internal note' : item.sender_name ?? item.sender_role}</strong><time>{dateTime(item.created_at)}</time></div><p>{item.content}</p>
          </article>)}
          <div className="draft-box"><div className="panel-heading"><div><h3>AI response draft</h3><p className="muted">Generating or editing a draft does not send it.</p></div><button className="btn secondary" disabled={props.busy} onClick={props.onGenerateDraft}>Generate draft</button></div>
            <textarea rows={5} value={props.draft} onChange={(event) => props.onDraftChange(event.target.value)} placeholder="Generate a draft or write a response here." />
            <button className="btn secondary" disabled={props.busy || !props.draft.trim()} onClick={props.onSaveDraft}>Save draft</button>
            <button className="btn secondary" disabled={!props.draft.trim()} onClick={props.onUseDraft}>Copy draft to public reply</button>
          </div>
          <div className="form admin-message-form"><label className="field"><span>Public reply to author</span><textarea rows={3} value={props.reply} onChange={(event) => props.onReplyChange(event.target.value)} /></label><button className="btn" disabled={props.busy || !props.reply.trim()} onClick={props.onSendReply}>Send public reply</button></div>
          <div className="form admin-message-form internal-note-form"><label className="field"><span>Internal note (staff only)</span><textarea rows={3} value={props.internalNote} onChange={(event) => props.onNoteChange(event.target.value)} /></label><button className="btn secondary" disabled={props.busy || !props.internalNote.trim()} onClick={props.onSaveNote}>Save internal note</button></div>
        </div>
      </>}
    </section>
  </div>;
}
