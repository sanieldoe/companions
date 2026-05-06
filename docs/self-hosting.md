# Self-hosting Companions

Companions is meant to run on hardware you control: a laptop, mini PC, NAS, or home server.

## Requirements

- Node 20+
- npm
- an LLM provider or local compatible endpoint
- a local vault path
- optionally Tailscale for mobile access

## First-time setup

```bash
git clone https://github.com/sandoe/companions.git
cd companions/server
npm install
npm run setup
npm start
```

## Keep it running

For a casual setup, a tmux session is enough.

For a longer-lived setup, use a service manager.

## macOS with launchd

Create a plist similar to:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.companions.server</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-lc</string>
      <string>cd /Users/you/companions/server && npm start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/Library/Logs/companions.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/Library/Logs/companions.error.log</string>
  </dict>
</plist>
```

Load it with:

```bash
launchctl load ~/Library/LaunchAgents/com.companions.server.plist
```

## Linux with systemd

Create `/etc/systemd/system/companions.service`:

```ini
[Unit]
Description=Companions server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/companions/server
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable companions
sudo systemctl start companions
sudo systemctl status companions
```

## Logs

At minimum, capture stdout/stderr to files or your service manager’s journal.

Check logs when:

- setup completed but the server will not start
- mobile pairing fails
- your provider key is invalid
- a local model endpoint is unavailable

## Log rotation

If you log to files, rotate them.

On Linux, `logrotate` is the standard choice.
On macOS, `newsyslog` or a service-manager-managed log path works fine.

## Backups

Back up your vault separately from the app runtime.

The important pieces are usually:

- your vault directory
- `server/.env`
- `companions.config.json`
- optionally `server/data/tokens.json`

## Upgrades

A simple manual upgrade flow:

```bash
cd ~/companions
git pull
cd server && npm install
cd ../app && npm install
cd ../web && npm install
```

Then restart the server process.

## Security notes

- keep `server/.env` private
- treat `server/data/tokens.json` as sensitive
- revoke tokens you no longer use
- prefer Tailscale over exposing the server directly to the public internet
- keep dependencies and Node updated
