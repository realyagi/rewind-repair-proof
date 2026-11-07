# REWIND

**Find the cause. Fix the code. Prove it works.**

REWIND is an AI-powered software investigation and repair platform. It imports a project, inspects its source, reproduces failures in an isolated environment, traces the root cause, applies a focused patch, and runs verification again.

## What it does

- Import projects from ZIP archives or GitHub repositories.
- Inspect project structure, languages, dependencies, and scripts.
- Run builds and tests in isolated Docker sandboxes.
- Diagnose failures using real logs and source-code evidence.
- Generate reviewable patches and unified diffs.
- Verify repairs with actual test/build exit codes.
- Download repaired project artifacts and inspect repair reports.
- Keep project history and repair runs available in the dashboard.

REWIND distinguishes verified, unverified, failed, and unreproduced runs. It never reports a successful repair unless the configured verification commands actually pass.

## Architecture

- **Frontend:** React, TypeScript, TanStack Start, Tailwind CSS.
- **API and worker:** Node.js, TypeScript, REST.
- **Database:** PostgreSQL with Prisma migrations.
- **Authentication:** Clerk.
- **AI:** Vultr Serverless Inference for repair-agent reasoning; optional Gemini support for explanations.
- **Execution:** Docker-based isolated sandbox services.
- **Deployment:** Docker Compose on your own infrastructure.

## Local development

Requirements: Bun, Docker, and a PostgreSQL instance.

```bash
git clone https://github.com/realyagi/rewind-repair-proof.git
cd rewind-repair-proof
bun install
bun run dev
```

Copy `.env.example` to `.env` and configure the required values. Never commit real API keys, access tokens, or production credentials.

## Self-hosting

See [DEPLOY.md](./DEPLOY.md) for server setup, environment configuration, Docker Compose deployment, and operational guidance.

## Project principles

1. Real evidence over simulated progress.
2. Isolated execution for untrusted project code.
3. Reviewable changes before applying patches.
4. Verification before claiming success.
5. Self-hosted infrastructure and user-owned project data.
