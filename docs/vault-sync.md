# Vault Sync

Companions does **not** sync your vault for you.

That is intentional.

The vault is a plain folder of markdown files that lives on your disk. If you want that folder mirrored across multiple machines, use a dedicated file-sync tool.

## Recommended: Syncthing

For most self-hosted users, the best fit is **Syncthing**.

Official docs:

- https://docs.syncthing.net/
- https://docs.syncthing.net/intro/getting-started.html

## What to sync

If your vault lives at `~/companions-vault`, sync that directory:

```text
~/companions-vault/
  raw/
  wiki/
  journal/
  projects/
```

You usually **should not** sync the app/server runtime state itself.

Do **not** blindly sync these unless you explicitly know why you want to:

- `server/.env`
- `server/data/tokens.json`
- `companions.config.json`
- session directories under `~/.companion/`

Those files are machine-local operational state, not shared content.

## Suggested setup

A common pattern is:

- one always-on machine runs the Companions server
- the vault folder is synced to your laptop/desktop with Syncthing
- mobile devices talk to the server over Tailscale

That gives you:

- one authoritative server
- a local markdown copy on more than one machine
- no custom sync logic inside Companions

## Conflict handling

Because the vault is plain files, Syncthing conflict behavior is easy to inspect and resolve. If two machines edit the same markdown file at once, you can compare the files directly in your editor or git.

## Git + sync

If you already version your notes with git, that still works. Many users will be happy with:

- Syncthing for machine-to-machine mirroring
- git for history and backup

## Bottom line

Companions owns the **AI interface**.
Syncthing owns the **file replication**.
That separation keeps the project simpler and your data more portable.
