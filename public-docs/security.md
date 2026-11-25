---
title: Security
description: "Security model for Paseo: architecture overview, connection methods, relay encryption, and best practices."
nav: Security
order: 5
category: Getting started
---

# Security

Paseo follows a client-server architecture, similar to Docker. The daemon runs on your machine and manages your coding agents. Clients (the mobile app, CLI, or web interface) connect to the daemon to monitor and control those agents.

Your code stays on your machine. Paseo collects no telemetry, requires no account, and connects directly to your development environment.

## Architecture

The Paseo daemon can run anywhere you want to execute agents: your laptop, a Mac Mini, a VPS, or a Docker container. The daemon listens for connections and manages agent lifecycles.

Clients connect to the daemon over WebSocket. There are two ways to establish this connection:

- **Relay connection (recommended)**, The daemon connects outbound to our relay server, and clients meet it there. No open ports required.
- **Direct connection**, The daemon listens on a network address and clients connect directly.

## Relay connections (recommended)

The relay is the simplest way to connect from your phone. It requires no VPN setup, no port forwarding, and no firewall configuration. The daemon can stay bound to localhost or a socket file, it connects _outbound_ to the relay, and your phone meets it there. The official relay server is the open-source Elixir service at [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay).

Relay is off on new installations. When you pair a device from `paseo`, `paseo daemon pair`, or Paseo Desktop, Paseo asks before enabling it. Choosing not to enable relay leaves the daemon available for direct TCP, Tailscale, or other VPN connections and does not create a pairing QR code. Use `--relay` with the CLI pairing or startup command to opt in without an interactive prompt.

> **The relay is designed to be untrusted.** All traffic between your phone and daemon is end-to-end encrypted. The relay server cannot read your messages, see your code, or modify traffic without detection. Even if the relay is compromised, your data remains protected.

### How it works

