# Contributing to Companions

Thanks for your interest in contributing! This document covers the basics for getting your development environment running and submitting changes.

---

## Development setup

**Prerequisites:** Node ≥ 20, Git, npm.

```bash
git clone https://github.com/sandoe/companions.git
cd companions

# Server
cd server && npm install

# Web app
cd ../web && npm install
npm run dev            # Vite dev server at http://localhost:5173

# Mobile app (requires Expo CLI)
cd ../app && npm install
npm run build          # exports the Expo web build used by the server
npx expo start

# Build server + browser assets used by /install, /dashboard, and /app
cd ../server && npm run setup
```

Start the server with `cd server && npm start` (or `npm run dev` for hot-reload via tsx).

---

## Branch conventions

| Branch | Purpose |
|---|---|
| `main` | Always releasable. Protected. |
| `feat/<name>` | New features. |
| `fix/<name>` | Bug fixes. |
| `chore/<name>` | Tooling, deps, docs, CI. |

Open a PR against `main`. Keep branches short-lived.

---

## Commit style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(setup): add emoji picker to persona screen
fix(auth): debounce lastSeenAt writes to reduce I/O
chore(deps): bump ws to 8.18.0
docs(networking): add Cloudflare Tunnel alternative
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `ci`.

---

## Typecheck + lint

```bash
# Server
cd server && npm run typecheck

# Web
cd web && npm run typecheck

# App
cd app && npm run typecheck
```

CI runs all three on every PR. Don't open a PR with type errors.

---

## Testing

There are no automated tests yet — this is listed in the roadmap.

---

## Adding a provider

See `server/src/models.ts` and the install/dashboard flows under `server/src/install.ts` and `web/src/dashboard/`. Add the new provider ID and update any required environment variable documentation.

---

## Questions?

Open a Discussion or a draft PR and we'll figure it out together.
