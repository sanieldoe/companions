---
name: canvas-builder
description: Teaches agents how to output structured canvas definitions for the Ruse tab
---

## Canvas Builder

When working on a project with the user, you can build and update a visual canvas that appears in their Ruse tab. The canvas persists between conversations and builds up over time as the project develops.

### When to update the canvas

Update the canvas when:
- The user asks you to add something to their canvas or Ruse tab
- You produce a plan, outline, checklist, or structured artifact that belongs in the project space
- The project's scope or status changes meaningfully
- A key decision, reference, or resource should be permanently visible

Don't update the canvas on every message — only when there's something worth adding.

### Canvas output format

At the END of your response (after your conversational text), output a canvas block:

```
<canvas>
{
  "blocks": [
    { "id": "b1", "type": "markdown", "content": "# Project Title\n\nOne-line description." },
    { "id": "b2", "type": "tasks", "title": "Next steps", "items": [
      { "id": "t1", "text": "Do the thing", "done": false }
    ]},
    { "id": "b3", "type": "note", "title": "Key insight", "content": "The main idea in one sentence.", "color": "amber" }
  ]
}
</canvas>
```

### Rules

- Always include ALL existing blocks when updating — the full canvas replaces the previous one. Don't drop blocks the user hasn't removed.
- Generate short, stable IDs: `b1`, `b2`, `b3` for blocks; `t1`, `t2` for task items.
- The `<canvas>` block is invisible to the user in chat — it only appears in their Ruse tab.
- Put the `<canvas>` block at the very end of your response, after everything else.
- Never put the `<canvas>` block inside your regular message text.

### Block types

| type | required fields | optional fields |
|------|----------------|-----------------|
| `markdown` | `content` (markdown string) | — |
| `tasks` | `items` (array of {id, text, done}) | `title` |
| `note` | `content` | `title`, `color` (amber/blue/green/red) |
| `links` | `items` (array of {id, label, url}) | `title` |
| `code` | `content` | `language`, `title` |
| `section` | — | `label` |
| `button` | — | `label` (button text), `content` (optional description above) |

> The `button` block renders a tappable call-to-action. When tapped it opens a chat with Ruse. Use it when you want the user to take a specific action related to the project — e.g. "Start the session", "Review this with Ruse", "Begin the writing sprint".

### Example: talk prep canvas

```
<canvas>
{
  "blocks": [
    { "id": "b1", "type": "markdown", "content": "# Friend Zone Talk\n\n**One point:** Real friendship requires risk.\n\n**Key phrase:** You can't stay safe and stay close at the same time." },
    { "id": "b2", "type": "tasks", "title": "Prep checklist", "items": [
      { "id": "t1", "text": "Write the ME opening story", "done": false },
      { "id": "t2", "text": "Find the WE illustration", "done": false },
      { "id": "t3", "text": "Memorise the key phrase", "done": false }
    ]},
    { "id": "b3", "type": "note", "title": "Opening tension", "content": "Everyone wants deep friendship. Almost nobody risks the vulnerability it requires.", "color": "blue" }
  ]
}
</canvas>
```
