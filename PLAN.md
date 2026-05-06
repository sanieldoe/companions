# Companions — Product Plan

> A working, technical plan for taking Companions from a private repo to a polished, self-hostable open-source project that anyone can install in under five minutes.

---

## 1. Vision

Companions is a self-hosted, four-tab AI agent system for organisation, creativity, and reflection. Instead of a single generic chatbot, you get four specialised agents — **Mentor** (deep thinking, learning, debugging), **Shapeshifter** (creative experiments, quick builds, canvas outputs), **Keeper** (notes, journaling, wiki maintenance), and **Tracker** (calendar, scheduling, tasks) — each with its own tab, persona, and accent colour, but all sharing a single local vault of markdown notes, a wiki, a journal, and project folders. The vault is yours: plain files on your disk, editable in any text editor, versionable in git.

The point is *sovereignty plus structure*. Most "AI second brain" products either lock your data in their cloud or give you a single undifferentiated assistant that has to be everything at once. Companions is the opposite: your data sits in `~/companions-vault/` on your own machine, the server runs on hardware you control (laptop, NAS, mini-PC), and four distinct agents with distinct jobs share that vault. Companions is **bring-your-own-LLM**: you plug in Anthropic, OpenAI, or any OpenAI-compatible local model (Ollama, LM Studio, llama.cpp). Nothing is bundled, and there is no default provider — setup fails gracefully and refuses to start if no provider is configured. The same UI works whether you're paying per-token or running entirely offline.

The target user is a developer or power-user who already keeps notes in Obsidian / Logseq / a folder of markdown files, who has API keys or a local model set up, and who wants something more opinionated than raw ChatGPT but more open than Notion AI. The project ships an Android app (via Expo / EAS) and a web app, both of which connect to the user's self-hosted server over Tailscale (or equivalent). One owner, one vault, four agents, every device.

**Scope decisions for v1** (see §10 for context — the previously-open questions are now closed):

- **Single owner, multi-device.** No multi-user / sharing. The auth model is one human, many devices.
- **Bring-your-own-LLM, no defaults.** No bundled model, no auto-pick, no "best Ollama for each agent" recommendation. If the user hasn't configured a provider, setup will not write a working config.
- **Exactly four personas.** Mentor, Shapeshifter, Keeper, Tracker. Not three, not five. Users can rename / re-emoji them, and the codebase documents the extension point for power users who want to fork and add a fifth — but the core ships four.
- **Android-only mobile build.** No iOS build pipeline, no TestFlight, no Apple Developer Program in v1. iOS users use the web app on their phone.
- **Sideload / free distribution only.** Android APK distributed via GitHub Releases. No Play Store, no paid signing infrastructure.
- **Tailscale as the recommended tunnel.** Alternatives (Cloudflare Tunnel, plain LAN, ngrok, self-run Wireguard) get a brief mention in `docs/networking.md` but Tailscale is the only path the wizard actively assists with.
- **Vault sync is the user's problem.** Companions does not manage replication. We document Syncthing as the recommended approach (point at official docs) and stop there.
- **Empty vault by default.** No personal example content shipped — fresh install gets an empty `{raw,wiki,journal,projects}/` skeleton plus a single `wiki/welcome.md` stub.
- **Lean tokens, lean rotation, lean QR pairing.** Opaque random tokens, simple revocation list, single-screen QR pairing flow. No JWT, no device fingerprinting, no rotating refresh tokens.

---

## 2. End-to-End User Journey

The journey from "found the repo on Hacker News" to "talking to Mentor on my phone on the train" should take less than ten minutes for anyone with Node, an LLM provider, and a Tailscale account.

**Step 1 — Discovery.** User lands on `github.com/<owner>/companions`. README opens with a single screenshot of the four-tab mobile UI side-by-side with the TUI setup wizard. One paragraph of "what this is", a 30-second demo GIF, and a fenced code block with the install command. Badges across the top: license, latest release, build status, "Anthropic / OpenAI / Ollama compatible", "BYO LLM".

**Step 2 — Install the server.** User runs `curl -fsSL https://companions.sh/install | bash` (or `wget` equivalent) on their always-on machine. Script detects OS, checks Node ≥ 20, clones the repo into `~/companions/`, installs deps, and immediately drops them into the setup TUI.

**Step 3 — TUI setup.** Wizard walks through: welcome → LLM provider + credentials (no skip — must configure one) → vault location → name + emoji for each of the four agents → port → token generation → Tailscale detection → confirmation → write `companions.config.json` and `.env` → print connection details + QR.

**Step 4 — Start the server.** Wizard ends with `cd ~/companions/server && npm start`. User sees `Companions server listening on http://0.0.0.0:3000` and `Tailscale URL: http://my-mac.tailnet-1234.ts.net:3000`.

**Step 5 — Install the mobile app.** Android user scans a QR code in the README (or visits the latest GitHub release page) and downloads `companions-android.apk`. iOS users open the web app instead.