1. On first run, the daemon generates a persistent Curve25519 keypair and saves it to `$PASEO_HOME/daemon-keypair.json` (mode `0600` on Unix).
2. When you scan the QR code or open the pairing link (`https://app.paseo.sh/#offer=...`), your client reads the daemon's public key from the URL fragment. Browsers never send URL fragments to the server, so `app.paseo.sh` never sees the key.
3. When a client connects through the relay, both sides generate fresh ephemeral keys and run a Noise `NK` handshake bound to the daemon's public key. The handshake uses `X25519`, `ChaCha20-Poly1305`, and `SHA-256`. The daemon ignores all commands until the handshake completes.
4. After the handshake, every message is encrypted with `ChaCha20-Poly1305` and an incrementing counter. When either side predates Noise, the session falls back to NaCl `box` (`XSalsa20-Poly1305`) until both sides are updated.
5. With [device authentication](/docs/configuration#device-authentication) enabled, the client authenticates inside the encrypted channel. It uses the one-time pairing token on the first connection and the device credential issued by the daemon on later connections. The daemon opens a session only after authentication succeeds.

The relay sees only IP addresses, connection timing, message sizes, session IDs, and the public handshake frames. It cannot read message contents, tamper with messages, or derive encryption keys.

### Why the relay can't attack you

The daemon requires a valid cryptographic handshake before it accepts any command. A compromised relay cannot do the following:

- Impersonate the daemon: without the daemon's private key, the relay cannot complete the handshake, so your client rejects any traffic it injects.
- Read your traffic: only your client and daemon hold the session keys.
- Forge or modify messages: authenticated encryption rejects tampered payloads.
- Replay old messages: each Noise session uses fresh ephemeral keys from both sides and checks message counters. Replayed, duplicated, or reordered messages close the connection.

Legacy NaCl `box` sessions remain supported by default during migration and do not have replay protection. Once both your daemon and clients are updated, set `daemon.relay.requireProtectedSecurity` to `true` in `config.json` and restart the daemon to require the Noise handshake.

### Trust model

The QR code or pairing link is the trust anchor. It contains the daemon's public key, which the client needs to start an encrypted session and which is never sent to the relay. Treat the link like a password and do not share it publicly.

If device authentication is off and you set a daemon password, relay clients send it inside the encrypted channel. The daemon rejects any client without the right password, so a leaked pairing link alone does not grant access.

With device authentication on, a pairing link or QR code pairs one device and stops working after 5 minutes. Once your device has paired, the link is worthless to anyone who finds it. Until then, whoever uses it first gets access, even to a password-protected daemon, so don't share it.

A paired device does not send the daemon password. Its device credential is tied to the password it was paired under, so setting, changing, or removing the password signs out every paired device. To remove a single device:

```bash
paseo daemon devices                   # list paired devices
paseo daemon devices revoke <id>       # disconnect that device within 15 seconds
paseo daemon devices revoke --all
```

## Direct connections

By default, the daemon listens on `127.0.0.1:6767` (localhost only). This is safe for local CLI usage but not reachable from your phone or other devices.

For relay and Tailscale setup instructions, see [Connectivity](/docs/connectivity).

### Socket file (CLI only)

For maximum isolation, you can configure the daemon to listen on a Unix socket file instead of a TCP port. This prevents any network access entirely, only processes on the same machine can connect. The CLI supports this mode, but the mobile app and web interface require a network connection.

### VPN access

Use a VPN such as [Tailscale](https://tailscale.com) when you want a direct connection outside your local network. The VPN encrypts the traffic and keeps the daemon off the public internet. Bind the daemon to its VPN address, set a Paseo password, then add that address as a direct connection in the client.

### Binding to 0.0.0.0

> **Warning:** Binding to `0.0.0.0` makes the daemon reachable on all network interfaces, including public Wi-Fi and local networks. This can expose your daemon to unauthorized access. If you must bind to all interfaces, ensure you have proper firewall rules and review your `hostnames` configuration.

## DNS rebinding protection

**CORS is not a complete security boundary.** It controls which browser origins can make requests, but does not prevent a malicious website from resolving its domain to your local machine (DNS rebinding).

Paseo uses a host allowlist to validate the `Host` header on incoming requests. Requests with unrecognized hosts are rejected.

Configure via `daemon.hostnames` in `config.json`:

- Default (`[]`): allow `localhost`, `*.localhost`, and all IP addresses
- `["myhost"]`: allow `myhost`, plus defaults
- `[".example.com"]`: allow `example.com` and any subdomain, plus defaults
- `true`: allow any host (not recommended)

Entries ignore the port in the `Host` header. Append a port to require it, `example.com:6767`. A trailing colon, `example.com:`, spells out any port. A port narrows only the entry it is written on: the defaults stay allowed on every port, so `localhost:6767` does not block `localhost:9999`. Entries take no scheme; schemes belong to origins.

## Browser origins

Browsers send an `Origin` header on cross-origin requests and on every WebSocket connection. The daemon adds CORS headers, and accepts the upgrade, only when that origin is listed in `daemon.cors.allowedOrigins` or `PASEO_CORS_ORIGINS` (comma-separated). Same-origin traffic, including the web UI the daemon serves itself, needs no entry, and neither does the desktop app.

Entries use the `hostnames` syntax with an optional scheme. Without a port, an entry matches only an origin that has no explicit port:

- `https://app.example.com`: that origin exactly
- `.example.com`: `example.com` and any subdomain, on any scheme, without an explicit port
- `.example.com:`: the same on any port
- `https://.example.com:8443`: HTTPS subdomains on port 8443
- `*`: any origin (not recommended)

Prefer entries with a scheme. Without one, `.example.com` also admits plain `http://` pages on those hosts. Browsers send `Origin: null` for sandboxed frames and local files, so an entry of `null` admits all of them and is as broad as `*`.

## Password authentication

By default, anyone who can reach the daemon's listening address can connect. On localhost this is fine, only local processes have access. But if you bind to a network interface (e.g. your LAN IP or `0.0.0.0`), or if you don't fully trust your local network, you can require a password.

When a password is configured, all HTTP requests must include an `Authorization: Bearer <password>` header, and every WebSocket client must send the password when it connects. Relay clients send it inside the end-to-end encrypted channel, so the relay never sees it. With [device authentication](/docs/configuration#device-authentication) on, a paired relay device signs in with its device credential instead and is not asked for the password. Direct connections, including the bundled web UI, still need it. Unauthenticated HTTP requests receive a `401 Unauthorized` response. Only the `/api/health` liveness endpoint is exempt, so that process supervisors and load balancers can probe without credentials.

If you enable the [bundled web UI](/docs/web-ui), its static files are also served without the password so the login screen can render. This is by design, the API and WebSocket still require authentication before any agent data is returned or any command runs. Set a password before binding the daemon to a network so the data behind the page stays protected.

The password is stored as a bcrypt hash in `config.json`, the daemon never stores it in plaintext. See [Configuration](/docs/configuration#password-authentication) for setup instructions.

### What password auth does and does not do

- **Does:** Prevents unauthorized clients from controlling your agents, even if they can reach the daemon over the network.
- **Does not:** Encrypt traffic. Password auth protects access, not confidentiality. If you need encrypted connections over an untrusted network, use the relay (which provides end-to-end encryption) or a VPN like Tailscale.

### When to use it

- You want to bind the daemon to a LAN or Tailscale address and restrict who can connect.
- You don't fully trust your local network (shared office, public Wi-Fi with a VPN, etc.).
- You're exposing the daemon via a reverse proxy and want an additional authentication layer.

We still recommend the relay for mobile access, it combines authentication with end-to-end encryption out of the box. Password auth is primarily useful for direct LAN or VPN connections where you want access control without the relay.

## Docker self-hosting

The official Docker image runs the daemon and bundled web UI in one container. It binds to `0.0.0.0:6767` inside the container so Docker port publishing and reverse proxies work normally.

For Docker deployments:

- Set `PASEO_PASSWORD` before publishing the port to a LAN, VPN, or public address.
- Use HTTPS at your reverse proxy for browser access outside localhost.
- Set `PASEO_HOSTNAMES` for any DNS names you use to reach the container.
- Keep `/workspace` mounts scoped to repositories the agents should be able to read and write.
- Treat `/home/paseo` as sensitive, it can contain daemon state and provider credentials.

The image runs the daemon and launched agents as the non-root `paseo` user, but container user isolation is not a substitute for careful mounts. Agents can still access whatever code and credentials you mount into the container.

See [Docker](/docs/docker) for Compose and reverse proxy examples.

## Linux desktop sandbox

Paseo checks Chromium sandbox availability each time the desktop app launches on Linux. It keeps sandboxing enabled when user namespaces work or an installed sandbox helper is usable. The `.deb` and `.rpm` installers configure that helper.

AppImage and extracted tar archives launch with Chromium's sandbox disabled when neither is available. Use the `.deb` or `.rpm` package if you require Chromium process isolation. Passing `--no-sandbox` explicitly disables it.

Open **Settings → Diagnostics → App Diagnostics** to check the sandbox state and reason. The [desktop log](/docs/troubleshooting#reading-the-logs) records the same decision.

## Agent authentication

Paseo wraps agent CLIs (Claude Code, Codex, OpenCode, Muse Code) but does not manage their authentication. Each agent provider handles its own credentials:

- **Claude Code**, authenticates via Anthropic's OAuth flow, stored in `~/.claude/`
- **Codex**, uses your OpenAI API key or OAuth session
- **OpenCode**, configured via provider-specific API keys

Paseo never stores or transmits provider API keys. Agents run in your user context with your existing credentials.

## Hub identities and credentials

Hub CLI login and daemon enrollment are separate identities. `paseo hub login [origin]` stores a durable organization-scoped credential in a private file under `PASEO_HOME`, keyed by the normalized Hub origin.

A stored credential is never sent to another origin, so protect `PASEO_HOME` as sensitive local state. Hub CLI credentials are bearer secrets, and remote Hub origins must use HTTPS (cleartext HTTP is accepted only on `localhost`, `127.0.0.1`, and `[::1]`).

`paseo hub connect [origin]` uses your CLI login or an API key only to request a short-lived one-time enrollment token. The daemon exchanges that token for its own independent relationship credential.

Logging out of the CLI does not silently remove daemon authority. Interactive `logout` asks whether to disconnect a same-origin daemon before deleting the login, while JSON and non-interactive logouts require `--disconnect-daemon` to remove both identities.

`--api-key` and `PASEO_HUB_API_KEY` override stored login without being persisted. Prefer environment variables or secret-manager injection for automation, and avoid command-line flags when local process listings or shell history are visible to other users.

## Recommendations

- **Use the relay** for mobile access, it's the simplest option and all traffic is end-to-end encrypted
- **Treat the QR code like a password**, enable device authentication to limit pairing offers to one use within five minutes
- **Set a password** if you bind to a network address, it prevents unauthorized clients from controlling your agents
- **Never bind to 0.0.0.0 without a password**, without one, any device on your network can connect
- **Scope Docker mounts tightly**, agents can access mounted workspaces and provider credentials
- **Keep your daemon updated**, security improvements are released regularly
- **Protect Hub trigger files and organization access**, push access to `.paseo/triggers/*.yml` controls what Hub can run on your daemons, see [How Hub works](/docs/hub/concepts)
