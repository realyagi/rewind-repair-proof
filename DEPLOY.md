# Deploying REWIND on Vultr with Coolify

## Architecture
```text
Internet -> proxy (Caddy / Coolify Traefik)
             |-- frontend  (React SSR, :3000)
             '-- api       (Express REST, :4000) --+
                                                   |  internal network (no internet ingress)
             worker (queue, repair engine) --------+-- postgres
             sandbox (runner API) --- dind (isolated Docker daemon) --- disposable project containers
```
- Project code runs ONLY in disposable containers created by the `dind` daemon: `--network none` (except optional install step), `--cap-drop ALL`, `--read-only`, CPU/memory/pids/tmpfs-disk limits, timeouts, no secrets, no DB network, no host Docker socket.
- PostgreSQL, worker, sandbox and dind are on `internal: true` networks — never published.

## 1. Vultr server
1. Create a Vultr Cloud Compute instance (Ubuntu 24.04, ≥ 4 vCPU / 8 GB recommended).
2. Point your domain's A record to the server IP.
3. Install Coolify: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`, open `http://<ip>:8000`.

## 2. Coolify
1. New Resource -> Docker Compose -> connect your GitHub repo (this project), branch `main`, compose file `docker-compose.yml`.
2. Paste every variable from `.env.example` into Environment Variables with real values.
3. Assign your domain to the **proxy** service (port 80). Coolify issues HTTPS via Let's Encrypt. Remove the `ports:` line on `proxy` if Coolify complains about port 80.
4. Deploy. Migrations run automatically on API start (`prisma migrate deploy`).

## 3. Clerk
1. In the Clerk Dashboard for your existing application -> **Configure -> SSO connections**: enable **Google** and **GitHub**. For production, supply your own OAuth credentials:
   - Google Cloud Console -> OAuth client (Web) -> redirect URI shown by Clerk.
   - GitHub -> Settings -> Developer settings -> OAuth Apps -> callback URL shown by Clerk.
2. **Domains**: add your production domain. Copy the publishable/secret keys into Coolify (`VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`).

## 4. GitHub private-repo import (optional)
Create a separate GitHub OAuth App: callback `https://<domain>/api/github/callback`. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ENCRYPTION_KEY`. REWIND never pushes to repositories.

## 5. AI providers
- `VULTR_INFERENCE_API_KEY` + `VULTR_INFERENCE_MODEL` (required for repair runs; list models via `GET https://api.vultrinference.com/v1/models`).
- `GEMINI_API_KEY` (optional assistant).
The app starts without them and shows "not configured" in Settings.

## 6. Sandbox hardening notes
- `dind` runs privileged but is isolated on an internal network reachable only by `sandbox`. For stronger isolation, run dind with `--runtime=runsc` (gVisor) or replace it with a separate VM.
- Install-step network (`SANDBOX_INSTALL_NETWORK=bridge`) allows package downloads. Set to `none` to fully disable network; commands that need dependencies will then fail truthfully. Block cloud metadata on the host: `iptables -I DOCKER-USER -d 169.254.169.254 -j DROP`.

## 7. Live Preview
Previews run the repaired project in a dedicated container (separate from repair exec containers):
- Network `rewind_preview` inside dind: bridge with masquerade disabled (no internet/metadata egress) and ICC off. Install/build happens first in a separate egress-only container, then a snapshot runs offline.
- dind drops all traffic from container bridges to the dind host (so previews cannot reach the Docker API on 2375).
- Limits: `PREVIEW_CPU_LIMIT`, `PREVIEW_MEMORY_LIMIT`, `PREVIEW_PIDS_LIMIT`, `SANDBOX_DISK_LIMIT` (needs `SANDBOX_STORAGE_OPT=1` + overlay2 on xfs), lifetime `PREVIEW_TTL_MINUTES` (hard cap `PREVIEW_MAX_TTL_SECONDS`). The worker expires sessions from Postgres every 30s; the sandbox removes every leftover preview container on restart.
- Routing: browser → Caddy (`*.PREVIEW_BASE_DOMAIN`) → API (validates the hashed per-session token embedded in the host name) → sandbox `/proxy/<id>` → fixed dind port. No user-controlled upstreams.
- **Required**: set `PREVIEW_BASE_DOMAIN` to a site different from `APP_URL`. Without a domain use `<server-ip>.nip.io` and `PREVIEW_SCHEME=http`. With a domain, point wildcard DNS `*.your-preview-domain` at the server; for HTTPS you need a wildcard certificate (DNS challenge) in Caddy/Coolify and `PREVIEW_SCHEME=https`.
- Supported: static HTML, Vite (incl. React), Create React App, Next.js. Commands come from a fixed allowlist, never from package.json scripts.

Deploy (the additive migration runs automatically on API start; no data is removed):
```bash
docker compose build api worker sandbox frontend
docker compose up -d api worker sandbox dind proxy frontend
```

## Local development
```bash
cp .env.example .env   # fill values
docker compose up --build
```
