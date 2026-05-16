<p align="center">
  <img src="docs/screenshots/logo.png" alt="Companions logo" width="160">
</p>

<h1 align="center">Companions</h1>

<p align="center"><strong>One vault. Four agents. Your machine.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg" alt="Node ≥ 20"></a>
  <a href="https://github.com/sanieldoe/companions/releases/latest"><img src="https://img.shields.io/github/v/release/sanieldoe/companions" alt="Latest release"></a>
  <a href="#bring-your-own-model"><img src="https://img.shields.io/badge/LLM-Anthropic%20%7C%20OpenAI%20%7C%20Ollama-orange.svg" alt="BYO LLM"></a>
</p>

---

Most AI tools give you one generic chatbot. Companions gives you four agents built around how you actually think, create, reflect, and plan — all sharing a single vault of plain markdown files on your own machine.

<!-- screenshot: hero image — all four agent tabs side by side on mobile + dashboard in background -->

---

## The four agents

Each agent ships with a default name, emoji, and role. During setup you rename them, pick new emoji, and tailor their personas to suit how you work.

<!-- screenshot: four-agents — side-by-side of Mentor / Shapeshifter / Keeper / Tracker tabs -->

---

### 🐸 Mentor — Patient step-by-step guide

The best thinking rarely happens fast. Mentor is designed to slow you down.

Instead of handing you an answer, Mentor walks beside you — asking the next right question, pointing out what you might have missed, and building understanding one step at a time. Use it for hard problems, learning something new, debugging, or any conversation worth having carefully. ADHD-aware pacing: one clear next action, never a wall of text.

> *Don't skip ahead. Let's work through this properly.*

<!-- screenshot: mentor-tab — a step-by-step explanation broken into small pieces -->

---

### 🦊 Shapeshifter — Bold fast creator

Some ideas don't fit in a chat box. Shapeshifter is your open creative workspace.

Shapeshifter doesn't ask for clarification — it reads between the lines, makes a smart assumption, states it briefly, and goes. Build canvases with 10 composable block types (markdown, tasks, code, links, HTML, buttons, inputs, and more), or use it as a scratchpad for rapid prototyping, drafts, and plans.

> *What if we tried it this way instead?*

<!-- screenshot: shapeshifter-tab — canvas with mixed block types -->

---

### 🐝 Keeper — Personal wiki steward

