import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const zh: Dict = {
  chrome: {
    skip: "跳到正文",
    homeLabel: "Offdesk Dev 首页",
    navLabel: "主导航",
    nav: {
      download: "下载",
      how: "工作原理",
      away: "远程访问",
      docs: "文档",
      cli: "CLI",
    },
    discordLabel: "Offdesk 的 Discord",
    githubLabel: "Offdesk 的 GitHub",
    language: "语言",
    languageLabel: "语言：{name}。选择其他语言",
    footer: {
      madeBy: "由 {zalify} 打造",
      tagline: "自托管远程终端",
      gettingStarted: "入门",
      tunnel: "隧道指南",
      security: "安全",
      releases: "发布说明",
    },
    copy: "[复制]",
    copied: "[已复制]",
    copyFailed: "[按 ⌘C]",
  },

  home: {
    title: "Offdesk — 你和 Agent 共用同一个终端",
    description:
      "你和 AI 编程 Agent 共用同一个终端：Agent 通过 CLI 打开、输入、读取，你在手机上看着同一个终端，需要时接管键盘。自托管远程终端，支持 Claude Code、Codex 和 tmux 里的任何程序，Hub 以 MIT 开源。",
    hero: {
      title: "你和 Agent，共用一个终端。",
      lead: "Agent 通过 CLI 打开终端、输入命令、读取输出。你在手机上看着同一个终端，需要你时接管键盘。",
      downloadMac: "下载 Mac 版",
      allDownloads: "全部下载",
      copyInstallLabel: "复制安装命令",
      note: "Mac App 已签名并经过公证，支持 Apple silicon 和 Intel。一行命令即可在 macOS 或 Linux 上安装 Hub。",
      figcaption: "示意图：一个终端，由 Agent 用 CLI 打开，同时在手机上查看。",
    },
    proofLabel: "一览",
    // Offdesk's own row of the comparison table further down.
    proof: [
      { key: "任意程序", value: "tmux 里能跑的都行" },
      { key: "机器", value: "任意数量，一个网址" },
      { key: "流量", value: "经过你自己的 Hub" },
      { key: "Agent", value: "open · send · wait · read" },
      { key: "许可", value: "自托管，Hub MIT" },
    ],
    beats: {
      title: "谁需要键盘，谁就接过去。",
      items: [
        {
          label: "01 / Agent",
          title: "Agent 打开终端",
          body: "一条命令，就能在你任何一台机器的终端里启动 Claude Code、Codex 或别的程序。所有人都走开了，它也照样运行。",
        },
        {
          label: "02 / 你",
          title: "你看着同一个终端",
          body: "不是对话记录，而是实时终端，在手机、笔记本或浏览器上都能看。它停下来提问时，你马上就能看到。",
        },
        {
          label: "03 / 任一方",
          title: "接管控制，再交回去",
          body: "按 Enter 回答，或者直接接管键盘。Agent 的浏览器也一样：替它登录，再交还给它。",
        },
      ],
    },
    start: {
      title: "三步打开你的第一个终端。",
      steps: [
        {
          label: "第 1 步",
          title: "在 macOS 或 Linux 上安装 Hub",
          body: "打开 Mac App，说明这是常开的那台机器，它就成了你的 Hub：登录时自动运行，停止后自动重启。自托管不需要任何厂商账户。在 NAS 或没有屏幕的服务器上，一行命令也能做到：",
        },
        {
          label: "第 2 步",
          title: "配对手机，或从浏览器登录",
          body: '选择 Offdesk App，生成供 App 内扫描器读取的加密配对码；选择 Browser access，获取浏览器登录链接。两者都在 Mac 菜单栏里，也可以运行 <span class="inline-code">offdesk link</span> 获取浏览器访问链接。',
        },
        {
          label: "第 3 步",
          title: "重新连上同一个 tmux 会话",
          body: "和桌前是同一个 tmux 会话，实时同步。让 Hub 保持唤醒和在线。tmux 里能跑的，这里都能跑。",
        },
      ],
      readGuide: "阅读 Mac 教程",
      iphone: "iPhone App",
      android: "Android App",
      orBrowser: "或手机上的任何浏览器",
    },
    download: {
      title: "桌面、手机和网页客户端。",
      lead: "桌面 App 在 Mac 上就是 Hub，在其他地方都是客户端。手机 App 封装的是浏览器里显示的同一个终端。",
      mac: {
        body: "一个 dmg 同时支持 Apple silicon 和 Intel。使用 Developer ID 签名并经过公证，打开方式和 App Store 里的应用一样。在常开的那台 Mac 上它就是你的 Hub，在其他地方它是客户端。",
        button: "下载 .dmg →",
        meta: "macOS 11 或更高版本 · 通用 · .dmg",
      },
      windows: {
        body: "一个客户端：打开别处 Hub 上的终端。粘贴 Hub 输出的链接，或者登录。Windows 机器不能当 Hub，因为 Hub 需要 tmux。",
        button: "下载 .msi →",
      },
      linux: {
        body: "和 Windows 一样是客户端。要让 Linux 机器当 Hub，请用一行命令安装：它会把 Hub 作为服务运行。",
        button: "下载 .AppImage →",
        meta: "x64 · .AppImage · .deb 和 .rpm 见{release}",
        release: "发布页面",
      },
      iphone: {
        body: "通过 TestFlight 提供。在 iPhone 或 iPad 上打开邀请，安装 App，然后选择 Scan QR Code 连接你的 Hub。",
        button: "加入测试 →",
      },
      android: {
        body: '需侧载安装的 APK。新款手机选 <span class="inline-code">arm64-v8a</span>，不确定就选<a href="/apk/universal">通用版</a>。',
        button: "下载 APK →",
      },
      cli: {
        title: "Hub、Node 和 CLI",
        body: "三个二进制文件，适用于 NAS、VPS 或任何没有屏幕的机器。支持 Linux 和 macOS，x64 和 arm64。",
      },
    },
    how: {
      title: "Rust Hub。出站 WebSocket。持久 tmux。",
      items: [
        {
          title: "Hub",
          body: "基于 Axum 的 Rust 服务器，使用 SQLite 存储，内嵌 Web 界面。它为客户端做身份验证，并把终端流量路由到你的 macOS 和 Linux Node。可以安装二进制文件，也可以用 Docker 部署。",
        },
        {
          title: "Node",
          body: "装在每台你想访问的机器上。它通过 WebSocket <em>主动向外</em>连接 Hub，所以 Node 不需要入站端口，也不需要公网 IP。每个终端都是所在机器上的一个 tmux 会话：App 关了、网络断了、你走开了，它都还在。卸载 Offdesk，它也还在。",
        },
        {
          title: "客户端",
          body: "React 和 xterm.js 在浏览器里渲染交互式终端。Tauri App 在桌面和手机上提供原生的加密配对。Rust CLI 提供可脚本化的访问。客户端通过 Hub 共享终端输出；由控制租约决定谁能输入。",
        },
      ],
      note: "两个屏幕看同一个终端，就是同一个 Hub 的两个客户端，连接到同一个 tmux 会话。客户端断开不会终止 Node 上的会话。Offdesk 使用自己的 Hub/Node 传输，而不是 SSH：在每台想访问的机器上安装 offdesk-node。",
    },
    away: {
      title: "在局域网自托管，需要时再加远程访问。",
      body: [
        "在 macOS、Linux、NAS 或 VPS 上运行开源的 Hub。Node 主动向外连接这个 Hub；终端会话留在运行 tmux 的机器上。Hub 和这些机器都需要保持唤醒和在线。",
        `在 Hub 旁边运行 cloudflared，无需在路由器上开端口就能提供一个 HTTPS 地址，在 NAT 或 CGNAT 后面也可以。配置你的域名和隧道入口规则，或者用 <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> 在你的各台设备之间私密访问 Hub。`,
        `已配对的 Offdesk App 会在 App 和 Hub 之间对终端流量做端到端加密，经过隧道时也一样。普通浏览器访问使用 HTTPS 和它自己的身份验证，HTTPS 由隧道服务商终止；它不会自动获得 App 的加密。参见<a href="${repo}/blob/main/docs/encrypted-connections.md">加密连接指南</a>。`,
      ],
      tunnelGuide: "隧道指南",
      lanSetup: "局域网设置",
      pairing: "App 加密配对",
      cloudSetup: "Cloud 设置",
      homeTitle: "# 在家里的机器上",
      homeBody:
        '在 Cloudflare 控制台创建隧道，指向 <span class="inline-code">server:4317</span>，把它的 token 放进 <span class="inline-code">.env</span>，然后：',
      copyTunnelLabel: "复制隧道命令",
      homeAfter:
        "要用 App 加密访问，用 App 的扫描器扫描加密配对码。要用普通浏览器访问，按隧道指南配置身份验证。",
      cloudBadge: "邀请制测试",
      cloudBody:
        "可选的 Offdesk Cloud 提供托管的远程访问。它的服务是闭源的；公开仓库里的 Hub、Node 和 CLI 采用 MIT 许可，Web UI 和各端 App 以 FSL-1.1-MIT 公开源码。本地连接器会检查加密连接是否可达，隧道持续失败时会自动退避重试。本地使用不需要 Cloud 账户。",
    },
    more: {
      title: "远程 Shell、手机上的编程 Agent，以及 CLI 自动化。",
      machines: {
        title: "管理 macOS 和 Linux 终端",
        body: "NAS、VPS、笔记本。打开 Hub，选择 <strong>Add a machine</strong>，它会给你一行带 token 的命令。在那台机器上粘贴运行，它就出现了。",
      },
      agents: {
        title: "任何 Agent 都能用",
        body: "Offdesk 不封装 Agent，也不对接它的协议。它把 Agent 本来就在运行的那个终端交给你：你的订阅、你的配置、你的 dotfiles。",
        anyCli: "任何 CLI",
      },
      phone: {
        title: "在手机上用 Claude Code 和 Codex",
        body: [
          `自定义按键栏：Esc、Tab、Shift+Tab、Shift 组合键，以及可按住连删的 Backspace。方向键、Enter 和键盘开关固定不变；其他按键可以在设置里隐藏或调整顺序。<a href="${repo}/blob/main/docs/terminal-keys.md">配置终端按键</a>。App 还提供二维码扫描和端到端加密连接。`,
          `等待横幅让你不离开当前画面，就能打开另一个终端的确认请求，或向它当前的选项发送 Enter。<a href="${repo}/blob/main/docs/terminal-attention.md">了解确认快捷操作</a>。`,
          "<strong>iPhone 和 iPad：</strong>通过下面的链接加入公开的 TestFlight 测试。App 更新由 TestFlight 负责。",
        ],
        android: "Android APK",
        universal: "通用版",
        iphone: "iPhone · TestFlight",
        heroAlt: "桌前的机器上运行着 Claude Code，同时一部手机连接着同一个 tmux 会话",
        iosAlt: "Offdesk iPhone App 里的 Claude Code，连接着家里的 Mac",
        stillAlt: "手机上的 Offdesk 终端：家里 Mac 上的 Claude Code，从手机浏览器连接",
        caption: "持久远程 tmux 会话里的 Claude Code。",
      },
    },
    cli: {
      title: "用 Offdesk CLI 自动化远程终端。",
      lead: "用 open、send、wait 和 read 命令，从 Shell 脚本或 AI 编程 Agent 控制远程 tmux 会话。JSON 输出让脚本可以拿到终端 ID，在步骤之间传递结果。Agent 打开的终端会标记为由 Agent 打开，方便和你自己的区分。",
      body: `一个 token 就等于能在你注册的每台机器上远程执行代码。每个 Agent 单独发一个，起个名字，可以单独吊销。<a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "复制示例",
    },
    compare: {
      title: "横向对比",
      note: "每一格都来自该项目自己的文档，于 2026 年 9 月 1 日核对。来源列在 README 中同一张表格的下方。",
      project: "项目",
      columns: [
        "任意终端程序",
        "每个 Hub 的机器数",
        "流量经过",
        "Agent 能否通过 CLI 驱动",
        "自托管",
      ],
      // One row per project, in the order of the table in the template; names
      // stay in English and live in the template.
      rows: [
        ["tmux 里能跑的都行", "任意数量，一个网址", "你自己的 Hub", "open / send / wait / read", "是，MIT + FSL"],
        ["否：是 Claude Code 会话，不是终端", "多台机器的会话在同一个列表里", "Anthropic 的服务器；对话记录存储在那里", "文档未说明", "否"],
        ["是：vt &lt;任意命令&gt;、vt --shell", "每台机器一个服务器", "自选：局域网、Tailscale、ngrok、Cloudflare", "只能启动命令", "是，MIT"],
        ["否：封装 claude 和 codex", "多台；spawn --machine", "默认经 slopus 云，端到端加密", "create / send / history / wait", "可选，MIT"],
        ["Agent 会话；文档未提及原始终端", "每个 Agent 可同时连多台", "默认经 api.omnara.com", "CLI 和 REST", "可选，Apache-2.0"],
        ["是：真实终端，支持 30+ CLI Agent", "多台，通过 SSH worktree 和 orca serve", "默认经 Orca Relay，或在局域网内直连", "orca terminal create/send/read/wait", "是，MIT"],
      ],
    },
    close: {
      title: "今晚就搭好你的 Hub。",
      lead: "在 macOS 或 Linux 上安装 Hub，注册你的机器，然后从浏览器或手机打开持久的 tmux 会话。",
      iphone: "iPhone App",
      android: "Android App",
    },
  },

  tunnel: {
    title: "Offdesk 搭配 Cloudflare Tunnel",
    description:
      "无需开放端口，从任何地方访问家里的 Offdesk Hub：完整的 Cloudflare Tunnel 内网穿透设置指南。",
    heading: "使用 Cloudflare Tunnel",
    lead: "适用于放在 NAS 或家里台式机上的 Hub。<code>cloudflared</code> 运行在 Hub 旁边，<em>主动向外</em>连接 Cloudflare，再由 Cloudflare 通过 HTTPS 提供你的域名。不用端口转发，不用动态 DNS，不用续期证书，而且在 CGNAT 后面也能用，那种环境下连端口转发都做不到。",
    intro: `对于普通浏览器连接，Cloudflare 会终止 HTTPS，能读取终端流量。App 加密配对在 App 和 Hub 之间加了一层加密，因此隧道里传的是加密后的终端内容。这种模式请参照<a href="${repo}/blob/main/docs/encrypted-connections.md">加密连接指南</a>。你也可以改用 <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a>：同样的二进制文件，中间没有第三方。`,
    needDomain: "你需要一个托管在 Cloudflare 账户上的域名。免费套餐就够了。",
    create: {
      title: "1. 创建隧道",
      body: "Cloudflare Zero Trust 控制台 → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>。起个名字，然后复制它显示的 token，也就是安装命令里 <code>--token</code> 后面那串长字符串。这个 token 是凭据：任何人拿到它，都能以你的隧道的身份提供流量。",
      hostname: "给隧道添加一个公共主机名：",
      field: "字段",
      value: "值",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> 是 Hub 在 <code>docker-compose.yml</code> 里的服务名，<code>cloudflared</code> 就是靠它通过 compose 网络访问 Hub。从 Cloudflare 到你机器的这一段在隧道里；从 <code>cloudflared</code> 到 Hub 的这一段不会离开 Docker 网络，所以这里用明文 HTTP 没问题。",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>docker-compose.yml</code> 旁边的 <code>.env</code>：",
      // Placeholders inside the .env example; the angle brackets are added
      // by the template.
      secretPlaceholder: "openssl rand -hex 32 的输出",
      tokenPlaceholder: "第 1 步得到的 token",
      oauth: `放在互联网上的 Hub 通过 GitHub 或 Google 登录。按照 <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">VPS 指南</a>原样注册 OAuth 回调 URL：Hub 根据 <code>OFFDESK_BASE_URL</code> 生成它们，用隧道也不会改变这一点。然后：`,
      profile:
        "<code>tunnel</code> profile 负责启动 <code>cloudflared</code>；不加它，就只有 Hub 本身，并且仍然只绑定在 <code>127.0.0.1:4317</code>。确认两者都已启动：",
    },
    machines: {
      title: "3. 机器",
      body: "在浏览器里打开 Hub，选择 <strong>Add host</strong>：它会显示一行已填好注册 token 的命令。在你想访问的机器上运行：",
      after:
        "与 Hub 在同一局域网的机器，流量仍会绕到 Cloudflare 再回来。如果你介意，可以改用 Hub 的局域网地址注册它：机器上的 Node 只需要能访问 Hub，并不在乎你的手机用另一个名字访问同一个 Hub。",
    },
    notes: {
      title: "注意事项",
      items: [
        "<strong>任何找到这个 URL 的人都能登录</strong>，和 VPS 方案一样：任何 GitHub 或 Google 账户都能在你的 Hub 上创建账户，没有白名单。Cloudflare Access 可以在整个主机名前面再加一道登录，但所有不是浏览器的客户端，比如 <code>offdesk-node</code>、CLI、Android App，都需要各自的 Access 服务令牌，而机器上的 Node 没有地方放这个令牌。要么把 Access 策略限定在浏览器路径上，要么不用它，依靠 Hub 自己的登录。",
        "<strong>WebSocket 长连接没问题。</strong>机器上的 Node 每 30 秒发一次 ping，浏览器在应用层发 ping，所以路径上的空闲超时不会悄悄断开终端。",
        "<strong>不要用 quick tunnel</strong>（<code>cloudflared tunnel --url</code>，即 <code>*.trycloudflare.com</code> 主机名），除非只是演示。主机名每次重启都会变，你的 OAuth 回调 URL、每台已注册的机器，以及保存了旧地址的手机都会因此失效。",
      ],
    },
    others: `另外两种方式，即 Caddy 后面的 VPS 和 Tailscale，以及三者之间的取舍，见 <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>。`,
  },

  mac: {
    title: "从一台 Mac 开始使用 Offdesk",
    description: "通过真实 App 截图，完成 Mac 首次安装、打开终端和手机扫码连接。",
    eyebrow: "入门教程 · macOS",
    lead: "把常开着的 Mac 变成主机，然后用手机连接它的终端。第一次先在同一局域网内完成连接。",
    preview: "截图版本说明",
    previewText:
      "配图来自 Mac Mini 上的 0.6.4-rc.1 实测。当前正式版已更新手机配对和 Cloud 引导；以下文字对应新版，旧截图保留当时的 RC 标识和布局。配对页现在通过 Offdesk App / Browser access 两个选项切换用途，下面的下载按钮提供正式版。",
    download: "下载 Mac 正式版",
    phone: "下载手机 App",
    contents: "本页步骤",
    stepLabel: "第 {n} 步",
    openScreenshot: "打开完整截图",
    before: "开始之前",
    needs: [
      "一台保持开机、联网的 Mac，以及它的登录账户。",
      "手机和 Mac 位于同一个局域网：例如 Mac 接路由器网线，手机连接同一路由器的 Wi-Fi。",
      "手机安装 Offdesk：iPhone / iPad 使用 TestFlight，Android 使用官网 APK。",
    ],
    terms:
      "Hub 是管理连接的主机；Node 让这台机器的终端可用。选择将 Mac 作为 Hub 后，App 会一并安装它们。正常的 App 安装流程不需要额外运行 install.sh，也不需要 Docker。",
    // Each step's title starts with its number, "1. …": the template splits
    // it into the step label and the heading.
    steps: {
      install: {
        title: "1. 下载并安装 Mac App",
        body: "从官网的 <a href='/mac'>Mac 下载入口</a>获取安装包，打开 DMG，将 Offdesk Dev 拖入 Applications，再从安装位置打开 App。不要一直从磁盘映像中运行它。",
        extra:
          "如果你使用标准账户，写入系统 Applications 可能需要管理员密码；也可以安装到自己用户目录下的 Applications 文件夹。截图里的 RC 是测试版名称。",
        alt: "Mac 的 DMG 窗口，包含 Offdesk RC App 和 Applications 文件夹入口。",
        caption: "把 App 拖入 Applications，再打开安装后的副本。",
      },
      choose: {
        title: "2. 选择这台 Mac 作为主机",
        body: "首次打开时，找到 <strong>Which machine is this?</strong>，选择 <strong>The one that stays on → Set this machine up</strong>。这表示你希望手机访问这台 Mac 上的终端。",
        extra:
          "只有已经在别处设置过 Hub、现在仅想从这台 Mac 访问它时，才选 <strong>Just connecting</strong>。首次使用不需要先创建账户。",
      },
      ready: {
        title: "3. 等待 Mac 准备完成",
        body: "新版引导会逐项检查下面四件事。让 App 完成检查，再连接手机；不要因为已经看到一个地址就认为安装完成了。",
        checks: [
          "Hub 已启动并可以响应。",
          "这台 Mac 已注册到 Hub。",
          "本机 Node 已上线。",
          "终端工具 tmux 可用。",
        ],
        extra:
          "完成后会出现 <strong>Connect your phone</strong>，再点击 <strong>Pair an encrypted device</strong> 生成配对码。如果检查失败，使用页面上的重试按钮。如果 macOS 询问是否允许 Offdesk Dev 的入站连接，在你要让手机连接的这台 Mac 上允许它。",
      },
      terminal: {
        title: "4. 打开第一个终端",
        body: "点 <strong>Open my terminal</strong>。如果看到 <strong>No terminals yet</strong>，先查看右上角是否是 <strong>Watching / Viewing</strong>：点击它接管控制，再点 <strong>Start terminal</strong>。如果别的设备正在控制终端，先确认自己确实要接管。",
        extra:
          "在终端输入下面这行并按 Enter，应当看到同样的文字返回。此时运行命令的是 Mac，不是手机。",
        alt: "Offdesk 在测试用户的 Mac 终端运行 echo hello from offdesk，并返回 hello from offdesk。",
        caption: "实际终端输入和输出。右上角的控制状态决定能否创建终端或输入。",
      },
      phone: {
        title: "5. 在手机 App 里扫码",
        body: "在 Mac App 中点击 <strong>Phone</strong> 或 <strong>Show me</strong>，打开配对页。选择 <strong>Offdesk App · Recommended</strong>，点击 <strong>Pair an encrypted device</strong>，再用手机 Offdesk 连接首页的 <strong>Scan QR Code</strong> 扫描新生成的加密配对码。按提示允许使用相机。",
        extra:
          "<strong>Browser access</strong> 选项提供浏览器登录码，手机系统相机可以用浏览器打开。<strong>Offdesk App</strong> 选项生成的加密配对码只供 App 内扫描器读取。一次只选一种用途，不需要扫两个码。配对码过期后，在 Mac 上重新生成。",
        alt: "Mac 上的手机连接弹窗，包含局域网地址、手机 App 下载入口和加密配对按钮；二维码及登录链接已遮挡。",
        caption: "旧版截图的二维码和登录链接已隐藏。0.7.1 中先选择 Offdesk App，再生成自己的配对码。",
        after:
          "配对后，应能看到这台 Mac 和已创建的终端。若没有终端可选，先按上一步在 Mac 创建一个。测试时在手机输入一条简单命令，再退出重开手机 App，确认仍能连接。",
      },
      return: {
        title: "6. 离开 App，再回来",
        body: "退出 Mac App 后，Hub 和 Node 服务仍在后台运行；重新打开 App，可以回到之前的终端。关闭 App 与让电脑休眠、关机或退出 macOS 账户不是同一回事。",
        extra:
          "保持 Mac 开机、登录且联网。局域网地址只适合当前网络；要在外面使用，之后再配置远程连接。这里的扫码步骤本身不会让局域网地址变成公网地址。",
      },
      cloud: {
        title: "7. 可选：通过 Offdesk Cloud 在外面连接",
        body: "Cloud 当前为邀请制测试服务。在 <a href='https://offdesk.so'>Cloud 控制台</a>登录并兑换邀请码，再回到 Mac 的 <strong>Set up remote access</strong>，按步骤登录、核对电脑授权信息。Cloud 地址就绪后，再通过 Offdesk App 模式配对手机。",
        extra:
          "验证完整新用户流程时，请从官网安装最新 macOS 和 Android 正式版。iOS 通过 TestFlight 分发；测试组中的可用版本以 TestFlight 显示为准。Cloud 完成后关闭手机 Wi-Fi，用蜂窝网络确认终端可连接；Mac 必须保持在线。已配对手机可从顶部标题打开 <strong>Hub &amp; connection</strong>。局域网使用可跳过 Cloud 和邀请码。",
      },
    },
    trouble: "如果界面和教程不一样",
    faqs: [
      [
        "看到 Connect a machine / Generate a token",
        "这说明 Hub 里还没有可用机器，不代表手机应该成为主机。先回到 Mac 检查本机是否已完成设置。旧版 0.6.3 的手动恢复方式是：在这台 Mac 的页面点 Generate a token，把生成的整条命令放到这台 Mac 的系统终端执行。这是旧版故障的恢复方式，不是正常安装的必做步骤。",
      ],
      [
        "扫码后进入登录页，或只输入 IP 无法登录",
        "单独的 IP 地址不包含登录信息。普通登录要使用完整登录链接或它对应的二维码；加密配对则使用 App 内扫描器和加密配对码。不要在群聊里分享完整链接或二维码。",
      ],
      [
        "手机连接不上或出现空白页",
        "确认两台设备确实在同一局域网，二维码选择了手机能访问的网络地址；访客 Wi-Fi 可能隔离设备。先在 Mac 确认终端可用，再检查手机的局域网权限。若扫描后黑屏，退出并重新打开 App，记录 App 版本、手机型号及发生步骤；这不应当是每次连接的必需操作。",
      ],
    ] as [string, string][],
    tested: "这篇教程实际验证到了哪一步？",
    testedIntro:
      "2026 年 9 月 7 日，在 Mac Mini 的新建标准账户 offdesk-test 中测试；该账户没有 Offdesk 配置或服务，未预先执行安装脚本。它不是整台机器恢复出厂设置。9 月 10 日又在同一测试账户中备份并重置 App / Hub 配置，验证 0.7.1-rc.1 的自动设置、加密配对码生成、终端输入和重开恢复。该复测保留了系统工具、浏览器状态和旧 tmux 会话。",
    passed: [
      "下载 DMG、拖入用户 Applications、从 Finder 打开。",
      "App 自动安装 Hub / Node，完成注册、上线和 tmux 检查，再显示二维码。",
      "真实终端命令输入输出。",
      "退出重开 App 后保留终端；单独重启测试 Hub 后重新连接。",
    ],
    pending:
      "本轮尚未完成：手机真机扫码与冷启动、测试账户注销重登，以及正式签名公证包的 Gatekeeper 验收。RC 通过了用户授权的首次运行，不能据此宣称正式安装包验证通过。",
    known:
      "测试中也确认了 Watching 状态会隐藏 Start terminal 按钮的引导问题，因此第 4 步明确写出了接管控制的操作。",
    next: "接下来",
    nextText: "先确认同一局域网内使用顺畅，再阅读加密连接和远程访问说明。",
    encryption: "端到端加密说明",
    lan: "局域网排查",
    allDocs: "所有技术文档",
  },
};

export default zh;