**Step 6 — Connect mobile app.** First launch shows a "Connect to your server" screen. User scans the QR code that the TUI printed on completion (containing server URL + access token), or pastes them manually. App stores them in `expo-secure-store` and opens to the four-tab interface.

**Step 7 — First conversation.** User taps the Mentor tab, types "hey", and gets a reply. Vault skeleton was created automatically: empty `raw/`, empty `journal/`, empty `projects/`, and a single `wiki/welcome.md` orienting them. They're done.

---

## 3. GitHub Repo Requirements

The repo is the funnel. If the README is mid, nothing downstream matters.

### 3.1 README.md structure

1. **Hero**: project name, one-line tagline, badges (license MIT, node ≥20, latest release, "works with Anthropic / OpenAI / Ollama", "BYO LLM").
2. **Hero image**: a single composite PNG showing the four mobile tabs and the TUI setup screen.
3. **30-second pitch**: 2–3 sentences. What it is, why it exists, who it's for. Make it explicit: bring your own model, single-owner, Android + web.
4. **Demo**: animated GIF or a short MP4 (linked, not embedded — keep README light) showing tab switching, vault file appearing on disk, and a Tracker agent creating a calendar event.
5. **Install**: the one-line curl command, fenced. Below it: "What this does" expandable section with the actual steps.
6. **The four agents**: 2x2 grid, one paragraph each, with their accent colour as a small swatch. A short note: "Companions ships exactly four personas. You can rename them and change their emoji in setup. If you want to add a fifth, see `docs/extending-personas.md`."
7. **The vault**: tree diagram of `~/companions-vault/{raw,wiki,journal,projects}/` with a sentence on each. Note: ships empty except for `wiki/welcome.md`.
8. **LLM support**: matrix of providers x features (chat / tool use / streaming). Explicit "no default — you bring the model" callout.
9. **Mobile + Web**: Android APK download link + screenshots. Note that iOS users should use the web app for now.
10. **Self-hosting requirements**: Node 20+, ~500MB disk, Tailscale recommended, optional GPU for local models.
11. **Multi-device + sync**: explain that the server is single-owner, that you pair multiple devices via QR, and that if you want your *vault* on multiple machines you use Syncthing (link to its docs).
12. **Roadmap**: checklist of what's done vs what's coming.
13. **Contributing**, **License (MIT)**, **Acknowledgements**.

### 3.2 Repo files needed beyond code

- `LICENSE` — MIT.
- `.env.example` — template for `server/.env`.
- `.gitignore` — must exclude `companions.config.json`, `personas/`, `companions-vault/`, `server/.env`, `server/.expo/`, `app/.expo/`, `web/dist/`, `node_modules/`, `server/data/tokens.json`.
- `CONTRIBUTING.md` — dev setup, branch convention, commit style.
- `CODE_OF_CONDUCT.md` — Contributor Covenant, standard.
- `SECURITY.md` — how to report vulnerabilities (the token surface needs this).
- `CHANGELOG.md` — Keep-a-Changelog format.
- `.github/ISSUE_TEMPLATE/{bug.yml,feature.yml}`.
- `.github/workflows/ci.yml` — typecheck + test on PR.
- `.github/workflows/release.yml` — tag → build APK via EAS → attach to release.
- `docs/screenshots/` — committed PNGs used by README.
- `docs/networking.md` — Tailscale (primary) + brief notes on alternatives.
- `docs/vault-sync.md` — how to run Syncthing alongside Companions to mirror your vault across machines. Companions does not manage this; the doc just points at Syncthing's setup guide and notes which paths to sync.
- `docs/extending-personas.md` — the four personas are intentional, but here's how to fork and add a fifth, plus how to deeply rewrite an existing persona's system prompt.
- `docs/self-hosting.md` — running the server long-term (launchd, systemd, restart-on-crash, log rotation).

### 3.3 Empty vault skeleton

A fresh setup creates the vault skeleton itself, not from a copy of `examples/`:

```
~/companions-vault/
├── raw/.keep
├── wiki/welcome.md          # one short orientation note (the only seed file)
├── journal/.keep
└── projects/.keep
```

`wiki/welcome.md` is a minimal, non-personal stub: one paragraph each on the four agents, where files live, and how to ask Keeper to write your first wiki entry. No fake journal entries, no example projects, no curated wiki content.

---

## 4. Install Script (`install.sh`)

Hosted at `https://companions.sh/install` once the domain is up, otherwise as a raw GitHub link: `https://raw.githubusercontent.com/<owner>/companions/main/install.sh`.

### 4.1 Behaviour

```bash
#!/usr/bin/env bash
set -euo pipefail
```

