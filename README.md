# 外网连接 / External Network

A subscription-driven outbound proxy plugin for DeepSeek Harness.

- **Settings → 外网连接** — paste a Clash / mihomo subscription URL (or a Base64 node list), pick a node, connect, test the exit IP.
- **Harness-scoped routing** — while connected, the plugin installs DSH's process-wide HTTP proxy policy. Model requests, `web_search` / `web_fetch`, MCP, and subprocesses started afterwards use the selected node.
- **No system changes** — no system proxy, no TUN, no firewall or routing-table edits.
- **Local only** — the mixed HTTP/SOCKS proxy binds `127.0.0.1` on a random port; the management API is registered on the existing DSH Web server.
- **Agent tool** — `vpn_connection` exposes status, subscribe, connect, disconnect, select, and test to the agent.

## Usage

1. Open **Settings** (sidebar foot) → **外网连接**.
2. Paste the subscription URL and press **保存并解析**.
3. Choose a node, then press **连接**.
4. Press **测试出口** to check the public exit IP.
5. **断开** restores direct access and removes the proxy environment for new subprocesses.

The subscription may be:

- A Clash / Clash.Meta / mihomo YAML document with an inline `proxies` list.
- A Base64-encoded or plain URI list containing `ss`, `vmess`, `trojan`, `vless` (including Reality), `hysteria2`, `tuic`, `socks5`, or `http` nodes.

Subscription groups and rules are ignored: the plugin creates one deterministic `select` group and uses `MATCH` for all non-local traffic. Local, loopback, and RFC1918 destinations stay direct. Clash `hosts` overrides are preserved, because some providers publish pseudo hostnames in `server` and map them to real CDN names there.

## Files and data

The plugin lives at this package root. Runtime data is under `.data/`:

| File | Purpose |
|---|---|
| `.data/state.json` | Subscription URL, parsed nodes, selected node, quota metadata (mode `0600`). |
| `.data/config.yaml` | Generated mihomo configuration while connected (mode `0600`). |
| `.data/mihomo` | Optional downloaded core when the packaged binary is unavailable. |

The directory is owner-only (`0700`). Removing the subscription deletes the state; uninstalling the plugin leaves `.data/` in the checkout so it can be removed manually.

## Core

The bundled Linux binary comes from [`@pkgship/mihomo-linux-amd64`](https://www.npmjs.com/package/@pkgship/mihomo-linux-amd64) via [`@pkgship/mihomo`](https://www.npmjs.com/package/@pkgship/mihomo), version `1.19.33`, which packages [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo). mihomo is licensed **GPL-3.0-or-later**; the plugin source is separate and does not relicense the core. If the platform package is missing, the plugin falls back to downloading the pinned Linux release from GitHub; set `DSH_VPN_CORE_PATH` to use a locally installed mihomo instead.

## Limitations

- Only the Harness process tree is routed. Other applications on the machine are unaffected.
- No TUN, no system-wide DNS changes, no OS proxy toggling.
- The subscription must be reachable while disconnected (or through any proxy already configured for DSH).
- If the selected node cannot reach a service the Harness depends on, that service will fail while connected. Disconnect to restore direct access.
- The management page is a React slot contribution in the existing DSH Web UI; it does not replace the app root, open an iframe, or read another plugin's DOM.

## Development

```bash
pnpm install
node --check index.js
node --check client.js
node --test test/subscription.test.mjs # when present
```

The Host half is plain ESM. The Client half is a lazy `window.__ModuleLoader__` factory and imports only `react` from the browser module table.
