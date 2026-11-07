# REWIND — Project Engineering Rules

- Production is self-hosted with Docker Compose (frontend, API, worker, sandbox, and PostgreSQL).
- Frontend communicates with the backend through `src/lib/api.ts` using a Clerk bearer token.
- Repair-agent reasoning uses Vultr Inference in `server/src/ai/providers.ts`; Gemini is optional for explanations only.
- Untrusted project code executes only in the isolated sandbox service, never in the API or worker.
- A repair is marked verified only when real sandbox verification commands exit successfully.
- Schema changes require a new hand-written SQL migration in `server/prisma/migrations/`.
- Live Preview runs through the sandbox preview service on its isolated network and separate preview domain.
- Run timelines, proof, and reports are derived from persisted run records; never fabricate events or results.
- Preserve existing data volumes and deployment configuration when changing application code.
