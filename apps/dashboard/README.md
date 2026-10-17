# Urumi MCP Gateway dashboard

Admin and member UI for the gateway: React 19 + Vite + TypeScript, served in production by
`nginxinc/nginx-unprivileged` on port 8080. It talks only to the gateway's REST API under `/api`
(contracts.md §9) and to the chat SSE stream `POST /api/chat` (§11); the browser session is the
`gw_session` cookie, so the dashboard must be served from the same origin as the gateway (the
Ingress routes `/api` and `/mcp` to the gateway and everything else here).

## Run locally

```sh
cd apps/dashboard
npm ci

# Terminal 1: an in-memory mock of the gateway on http://localhost:8080
npm run dev:mock

# Terminal 2: Vite on http://localhost:5173, proxying /api -> localhost:8080
npm run dev
```

Mock accounts (everything resets on restart):

| Email | Password | Role |
|---|---|---|
| `admin@example.com` | `admin123` | admin |
| `member@example.com` | `member123` | member |

The mock implements every §9 endpoint with fake data (three seeded servers in the three states,
users, keys, a 60-row audit log that pages through `nextBefore`) and a simulated §11 chat stream
that emits `start`, streamed `text`, one `tool_call` / `tool_result` pair and `done`. Environment
knobs: `PORT` (default 8080), `PUBLIC_URL` (used in invite links and the connect snippets),
`CHAT_ENABLED=false` to see the "chat disabled" notice.

To point the dev server at a real gateway instead, run it on 8080 (or change the proxy target in
`vite.config.ts`) and sign in with a real account.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on 5173 with the `/api` proxy |
| `npm run dev:mock` | mock gateway (`mock/server.mjs`) on 8080 |
| `npm run build` | production build to `dist/` |
| `npm run preview` | serve `dist/` locally (no proxy; pair with a gateway on the same origin) |
| `npm run typecheck` | `tsc --noEmit` for `src/` and `vite.config.ts` |
| `npm test` | vitest: the SSE parser (`src/sse.test.ts`) and API error mapping (`src/api.test.ts`) |

## Routes

| Path | Who | Page |
|---|---|---|
| `/login` | anyone | email + password sign-in; returns to the page a 401 bounced you from |
| `/invite/:token` | anyone | accept an invitation: choose name + password, signs you in |
| `/` | session | servers list with status badges (connected / unreachable / disabled); admins get add / edit / enable / disable / refresh / remove, including the member tool policy (all / allowlist / denylist with `*` globs) |
| `/servers/:id` | session | one server: status, configuration, and the tools table with public names (`slug__tool`), hints and (admins) the members-allowed flag |
| `/chat` | session | streams `POST /api/chat` over fetch + ReadableStream; tool-call cards update in place as results arrive; header shows acting-as user, visible tool count, model and provider; shows a notice and disables the composer when `config.chat.enabled` is false |
| `/audit` | session | audit log with outcome / source / server / user filters (members see only their own rows), "Load more" via `nextBefore`, optional 5 s auto-refresh that prepends new rows |
| `/keys` | session | your API keys: create (plaintext shown once with copy), revoke, and the "Connect an MCP client" panel with ready-to-paste Claude Code, Cursor `mcp.json` and MCP Inspector CLI snippets |
| `/team` | admin | users: invite (link shown once), change role / status, delete, and issue / revoke keys per user |

Non-admins are redirected from `/team` to `/`; any 401 from a session route clears the user and
sends them to `/login`.

## Layout

```
src/
  api.ts            typed client for §9 + the §11 stream (credentials: 'include', ApiError, 401 hook)
  sse.ts            streaming SSE parser (fetch + ReadableStream; EventSource cannot POST)
  types.ts          wire types copied from contracts.md
  features/         one folder per route: auth, servers, chat, audit, keys, team, layout
  ui/               small presentational primitives (Button, Badge, Table, Modal, Toast, ...)
  lib/              useAsync, useConfig, formatting, error helpers
mock/               the mock gateway used by `npm run dev:mock`
nginx.conf          SPA fallback, /healthz + /readyz, immutable caching for /assets
Dockerfile          node:22-alpine build stage -> nginx-unprivileged:1.27-alpine runtime (8080)
```

## Container

```sh
docker build -t urumi/dashboard:dev apps/dashboard
docker run --rm -p 8080:8080 urumi/dashboard:dev
curl -s localhost:8080/healthz   # ok
```

The image runs as the unprivileged `nginx` user, serves `dist/` with an SPA fallback to
`index.html` (never cached) and answers `GET /healthz` and `GET /readyz` with 200. It does not
proxy `/api`; that is the Ingress's job.