Inspired by [Andrej Karpathy's approach to personal knowledge](https://karpathy.ai), Keeper turns your vault into a living, interconnected record of what you know.

Every note you share, every idea you drop in, gets woven into a linked wiki — cleaned up, cross-referenced, and retrievable. Keeper ingests raw captures and organises them into a Map of Content structure. It remembers so you don't have to, and surfaces the right context when you need it.

> *You wrote about this six months ago. Want me to bring it in?*

<!-- screenshot: keeper-tab — wiki ingestion conversation -->

---

### 🐦 Tracker — Daily rhythm and reflection

Most productivity systems push you to do more. Tracker is built around the opposite idea: slow down, look back, and prepare with intention.

Tracker gives you a daily rhythm of reflection and preparation. It reads your vault — open tasks, past entries, calendar events — and helps you begin each day with clarity and close it with honesty. No scattered lists. A single, grounded practice.

> *What did I actually do today? What's worth carrying forward?*

<!-- screenshot: tracker-tab — daily journal with tasks and calendar context -->

---

## One vault, shared by all four

Every agent reads and writes the same vault on disk. A reflection captured in Tracker shows up when Mentor needs context. A draft Shapeshifter built becomes a wiki entry Keeper can reference later.

```text
vault/
  raw/        quick captures — unprocessed notes, clips, voice transcripts
  wiki/       linked knowledge — Keeper-maintained articles and references
  journal/    dated entries — Tracker reflections, daily logs, check-ins
  projects/   long-form work — plans, drafts, talks, active projects
  tasks/      open tasks synced across agents
```

Plain markdown files on disk. No database, no lock-in. Open any file in any editor.

---

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/sanieldoe/companions/main/install.sh | bash
```

Requires **Node ≥ 20**, `git`, and `npm`. The script checks prerequisites, clones the repo to `~/companions/`, installs dependencies, and launches the setup wizard in your browser.

<details>
<summary>What the install script does</summary>

1. Detects your OS (macOS / Linux — Windows users: use WSL).
2. Verifies `node ≥ 20`, `git`, and `npm` — prints install instructions if anything is missing.
3. Clones this repo into `~/companions/` (or pulls if it already exists).
4. Runs `npm install` in `server/`, `app/`, and `web/`.
5. Starts the server and opens the setup wizard at `http://localhost:3000/install`.

</details>

### Manual install

```bash
git clone https://github.com/sanieldoe/companions.git
cd companions/server
npm install
npm run build
npm start
```

Then open `http://localhost:3000/install` in your browser.

---

## Setup wizard

The browser wizard at `/install` walks through eight steps:

1. **Welcome** — checks if Tailscale is running and detects your local IP
2. **Vault** — choose a folder path; the wizard creates it with all required subdirs
3. **Your name** — what the agents should call you
4. **Server secret** — auto-generated password for the app and dashboard
5. **LLM model** — model ID, API key, optional base URL for local runners
6. **Personas** — rename each agent and pick an emoji; defaults are applied immediately
7. **Google Calendar** — optional OAuth credentials for calendar read/write
8. **Done** — server restarts; dashboard and mobile app are ready

<!-- screenshot: install-wizard — step 6 persona customisation screen -->

---

## Bring your own model

No default provider, no bundled model. Setup asks you to configure one.

| Provider | Example model string |
|---|---|
| Anthropic | `anthropic:claude-sonnet-4-6` |
| OpenAI | `openai:gpt-4o` |
| Ollama (local) | `openai-compat:http://localhost:11434/v1:llama3.2` |
| oMLX / LM Studio | `openai-compat:http://localhost:8000/v1:your-model` |
| Any OpenAI-compatible | `openai-compat:<base_url>:<model_id>` |

Values are stored in `server/.env`. You can change the model at any time from the dashboard without restarting.

---

## Dashboard

The web dashboard at `/dashboard` lets you manage everything without editing config files.

<!-- screenshot: dashboard — overview of all five panels -->

| Panel | What you can do |
|---|---|
| **Vault** | View document counts, copy vault path, run and schedule backups |
| **Models** | Set the default LLM, configure per-persona model overrides, connect OAuth accounts |
| **Personas** | Edit agent names, emoji, and system prompts live |
| **Setup** | View server version, check for updates, trigger a one-click update + restart |
| **Logs** | Live server log stream for debugging |

---

## Mobile + web

- **Android:** [Download the latest APK](https://github.com/sanieldoe/companions/releases/latest/download/companions-android.apk)
- **iOS:** use the web app at `/app` (TestFlight build coming)
- **Web app:** `http://<your-server>/app`

### Sideloading the Android APK

1. On your device: **Settings → Apps → Special app access → Install unknown apps** → allow your browser or Files app.
2. Download `companions-android.apk` from the link above.
3. Tap the file and follow the install prompt.
4. On first launch, scan the QR code shown at the end of the setup wizard, or enter your server URL and secret manually.

<!-- screenshot: qr-pairing — QR code screen on Android -->

---

## Skills

Skills are markdown files that extend what agents can do. They're appended to persona system prompts at runtime — no code changes needed to add capabilities.

| Skill | What it enables |
|---|---|
| `calendar` | Injects Google Calendar context into Tracker; create, update, and delete events via `<cal_create>` / `<cal_update>` / `<cal_delete>` tags in chat |
| `canvas-builder` | Teaches Shapeshifter to emit structured canvas definitions with 10 composable block types (markdown, tasks, notes, code, links, HTML, file tabs, buttons, inputs, dividers) |
| `create-skill` | Documents the pattern for authoring new skills — any agent can guide you through creating one |

Skills live in `skills/<name>/SKILL.md`. Add a skill to a persona by referencing it in the persona's system prompt.

---

## Networking

The recommended remote-access path is **Tailscale** — the setup wizard detects it automatically and uses your Tailnet IP as the mobile pairing URL.

Without Tailscale, you can use any tunnel you trust (ngrok, Cloudflare Tunnel, reverse proxy). See `docs/networking.md` for options.

**Multi-device:** pair as many phones or browsers as you like to one server. The vault lives on the server machine. For vault sync across machines, use Syncthing or any file-sync tool you trust.

---

## Authentication

Companions uses **JWT bearer tokens** tied to a single server secret. All routes (except `/install`) require a valid token.

Tokens are issued at login (`POST /auth/token` with your secret) and expire after 30 days. The dashboard and mobile app handle this automatically.

---

## Tech stack

| Layer | Technology |
|---|---|
| Server | Node ≥ 20, Express 4, `ws` WebSocket, TypeScript |
| Agent engine | [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono) |
| Knowledge search | LanceDB + `@huggingface/transformers` |
| Calendar | `googleapis` + Google OAuth device flow |
| Web app | Vite 6, React 19, react-markdown |
| Mobile app | Expo 55, React Native 0.83, expo-router, Zustand |
| Auth | JWT (`jsonwebtoken`) |

---

## Repo layout

```text
app/        React Native / Expo mobile app (four persona tabs)
web/        Vite + React web app (/install wizard + /dashboard)
server/     Express + WebSocket backend
skills/     Agent skill definitions (markdown)
personas/   Agent persona files (written by setup wizard)
docs/       Networking, self-hosting, vault sync, extension notes
```

---

## Development

```bash
# Server
cd server && npm run build && npm run typecheck

# Web
cd web && npm run build && npx tsc --noEmit

# App
cd app && npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Roadmap

**Done**
- Four-agent architecture with shared plain-text vault
- Browser setup wizard (8 steps, no config file editing)
- Google Calendar integration (read + write)
- Interactive canvas system in Shapeshifter (10 block types)
- Android APK with QR pairing
- Web dashboard (vault, models, personas, updates, logs)
- Skills system for extending agent capabilities
- One-click server updates from dashboard
- Install script (macOS + Linux)

**Next**
- Signed APK release automation
- iOS TestFlight build
- Vault sync across machines (built-in)
- Long-term self-hosting polish

---

## Acknowledgements

- [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the core agent engine powering Companions
- [Andrej Karpathy](https://karpathy.ai) — inspiration for the Keeper wiki model
- [Expo / EAS](https://expo.dev/) — Android build infrastructure
- [Tailscale](https://tailscale.com/) — recommended remote access layer

---

## License

MIT — see [LICENSE](LICENSE).
