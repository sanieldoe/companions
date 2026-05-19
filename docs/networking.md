# Networking Companions

Companions is designed for a **single owner with multiple devices**. Your phone, tablet, and browser need to reach your self-hosted server wherever it runs. For v1, the recommended path is **Tailscale**.

## Recommended: Tailscale

Why Tailscale is the default recommendation:

- free for personal use
- works on macOS, Linux, Android, iOS, and Windows
- gives you a stable MagicDNS hostname like `my-mac.tailnet-1234.ts.net`
- no router port-forwarding
- no custom DNS setup
- ideal for a personal, single-owner deployment

The setup wizard detects Tailscale with:

```bash
tailscale status --json
```

If it finds a logged-in client, it offers the device DNS name as the public host for mobile pairing.

### Install

**macOS**

```bash
brew install tailscale
sudo tailscale up
```

**Linux**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Once connected, open the setup wizard or dashboard again if you want Companions to use the Tailscale hostname for remote access.

## Alternative: plain LAN

If you only use Companions at home or on the same network, a local IP like `192.168.1.25:3000` is fine.

Trade-offs:

- easy to start
- no extra software
- stops working when your phone is off your home network

## Alternative: Cloudflare Tunnel

Cloudflare Tunnel is a good choice if you want a stable public hostname without opening router ports directly.

Trade-offs:

- good public URL story
- more setup than Tailscale
- public-internet exposure means you should be extra careful with tokens and updates

## Alternative: ngrok

ngrok is fine for quick demos and short-lived testing.

Trade-offs:

- fast to get running
- free URLs change often
- not ideal for a stable daily driver setup

## Alternative: self-run WireGuard

If you already run your own VPN, Companions can sit behind it just fine.

Trade-offs:

- powerful and flexible
- more operational work
- no setup-wizard assistance

## HTTP vs HTTPS

v1 uses plain HTTP / WS by default on your Tailnet or LAN. This is acceptable for many self-hosted personal deployments, especially on a private Tailnet.

If you want HTTPS later, you can front the server with your preferred reverse proxy or tunnel provider.

## Ports

The default server port is `3000`. You can change this with the `PORT` environment variable before starting the server.

If mobile pairing fails:

- make sure the server is running
- confirm the host and port match the setup summary
- test `http://<host>:<port>/ping`
- confirm you can load `http://<host>:<port>/install` or `http://<host>:<port>/dashboard`
