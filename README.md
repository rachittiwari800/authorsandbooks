# BookLeaf Author Support & Communication Portal

A working React/Vite and Express/TypeScript application for BookLeaf authors and support administrators. SQLite stores the supplied publishing dataset, users, durable sessions, tickets, messages, and administrative decisions.

## What works

- Session login/logout with bcrypt password hashes, HTTP-only cookies, and author/admin checks on every protected API.
- Persistent SQLite-backed sessions and role-linked demo author/admin accounts for local development.
- Dataset-seeded author dashboard, book catalogue, royalty totals, null-safe book details, production stage, platform and partner fields.
- Author support tickets with account-level or author-owned book selection, classification/priority, ticket list, and public conversation view.
- Admin queue with priority/age ordering, search, status/category/priority/assignee/date filters, pagination, status changes, classification/priority overrides, and self-assignment.
- Separate staff-only notes, persisted drafts, and deliberately sent public replies. Authors only receive public messages.
- Ten-second ticket conversation polling, with server-side authorization on every refresh.
- Backend-only OpenAI service for structured category/priority suggestions and policy-grounded drafts. Ticket creation and manual support continue when the provider is unavailable.
- Responsive layouts, accessible labels/focus indicators, loading/empty/error states, and a local-only attachment picker that clearly does not upload files.

## Stack and design

- React 18, TypeScript, Vite
- Express, express-session, SQLite via better-sqlite3
- bcryptjs for password hashing; Zod for request/model output validation; OpenAI SDK for optional server-side LLM calls
- SQLite remains the existing lightweight project database rather than introducing a disruptive PostgreSQL migration. See [architecture notes](./docs/architecture.md).

## Requirements

- Node.js 20.19+ or 22.12+
- npm

## Local setup

From the project directory:

```powershell
npm install
Copy-Item .env.example .env
@'
const fs = require("node:fs");
const crypto = require("node:crypto");
let env = fs.readFileSync(".env", "utf8");
for (const [key, value] of [
  ["SESSION_SECRET", crypto.randomBytes(48).toString("hex")],
  ["SEED_PASSWORD", crypto.randomBytes(24).toString("hex")],
]) {
  const setting = new RegExp("^" + key + "=.*$", "m");
  if (!setting.test(env)) throw new Error("Missing " + key + " in .env");
  env = env.replace(setting, key + "=" + value);
}
fs.writeFileSync(".env", env, "utf8");
'@ | node -
npm run dev
```

The command writes unique values directly into `.env`; keep that file private and do not share or commit it. Open `http://localhost:5173`. The server starts on port 3001. Vite proxies `/api` requests to it. The API health check is `http://localhost:3001/health`.

The exact author and book records from the supplied attachment are imported idempotently at server startup from `bookleaf_sample_data.json`: 10 authors and 18 books. Original book status strings are retained alongside normalized values used for filtering. It can also be explicitly imported with `npm run seed`. The SQLite database is `bookleaf.db` by default; set `DATABASE_URL` to use another path.

Local demo accounts are generated for each supplied author plus `admin@bookleaf.local`. All use the unique `SEED_PASSWORD` you set in `.env`; there is no shared default password. The backend refuses to start demo accounts if that value is empty or shorter than 12 characters. The same email and password can be used to sign in as any local sample author; the admin email is `admin@bookleaf.local`. Never use demo accounts in production.

To log in locally, start the app with `npm run dev`, open `http://localhost:5173`, and enter `admin@bookleaf.local` for the support desk or one of the author emails below for the author portal. Use the `SEED_PASSWORD` value stored in your private `.env` file for either account type. If the browser shows a server error, confirm both development processes are running and that `http://localhost:3001/health` returns `{"ok":true,"service":"bookleaf-api"}`.

All ten attached author accounts use the configured local `SEED_PASSWORD`:

- Priya Sharma — `priya.sharma@email.com`
- Rohit Kapoor — `rohit.kapoor@email.com`
- Ananya Reddy — `ananya.reddy@email.com`
- Vikram Joshi — `vikram.joshi@email.com`
- Meera Nair — `meera.nair@email.com`
- Arjun Malhotra — `arjun.malhotra@email.com`
- Sneha Kulkarni — `sneha.kulkarni@email.com`
- Farhan Sheikh — `farhan.sheikh@email.com`
- Kavita Deshmukh — `kavita.deshmukh@email.com`
- Diya Chatterjee — `diya.chatterjee@email.com`