1. **Print banner** — ASCII logo + version.
2. **Detect OS** — `uname -s` → macOS / Linux. Bail with a friendly message on anything else (Windows users get pointed at WSL).
3. **Check prerequisites** — `node --version` ≥ 20, `git --version`, `npm --version`. If Node missing, print install instructions for the detected OS (Homebrew on macOS, NodeSource curl on Debian/Ubuntu, asdf as a fallback) and exit non-zero.
4. **Choose install dir** — default `$HOME/companions`. If exists and is a git repo for this project, offer `git pull` instead of clone. If exists and is *not* the project, bail.
5. **Clone** — `git clone --depth 1 https://github.com/<owner>/companions.git "$INSTALL_DIR"`.
6. **Install deps** — run `npm install` in `server/`, `app/`, `web/`. Stream output. On any failure: print the last 20 lines of the relevant log and exit.
7. **Run setup** — `cd server && npm run setup` (interactive TUI takes over).
8. **Final hint** — after setup writes config, print `To start: cd ~/companions/server && npm start`.

### 4.2 Curl-pipe safety

- Always read entire script before execution: `set -euo pipefail` at top, no eval of remote content mid-stream.
- Honour `COMPANIONS_INSTALL_DIR`, `COMPANIONS_BRANCH`, `COMPANIONS_SKIP_SETUP` env vars for power users and CI.
- Support `--dry-run` flag (parse `$@` even though piped — bash sees flags via `bash -s -- --dry-run`).
- Idempotent: re-running upgrades cleanly.

### 4.3 Error handling

- `trap 'echo "Install failed at line $LINENO"; exit 1' ERR`.
- Each phase prints `==> Phase name` so the user can see where it died.
- On Node version mismatch, suggest `nvm install 20 && nvm use 20`.

---

## 5. TUI Setup Redesign

Built on `@clack/prompts` (already in use). File: `server/src/setup.ts`. Output files: `companions.config.json` (non-secret) and `server/.env` (secrets).

### 5.1 Wizard flow

#### Screen 1 — Welcome
```
 ╭─────────────────────────────────────╮
 │  Companions — Setup                 │
 │  Four agents. One vault. Your box.  │
 ╰─────────────────────────────────────╯
```
Single confirm prompt: "Press Enter to begin, Ctrl-C to abort." Detects existing `companions.config.json` and offers: **Reconfigure / Migrate / Cancel**.

#### Screen 2 — LLM Provider (required, no default)
- `select` prompt with options:
  - `Anthropic (Claude)` — prompts for API key, validates format `sk-ant-...`, optional test call.
  - `OpenAI` — prompts for API key, validates `sk-...`.
  - `OpenAI-compatible / Local` — prompts for base URL (e.g. `http://localhost:11434/v1` for Ollama), optional API key, model name (user must enter — no default).
