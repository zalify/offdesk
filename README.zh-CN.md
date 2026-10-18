<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" alt="Offdesk Dev" height="48">
  </picture>
</p>

<p align="center">
  <img src="docs/media/hero-banner.png" alt="一个终端，你和你的 agent 共用。tmux 里的任何程序，跑在你所有的机器上，汇集到你自己运行的一个 Hub。" width="800">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a>
</p>

# Offdesk Dev：面向 tmux 与 AI 编程 agent 的自托管远程终端

> 本文是 [英文 README](README.md) 的中文翻译。两者不一致时，以英文版为准。
> 中文网站：[offdesk.dev/zh](https://offdesk.dev/zh/)

**一个终端，你和你的 agent 共用。** agent 通过 `offdesk` CLI 打开终端、输入、读取输出；你在手机上看着同样的终端，需要你的时候直接接过键盘。

在浏览器、iPhone、Android 手机或桌面 App 上访问 **Claude Code、Codex、OpenCode 或任何终端程序**。Offdesk 通过一个自托管的 Hub，把客户端连接到你自己的 macOS 和 Linux 机器上持久运行的 **tmux 会话**。命令在远程机器上执行，客户端通过 WebSocket 连接传输终端的输入和输出。

App 安装后的名字是 **Offdesk Dev**，本文简称 Offdesk。命令行工具沿用 `offdesk` 这个名字：`offdesk` CLI、`offdesk-hub` 服务端和 `offdesk-node`
机器 agent。

你可以用它在手机上查看 AI 编程 agent 的进度，在网络断开后接着用原来的 shell，或者在一个界面里管理 Mac、Linux 服务器、NAS 和 VPS 上的终端。运行 Hub
和会话的机器需要保持在线。

- **持久的远程会话：** 重新连上同一个 tmux 终端，交互式 CLI、编辑器、构建输出和 shell 历史都还在。
- **一个 Hub 管多台机器：** 每个 `offdesk-node` 主动向外连接 Hub，节点不需要开放入站端口，也不需要公网 IP。
- **手机端终端控制：** 按键栏排成整齐的网格，支持自定义快捷键、Shift+Tab、Shift
  组合键和长按 Backspace 连删；方向键、Enter 和键盘开关位置固定。支持文件附件，以及扫二维码完成 App 加密配对。点标题栏里的终端名切换会话；旁边的 `[f]`、`[b]`
  和 `[m]` 分别打开文件、agent 浏览器和 Machines & Hub。
- **CLI 自动化：** 用 `offdesk open / send / wait / read` 打开终端、发送输入、等待输出、读取结果，支持 JSON 输出。agent 打开的终端会在 App 中带有标记。
- **自托管部署：** 在 macOS/Linux 上使用 Rust 二进制或 Docker 部署，数据存于 SQLite，Web UI 内置在 Hub 二进制中。
- **App 加密连接：** 已配对的 App 与 Hub 之间端到端加密。普通浏览器访问走另一套登录流程；从公网用浏览器访问需要 HTTPS 和身份验证。

本仓库中的 Hub、node、CLI 以及协议和加密 crate 采用 **MIT 许可证**；Web UI 和桌面端、手机端 App 以 **FSL-1.1-MIT** 公开源码（见[许可证](#许可证)）。自托管不需要任何厂商账号。可选的托管版 **Offdesk**（[offdesk.so](https://offdesk.so)）是一项独立的闭源服务，提供托管的远程访问。它的开源本地连接器会检查加密连接是否可达，在隧道持续故障时自动重启，长时间中断时按退避策略重试。

有问题、配置没跑通、想要什么功能：来 [Discord](https://discord.gg/aFUu6VMzc)。

## 下载

| | | |
|---|---|---|
| **macOS** | [offdesk.dev/mac](https://offdesk.dev/mac) | 一个 dmg 同时支持 Apple 芯片和 Intel，已签名并公证。可以作为 Hub。 |
| **Windows** | [offdesk.dev/windows](https://offdesk.dev/windows) | x64 `.msi`。仅作客户端。 |
| **Linux** | [offdesk.dev/linux](https://offdesk.dev/linux) | x64 `.AppImage`；`.deb` 和 `.rpm` 见 [发布页](https://offdesk.dev/desktop)。仅作客户端。 |
| **iPhone / iPad** | [加入 TestFlight](https://testflight.apple.com/join/rV4ktaGv) | 用 App 进行加密配对；浏览器可以使用 Hub 的登录链接。 |
| **Android** | [offdesk.dev/apk](https://offdesk.dev/apk) | `arm64-v8a`；不确定就选 [`/apk/universal`](https://offdesk.dev/apk/universal)。 |
| **Hub、node、CLI** | `curl -fsSL https://offdesk.dev/install \| sh` | Linux 和 macOS，x64 和 arm64。适用于 NAS、VPS 等任何没有屏幕的机器。 |

每个链接都指向该类别的最新版本。Windows 只是桌面客户端；Linux 另行安装 tmux 后也可以运行 Hub。

## 文档

- [macOS 安装与手机配对（图文指南）](https://offdesk.dev/zh/docs/mac)
- [局域网配置](docs/setup-lan.md)，以及 [通过 HTTPS、OAuth 或 Tailscale 公网访问](docs/setup-public.md)
- [App 端到端加密连接](docs/encrypted-connections.md) 和[可选的 Offdesk（offdesk.so）远程访问配置](docs/managed-connections.md)
- [localhost 网页预览](docs/web-previews.md)：需手动开启的端口转发，使用专用预览域名和 HTTPS 入口，与终端的端到端加密相互独立
- [HTML 文件预览](docs/html-file-previews.md)：在桌面或 Android App 中把机器上的 `.html` 文件作为网页打开
- [自定义终端按键](docs/terminal-keys.md)：按键布局、Shift 组合键，以及无需重新弹出系统键盘的向后删除
- [Agent 浏览器](docs/agent-browser.md)：机器上的无头 Chromium，agent 用 `offdesk browser` 操控，需要人工介入时交给你
- [从源码构建](docs/building.md) · [安全模型](SECURITY.md)
- [发布说明与版本历史](https://github.com/zalify/offdesk/releases)

## 安装

建议先看 Mac 图文安装指南：[简体中文](https://offdesk.dev/zh/docs/mac) ·
[English](https://offdesk.dev/docs/mac)。指南包含真实的 App 截图、手机配对、打开第一个终端的步骤，以及我们在全新账户上的测试范围。

装在那台一直开着的机器上——一台 Mac 或一台 NAS——它通常也是你最先想访问的那台。

**在 Mac 上：** 从 [offdesk.dev/mac](https://offdesk.dev/mac) 下载 App（已签名并公证，一个 dmg 同时支持 Apple 芯片和 Intel）。打开后它只问一个问题：这是哪台机器？选 **The one that stays on**，它会把 Hub、node 和 tmux 安装为登录时启动、意外退出后自动重启的服务，注册本机，并显示供手机扫描的二维码。App 常驻在菜单栏，手机二维码、Hub 地址和 **Add a machine** 都在那里。选 **Just connecting**，它就和手机一样，作为别处某个 Hub 的客户端。

**在 NAS、VPS 或任何没有屏幕的机器上：**

```bash
curl -fsSL https://offdesk.dev/install | sh
```

这一行命令会把三个二进制——**hub**、**offdesk-node** agent 和 **CLI**——安装到 `~/.local/bin`（支持 x64 和 arm64 上的 Linux 与 macOS），然后把 Hub 作为登录时启动、退出后自动重启的服务运行起来，把本机注册到 Hub，并打印一个可以直接登录的链接：

```
  offdesk is running at http://192.168.1.10:4317
  data: /Users/you/Library/Application Support/offdesk
  It starts at login and restarts if it stops. Logs: ~/Library/Logs/offdesk/offdesk-hub.stdout.log

  This machine is registered as "studio" and its node runs as a service
  too, so the first terminal you open is a shell right here.

  Scan this with your phone's camera (good for 15 minutes), or open the link:

    █▀▀▀▀▀█ ▀▄█ ▄ █▀▀▀▀▀█
    …

    http://192.168.1.10:4317/?token=eyJhbGciOi…
```

用手机扫码，或者在这台机器上打开链接（如果你就坐在终端前，它会自动在浏览器中打开），你就成了这个 Hub 的所有者，眼前是这台机器上的一个终端。Web UI 已经内置在二进制里，没有别的要装，也没有什么要配置。在 Mac 上，Hub 运行期间还会阻止系统闲置休眠（用 `--allow-idle-sleep` 关闭；不影响显示器和合盖）。

想再次查看链接和二维码，在那台机器的任意终端里运行：

```bash
offdesk-hub link
```

（配置好 CLI 后，`offdesk link` 效果相同；如果本机没有 Hub，它会打开远程 Hub
的地址。）

拿到这个链接的人都能登录，所以别让它出现在共享的终端里。配置 GitHub 或 Google
登录后就不再打印这个链接——一旦 Hub 能从你的网络外访问，就应该这么做：[docs/setup-public.md](docs/setup-public.md)。

链接里的地址是同一 Wi-Fi 下的手机能访问到的地址，VPN 或 TUN 模式的代理不会干扰它的判断。如果打印出的地址仍然访问不了，用 `OFFDESK_BASE_URL=http://<this machine's LAN IP>:4317` 启动 Hub。

安装脚本参数：`--no-service` 只安装二进制，之后由你自己运行同样的 `offdesk-hub service install`；`--node-only`、`--hub-only` 和 `--cli-only` 只安装其中一个二进制；`--prefix <dir>` 安装到其他目录；`--system` 安装到 `/usr/local/bin`（只有这一步会请求 sudo）。单独运行 `offdesk-hub` 会在前台运行 Hub，适合 Docker 或查看日志。想从源码构建：[docs/building.md](docs/building.md)。

### 或者用 Docker

NAS 上通常这样部署：

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

它绑定 `127.0.0.1:4317`，数据库保存在 `offdesk-data` 卷中。这里请自己设置 `JWT_SECRET`——容器自动生成的密钥会存在卷里，卷一丢，所有人都会被登出。

## 工作原理

Hub 在客户端和已注册的节点之间转发终端流量。每个节点与 Hub 保持一条出站 WebSocket 连接，并在本地运行 tmux。Hub 和承载活跃会话的节点都需要保持在线。

| 组件 | 技术 | 职责 |
| --- | --- | --- |
| Hub | Rust、Axum、SQLite | 身份验证、机器注册、终端路由、内置 Web UI |
| Node | Rust、tmux、WebSocket | 在每台 macOS 或 Linux 机器上提供持久终端 |
| Web 客户端 | React、TypeScript、xterm.js | 在浏览器中渲染交互式终端 |
| 原生 App | Tauri、共享 Web UI | 桌面/移动客户端、二维码配对、加密的原生传输 |
| CLI | Rust、JSON 输出 | 供开发者和编程 agent 使用的可脚本化终端控制 |

1. **Hub**——`offdesk-hub`。运行在那台一直开着的机器上的一个进程，旁边是 SQLite，Web UI 内置其中。它知道你所有的机器，也是客户端唯一需要知道的地址。
2. **Node**——`offdesk-node` 加上 tmux。装在每台你想访问的机器上，包括 Hub 所在的机器。它主动连接 Hub 并保持一条 WebSocket，所以机器上不需要任何入站端口或公网 IP：酒店路由器后面的笔记本和家里 NAT 后面的 NAS 会出现在同一个列表里。每个终端都是所属机器上的一个 tmux 会话，App 关了、网络断了、人走开了，它都还在。卸载 Offdesk，ssh 上去 `tmux attach`，会话依然都在。
3. **客户端**——任何和 Hub 通信的东西。浏览器标签页、iPhone 或 Android App、桌面 App、`offdesk` CLI、另一台机器上的另一个 agent。客户端从不直接接触节点；它向 Hub 请求某台机器，由 Hub 在它和 tmux 之间中转数据。所以两块屏幕可以共用一个终端：最后输入的人持有键盘，其他人实时观看。

```
      clients                   hub                       nodes
  ┌────────────────┐      ┌──────────────┐        ┌──────────────────────┐
  │ browser, phone │      │ offdesk-hub  │        │ offdesk-node         │
  │ desktop app    │◄────►│              │◄──────►│   tmux ── claude     │
  └────────────────┘  WS  │  Axum + WS   │   WS   │   tmux ── vim        │
                          │  SQLite      │        │   tmux ── htop       │
  ┌────────────────┐      │              │        └──────────────────────┘
  │  offdesk CLI   │◄────►│  control     │        ┌──────────────────────┐
  │  another agent │  WS  │  lease       │◄──────►│ offdesk-node (NAS)   │
  └────────────────┘      └──────────────┘   WS   └──────────────────────┘
```

两块屏幕共用一个终端，就是把上图画两遍：桌前的浏览器和手机都是同一个 Hub 的客户端，连在同一个 tmux 会话上。

**谁可以输入。** 桌前和手机连在同一个 tmux 会话上，看到的字节完全相同。由控制租约（control lease）决定谁可以输入：它按（用户，机器）持有，发送输入就会占用它——最后写入者获胜，没有排队。其他人照常接收输出，但他们的按键、窗口尺寸调整和图片粘贴会被丢弃：他们在实时观看，并没有断开。读取和等待从不占用租约。租约只保存在内存里，Hub 重启后不会保留。由于 tmux 以 `window-size manual` 运行，手机连上来不会改变桌前终端的尺寸。

### 添加机器

Hub 所在的机器在安装时已经注册。对于其他想访问的机器，在浏览器里打开 Hub，在机器切换器里选择 **Add a machine**（还没有任何机器的新 Hub 会自动进入这个页面）。页面上会显示一行已经填好 token 的命令：

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://192.168.1.10:4317/ws/machine --token <token>
```

把它粘贴到新机器的终端里运行。它只安装 agent，把机器注册到你的 Hub，并让 agent
作为服务持续运行——Linux 上是 systemd 用户服务，macOS 上是 launchd agent。tmux
是必需的；agent 启动时会检查，缺少就退出。

`<token>` 是注册 token：Hub 为每台新机器单独签发一个，它是把节点绑定到你的 Hub
的唯一凭据。你不用手动输入，页面显示的那行命令里已经带上了。每个 token 只能用一次，签发 24 小时后过期；下一台机器请重新生成。同一行命令也可以把机器从一个 Hub
迁到另一个 Hub；如果安装时 Hub 所在的机器仍留在它原来所属的 Hub 上，也可以用它重新注册。

手动操作的话，就是先运行 `offdesk-node register --hub-url … --token …`，再运行 `offdesk-node service install`。注册会重启已经安装的 agent 服务，新 Hub 立即生效。

`service install` 让它在重启后继续运行——Linux 上是 systemd 用户服务，macOS 上是 launchd agent。`offdesk-node start` 则在前台运行。

在 macOS 上，运行中的节点默认会阻止系统自动闲置休眠，以保持可访问。显示器仍可能关闭；合上笔记本盖子、手动选择睡眠或电量严重不足时，Mac 仍会休眠。如需关闭此行为，在 `~/Library/Application Support/offdesk/machine.json` 中加入 `"prevent_idle_sleep": false`，然后用 `offdesk-node service restart` 重启节点（前台运行的节点则停止后重新启动）。

## 两种部署方式

两种方式用的是同一套二进制，唯一的区别是：你的手机现在能不能访问到 Hub 的地址。

- **在家，离开桌前**——Hub 在你的 Mac 或 NAS 上，手机连同一个 Wi-Fi。不需要 TLS，不需要域名。→ [docs/setup-lan.md](docs/setup-lan.md)
- **出门在外**——Hub 放在 Caddy 后面的 VPS 上，或者放在家里、通过 Cloudflare
  Tunnel 暴露，或者放在你的 tailnet 里。指南按"最终谁能读到你的流量"对这几种方式做了比较。→ [docs/setup-public.md](docs/setup-public.md)

## 故障排查

- [局域网能连，但 Remote 连接显示 Unreachable](docs/troubleshooting/remote-connection.md)

## 在手机上使用

浏览器就是完整的客户端。打开 Hub 的 URL 就能用，任何手机都行。完整的终端，配一个带 Ctrl-C、Esc、Tab 和方向键的按键栏——agent 会提问，构建要按 Ctrl-C。按键排成整齐的网格：`↑` 在 `↓` 正上方，方向键、Enter 和键盘开关的位置固定不变，其余按键可以在 Settings 里重新排列（[自定义终端按键](docs/terminal-keys.md)）。

标题栏显示当前终端、它所在的机器，以及你是在控制还是在观看。点终端名打开会话切换器，新终端也从那里创建。旁边的 `[f]` 打开这台机器的文件（屏幕最窄的手机上放在 `[m]` 菜单里），`[b]` 打开 agent 浏览器，`[m]` 打开 Machines & Hub。

当其他终端里的 Claude Code 或 Codex 请求确认时，标题栏下方会出现一条提示栏列出它们。点终端可以打开它，点它的 `[enter]` 则在不离开当前视图的情况下确认当前选中的选项。如果正在等待的就是你当前所在的终端，按键栏上方会显示一张等待卡片。检测范围的限制，以及需要更新哪些组件，见[终端提醒与输入行为](docs/terminal-attention.md)。

另外还有三个打包好的客户端：

- **iPhone / iPad**——加入 [公开的 TestFlight 测试](https://testflight.apple.com/join/rV4ktaGv)。在 App 里打开 **Scan QR Code**，扫描 Hub 的加密配对码。加密连接使用 App 自带并经过签名的界面，它和桌面版、Android 版一样在线更新（0.9.2 起）；App 本身通过 TestFlight 更新。同一个版本适用于任何 Hub。手机上有两个开关可能挡住局域网里的 Hub，遇到时 App 会直接指出来：本地网络（Local
  Network），以及国行手机上的无线数据（Wireless Data）。由 `v*` 标签构建，与 Hub 一同发布。
- **Android**——从 [offdesk.dev/apk](https://offdesk.dev/apk) 下载 APK，这个地址始终指向最新的 App 构建（通用版用 `/apk/universal`）；较新的手机选 `arm64-v8a`，不确定就选 `universal`。侧载安装；它支持 App 内检查更新、剪贴板和加密配对。首次启动时扫描 Hub 显示的二维码——安装时打印在终端里的、Phone 按钮下的，或 `offdesk-hub link` 输出的——即可登录；一个 APK 适用于任何 Hub，不会把任何 Hub
  的信息编译进去。也可以手动输入地址，或粘贴登录链接。
- **桌面端**——macOS（[offdesk.dev/mac](https://offdesk.dev/mac)，已签名并公证）、Windows（[/windows](https://offdesk.dev/windows)）和 Linux
  （[/linux](https://offdesk.dev/linux)），自带自动更新。tmux 风格的标签页、显示终端由谁打开的窗格标题，以及显示哪个终端在等你的状态栏。在 Mac 上它可以作为 Hub——见 [安装](#安装)；在 Windows 和 Linux 上它是客户端，会让你填入 Hub 的链接。由 `v*` 标签构建，与 Hub 一同发布。

想自己构建其中任何一个：[docs/building.md](docs/building.md)。

### 自带 agent

Offdesk 不封装 agent，也不实现任何 agent 的协议。它把 agent 正在运行的那个终端交给你，用的是你自己的订阅、自己的配置、自己的 dotfiles。凡是能在 tmux 里运行的，在这里都能运行：Claude Code、Codex、OpenCode、Gemini CLI、Aider、vim、htop、一个要跑一小时的构建。终端访问不需要针对任何 agent 做专门集成。

在 Linux 和 macOS 上，即使 Codex 只把项目名写进终端标题，节点也能识别本地 Codex
的会话名并显示在终端列表中。这不需要改动 Codex 的任何配置。它读取的是该窗格中 Codex 进程打开的会话的元数据；如果无法确定会话，或元数据不可用，就使用普通的终端标题。

## 给 agent 用

一个 token，任何 agent 就能操控你名下的任何机器。任何脚本，或者任何机器上的任何 agent，都可以在注册到你 Hub 的任意其他机器上 **open** 一个终端，向它 **send**
按键，**wait** 它，再把内容 **read** 回来。操控的不是 agent 会话，而是终端，所以你驱动的就是你本来会亲手运行的东西。

```bash
T=$(offdesk open nas --cwd ~/projects/foo --cmd claude --json | jq -r .id)
offdesk send $T "fix the type errors in src/auth.ts; stop when tests pass"
offdesk wait $T --silence 5000 --timeout 600     # 或用 --pattern '❯' 等待提示符
offdesk read $T --lines 80                       # 取回结果
offdesk kill $T --yes
```

### 配置 CLI

安装脚本已经装好了 CLI。在 Web UI 里创建一个 API token（Settings → API tokens →
Create），然后写进配置文件：

```toml
# ~/.config/offdesk/config.toml  (chmod 600)
# macOS：~/Library/Application Support/offdesk/config.toml
url   = "https://your-hub.example.com"
token = "odk_..."
```

或者导出 `OFFDESK_URL` 和 `OFFDESK_TOKEN` 环境变量。`--url` 和 `--token` 参数的优先级高于这两者。

### 命令

```
offdesk machines [--all] [--json]               # 列出机器（默认只列在线的；--all 包括离线的）
offdesk machines rm <id|name> [--yes]           # 移除一台已注册的机器
offdesk ls [--machine <id>] [--json]            # 列出终端：id、标题、分组、cwd、尺寸、是否可达、打开者
offdesk open <machine> --cwd <dir> [--cmd <shell command>] [--group <name>] [--label <name>] [--json]
offdesk read <term> [--lines N] [--json]        # 以文本形式抓取当前屏幕
offdesk read --all [--machine <id>] [--lines N] [--json] [--concurrency N] [--include-unreachable]
                                                # 一次调用批量抓取所有终端的屏幕
offdesk send <term> <text...> [--no-enter]      # 输入文本（默认在末尾追加 Enter）
offdesk key  <term> <KEY>...                    # Enter Esc Tab BTab Up Down Left Right C-c C-d F1-F12 ...
offdesk wait <term> [--pattern <regex>] [--silence <ms>] [--timeout <sec>]
offdesk kill <term> [--yes]
offdesk layout equalize --group <name|cwd:path> [--machine <id>] [--json]
                                                # 均分一个分组的窗格；Web 客户端实时更新
offdesk layout rotate --group <name|cwd:path> [--machine <id>] [--json]
                                                # 把每个分割在左右排列和上下排列之间切换
offdesk browser open [URL] [--machine M] [--json]   # 在节点的无头 Chromium 中打开标签页；输出其 id
offdesk browser ls [--machine M] [--json]           # 列出 agent 浏览器
offdesk browser goto|snapshot|click|fill|upload|press|dialog|wait|screenshot|close <browser> ...
                                                # 操控浏览器；见 docs/agent-browser.md
offdesk browser handoff <browser> --reason "Please log in" [--wait]   # 请人来帮忙
offdesk browser wait-control <browser>          # 有人控制浏览器时阻塞等待（超时退出码为 1）
offdesk browser take <browser> --reason "..." [--force]   # 从人手里收回控制权
offdesk mcp                                     # 通过 stdio 把 agent 浏览器作为 MCP 工具提供：claude mcp add offdesk-dev -- offdesk mcp
offdesk fetch <path>... [--plain]               # 为本机文件/文件夹输出可点击下载的链接（OSC 8）；单个文件最大 20 MiB；不需要 Hub token
offdesk link [--no-open]                        # 在浏览器中打开 Hub；在 Hub 所在机器上则输出登录链接和二维码
```

- 机器和终端用 **id 前缀** 指定（`ls` 的第一列）；前缀有歧义时会列出候选项。
- CLI 打开的终端会在 App 和 `ls` 里标记为"opened by agent"，名称取自 `--label`，没有则取 API token 的名称，方便你和自己开的终端区分开。在 App 里打开的终端不带标记。
- 退出码：`0` 成功或等待条件已满足 · `1` 等待超时 · `2` 用法/配置/网络错误 ·
  `3` 因为有人正在控制浏览器，agent 浏览器命令被拒绝。所有有输出的命令都支持 `--json`。
- `--lines N` 在文本和 JSON 模式下都表示"当前屏幕渲染后的最后 N 行"（去掉末尾空行之后）；JSON 还会给出 `lines_total`（截取前的行数）和 `truncated`。
- 所有打印和序列化的输出都经过清理——去掉控制字符，保留 `\n`/`\t` 和 Unicode。可以放心通过管道交给 `jq`。
- `send` 先输入文本，再把 Enter 作为 **单独的延迟帧** 发送（150 ms 加上每个换行 60 ms，最多 800 ms），这样会把多行连续输入当作粘贴处理的 TUI 程序也能正常提交。`--no-enter` 只发送文本帧。
- `read --all --json` 默认 **只列出可达的终端**，并在顶层给出 `skipped_unreachable_count`；`--include-unreachable` 会把它们的 `{"error":"unreachable"}` 条目加回来。每个抓取到的条目都带有 `pane_title`、`title_source`（`osc`/`process`/`none`）、`foreground_process`
  （`{has_foreground_process, process_name}`，查询失败时为 null）、`activity`
  （`active`/`quiet`/`idle`）和 `idle_ms`——activity 只在抓取窗口期间观测。`cwd` 是实时的（tmux `pane_current_path`），不是创建时的目录。

### 必须了解的语义

1. **`send`/`key` 会占用控制权**（最后写入者获胜）。同一账号下的其他客户端会变成只读，直到有人重新夺回控制权。如果可能有人正在输入，先 read。CLI 在执行 `open`
   和 `kill` 时也会占用租约。
2. **`read`/`wait` 只是旁观者。** 它们从不占用控制权，也不会打扰其他客户端——tmux
   以 `window-size manual` 运行，连接上来不会改变任何人的视图尺寸。
3. **`read` 只能看到当前屏幕**，内容由 tmux attach 时的重绘重建而来，看不到回滚历史。输出很长时，让会话里的 agent 把结果写进文件，再去读那个文件。
4. **不要反复 `read` 来轮询**——每次调用都要 attach 一次，大约一秒。改用 `wait`
   等待条件满足。
5. **要总览所有终端，用 `read --all`。** 不要循环启动 N 个 CLI 进程去 `read`：那是 N×（TLS + attach）的开销，而且如果调用方没有并发读取 stdout，可能会卡死在管道缓冲区上。
6. `REACHABLE=no` 的终端属于离线机器，无法连接。`read --all` 会跳过它们，并在 stderr 和 JSON 的 `skipped_unreachable_count` 中报告数量。
7. **一个 token 就等于在每台已注册机器上远程执行代码的能力。** 每个 agent 单独签发一个，起好名字，用完后单独吊销。

## 与同类工具对比

把多台机器汇集到一处的工具，给你的是一个聊天界面；给你真正终端的工具，每台机器都要跑一个服务端。下表每一格都来自厂商自己的文档。核对于 2026-09-01；这些产品变化很快，引用前请重新核实。

| | 任意终端程序 | 每个 Hub 的机器数 | 流量经过 | agent 能否通过 CLI 操控 | 自托管 |
|---|---|---|---|---|---|
| **Offdesk** | 任何能在 tmux 里运行的程序 | 不限数量，一个 URL | 你自己的 Hub | `open` / `send` / `wait` / `read` | 是，MIT |
| Claude Code Remote Control | 否——是 Claude Code 会话，不是终端 | 多台机器的会话在一个列表里 | Anthropic 的服务器；对话记录存储在那里 | 无文档说明 | 否 |
| VibeTunnel | 是——`vt <any command>`、`vt --shell` | 每台机器一个服务端 | 自选：局域网、Tailscale、ngrok、Cloudflare | 只能启动命令；无法对运行中的会话 send/read/wait | 是，MIT |
| Happy Coder | 否——封装 `claude` 和 `codex` | 多台；`spawn --machine`、`machines` | 默认走 slopus 云端，端到端加密 | `create` / `send` / `history` / `wait` | 可选，MIT |
| Omnara | agent 会话；文档未提供原始终端 | 每个 agent 可同时使用多台 | 默认 `api.omnara.com` | CLI 和 REST：`POST .../inputs`、SSE 时间线 | 可选，Apache-2.0 |
| Orca | 是——真正的终端，支持 30 多种 CLI agent | 每台机器一个服务端；通过 SSH worktree 连到其他机器 | 默认 Orca Relay，或在局域网内直连 | `orca terminal create/send/read/wait` | 是，MIT |

每一格的出处见 [英文 README](README.md#how-it-compares)。

### 这张表说明了什么

这个领域分成两类，区别不在于好坏。

**汇集多台机器，但给你的是对话。** Claude Code Remote Control、Happy Coder 和 Omnara 都能让多台机器汇报到同一个地方。你在那里拿到的是 agent 会话，而不是终端——如果你要的就只是 agent，这个取舍是对的。

**真正的终端，但每台机器一个服务端。** VibeTunnel 和 Orca 都给你货真价实的终端。两者都是每台机器跑一个服务端：VibeTunnel 是设计如此，Orca 则是因为一个 Remote
Orca Server 只绑定一台主机，要通过 SSH 才能连到其他机器。

Offdesk 是两者的结合：离开你名下的任何一台机器，都能在手机上接着用那个真正的终端，而且经过的是你自己运行的服务端。另外五个工具都各自少了这三样中的一样——
agent、机器，或服务端。

这张表能支撑的结论只有这一个，而且比"更好"窄得多。如果你想要并行的 git
worktree、diff 审查，以及围绕 agent 的浏览器和模拟器环境，**Orca** 能做的远比 Offdesk 多，而且同样是 MIT。如果你只想用最少的配置在浏览器里打开一台机器的终端，**VibeTunnel** 要运行的东西更少。如果你只用 Claude Code 并且不想做任何配置，**Remote Control** 已经在你的 CLI 里了。

## 安全

**一个 token 就等于在每台已注册机器上远程执行代码的能力。** 它能打开终端并向其中输入，而终端能运行你的 shell 能运行的一切。请像对待 SSH 密钥那样对待它，而不是当成普通的 API key。

Hub 提供了这些手段来控制风险：

- **每个 agent 一个 token。** 每个 token 在创建时都有一个你起的名字。
- **单独吊销。** 删除一个 token 不会影响其他 token。
- **最近使用时间。** 每个 token 都会记录最后一次认证的时间，便于判断哪些还在用。
- token 以 SHA-256 哈希形式存储。明文只在创建时显示一次，之后无法找回。

Hub 打印的登录链接谁拿到谁就能登录，请像对待密码一样对待它。控制租约不是安全边界，它挡不住任何持有有效 token 的人。

威胁模型、控制租约能防住什么和防不住什么，以及 Hub 在 SQLite 中保存了哪些数据：[SECURITY.md](SECURITY.md)。

## 常见问题

**Offdesk 是 SSH 客户端吗？** Offdesk 使用自己的 Hub/node WebSocket 传输。在机器上安装 `offdesk-node`，就能通过 Hub 访问它的 tmux 会话；Offdesk 不会连接任意的 SSH
服务器。你仍然可以另外用 SSH 管理那台机器，或者连接它的 tmux 会话。

**浏览器或手机断线后，终端还在吗？** tmux 运行在节点上，所以关闭客户端或客户端断网都不会结束会话。等 Hub 和节点重新可达后，再连回同一个终端即可。主机关机或重启则不同：tmux 不会在重启后保留正在运行的进程。

**需要注册账号吗？** 自托管不需要任何厂商账号：安装时会创建一个本地用户和一个登录链接。通过托管版 Offdesk（offdesk.so）进行的可选远程访问使用单独的登录。

**我的流量会经过 offdesk.dev 吗？** 局域网直连时流量直达你的 Hub。通过 Offdesk（offdesk.so）
进行的可选远程访问会通过 `*.relay.offdesk.cloud` 下的托管地址转发加密的 App 流量。自己管理的隧道则经过对应的服务商。[加密配对](docs/encrypted-connections.md) 保护 App 与 Hub
之间的终端内容；普通的浏览器登录链接是另一种模式。

**只能用于 Claude Code 吗？** 它就是一个终端。Claude Code、Codex、OpenCode、一个要跑一小时的构建，或者 vim——只要能在 tmux 里运行，在这里就能运行，Offdesk 并不知道、也不关心你跑的是什么。

**iPhone 呢？** 有 App，目前通过 TestFlight 分发——见[在手机上使用](#在手机上使用)。不装 App 的话，浏览器就是完整的客户端：用相机扫 Hub 的二维码，再把页面添加到主屏幕。Android 也有 App。加密配对码请用 App 内的扫码功能扫描；通过浏览器连接时，使用普通的登录链接。

**两个人同时输入会怎样？** 由控制租约决定谁可以输入。发送输入就会占用它——最后写入者获胜，没有排队。其他人照常接收输出，所以他们是在实时观看，而不是被断开。

## 社区

问题和配置交流请到 [Discord](https://discord.gg/aFUu6VMzc)；bug 请提交到 GitHub
[issues](https://github.com/zalify/offdesk/issues)。

## 许可证

`crates/` 下的全部代码（Hub、node、CLI、协议和加密 crate）以及 `packages/shared` 采用 MIT 许可证。Web UI（`packages/app`）和桌面端、Android、iOS App（`packages/desktop`）采用 Functional Source License（FSL-1.1-MIT）：可以阅读、审计、编译、修改和使用（包括在工作中使用），但不能拿来做竞品，每个版本发布两年后自动转为 MIT。0.25.0 及以前的版本全部是 MIT。见 [LICENSE](LICENSE) 和 [TRADEMARKS.md](TRADEMARKS.md)。可选的托管版 Offdesk 服务（offdesk.so）单独维护，不包含在本仓库中。
