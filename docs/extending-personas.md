# Extending Personas

Companions ships with **exactly four personas**:

- `mentor`
- `shapeshifter`
- `keeper`
- `tracker`

For normal users, the supported customization path is:

- rename each persona during the browser setup wizard
- choose a different emoji during the browser setup wizard or from the dashboard

That changes the **display layer**, not the internal persona keys.

## What you can change without forking

The setup wizard stores persona display settings in the persona files themselves. A default persona file starts like this:

```md
---
name: Mentor
emoji: 🐢
description: Patient, grounded, one step at a time.
---
```

You can safely revisit the setup wizard or dashboard to rename them.

## Rewriting a persona prompt

The generated persona files live under:

```text
personas/
  mentor/PERSONA.md
  shapeshifter/PERSONA.md
  keeper/PERSONA.md
  tracker/PERSONA.md
```

If you want a radically different Mentor or Keeper, editing those files is the simplest path.

## Adding a fifth persona

This is a **fork-and-modify** workflow, not a runtime setting.

You need to update every place where persona keys or tab count are assumed.

### Code sites to update

At minimum, inspect and update these files:

- `server/src/install.ts`
  - fixed persona defaults
  - install-time name and emoji handling
- `server/src/routes.ts`
  - mode metadata
  - `/personas` output
- `server/src/agent.ts`
  - mode union assumptions
  - session creation / switching
  - shared chat-mode logic
- `server/src/gateway.ts`
  - message persona typing
  - mode switching validation
- `app/app/(tabs)/_layout.tsx`
  - tab definitions and order
- `app/components/ModeHeader.tsx`
  - mode pill rendering
- `app/lib/store.ts`
  - fallback mode metadata / persona defaults
- any persona-specific screen under `app/app/(tabs)/`

### Special case: Mentor + Shapeshifter

Right now, Mentor and Shapeshifter share one persistent chat session in `server/src/agent.ts`.
If you add a fifth tab, decide whether it:

- gets its own session
- joins the shared chat session
- is a tool-centric mode like Tracker

That decision affects server-side routing, session reuse, and UI behavior.

## Recommendation

If you want a fifth persona, fork the repo and make it a first-class feature in your branch. The core project is intentionally opinionated about shipping four.