- **Cannot be skipped.** If the user aborts this screen, setup exits without writing config and prints: "Companions requires an LLM provider. Configure one and re-run `npm run setup`." There is no bundled model and no fallback. We never assume a provider or model name.
- Validation: API key non-empty (when required by provider); URL parseable; for local, attempt a `GET /models` and warn (don't fail) if unreachable; model name non-empty.
- Stored in `.env` as `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.

#### Screen 3 — Companion Vault Location
- `text` prompt, default `~/companions-vault`. Expand `~`. Create directory if missing. If non-empty and not previously a Companions vault, warn and require confirmation.
- Always create the empty skeleton: `raw/.keep`, `journal/.keep`, `projects/.keep`, and a single `wiki/welcome.md` stub. No prompt for example content — there is no example content to seed.
- Stored in `companions.config.json` as `vaultPath`.

#### Screen 4 — Name + Emoji per Agent
For each of the four slots (order is fixed because accent colours are bound to slots, and the persona keys are hard-coded in the agent dispatch — see `docs/extending-personas.md` if you need a fifth):

| Slot | Persona key | Default name | Default emoji | Accent (fixed) |
|---|---|---|---|---|
| 1 | `mentor` | Mentor | 🐸 | green |
| 2 | `shapeshifter` | Shapeshifter | 🦊 | orange |
| 3 | `keeper` | Keeper | 🐝 | yellow |
| 4 | `tracker` | Tracker | 🐦 | blue |

Per slot: `text` prompt for name (validate: 1–32 chars, no slashes), then `select` prompt for emoji from a curated animal list (~30 entries) plus "Custom…" → `text` prompt accepting any single grapheme. Stored as:
```json
{
  "personas": {
    "mentor":       { "displayName": "Mentor",       "emoji": "🐸", "slot": 0 },
    "shapeshifter": { "displayName": "Shapeshifter", "emoji": "🦊", "slot": 1 },
    "keeper":       { "displayName": "Keeper",       "emoji": "🐝", "slot": 2 },
    "tracker":      { "displayName": "Tracker",      "emoji": "🐦", "slot": 3 }
  }
}
```
Internal keys never change — they're the persona IDs the agent code dispatches on. Only display name + emoji are user-configurable in the wizard. Adding a fifth persona requires a code change documented in `docs/extending-personas.md`.

#### Screen 5 — Port
- `text` prompt, default `3000`. Validate integer 1024–65535. Check port is free with a transient `net.createServer().listen()` and warn if not. Stored in `.env` as `PORT`.

#### Screen 6 — Auth
No prompts — fully automatic.
- Generate `ACCESS_TOKEN = crypto.randomBytes(32).toString('base64url')`. Opaque random token, no JWT.
- Persist to `server/data/tokens.json`:
  ```json
  { "tokens": [ { "id": "<uuid>", "token": "<opaque>", "label": "setup-initial", "createdAt": "...", "lastSeenAt": null, "revokedAt": null } ] }
  ```
- Token also held in memory for the final summary screen.

#### Screen 7 — Tailscale (optional)
- Detect: run `tailscale status --json` with a 1s timeout.
  - **Installed + logged in** → parse `Self.DNSName` and `Self.TailscaleIPs[0]`. Display "Detected: `my-mac.tailnet-1234.ts.net` / `100.x.y.z`". Confirm "Use this for the mobile connection URL? (Y/n)".
  - **Installed, not logged in** → print `tailscale up` and pause for user to run it, then re-detect.
  - **Not installed** → print OS-specific install instructions (`brew install tailscale`, `curl -fsSL https://tailscale.com/install.sh | sh`) and offer **Install now / Skip / Use LAN IP / Use localhost**.
  - **Skip** → fall back to LAN IP (auto-detected via `os.networkInterfaces()`) with a warning that mobile-on-cellular won't work without a tunnel. Briefly mention `docs/networking.md` for alternatives (Cloudflare Tunnel, etc.).
- Stored in `companions.config.json` as `publicHost`.

#### Screen 8 — Confirmation Summary
Render a boxed summary:
```
 Vault:        /Users/sandoe/companions-vault
 Provider:     Anthropic (claude-sonnet-4)
 Port:         3000
 Public host:  my-mac.tailnet-1234.ts.net
 Agents:       Mentor 🐸 · Shapeshifter 🦊 · Keeper 🐝 · Tracker 🐦
 Access token: generated (shown next)
```
Confirm "Write configuration? (Y/n)". On no, loop back to a "which screen do you want to redo?" select.

#### Screen 9 — Post-setup
- Write `companions.config.json` (pretty JSON, 2-space indent).
- Write `server/.env` (with a header comment: `# Generated by setup. Do not commit.`).
- Write `server/data/tokens.json` (gitignored).
- Print:
  ```
  Setup complete.

  Connection URL:  http://my-mac.tailnet-1234.ts.net:3000
  Access token:    <token>

  QR code (scan from Companions mobile app):
  <ASCII QR>

  Start the server:
    cd ~/companions/server && npm start
  ```
- ASCII QR generated with `qrcode-terminal`, payload `companions://connect?url=<urlenc>&token=<urlenc>`.

### 5.2 Files written

| File | Purpose | Committed? |
|---|---|---|
| `companions.config.json` | persona names/emojis, vault path, public host, port | No (gitignored) |
| `server/.env` | LLM credentials, access token mirror | No (gitignored) |
| `server/data/tokens.json` | token revocation list | No (gitignored) |
| `companions.config.example.json` | template with defaults | Yes |
| `server/.env.example` | template with placeholders | Yes |

### 5.3 Validation rules summary

- Persona name: 1–32 chars, `^[\p{L}\p{N} _-]+$`.
- Emoji: must be a single grapheme cluster (use `Intl.Segmenter`).
- Vault path: absolute after expansion, writable.
- Port: 1024–65535.
- API keys: provider-specific regex, plus optional live ping. Cannot be empty when provider requires one.
- Model name: non-empty for every provider.
- URL: `URL` constructor must parse, must be `http` or `https`.

---

## 6. Mobile Distribution

**v1 is Android-only.** No iOS build pipeline, no TestFlight, no Apple Developer Program. iOS users open the web app on their phone.

### 6.1 Android (APK via EAS Build)

- Configure `app/eas.json` (already present) with two profiles: `development` (local dev), `preview` (signed APK, internal distribution via GitHub Releases).
- `eas build --profile preview --platform android` produces a signed APK using EAS's free tier (managed credentials — no Play signing key needed).
- Public download via GitHub Releases: CI workflow `release.yml` triggers on tag `v*`, runs EAS build, downloads the artifact, and attaches `companions-android-<version>.apk` to the release.
- README links directly to `github.com/<owner>/companions/releases/latest/download/companions-android.apk` (use a stable filename via the release-attach step).
- Sideload instructions in README: "Allow installs from unknown sources for your browser, tap the APK, install."
- No production / AAB / Play Store profile in v1.

### 6.2 iOS

Out of scope for v1. The web app is responsive and works on iOS Safari. README explicitly states this so users aren't surprised.

### 6.3 Mobile connection setup screen

First launch in `app/`:
1. **Welcome** — one screen, "Connect to your server".
2. **Choose method** — `Scan QR` / `Enter manually`.
3. **Scan path** — opens camera (`expo-camera`), parses `companions://connect?url=...&token=...`, validates by hitting `GET <url>/api/health` with `Authorization: Bearer <token>`. On 200, persist to `expo-secure-store` and continue. On error, show specific failure (network / auth / version mismatch).
4. **Manual path** — two text inputs: server URL, access token. Same validation.
5. **Persona names sync** — on first successful connect, fetch `/api/personas` and cache display names + emojis locally. Re-sync on each cold start.
6. **Done** — drop into the four-tab UI.

A "Reconnect / Switch server" item lives in the app's settings screen.

---

## 7. Auth System

### 7.1 Threat model

The server is exposed to the user's Tailnet (or LAN, or public via tunnel). Anyone reaching the HTTP/WS endpoints must present a valid token. There is **one user (the owner), possibly multiple devices** (phone, tablet, laptop browser). No multi-tenant, no sharing, no per-resource ACLs.

### 7.2 Mechanism (lean, opaque tokens)

- **Access tokens** are opaque random strings: `crypto.randomBytes(32).toString('base64url')`. No JWT, no signature, no claims.
- All tokens live in `server/data/tokens.json`:
  ```json
  {
    "tokens": [
      { "id": "<uuid>", "token": "<opaque>", "label": "setup-initial", "createdAt": "...", "lastSeenAt": "...", "revokedAt": null }
    ]
  }
  ```
- Server middleware on every `/api/*` request: extract bearer token, look up by exact match in `tokens.json`, reject if missing or `revokedAt` is set. Update `lastSeenAt` (debounced, e.g. once per minute per token).
- File-backed list is fine for single-owner v1. Move to SQLite if it ever becomes a hotspot.

### 7.3 Token transfer to mobile

- Primary: QR code printed by the setup wizard, scanned by the app on first launch. Payload `companions://connect?url=<url>&token=<opaque>`.
- Secondary: manual paste. Useful when the phone isn't physically near the server.
- Tertiary: the web app (running on a trusted device on the same Tailnet) has a "Pair a device" screen that displays a QR from the same endpoint.

### 7.4 Token rotation (lean)

- `npm run token:issue -- --label "iPad"` → generate + persist a new token, print it + a fresh QR.
- `npm run token:revoke -- --id <uuid>` → set `revokedAt` on a single token.
- `npm run token:list` → table of `id`, `label`, `createdAt`, `lastSeenAt`, `revokedAt`.
- `npm run token:rotate-all` → revoke every existing token and issue a new `setup-initial`. User must re-pair every device. This is the "I think I'm compromised" button.

No refresh tokens, no expiry, no per-token scopes. If you ever need that, add it later.

### 7.5 Endpoints

- `GET /api/health` — unauthenticated, returns `{ ok: true, version }`. Used by mobile to test connectivity before sending the token.
- `POST /api/auth/verify` — body `{ token }`, returns `{ ok, label }`. Used by mobile to validate credentials at pair time.
- All other `/api/*` and `/ws` require `Authorization: Bearer <token>`.

---

## 8. Tailscale Integration

### 8.1 Why Tailscale (and only Tailscale, in the wizard)

The server lives on the user's machine. The phone needs to reach it from anywhere — coffee shop, train, bedroom. The wizard actively assists with **Tailscale** because: free for personal use up to 100 devices, MagicDNS gives a stable hostname (`my-mac.tailnet-1234.ts.net`), works on iOS/Android/macOS/Linux/Windows, no port forwarding, no DNS, no certificates. It's the right default for the target user, and integrating one option deeply beats integrating three options shallowly.

Other tunnels work fine, but the wizard does not detect or configure them — the user pastes whatever hostname they want into the "public host" field.

### 8.2 What the setup step does

Detect via `tailscale status --json`. Parse `Self.DNSName` (strip trailing dot) and `Self.TailscaleIPs[0]`. Offer the DNS name as the public host. If not installed: print install commands, link to `tailscale.com/download`, allow Skip → fall back to LAN IP or user-entered hostname.

### 8.3 Alternatives (briefly documented in `docs/networking.md`)

- **Cloudflare Tunnel** — free, custom domain, works without the user's machine being directly reachable.
- **ngrok** — easy, but free tier rotates URLs. Testing only.
- **Plain LAN** — fine if you only use the app at home.
- **Self-run Wireguard** — for users who already have a VPN.

The doc gives one paragraph per option and a link, no step-by-step. Tailscale is the only path with hand-holding.

### 8.4 HTTPS

Tailscale offers automatic HTTPS via `tailscale cert` and MagicDNS. Out of scope for v1; documented as a follow-up in `docs/networking.md`. The wizard configures plain HTTP and the app speaks `ws://` over the Tailnet.

---

## 9. Master Implementation Checklist

This is the agent-ready breakdown. Each item is a single concrete deliverable, priority-tagged (**P0** launch blocker, **P1** important, **P2** nice to have), and area-tagged (`[server]`, `[app]`, `[web]`, `[setup]`, `[infra]`, `[docs]`). One item, one assignable task.

### Phase 0 — Repo hygiene (must land before anything is public)

- [ ] **P0** `[infra]` Add `LICENSE` file at repo root (MIT, standard text, owner = current GitHub user).
- [ ] **P0** `[infra]` Update `.gitignore` to exclude `companions.config.json`, `server/.env`, `server/.expo/`, `app/.expo/`, `app/.npmrc`, `web/dist/`, `personas/`, `companions-vault/`, `server/data/tokens.json`, `node_modules/`.
- [ ] **P0** `[infra]` Audit current branch for committed secrets, persona files, or vault content; remove from history if found.
- [ ] **P0** `[infra]` Add `companions.config.example.json` with all keys present and dummy values.
- [ ] **P0** `[server]` Add `server/.env.example` with placeholders for `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `PORT`, `ACCESS_TOKEN`.
- [ ] **P1** `[infra]` Add `CONTRIBUTING.md` (dev setup, branch + commit conventions).
- [ ] **P1** `[infra]` Add `CODE_OF_CONDUCT.md` (Contributor Covenant verbatim).
- [ ] **P1** `[infra]` Add `SECURITY.md` (vuln disclosure email, scope: token/auth surface).
- [ ] **P1** `[infra]` Add `CHANGELOG.md` with Keep-a-Changelog header + initial `Unreleased` section.
- [ ] **P1** `[infra]` Add `.github/ISSUE_TEMPLATE/bug.yml` and `feature.yml` and `PULL_REQUEST_TEMPLATE.md`.
- [ ] **P1** `[infra]` Add `.github/workflows/ci.yml` running typecheck + tests against `server/`, `app/`, `web/` on every PR.

### Phase 1 — Setup wizard (the TUI end-to-end)

- [ ] **P0** `[setup]` Rewrite `server/src/setup.ts` Screen 1 (welcome + existing-config detection with Reconfigure / Migrate / Cancel branches).
- [ ] **P0** `[setup]` Implement Screen 2 (LLM provider select + provider-specific credential prompts). Setup must abort cleanly if user does not configure a provider — no defaults, no bundled model.
- [ ] **P0** `[setup]` Implement Screen 3 (vault path prompt, expand `~`, create empty skeleton with `raw/.keep`, `journal/.keep`, `projects/.keep`, and a single `wiki/welcome.md` stub).
- [ ] **P0** `[setup]` Implement Screen 4 (per-slot name + emoji prompts for the four fixed personas, with the curated emoji list + custom-grapheme fallback).
- [ ] **P0** `[setup]` Implement Screen 5 (port prompt + free-port check).
- [ ] **P0** `[setup]` Implement Screen 6 (auto-generate opaque access token, persist initial entry to `server/data/tokens.json`).
- [ ] **P0** `[setup]` Implement Screen 7 (Tailscale detection via `tailscale status --json`, fallback to LAN IP / manual hostname).
- [ ] **P0** `[setup]` Implement Screen 8 (confirmation summary + "redo which screen?" loop).
- [ ] **P0** `[setup]` Implement Screen 9 (transactional config write — `*.tmp` + fsync + rename — and post-setup output with ASCII QR via `qrcode-terminal`).
- [ ] **P0** `[setup]` Validation helpers module (`server/src/setup/validators.ts`): persona name regex, single-grapheme emoji check, vault path writability, port range, URL parse.
- [ ] **P1** `[setup]` Setup re-run safety: by default preserve existing tokens; expose `--reset-auth` flag to wipe them.
- [ ] **P1** `[setup]` Unit tests for each screen function and each validator.

### Phase 2 — Install script (curl install experience)

- [ ] **P0** `[infra]` Author `install.sh` per §4 (banner, OS detect, prereq check, clone, deps install, hand off to setup).
- [ ] **P0** `[infra]` Honour `COMPANIONS_INSTALL_DIR`, `COMPANIONS_BRANCH`, `COMPANIONS_SKIP_SETUP` env vars; support `--dry-run`.
- [ ] **P0** `[infra]` `trap` on ERR with line-number reporting; per-phase `==>` headers.
- [ ] **P0** `[server]` Implement auth middleware in `server/src/auth.ts`: bearer-token extraction, lookup against `tokens.json`, 401 on miss/revoked, debounced `lastSeenAt` update.
- [ ] **P0** `[server]` Wire auth middleware onto every `/api/*` route and the WebSocket upgrade handshake.
- [ ] **P0** `[server]` Add `GET /api/health` (unauthenticated) and `POST /api/auth/verify`.
- [ ] **P0** `[server]` Confirm `/api/personas` returns `{ key, displayName, emoji, slot }[]`; add if missing.
- [ ] **P1** `[server]` Token CLI scripts: `scripts/token-issue.ts`, `token-revoke.ts`, `token-list.ts`, `token-rotate-all.ts`. Wire to `npm run token:*`.
- [ ] **P1** `[server]` Server start banner: print connection URL, public host, "keep your `.env` private" reminder, and a hint for `npm run token:issue`.
- [ ] **P2** `[infra]` Register `companions.sh` domain and host `install.sh` there (GitHub Pages or Cloudflare Pages redirect).

### Phase 3 — Mobile (Android APK distribution)

- [ ] **P0** `[app]` First-run pairing screen: welcome → Scan QR / Enter manually → validate via `/api/health` + bearer → persist to `expo-secure-store`.
- [ ] **P0** `[app]` Camera + QR parser (`expo-camera`), parse `companions://connect?url=...&token=...`, surface specific failure modes (network / auth / version).
- [ ] **P0** `[app]` API client: read token from secure storage, attach `Authorization: Bearer ...` to every fetch and WebSocket connection.
- [ ] **P0** `[app]` Persona sync on cold start: fetch `/api/personas`, cache locally, drive tab labels and emojis.
- [ ] **P0** `[app]` Settings entry "Reconnect / Switch server" that clears secure storage and returns to pairing screen.
- [ ] **P1** `[app]` Configure `eas.json` with `development` and `preview` profiles (signed APK, internal distribution). Remove or stub the `production` profile in v1.
- [ ] **P1** `[infra]` `.github/workflows/release.yml`: on tag `v*`, run `eas build --profile preview --platform android`, download artifact, attach as `companions-android-<version>.apk` *and* a stable-name copy.
- [ ] **P1** `[docs]` README section: APK download link + sideload instructions (allow unknown sources, tap APK).
- [ ] **P1** `[app]` Manual smoke test plan (one PR, one issue): pair via QR, pair manually, revoke token from server CLI, reconnect.

### Phase 4 — Polish (README, docs, GitHub presentation)

- [ ] **P0** `[docs]` Rewrite `README.md` per §3.1 (hero, badges, pitch, demo, install, four-agent grid, vault tree, LLM matrix, Android-only note, BYO-LLM note, single-owner note, multi-device + Syncthing note, roadmap, license).
- [ ] **P0** `[docs]` Capture screenshots for `docs/screenshots/`: four mobile tabs, TUI setup mid-flow, vault file appearing on disk, web app.
- [ ] **P0** `[docs]` Record + link a 30-second demo GIF/MP4 (do not embed in README).
- [ ] **P1** `[docs]` Write `docs/networking.md` (Tailscale primary, brief alternatives).
- [ ] **P1** `[docs]` Write `docs/vault-sync.md` (Syncthing recommendation, paths to sync, link to Syncthing official docs — Companions does not manage sync).
- [ ] **P1** `[docs]` Write `docs/extending-personas.md` (rename via wizard vs. forking to add a fifth persona; list every code site that dispatches on persona key).
- [ ] **P1** `[docs]` Write `docs/self-hosting.md` (running long-term, launchd / systemd, log rotation).
- [ ] **P2** `[docs]` Add a tiny `companions.sh/download` page that User-Agent-redirects Android to the latest APK (and shows iOS users a "use the web app" message).
- [ ] **P2** `[infra]` `scripts/launchd/com.companions.server.plist` and `scripts/systemd/companions.service` so the server starts on boot.
- [ ] **P2** `[server]` `npm run vault:backup` → tarball of the vault to `~/companions-backups/`.
- [ ] **P2** `[server]` `npm run upgrade` → `git pull && npm install` wrapper.
- [ ] **P2** `[web]` Bring web-app pairing flow to parity with mobile (QR display + manual entry + `expo-secure-store`-equivalent in browser).

---

## 10. Open Questions (resolved)

All previously-open questions have been decided. Recorded here so reviewers can see the rationale rather than guessing at it.

1. **Token format → opaque random tokens.** No JWT. Revocation already needs a list lookup, so the JWT signature buys nothing. `crypto.randomBytes(32).toString('base64url')`, stored in `server/data/tokens.json`. Lean.
2. **Multi-user vs single owner → single owner only for v1.** One human, many devices. Multi-user / sharing is not in scope. The auth model deliberately has no `userId` field; if we ever need it, it's a schema migration.
3. **Vault sync → Syncthing, user-managed.** Companions does not replicate the vault. Users who want their vault on multiple machines run Syncthing themselves; we document the recommendation and stop there.
4. **Default LLM → none, BYO only.** No bundled model, no auto-pick, no recommended Ollama model. Setup refuses to write a working config without a configured provider, and prints a clean error so the user knows what to do.
5. **iOS distribution → no iOS build in v1.** No TestFlight, no Apple Developer Program, no IPA, no AltStore docs. iOS users open the web app. Reduces launch cost to $0 and removes the largest single piece of platform friction.
6. **Persona extensibility → users can rename via wizard, advanced users can fork.** Display name + emoji are configurable for the four fixed slots. `docs/extending-personas.md` documents how to add a fifth persona or rewrite a persona's system prompt — explicitly framed as a fork-and-modify flow, not a runtime extension point.
7. **Token rotation → lean.** `token:issue`, `token:revoke`, `token:list`, `token:rotate-all`. No refresh tokens, no expiry, no per-token scopes.
8. **Mobile platforms → Android only.** No iOS pipeline, no `production` EAS profile in v1. Web app covers iOS users.
9. **QR pairing → lean single-screen flow.** `companions://connect?url=...&token=...` payload, scanned via `expo-camera`, validated against `/api/health` + bearer. Manual paste as fallback. No deep-link handling beyond the pairing scheme.
10. **Number of personas → exactly four.** Mentor, Shapeshifter, Keeper, Tracker. Hardcoded keys, fixed accent colours. Customisation is name + emoji only. Adding a fifth requires a fork (documented).
11. **Example vault content → none.** Fresh vault is empty except for the `wiki/welcome.md` orientation stub. No fake journal entries, no example projects, no curated wiki pages. No `examples/vault/` directory in the repo.
12. **Tunnel choice → Tailscale primary, alternatives briefly mentioned.** The wizard only actively assists with Tailscale. `docs/networking.md` lists Cloudflare Tunnel, ngrok, plain LAN, and self-run Wireguard with one paragraph each — no hand-holding.

Items that remain genuinely undecided (not blockers) live in the `companions.sh` row of the Phase 2 checklist (domain registration is a P2 nice-to-have, not a launch gate).

---

## Appendix A — File Layout After This Plan Lands

```
companions/
├── LICENSE                              [new, P0]
├── README.md                            [rewrite, P0]
├── CHANGELOG.md                         [new, P1]
├── CONTRIBUTING.md                      [new, P1]
├── CODE_OF_CONDUCT.md                   [new, P1]
├── SECURITY.md                          [new, P1]
├── install.sh                           [new, P0]
├── companions.config.example.json       [new, P0]
├── .gitignore                           [update, P0]
├── .github/
│   ├── workflows/{ci.yml,release.yml}   [new, P1]
│   ├── ISSUE_TEMPLATE/{bug.yml,feature.yml}
│   └── PULL_REQUEST_TEMPLATE.md
├── docs/
│   ├── screenshots/                     [new, P0]
│   ├── networking.md                    [new, P1]
│   ├── vault-sync.md                    [new, P1]
│   ├── extending-personas.md            [new, P1]
│   └── self-hosting.md                  [new, P1]
├── scripts/
│   ├── token-issue.ts                   [new, P1]
│   ├── token-revoke.ts                  [new, P1]
│   ├── token-list.ts                    [new, P1]
│   ├── token-rotate-all.ts              [new, P1]
│   ├── launchd/com.companions.server.plist  [new, P2]
│   └── systemd/companions.service           [new, P2]
├── server/
│   ├── .env.example                     [new, P0]
│   ├── package.json
│   └── src/
│       ├── setup.ts                     [rewrite, P0]
│       ├── setup/validators.ts          [new, P0]
│       ├── auth.ts                      [new, P0]
│       ├── config.ts
│       ├── routes.ts
│       └── …
├── app/                                 [pairing screen, P0; eas.json, P1]
└── web/                                 [pairing screen, P2]
```

(No `examples/vault/` — empty vault by design.)

---

## Appendix B — Setup Wizard Reference Implementation Sketch

```ts
// server/src/setup.ts
import * as p from '@clack/prompts';
import crypto from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import path from 'node:path';
import os from 'node:os';

async function main() {
  console.clear();
  p.intro('Companions — Setup');

  const existing = loadExistingConfig();
  if (existing) {
    const choice = await p.select({
      message: 'Existing configuration detected.',
      options: [
        { value: 'reconfigure', label: 'Reconfigure from scratch' },
        { value: 'migrate',     label: 'Add missing fields, keep the rest' },
        { value: 'cancel',      label: 'Cancel' },
      ],
    });
    if (choice === 'cancel') return p.cancel('Aborted.');
    // …
  }

  const provider = await p.select({ /* §5 Screen 2 — required, no default */ });
  if (!provider) {
    p.cancel('Companions requires an LLM provider. Re-run `npm run setup` once you have one configured.');
    process.exit(1);
  }
  const credentials = await promptCredentialsFor(provider);

  const vaultPath = await p.text({
    message: 'Vault location',
    initialValue: path.join(os.homedir(), 'companions-vault'),
    validate: validateVaultPath,
  });
  createEmptyVaultSkeleton(vaultPath); // raw/.keep, journal/.keep, projects/.keep, wiki/welcome.md

  const personas   = await promptPersonas(); // §5 Screen 4 — fixed four slots
  const port       = await promptPort();
  const auth       = generateOpaqueToken('setup-initial');
  const publicHost = await detectTailscaleOrFallback();

  const summary = renderSummary({ provider, vaultPath, personas, port, publicHost });
  const ok = await p.confirm({ message: `${summary}\n\nWrite configuration?` });
  if (!ok) return p.cancel('Aborted.');

  writeConfigFiles({ provider, credentials, vaultPath, personas, port, auth, publicHost });
  printPostSetup({ publicHost, port, token: auth.accessToken });
  p.outro('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
```

Illustrative, not final. Real implementation should split into one function per screen, each unit-testable, and the writers (`writeConfigFiles`) should be transactional (write to `*.tmp`, fsync, rename).

---

*End of plan.*
