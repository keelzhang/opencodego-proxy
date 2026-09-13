[English](README.md) | [简体中文](README.zh-CN.md)

# cursor-opencode-proxy

Once the OpenCode Go backend enforced session routing (requiring an `x-opencode-session` header), Cursor could no longer connect directly, since it offers no way to configure custom request headers. This proxy injects that header on Cursor's behalf: the SSE stream is passed through untouched, and the local port is exposed as a public HTTPS endpoint through a cloudflared named tunnel for Cursor to connect to.

## Usage

1. Copy `config.example.json` to `config.json` and fill in `baseUrl` and `apiKey`
2. `node cursor-opencode-proxy.js`
3. Expose the local port as a public HTTPS endpoint through a cloudflared named tunnel (see "Public Endpoint"), and use that HTTPS address (not `127.0.0.1`) as Cursor's Base URL
4. Chat away; with `log.headers: true` the console shows the session headers Cursor actually sends

> **Important: Cursor cannot connect to 127.0.0.1.** Cursor's BYOK requests are issued by Cursor's own servers (prompt building, context, Tab, and Agent all run server-side), so from that vantage point 127.0.0.1 refers to the server itself. It is blocked by their SSRF protection, which returns `403 Access to private networks is forbidden`. The Base URL must be a publicly reachable HTTPS endpoint.

## Public Endpoint (cloudflared Named Tunnel)

### One-time setup (the domain's DNS must be hosted on Cloudflare)

```
cloudflared tunnel login
cloudflared tunnel create cursor-proxy
cloudflared tunnel route dns cursor-proxy proxy.example.com
```

### Example config.yml (Windows paths)

