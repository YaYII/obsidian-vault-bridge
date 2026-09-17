# Vault Bridge

> [English](README.md) · [简体中文](docs/README.zh-CN.md)

Open a **token-protected port** on your computer, then upload and download vault files from your phone over a URL.

One codebase plays two roles:

- **On desktop** it runs an HTTP server: opens the port, verifies the token, reads and writes your vault.
- **On mobile** it is a client only: browse files on the computer and download them, or send files from the phone back to the computer.

No cloud service, no account, no third-party server in the middle. Files travel directly between your own devices.

## Features

| | |
|---|---|
| **Download to phone** | Browse the remote vault and tap a file. Tapping a folder downloads it recursively, keeping the same relative structure so wiki-links and attachments keep working on mobile. |
| **Upload to computer** | Browse the phone vault and send files back. The landing folder is configurable. |
| **Works without the plugin** | The desktop server also serves a mobile-friendly web page, so any phone browser can transfer files with zero install. |
| **Built-in setup page** | `/setup` walks you through installing the mobile plugin and hands out the installation bundle — no cable, no cloud drive. |
| **LAN first, public optional** | Same-WiFi transfers go straight over your local network. For 4G/5G there is a one-command HTTPS tunnel. |

## Requirements

Obsidian **1.13.0 or later**. The settings tab uses the declarative settings API
introduced in 1.13.0, which is what lets these settings show up in Obsidian's
settings search.

## Quick start

### 1. On the computer

```bash
npm install
npm run build
node tools/install.mjs --enable    # install into your vault and enable it
```

Or copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/vault-bridge/` and enable it under
**Settings → Community plugins**.

Reload Obsidian; the server starts automatically on port **8770**.

The plugin settings then show:

- the running status,
- a LAN address such as `http://192.168.1.44:8770/?token=…`,
- the access token.

Click the address to copy it.

### 2. On the phone

**Option A — browser, nothing to install.** Open the copied link on your phone.
Add it to your home screen and it behaves like an app.

**Option B — the mobile plugin.** On the phone open `http://<computer-ip>:8770/setup`,
download the bundle, unzip it into `<your vault>/.obsidian/plugins/vault-bridge/`,
then enable **Vault Bridge** in Obsidian and enter the address and token.

Step-by-step iOS instructions (中文): [docs/mobile-setup.md](docs/mobile-setup.md).

## Network

| Situation | Address | What to do |
|---|---|---|
| Phone and computer on the same WiFi | `http://192.168.1.44:8770` | Nothing — it just works |
| Phone on 4G/5G | `https://xxx.trycloudflare.com` | Run `tools/tunnel.sh start` on the computer |

Public access must be **HTTPS**: iOS App Transport Security rejects plain HTTP requests
from the app, which is why the LAN address stops working outside your home network.

```bash
tools/tunnel.sh start     # start the tunnel and print the public URL
tools/tunnel.sh status
tools/tunnel.sh stop
```

Quick-tunnel hostnames change on every restart. Update the address on your phone when that
happens; the token stays the same.

## Security

An open port gets probed, so every request is treated as hostile until proven otherwise.

- **The token is the only credential** — 32 URL-safe random characters, sent as `Authorization: Bearer` or `?token=`.
- **Constant-time comparison** — response timing cannot be used to guess the token character by character.
- **Rate limiting** — 8 failures from one IP within a minute triggers a 5-minute block.
- **Path sandbox** — every path from the network is normalized first; `../` escapes, absolute paths and drive letters are rejected.
- **The config directory is off-limits** — `.obsidian` cannot be read or written over the network, so tokens and plugin data cannot be exfiltrated or overwritten.
- **Writes can be disabled** — turn off "allow upload" and the phone becomes read-only.
- **Upload size cap** — 32 MB by default, configurable.
- **Access log** — see who did what and when in the settings tab.

Regenerating the token in the settings invalidates the old one immediately.

## FAQ

**The phone cannot connect.**
Open `http://<computer-ip>:8770/api/health` in the phone browser.
JSON back means the network is fine. A 401 means the network is fine but the token is wrong.
Nothing at all means WiFi or firewall.

**Port already in use?** Change the port in the settings (1024–65535) and press "restart service".

**Where do downloaded files go?** Into `VaultBridge下载/` on the phone, mirroring the computer's
relative paths. Configurable in the settings.

## How one bundle runs on both platforms

Mobile Obsidian cannot load Node built-in modules. The build therefore:

- bundles with `platform: browser` and marks `http`/`os`/`fs` as external,
- runs server code only when `Platform.isDesktopApp` is true, resolving Node modules lazily
  through a single `nodeRequire()` chokepoint.

`tools/verify-bundle.mjs` loads the real `main.js` the same way Obsidian does — injecting
`module`/`exports`/`require` through `new Function` — then starts the server and fires real HTTP
requests. It also asserts that on mobile the plugin **creates no server instance and binds no port**.

## Development

```bash
npm run build          # bundle to main.js
npm run typecheck
npm run lint
npm test               # 160 unit & integration tests
npm run test:coverage
npm run verify         # 42 bundle-level assertions against the real artifact
npm run bench          # end-to-end latency benchmark
```

### Layout

```
src/
├── main.ts              plugin entry; dispatches the two roles by platform
├── settings.ts          settings model and the desktop settings tab
├── shared/              used by both sides: types, path safety, token, protocol, transfer paths
├── server/              desktop: HTTP server, router, auth, vault ops, web UI, self-setup page
└── client/              mobile: API client and the transfer panel
tests/                   vitest: attack surface, auth, routing, real-port integration
tools/                   installer, tunnel, bundle verification, Obsidian host double
```

## Verifying a release

Release assets ship with a GitHub build provenance attestation, so you can confirm
that `main.js` was built from this repository by its release workflow:

```bash
gh attestation verify main.js --repo YaYII/obsidian-vault-bridge
```


On older `gh` versions (below 2.49) verify through the API instead:

```bash
D=$(sha256sum main.js | cut -d" " -f1)
gh api "repos/YaYII/obsidian-vault-bridge/attestations/sha256:$D"
```
The build is also reproducible: it embeds no timestamp or randomness, so rebuilding
from the same tag yields a byte-identical `main.js`.

<a id="sponsor"></a>

## Sponsor / 赞助

**English** — Vault Bridge is a spare-time project. If it saves you some hassle moving
files between your computer and phone, you can buy me a cup of tea.
**Entirely optional — every feature stays free.**

**中文** —— Vault Bridge 是业余时间的作品。如果它让你在手机和电脑之间传文件省了事，
欢迎扫码请我喝杯茶 —— **完全自愿，不影响任何功能**。

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/sponsor/wechat-pay.jpg" alt="WeChat Pay QR code / 微信支付收款码" width="260" />
      <br /><b>WeChat Pay / 微信支付</b>
    </td>
    <td align="center" width="50%">
      <img src="docs/sponsor/alipay.jpg" alt="Alipay QR code / 支付宝收款码" width="260" />
      <br /><b>Alipay / 支付宝</b>
    </td>
  </tr>
</table>

Three things that help just as much as money / 不花钱也能帮上忙：

1. Star this repo / 给仓库点个 Star；
2. Vote for it in the [community directory](https://community.obsidian.md/plugins) once it is listed /
   等它进入社区目录后点个赞；
3. Report what broke / 把遇到的问题反馈过来。

## License

[MIT](LICENSE)