The seed process upserts the supplied records and password hashes on startup; change `SEED_PASSWORD` in `.env` and run the seed command to rotate local demo credentials. The previously seeded example records are retained in the database with inactive flags, and their old author accounts cannot sign in; no ticket history or source records are deleted.

## Environment

See [.env.example](./.env.example). Important values:

| Variable | Purpose |
|---|---|
| `PORT` | Express listening port (default 3001) |
| `NODE_ENV` | `development`, `test`, or `production` |
| `SESSION_SECRET` | Required unique session signing secret of at least 32 characters |
| `DATABASE_URL` | SQLite path |
| `SEED_PASSWORD` | Required local demo-account seed password (at least 12 characters); leave unset in production |
| `ENABLE_DEMO_ACCOUNTS` | Local defaults to enabled; production explicitly rejects enabling demo accounts |
| `OPENAI_API_KEY` | Optional server-only AI provider key; empty disables external AI |
| `OPENAI_MODEL` | Model name (default `gpt-4o-mini`) |
| `CLIENT_URL` | Allowed frontend origin for credentialed CORS |
| `COOKIE_SECURE` | Set true for HTTPS production |
| `COOKIE_SAME_SITE` | `lax`, `strict`, or `none`; `none` requires secure cookies |
| `VITE_API_BASE` | Optional API origin/base for separately hosted frontend (must end in `/api`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Optional one-time production admin bootstrap; both must be set together. The password must be at least 12 characters and is not changed on later restarts. |
| `AUTHOR_EMAIL` / `AUTHOR_PASSWORD` | Optional one-time bootstrap for a single author in the supplied dataset; both must be set together. Use the private account provisioner for distinct passwords across every author. |

The first application start runs idempotent additive SQLite schema migrations and imports the dataset. Back up `bookleaf.db` before upgrading an existing deployment. Use `npm run seed` to repeat the import explicitly.

Generate a production session secret locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Do not commit `.env`, API keys, production credentials, or the local SQLite database. Production mode imports book/author data but does not create demo login accounts.

## Commands

```powershell
npm run dev       # Vite and Express development servers
npm run seed      # Idempotently seed the provided dataset and local demo accounts
npm run provision:accounts # Generate separate production login passwords in a private one-time file
npm test          # Vitest API integration tests
npm run lint      # Frontend and server TypeScript checks
npm run build     # Vite frontend and compiled Express backend
npm start         # Start compiled backend (frontend should be hosted separately)
```

The tests cover all supplied author/book values and duplicate IDs, authentication and role separation, author ownership, persisted ticket actions, public/internal message boundaries, queue priority/age ordering and filters, AI schema validation and provider failure fallbacks, and invalid input. Live OpenAI behavior is not tested without credentials. Reproduce the local checks with `npm test`, `npm run lint`, `npm run build`, and `npm audit`.

## Security decisions

- Session IDs are HTTP-only cookies; session data is persisted in SQLite, and authentication regenerates the session on login.
- Passwords are bcrypt-hashed. Local demo accounts require a unique configured password; demo accounts are disabled in production.
- Server middleware enforces role and author ownership on every protected API. Admin notes/drafts use separate message types and are not selected by author-facing message queries.
- CORS is restricted to `CLIENT_URL`; production cookies require HTTPS. Login, ticket creation, and AI routes have rate limits, with additional per-ticket AI cooldowns.
- `OPENAI_API_KEY` is read only by the backend and is never part of Vite environment variables or API responses. The workspace has no Git metadata, so repository privacy and tracked-secret state cannot be verified.

## AI strategy

When `OPENAI_API_KEY` is configured, the backend uses the configured model (default `gpt-4o-mini`), selected as a cost-conscious option for short classification and support drafts. Requests have a 12-second timeout, one SDK retry, a 350-token output cap for structured triage, JSON output validation, and exact category/priority enums. Draft prompts include the relevant BookLeaf policy, the specific ticket, the author's name, only the selected book's relevant facts, and at most five recent public messages (500 characters each)—not the full ticket history or whole dataset. Ticket content is treated as untrusted data; system instructions and the policy knowledge base govern generation.

When the key is missing or the provider fails, tickets still persist with a safe General Inquiry category and a conservative priority recommendation, both marked for manual review. Draft fallback text is calibrated to the supplied royalty, ISBN, printing, distribution, production, and metadata examples. It calculates the next quarterly payout deadline from the 45-day policy, distinguishes that deadline from a guaranteed individual payment date, and does not invent an escalation or distribution action that the application did not perform. Drafts require staff review; the portal never sends them automatically. A low-confidence or malformed model result is never stored as an arbitrary enum value. Drafts are stored as staff-only `draft` messages; admins must explicitly copy/edit and send a public reply. Authentication, ticket creation, and AI actions are rate limited in-process; each ticket's AI regeneration also has a 30-second cooldown.

## API outline

- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- Author: `GET /api/author/dashboard`, `GET /api/author/books`, `GET|POST /api/author/tickets`, `GET /api/author/tickets/:id`
- Admin: `GET /api/admin/dashboard`, `GET /api/admin/dashboard/metrics`, `GET /api/admin/tickets`, `GET /api/admin/tickets/:id`, `PATCH /api/admin/tickets/:id`
- Admin actions: `POST /api/admin/tickets/:id/assign`, `/notes`, `/replies`, `/draft`, `/ai/classify`, `/ai/priority`, `/ai/draft`
- Health: `GET /health`

The checked-in [OpenAPI document](./docs/openapi.yaml) describes the main request and response surfaces. AI regeneration has a per-ticket 30-second cooldown and returns `429` with a retry delay when invoked too soon.

Author ticket detail returns only public messages. Internal notes and drafts are available only to admins. Assignment/category/priority changes are validated on the server and category/priority override actor/timestamps are persisted.

## Deployment notes and limitations

Deployment target: Vercel for the static frontend and Render for the Express API. A [Render Blueprint](./render.yaml) is included for the API, generated session secret, HTTPS cookies, health check, and persistent SQLite disk. To deploy:

1. Keep the GitHub/GitLab repository private and create the Render web service from `render.yaml`; do not publish the assignment or repository publicly.
2. Set `CLIENT_URL` in Render to the final Vercel frontend origin. Add `OPENAI_API_KEY` only if AI is enabled.
3. In Vercel, import the same private repository, use `npm run build:client` as the build command and `dist` as the output directory, and set `VITE_API_BASE` to `https://<render-service-host>/api`.
4. Confirm Render has `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, and the generated `SESSION_SECRET`. Deploy both services, then check `https://<render-service-host>/health` and exercise sign-in, ticket creation, admin reply, and author-visible polling over HTTPS.

The project is prepared for this deployment shape. Production demo accounts remain disabled by default; provision distinct accounts through the operator-only procedure below after deployment.

### Provision separate production passwords

Production demo accounts stay disabled. After deploying a build that includes `provision:accounts`, open the Render service's private Shell and run:

```sh
npm run provision:accounts
```

The command seeds/updates the source records, creates a different cryptographically random password for every active author and `admin@bookleaf.local`, and stores only bcrypt hashes in the database. It writes the one-time plaintext credentials to an owner-only file under the system temporary directory and prints that file's path. In the same private Render Shell, inspect that exact path with `cat '<printed-path>'`, securely deliver each password only to its corresponding person, then remove the file with `rm -- '<printed-path>'`. Do not paste the contents into chat, commit them, or leave the file around.

The generated account list contains author emails already shown in this README and the admin email configured by `ADMIN_EMAIL` (or `admin@bookleaf.local` when unset). If one-time `ADMIN_*`/`AUTHOR_*` bootstrap variables have already created active accounts, use `npm run provision:accounts -- --reset-existing` to replace them with a separate generated password for every seeded author and the admin. Running without the flag refuses to replace any active accounts. The reset command creates a new credential file. This tool does not email users or implement self-service password reset.

SQLite sessions and data fit a single-instance demonstration/deployment; use a managed relational database and a shared session store before horizontal scaling. File selection is a local preview only; files are not uploaded or stored. Near-real-time updates use authenticated polling rather than SSE/WebSockets.

See [architecture notes](./docs/architecture.md) and [brief assignment write-up](./docs/assignment-brief.md) for additional decisions and trade-offs.
