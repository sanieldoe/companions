# Security Policy

Thanks for helping keep Companions and its users safe.

## Supported versions

Until the project has tagged stable releases, security fixes land on `main` first.
If you are self-hosting Companions, keep your deployment close to `main` or the latest tagged release.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

Instead, email: **sanieldoe@gmail.com**

Include:

- a clear description of the issue
- affected files / endpoints / commands
- steps to reproduce
- impact assessment
- any suggested mitigation or patch

We will aim to:

- acknowledge receipt within 72 hours
- provide an initial assessment within 7 days
- coordinate a fix and disclosure timeline with you

## Scope

Please report vulnerabilities in:

- authentication and token handling
- WebSocket and HTTP authorization
- setup wizard secret handling
- server-side file access and vault writes
- release / install script supply-chain risks
- mobile pairing flow and credential storage

## Out of scope

The following are generally out of scope unless they demonstrate a concrete exploit:

- missing rate limiting on a single-owner local deployment
- self-signed / plain HTTP setups on a private Tailnet or LAN chosen by the operator
- denial-of-service requiring local machine access
- issues in third-party providers (Anthropic, OpenAI, Ollama, Tailscale, Expo, etc.)

## Disclosure policy

Please give us a reasonable window to investigate and fix the issue before public disclosure.
We will credit reporters who want attribution once a fix is available.