```yaml
tunnel: cursor-proxy
credentials-file: C:\Users\<username>\.cloudflared\<tunnel-UUID>.json
ingress:
  - hostname: proxy.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

> The port in `ingress[0].service` must match the proxy's `port` (8787 in the example above).

### Enabling it

Configure auth and the tunnel in `config.json`:

- `auth.enabled: true` with `auth.token` filled in (or set the `COP_AUTH_TOKEN` environment variable)
- `tunnel.enabled: true`, with `tunnel.configFile` pointing at the `config.yml` above

Starting the proxy also starts cloudflared. If the tunnel crashes it restarts automatically; unrecoverable failures such as a missing `cloudflared` are logged as a warning without being retried, and never affect the proxy's own service.

### Why not Quick Tunnels (TryCloudflare)

The official docs state that Quick Tunnels do not support Server-Sent Events (SSE) and are limited to 200 concurrent requests; cloudflared contributors have likewise confirmed that SSE only works over named tunnels. Faithful SSE pass-through is this project's primary goal, so only named tunnels are supported.

## Connecting Cursor

| Cursor setting | Value |
|---|---|
| Override OpenAI Base URL | https://proxy.example.com/v1 |
| OpenAI API Key | the value of `auth.token` (not the upstream apiKey) |

Neither the address nor the access token needs to be looked up by hand: the startup log prints both, ready to copy.

```
Cursor Base URL: https://proxy.example.com/v1  (ingress hostname "proxy.example.com" from C:\Users\<username>\.cloudflared\config.yml)
Cursor API Key:  <the auth.token value from config.json>  (not the upstream apiKey)
```

Derivation rules: take the first entry under `ingress` that has a `hostname`; if there are several, prefer the one whose `service` port matches `port` (the trailing catch-all entry has no hostname and is ignored by construction). If the file cannot be read or no hostname is found, the proxy only prints a note and still starts; fill in the address manually per the table above in that case. Only block-style `ingress` (the style used in the "Public Endpoint" example) is supported; flow style (`- {hostname: x}`) and multi-line scalars are not parsed.

**The `Cursor API Key` line prints `auth.token` in plain text**, for easy copying; **the upstream `apiKey` is never printed to any log**, so do not confuse the two. If the log may be seen by others or shared as a screenshot, judge for yourself whether that plain-text exposure is acceptable (a leaked `auth.token` means anyone can spend your upstream quota through the tunnel). When `auth.enabled: false`, the line is still printed but contains no token value, only a note that any non-empty value may be used.

## Session Header and Session Strategy

Cursor's BYOK override endpoint **sends no session identifier at all** — this is the officially confirmed status quo, not a visibility problem on this proxy's side:

> "Cursor does not currently send conversation or agent identity headers (or equivalent metadata) on requests to a custom OpenAI-compatible base URL. Outbound calls to that override path effectively only carry the provider auth you'd expect, so a gateway sees anonymous completions and has to reassemble sessions after the fact."
>
> — Cursor Staff, [forum.cursor.com topic 166994](https://forum.cursor.com/t/grouping-requests-into-conversations-using-an-api-gateway/166994)

That feature request is tracked with no timeline (post #7 in the same topic), and the forum offers no supported way for users to configure custom request headers either. Meanwhile OpenCode Go explicitly asks clients to `Send a stable session ID in x-opencode-session for each conversation so we can optimize routing and prompt caching` ([opencode.ai/docs/go](https://opencode.ai/docs/go/)).

So in practice the `auto` strategy behaves like this:

1. Probe `x-session-id` → `x-client-session-id` → `x-request-id` in order (Cursor currently sends none of them);
2. **When none of them is present**, fall back to the device-level header `cf-warp-tag-id` (injected by Cloudflare, stable across requests);
3. Only when even that fallback is absent (for example a direct connection that bypasses Cloudflare) does it degrade to a fresh UUID per request.

Cost and boundaries: every Cursor conversation on the same device shares one upstream session — a **transitional compromise** (reusing routing and prompt caching in exchange for no longer distinguishing between conversations). As soon as any real session header appears in a request, the fallback drops out immediately and never pollutes a more precise mapping. The device-level fallback is labelled `cf-warp-tag-id(device)=…` in the log.

A more precise approach (same conversation reuses, different conversations distinguished) would derive the session key from a fingerprint of the request body's `messages` prefix. That requires parsing the body, which conflicts with the current "pass through untouched, never parse" design, and is not implemented.

### Lifetime of the Mapping Table (why the session changes after a night away)

Even when `cf-warp-tag-id` never changes, the injected `x-opencode-session` can still be renewed. There are two causes, neither related to the device identifier:

1. **TTL expiry (`session.ttlMs`, a sliding window).** The check and renewal live in `resolveSession`: only `now - createdAt < ttlMs` counts as a hit, and every hit refreshes `createdAt` to the current time. So **as long as the gap between consecutive requests is under `ttlMs` the session keeps renewing and never changes; once the proxy sits idle longer than `ttlMs`, the next request gets a new UUID**. The built-in default of 2 hours is bound to fail for "leave it overnight" usage, so both `config.example.json` and the local `config.json` use 7 days (`604800000`).
2. **Proxy process restart.** The mapping table is a plain in-memory `Map` (`createSessionManager`) and is never persisted. After a process or machine restart, the same `cf-warp-tag-id` gets a new UUID too — **raising `ttlMs` cannot fix this one**.

How to tell them apart: check the log for a fresh startup banner (`cursor-opencode-proxy listening on …`). No banner, with only `-> x-opencode-session=` changing, means TTL expiry; a banner means a process restart. Separately, `cleanupSessionMap` reclaims expired entries once an hour; its deletion condition is identical to the check condition, so it only frees memory and does not change the behaviour above.

> `session.*` supports hot reload: saving a new `ttlMs` takes effect immediately with no restart; existing entries in the mapping table that still count as unexpired under the new `ttlMs` keep being reused.

## Configuration

| Field | Default | Description |
|---|---|---|
| port | 8787 | Listening port (127.0.0.1 only) |
| baseUrl | (required) | Upstream OpenAI-compatible endpoint (http/https) |
| apiKey | (required) | Upstream API key |
| auth.enabled | false | Whether an access token is required to call the upstream through this proxy |
| auth.header | authorization | Name of the header carrying the access token |
| auth.token | "" | Access token (required when auth.enabled=true) |
| tunnel.enabled | false | Whether to start the cloudflared named tunnel automatically |
| tunnel.binary | cloudflared | Path to / command name of the cloudflared executable |
| tunnel.name | cursor-proxy | Named tunnel name |
| tunnel.configFile | "" | Path to the cloudflared config (config.yml) |
| tunnel.restartDelayMs | 5000 | Delay before restarting the tunnel after a crash (ms) |
| session.strategy | auto | auto / per-request / static |
| session.header | x-opencode-session | Name of the injected header |
| session.staticId | 00000000-… | Fixed value injected when strategy=static |
| session.ttlMs | 7200000 | Lifetime (ms) of the session key → injected UUID mapping. Sliding window: a hit renews it, and going idle longer than this value means the next request gets a new one (see "Lifetime of the Mapping Table"); `config.example.json` uses 604800000 (7 days) to suit overnight usage |
| log.headers | true | Print received request headers (Authorization redacted) |
| log.body | false | Print the first 2 KB of the request body |
| log.tunnel | false | Pass through cloudflared subprocess output (stdio inherit) |

- The environment variables `COP_PORT` / `COP_BASE_URL` / `COP_API_KEY` / `COP_AUTH_TOKEN` override the corresponding fields, and keep doing so after a hot reload
- `auth.header` and `session.header` must not be the same (sharing a name would overwrite the upstream Authorization header and cause an upstream 401); this is rejected at startup whether or not auth is enabled
- Saving `config.json` triggers a hot reload; an invalid config keeps the old one and logs a warning; port changes and `tunnel.*` changes require a process restart
- On first start, if `config.json` does not exist, it is copied from the template and the process exits

## Upgrade Notes

There are four behaviour changes worth noting in this version:

1. **The `auto` strategy gained a device-level fallback header.** When no session header is detected at all (which is exactly Cursor's situation), `cf-warp-tag-id` is used as the session key, so requests from the same device no longer get a fresh UUID each time but reuse one upstream session; when even that header is absent it still degrades to a fresh UUID per request. For the semantics and their source, see "Session Header and Session Strategy".
2. **`session.ttlMs` changed from 2 hours to 7 days (`604800000`).** This value is the lifetime of the sliding window; going idle longer than it renews the injected session. The old 2 hours meant it was guaranteed to renew overnight, resetting the upstream's session routing / prompt caching to zero. The built-in code default is unchanged (still `7200000`); what changed is the `config.example.json` template and the local `config.json`. Adjust it longer or shorter as you like — `session.*` takes effect on save via hot reload. Note that it **cannot fix renewal caused by a process restart** (the mapping table lives in memory); see "Lifetime of the Mapping Table" for details.
3. **`auth.header` and `session.header` must not be the same.** If an old config set both to the same field (for example both `x-opencode-session`), startup is rejected with `config: auth.header and session.header must differ`. The reason is that `proxyRequest` unconditionally writes `headers['authorization'] = Bearer <upstream apiKey>`, and if `headers[session.header] = <sessionId>` shares that name it overwrites the upstream auth header, causing an upstream 401. Set `session.header` back to `x-opencode-session` (the default) or pick another non-conflicting name.
4. **Cursor's Base URL can no longer be `http://127.0.0.1:8787/v1`.** That approach has been verified unusable: Cursor's BYOK requests are issued by Cursor's servers, whose SSRF protection rejects private network ranges and returns `403 Access to private networks is forbidden`. Use the public HTTPS address exposed by the cloudflared named tunnel instead; see "Public Endpoint".

## Tests

```
node --test tests/*.js
```
