---
name: create-skill
description: Instructions for creating new skills that can be shared across personas in the companion system
---

## Creating a New Skill

Skills are shared capability modules that personas can opt into. They live in `skills/` and are appended to a persona's system prompt at runtime.

### File Structure

```
companion/
  skills/
    <skill-name>/
      SKILL.md        ← the skill definition
  personas/
    ruse/PERSONA.md   ← references skills in frontmatter
```

### SKILL.md Format

```markdown
---
name: <skill-name>
description: One-line summary of what this skill does
---

## Skill Title

Content here — instructions, templates, rules, context.
This becomes part of the system prompt for any persona that references it.
```

### Wiring a Skill to a Persona

Open the persona's `PERSONA.md` and add the skill name to the `skills:` list in the frontmatter:

```yaml
---
name: ruse
description: ...
skills:
  - talk-prep
  - your-new-skill
---
```

The server reads the `skills:` list at session init and appends each skill's body to the system prompt automatically. No server restart needed after adding a skill — but a session reset is required (disconnect/reconnect in the app).

### Rules

- Skill names are lowercase, hyphenated: `talk-prep`, `code-review`, `weekly-review`
- Skills should be self-contained — don't assume context from another skill
- Keep skills focused: one capability per skill file
- Skills are appended after the persona body, separated by `---`
- Any persona can reference any skill — skills are not persona-specific

### Where Skills Live

All skills: `~/Desktop/companion/skills/<skill-name>/SKILL.md`
All personas: `~/Desktop/companion/personas/<name>/PERSONA.md`
User vault: `~/Desktop/companion/companion-vault/`
