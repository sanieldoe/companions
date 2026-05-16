<p align="center">
  <img src="docs/screenshots/logo.png" alt="Companions logo" width="160">
</p>

<h1 align="center">Companions</h1>

<p align="center"><strong>Self-hosted, four purpose-built AI helpers for organisation, creativity, and reflection.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg" alt="Node ≥ 20"></a>
  <a href="https://github.com/sanieldoe/companions/releases/latest"><img src="https://img.shields.io/github/v/release/sanieldoe/companions" alt="Latest release"></a>
  <a href="#bring-your-own-model"><img src="https://img.shields.io/badge/LLM-Anthropic%20%7C%20OpenAI%20%7C%20Ollama-orange.svg" alt="BYO LLM"></a>
</p>

---

**One generic AI can't hold all the roles you need it to.**
Reflection needs patience. Creation needs guardrails and momentum. Knowledge needs structure. It's not that most tools can't do it, but this one is the one that helps my brain.

**Your data shouldn't live on someone else's server.**
Companions runs on your machine. Your vault is plain markdown files. No cloud account, no subscription, no lock-in. All local!

**Context gets lost when your tools don't talk to each other.**
All four agents share one vault. A calendar event from Tracker shows up if Mentor needs context. A draft from Shapeshifter becomes a wiki entry Keeper can find later.

<!-- screenshot: hero image — all four agent tabs side by side on mobile -->

---

## The four agents

Each ships with a default name and character. Rename them, pick an emoji, and tune the persona during setup or any time from the dashboard.

### 🐸 Mentor — Step-by-step guide
Patient, ADHD-aware. Slows you down, asks the right question, gives you one next action. Never overwhelms. Use it when understanding matters more than speed.

### 🦊 Shapeshifter — Bold fast creator
Infers your intent and acts. Canvas by default — 10 composable block types for building plans, drafts, and prototypes. It already built it before Mentor finished the first question.

### 🐝 Keeper — Personal wiki
Ingests raw notes and organises them into a linked, searchable knowledge base uinspired by Karpathy and Johnny Decimal structure. Surfaces forgotten knowledge — the stuff you wrote six months ago that's relevant right now.

### 🐦 Tracker — Daily rhythm and reflection
Brings together everything you need to start or close the day: a weekly phrase to sit with, your calendar, prioritised to-dos, rhythms (daily / weekly / monthly / yearly), and a three-line haiku written fresh each morning.

<!-- screenshot: four-agents — tabs side by side -->

---

## One vault, shared by all four

```text
vault/
  raw/        quick captures — notes, clips, voice transcripts
  wiki/       linked knowledge — Keeper-maintained articles
  journal/    dated entries — Tracker reflections and logs
  projects/   long-form work — plans, drafts, active projects
```

Plain markdown. No database. Open any file in any editor.

---

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/sanieldoe/companions/main/install.sh | bash
```

Requires Node ≥ 20, `git`, and `npm`. Clones the repo, installs dependencies, and opens the setup wizard in your browser. The wizard covers vault path, your name, server secret, LLM provider, persona names, and optional Google Calendar.

**Manual:**
```bash
git clone https://github.com/sanieldoe/companions.git
cd companions/server && npm install && npm run build && npm start
```

Then open `http://localhost:3000/install`.

---

## Bring your own model

| Provider | Example |
|---|---|
| Anthropic | `anthropic:claude-sonnet-4-6` |
| OpenAI | `openai:gpt-4o` |
| Ollama / local | `openai-compat:http://localhost:11434/v1:llama3.2` |

Change the model any time from the dashboard — no restart needed.

---

## Mobile + web

- **Android:** [Download APK](https://github.com/sanieldoe/companions/releases/latest/download/companions-android.apk) — sideload and scan the QR code from the setup wizard
- **iOS:** web app at `/app` (TestFlight build coming)
- **Dashboard:** `http://<your-server>/dashboard` — manage vault, models, personas, and updates

Recommended remote access: [Tailscale](https://tailscale.com/) — the wizard detects it automatically.

<!-- screenshot: qr-pairing — QR code screen on Android -->

---

## Tech stack

| | |
|---|---|
| Server | Node ≥ 20, Express, WebSocket, TypeScript |
| Agent engine | [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono) |
| Mobile | Expo 55, React Native 0.83 |
| Web | Vite 6, React 19 |
| Knowledge | LanceDB + HuggingFace Transformers |

---

## Acknowledgements

- [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) — the core agent engine
- [Andrej Karpathy](https://karpathy.ai) — inspiration for the Keeper wiki model
- [Expo / EAS](https://expo.dev/) — Android build infrastructure

---

MIT — see [LICENSE](LICENSE).
