# Architecture and operating notes

## Components

- **React/Vite client (`src/`)** renders author and admin sections and communicates with the REST API using credentialed fetch requests. The client never receives or uses the OpenAI key.
- **Express API (`server/index.ts`)** owns authentication, role checks, validation, ticket lifecycle actions, and client-safe HTTP errors. Roles and author ownership are derived from the session, never request-supplied identity.
- **SQLite access (`server/db.ts`)** owns relational schema, idempotent imports from the supplied nested JSON, dashboard calculations, and ticket persistence. The attachment's exact ten authors and eighteen books are active records. Prior demo seed records are retained but inactive, and their logins are disabled so existing references are not deleted or misattributed. Foreign keys connect books/tickets/messages to their records. Additional columns are added using idempotent schema checks for existing local databases.
- **SQLite session store (`server/sessionStore.ts`)** stores session data and expirations in SQLite rather than express-session's development-only in-memory store.
- **AI service (`server/ai.ts`)** sends bounded ticket data to OpenAI only from the backend, validates JSON against Zod schemas and exact enumerations, and reports conservative fallback usage when disabled or unavailable.

## Main data flow

1. Startup applies the schema and idempotently seeds authors/books. Local development seeds demo users; production rejects the demo-account flag and imports no demo users.
2. Login verifies a bcrypt hash, then the server uses an HTTP-only session cookie. Author/admin middleware checks the corresponding persisted user role on each request.
3. An author submits a ticket. The server verifies any selected book belongs to that author, runs optional classification and priority assessment, then inserts the ticket and original author message in a database transaction. A provider failure does not block ticket creation.
4. Admins can update a ticket's status, final category/priority, and assignment. Original AI values remain separate; overrides record the administrator and timestamp. Notes are `internal_note` records, drafts are `draft` records, and deliberately sent replies are `public` records.
5. Author list/detail endpoints only query public messages and verify ticket ownership. The React client polls the authorized detail endpoint every ten seconds; internal notes and drafts are never returned on that route.

## Queue behavior

Admin queue order is deterministic: unresolved tickets first, then Critical, High, Medium, Low, then oldest ticket first within each group; resolved and closed tickets follow. Search, filters, and pagination are applied by the API. This avoids newer low-priority or completed tickets obscuring older active urgent cases.

## AI and policy behavior

The default model is `gpt-4o-mini`, configurable using `OPENAI_MODEL`. Each request uses a 12-second timeout, one SDK retry, bounded input size, and JSON output validation. Category and priority outputs must match the six/four canonical enum values exactly. Draft prompts include only the selected case, relevant book records, the BookLeaf knowledge base, and at most five recent public messages. Ticket text is explicitly treated as untrusted. Draft generation persists an editable staff draft and never sends it.

Fallback behavior is intentionally distinguishable: API responses report `usedFallback` and source values, and ticket records mark category/priority suggestions that need manual review. Invalid or low-confidence categories become `General Inquiry`. Fallback drafts use category-specific policy, request verification, and do not claim that BookLeaf has completed an action.

## Deployment and scaling trade-offs

The app can run as one Express instance plus a static Vite host. Configure `VITE_API_BASE`, CORS `CLIENT_URL`, session signing, and HTTPS cookie settings for the deployed origins. Startup applies idempotent additive SQLite schema changes before seeding; back up an existing database before deploying schema changes. SQLite session storage survives restarts but assumes one instance or a shared persistent disk. Rate limits are in-process and should be moved to shared storage for multiple instances. For multiple instances, replace SQLite with managed PostgreSQL and a shared session store, then add formal migrations and operational monitoring. No live deployment is configured or verified in this workspace.
