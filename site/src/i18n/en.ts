// English, the source language. Its shape is the type every other
// dictionary must match: a missing, extra or renamed key is a type error, and
// src/i18n/index.ts also checks the shape when the site builds.
//
// Every string shown as page text is HTML and may contain inline markup
// (<a>, <strong>, <em>, <code>, <span class="inline-code">), so a literal "<"
// is written &lt;. Strings used as attributes or metadata (title,
// description, *Label, *Alt, alt) and the .env placeholders are plain text. Placeholders in {braces} are filled in
// by the template. Commands, flags, paths, code and product names stay in
// English in every language.

const repo = "https://github.com/zalify/offdesk";

const en = {
  chrome: {
    skip: "skip to content",
    homeLabel: "Offdesk Dev home",
    navLabel: "Main",
    nav: {
      download: "download",
      how: "how-it-works",
      away: "remote-access",
      docs: "docs",
      cli: "cli",
    },
    discordLabel: "Offdesk on Discord",
    githubLabel: "Offdesk on GitHub",
    language: "language",
    languageLabel: "Language: {name}. Choose another language",
    footer: {
      madeBy: "made by {zalify}",
      tagline: "self-hosted remote terminal",
      gettingStarted: "getting started",
      tunnel: "tunnel guide",
      security: "security",
      releases: "release notes",
    },
    copy: "[copy]",
    copied: "[copied]",
    copyFailed: "[press ⌘C]",
  },

  home: {
    title: "Offdesk — One terminal, shared by you and your agents",
    description:
      "One terminal, shared by you and your agents. Agents open, type into and read terminals through the CLI; you watch the same ones from your phone and take the keyboard when they need you. Self-hosted remote terminal for Claude Code, Codex and anything in tmux. MIT licensed.",
    hero: {
      title: "One terminal, shared by you and your agents.",
      lead: "Agents open, type into and read terminals through the CLI. You watch the same ones from your phone, and take the keyboard when they need you.",
      downloadMac: "download for mac",
      allDownloads: "all downloads",
      copyInstallLabel: "Copy the install command",
      note: "The Mac app is signed and notarized, for Apple silicon and Intel. The one-liner installs the hub on macOS or Linux.",
      figcaption: "An illustration: one terminal, opened by an agent with the CLI and watched from a phone.",
    },
    proofLabel: "At a glance",
    // Offdesk's own row of the comparison table further down.
    proof: [
      { key: "any-program", value: "anything that runs in tmux" },
      { key: "machines", value: "any number, one url" },
      { key: "traffic", value: "through your own hub" },
      { key: "agents", value: "open · send · wait · read" },
      { key: "license", value: "self-hosted, MIT" },
    ],
    beats: {
      title: "Whoever needs the keyboard takes it.",
      items: [
        {
          label: "01 / agent",
          title: "your agent opens it",
          body: "One command starts Claude Code, Codex or anything else in a terminal on any machine you own. It keeps running when everyone walks away.",
        },
        {
          label: "02 / you",
          title: "you watch the same one",
          body: "Not a transcript: the live terminal, on your phone, laptop or a browser. When it stops to ask, you see it.",
        },
        {
          label: "03 / either",
          title: "take control, hand it back",
          body: "Answer with Enter, or take the keyboard. In the agent's browser too: sign in for it, then hand it back.",
        },
      ],
    },
    start: {
      title: "Your first terminal in three steps.",
      steps: [
        {
          label: "step 1",
          title: "Install the hub on macOS or Linux",
          body: "Open the Mac app, say this is the machine that stays on, and it becomes your hub: runs at login, restarts if it stops. Self-hosting needs no vendor account. On a NAS or a server with no screen, one line does the same:",
        },
        {
          label: "step 2",
          title: "Pair your phone or sign in from a browser",
          body: 'Choose Offdesk App to generate an encrypted pairing code for the in-app scanner. Choose Browser access for a browser sign-in link. Find both in the Mac menu bar, or run <span class="inline-code">offdesk link</span> for browser access.',
        },
        {
          label: "step 3",
          title: "Reconnect to the same tmux session",
          body: "Same tmux session as the desk, live. Keep the hub awake and online. Anything that runs in tmux runs here.",
        },
      ],
      readGuide: "read the mac guide",
      iphone: "iphone app",
      android: "android app",
      orBrowser: "or any browser on the phone",
    },
    download: {
      title: "Clients for desktop, phone and the web.",
      lead: "The desktop app is the hub on a Mac, and a client everywhere. The phone apps wrap the same terminal the browser shows.",
      mac: {
        body: "One dmg for Apple silicon and Intel. Signed with a Developer ID and notarized, so it opens like anything from the App Store. On the Mac that stays on it becomes your hub; anywhere else it is a client.",
        button: "download .dmg →",
        meta: "macOS 11 or later · universal · .dmg",
      },
      windows: {
        body: "A client: it opens the terminals on a hub somewhere else. Paste the link the hub printed, or sign in. A Windows machine cannot be the hub, which needs tmux.",
        button: "download .msi →",
      },
      linux: {
        body: "A client, as on Windows. For a Linux box that should be the hub, the one-line install is the way: it runs the hub as a service.",
        button: "download .AppImage →",
        meta: "x64 · .AppImage · .deb and .rpm on {release}",
        release: "the release page",
      },
      iphone: {
        body: "Available through TestFlight. Open the invitation on your iPhone or iPad, install the app, then choose Scan QR Code to connect to your hub.",
        button: "join the beta →",
      },
      android: {
        body: 'An APK to sideload. Take <span class="inline-code">arm64-v8a</span> on a modern phone, <a href="/apk/universal">universal</a> if unsure.',
        button: "download apk →",
      },
      cli: {
        title: "Hub, node and CLI",
        body: "The three binaries, for a NAS, a VPS, or any machine without a screen. Linux and macOS, x64 and arm64.",
      },
    },
    how: {
      title: "Rust hub. Outbound WebSockets. Persistent tmux.",
      items: [
        {
          title: "hub",
          body: "A Rust server built with Axum, SQLite storage, and an embedded web UI. It authenticates clients and routes terminal traffic to your macOS and Linux nodes. Install a binary or deploy with Docker.",
        },
        {
          title: "node",
          body: "On every machine you want to reach. It dials <em>out</em> to the hub over WebSocket, so the node needs no inbound port or public IP. Every terminal is a tmux session on the machine that owns it: it outlives the app, the network, and you walking away. Uninstall Offdesk and it's still there.",
        },
        {
          title: "client",
          body: "React and xterm.js render the interactive terminal in the browser. Tauri apps add native encrypted pairing on desktop and mobile. The Rust CLI provides scriptable access. Clients share terminal output through the Hub; a control lease determines who can type.",
        },
      ],
      note: "Two screens on one terminal are two clients of one hub, attached to one tmux session. Client disconnects do not terminate the session on the node. Offdesk uses its own Hub/node transport, not SSH: install offdesk-node on each machine you want to reach.",
    },
    away: {
      title: "Self-host on your LAN. Add remote access when you need it.",
      body: [
        "Run the open-source Hub on macOS, Linux, a NAS, or a VPS. Nodes connect outbound to that Hub; terminal sessions stay on the machines running tmux. Your Hub and those machines must remain awake and online.",
        `Run cloudflared next to your Hub to expose an HTTPS endpoint without opening a router port, including behind NAT or CGNAT. Configure your domain and tunnel ingress, or use <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> for private access to the Hub across your devices.`,
        `Paired Offdesk Apps encrypt terminal traffic end to end between the App and Hub, including through a tunnel. Ordinary browser access uses HTTPS and its own authentication, which the tunnel provider terminates; it does not automatically gain App encryption. See the <a href="${repo}/blob/main/docs/encrypted-connections.md">encrypted connection guide</a>.`,
      ],
      tunnelGuide: "the tunnel guide",
      lanSetup: "lan setup",
      pairing: "encrypted app pairing",
      cloudSetup: "cloud setup",
      homeTitle: "# on the machine at home",
      homeBody:
        'Create the tunnel in Cloudflare\'s dashboard, point it at <span class="inline-code">server:4317</span>, drop its token in <span class="inline-code">.env</span>, and:',
      copyTunnelLabel: "Copy the tunnel commands",
      homeAfter:
        "For encrypted App access, scan the encrypted pairing code with the App's scanner. For ordinary browser access, configure authentication as described in the tunnel guide.",
      cloudBadge: "invite-only beta",
      cloudBody:
        "Optional Offdesk Cloud offers managed remote access. Its service is closed source; the Hub, node, CLI, and clients in the public repository remain MIT licensed. The local connector checks encrypted reachability and automatically retries sustained tunnel failures with backoff. Local use needs no Cloud account.",
    },
    more: {
      title: "Remote shells, mobile coding agents, and CLI automation.",
      machines: {
        title: "Manage macOS and Linux terminals",
        body: "The NAS, the VPS, the laptop. Open the hub, choose <strong>Add a machine</strong>, and it hands you one line with a token in it. Paste it on that machine; it shows up.",
      },
      agents: {
        title: "Bring any agent",
        body: "Offdesk doesn't wrap an agent or speak its protocol. It hands you the terminal the agent already runs in — your subscription, your config, your dotfiles.",
        anyCli: "any CLI",
      },
      phone: {
        title: "Use Claude Code and Codex from your phone",
        body: [
          `Customize the key bar with Esc, Tab, Shift+Tab, Shift combinations and Backspace repeat. Arrows, Enter and the keyboard toggle stay fixed; hide or reorder the other keys in Settings. <a href="${repo}/blob/main/docs/terminal-keys.md">Configure terminal keys</a>. The apps add a QR scanner and end-to-end encrypted connections.`,
          `A waiting banner lets you open another terminal's confirmation request or send Enter to its current selection while keeping your view. <a href="${repo}/blob/main/docs/terminal-attention.md">Read about confirmation shortcuts</a>.`,
          "<strong>iPhone and iPad:</strong> join the public TestFlight beta using the link below. TestFlight handles app updates.",
        ],
        android: "android apk",
        universal: "universal build",
        iphone: "iphone · testflight",
        heroAlt: "Claude Code on a desk machine while a phone is attached to the same tmux session",
        iosAlt: "Claude Code in the Offdesk iPhone app, attached to the Mac at home",
        stillAlt: "An Offdesk terminal on a phone: Claude Code on a Mac at home, attached from the phone's browser",
        caption: "Claude Code in a persistent remote tmux session.",
      },
    },
    cli: {
      title: "Automate remote terminals with the Offdesk CLI.",
      lead: "Use open, send, wait, and read commands to control remote tmux sessions from shell scripts or AI coding agents. JSON output lets your scripts capture terminal IDs and pass results between steps. A terminal an agent opens is marked as opened by an agent, so you can tell it apart from your own.",
      body: `A token is remote code execution on every machine you registered. Mint one per agent, name it, revoke it alone. <a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "Copy the example",
    },
    compare: {
      title: "How it compares",
      note: "Every cell is from that project's own documentation, checked 2026-09-01. Sources are under the same table in the README.",
      project: "Project",
      columns: [
        "Any terminal program",
        "Machines per hub",
        "Traffic goes through",
        "Agents can drive it via CLI",
        "Self-hosted",
      ],
      // One row per project, in the order of the table in the template; names
      // stay in English and live in the template.
      rows: [
        ["Anything that runs in tmux", "Any number, one URL", "Your own hub", "open / send / wait / read", "Yes, MIT"],
        ["No — a Claude Code session, not a terminal", "Sessions from several machines in one list", "Anthropic's servers; transcript stored there", "Not documented", "No"],
        ["Yes — vt &lt;any command&gt;, vt --shell", "One server per machine", "Your choice: LAN, Tailscale, ngrok, Cloudflare", "Launches commands only", "Yes, MIT"],
        ["No — wraps claude and codex", "Several; spawn --machine", "slopus cloud by default, end-to-end encrypted", "create / send / history / wait", "Optional, MIT"],
        ["Agent sessions; no raw terminal documented", "Several at once per agent", "api.omnara.com by default", "CLI and REST", "Optional, Apache-2.0"],
        ["Yes — real terminal, 30+ CLI agents", "Several, via SSH worktrees and orca serve", "Orca Relay by default, or direct on the LAN", "orca terminal create/send/read/wait", "Yes, MIT"],
      ],
    },
    close: {
      title: "Set up your hub tonight.",
      lead: "Install the Hub on macOS or Linux, register your machines, and open persistent tmux sessions from your browser or phone.",
      iphone: "iphone app",
      android: "android app",
    },
  },

  tunnel: {
    title: "Offdesk behind a Cloudflare Tunnel",
    description:
      "Reach the hub at home from anywhere, with no port opened: the full Cloudflare Tunnel setup for Offdesk.",
    heading: "A Cloudflare Tunnel",
    lead: "For a hub on a NAS or a desktop at home. <code>cloudflared</code> runs next to the hub and dials <em>out</em> to Cloudflare, which then serves your hostname over HTTPS. No port forwarding, no dynamic DNS, no certificate to renew, and it works behind CGNAT where forwarding a port is not even possible.",
    intro: `For ordinary browser connections, Cloudflare terminates HTTPS and can read terminal traffic. Encrypted App pairing adds encryption between the App and Hub, so the tunnel carries encrypted terminal content. Follow the <a href="${repo}/blob/main/docs/encrypted-connections.md">encrypted connection guide</a> for that mode. You can also use a <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a> instead: same binaries, nobody in the middle.`,
    needDomain: "You need a domain on a Cloudflare account. The free plan is enough.",
    create: {
      title: "1. Create the tunnel",
      body: "Cloudflare Zero Trust dashboard → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>. Name it, then copy the token it shows you — the long string after <code>--token</code> in the install command. That token is a credential: anyone holding it can serve traffic as your tunnel.",
      hostname: "Add a public hostname to the tunnel:",
      field: "Field",
      value: "Value",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> is the hub's service name in <code>docker-compose.yml</code>, which is how <code>cloudflared</code> reaches it over the compose network. The hop from Cloudflare to your machine is inside the tunnel; the hop from <code>cloudflared</code> to the hub never leaves the Docker network, so plain HTTP there is fine.",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>.env</code> next to <code>docker-compose.yml</code>:",
      // Placeholders inside the .env example; the angle brackets are added
      // by the template.
      secretPlaceholder: "output of: openssl rand -hex 32",
      tokenPlaceholder: "the token from step 1",
      oauth: `A hub on the internet signs in through GitHub or Google. Register the OAuth callback URLs exactly as in <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">the VPS guide</a> — the hub builds them from <code>OFFDESK_BASE_URL</code>, and nothing about a tunnel changes that. Then:`,
      profile:
        "The <code>tunnel</code> profile is what starts <code>cloudflared</code>; without it you get the hub alone, still bound to <code>127.0.0.1:4317</code>. Check both are up:",
    },
    machines: {
      title: "3. Machines",
      body: "Open the hub in a browser and choose <strong>Add host</strong>: it shows one line with a registration token filled in. On the machine you want to reach:",
      after:
        "A machine on the same LAN as the hub still goes out to Cloudflare and back. If that bothers you, register it with the hub's LAN address instead — the machine agent only needs to reach the hub, and it does not care that your phone reaches the same hub by a different name.",
    },
    notes: {
      title: "Notes",
      items: [
        "<strong>Sign-in is open to anyone who finds the URL</strong>, same as the VPS path: any GitHub or Google account can create an account on your hub. There is no allowlist. Cloudflare Access can put a second login in front of the whole hostname, but everything that is not a browser — <code>offdesk-node</code>, the CLI, the Android app — then needs an Access service token of its own, and the machine agent has nowhere to put one. Either scope the Access policy to the browser paths, or leave it off and rely on the hub's own sign-in.",
        "<strong>Long-lived WebSockets are fine.</strong> Machine agents ping every 30 seconds and browsers ping at the application layer, so idle timeouts along the path do not silently drop terminals.",
        "<strong>Do not use a quick tunnel</strong> (<code>cloudflared tunnel --url</code>, the <code>*.trycloudflare.com</code> hostnames) for anything but a demo. The hostname changes every restart, which invalidates your OAuth callback URLs, every registered machine, and any phone that has the old one saved.",
      ],
    },
    others: `The other two routes — a VPS behind Caddy, and Tailscale — with the trade-offs between all three: <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>.`,
  },

  mac: {
    title: "Your first terminal, from a Mac",
    description: "A screenshot guide to installing Offdesk on a Mac, opening your first terminal, and connecting your phone.",
    eyebrow: "Getting started · macOS",
    lead: "Make the Mac that stays on your hub. Then open its terminal from your phone. Start with both devices on the same local network.",
    preview: "About the screenshots",
    previewText:
      "These screenshots come from our Mac Mini test of 0.6.4-rc.1. The current stable release includes updated phone pairing and Cloud setup. The instructions below follow the new version; the older screenshots retain their RC labels and layout. The pairing panel now separates Offdesk App from Browser access. The download button serves the stable release.",
    download: "Download for Mac",
    phone: "Get the phone app",
    contents: "On this page",
    stepLabel: "step {n}",
    openScreenshot: "Open full screenshot",
    before: "Before you start",
    needs: [
      "A Mac that can stay powered on and connected, and its macOS login account.",
      "Your phone and Mac on the same local network. A wired Mac and a phone on the same router’s Wi-Fi work too.",
      "Offdesk on your phone: TestFlight for iPhone / iPad, or the Android APK from this site.",
    ],
    terms:
      "The Hub manages connections; the Node makes a machine’s terminals available. Choosing this Mac as the Hub installs both. The normal App setup does not need a separate install.sh command or Docker.",
    // Each step's title starts with its number, "1. …": the template splits
    // it into the step label and the heading.
    steps: {
      install: {
        title: "1. Install the Mac app",
        body: "Get the disk image from the <a href='/mac'>Mac download page</a>. Open the DMG, drag Offdesk Dev into Applications, then open the installed copy. Do not keep running it from the mounted disk image.",
        extra:
          "A standard macOS account may need an administrator’s password to write to the system Applications folder. You can also use an Applications folder inside your own home directory. RC in the screenshot identifies our test build.",
        alt: "The Mac disk image window containing Offdesk RC and an Applications folder shortcut.",
        caption: "Drag the app into Applications, then launch the installed copy.",
      },
      choose: {
        title: "2. Make this Mac the hub",
        body: "At <strong>Which machine is this?</strong>, choose <strong>The one that stays on → Set this machine up</strong>. Choose this when you want your phone to reach terminals running on this Mac.",
        extra:
          "Choose <strong>Just connecting</strong> only if you already have a Hub elsewhere and want to use this Mac as a client. You do not need to create an account for this local setup.",
      },
      ready: {
        title: "3. Let the Mac finish getting ready",
        body: "The updated setup checks four things before showing the phone connection screen. An address appearing on screen alone does not prove setup is finished.",
        checks: [
          "The Hub is running and responding.",
          "This Mac is registered with the Hub.",
          "The local Node is online.",
          "The terminal tool, tmux, is available.",
        ],
        extra:
          "Once ready, you will see <strong>Connect your phone</strong>. Choose <strong>Pair an encrypted device</strong> to generate the pairing code. If a check fails, use the retry action on the setup screen. If macOS asks whether Offdesk Dev can accept incoming connections, allow it on the Mac you want your phone to reach.",
      },
      terminal: {
        title: "4. Open your first terminal",
        body: "Choose <strong>Open my terminal</strong>. If you see <strong>No terminals yet</strong>, check the top-right control: if it says <strong>Watching / Viewing</strong>, click it to take control, then choose <strong>Start terminal</strong>. If another device already has control, make sure you intend to take over.",
        extra:
          "Type this line and press Enter. You should see the words returned below it. Commands run on your Mac, even when you type them on your phone.",
        alt: "Offdesk running echo hello from offdesk in the test account’s Mac shell, with hello from offdesk returned below.",
        caption: "A real shell, with working input and output. Control status determines whether you can create a terminal or type.",
      },
      phone: {
        title: "5. Scan from the phone app",
        body: "On the Mac, choose <strong>Phone</strong> or <strong>Show me</strong> to open the connection panel. Select <strong>Offdesk App · Recommended</strong>, then <strong>Pair an encrypted device</strong>. In the phone App’s connection screen, choose <strong>Scan QR Code</strong> and scan the newly generated encrypted pairing code. Allow camera access when prompted.",
        extra:
          "<strong>Browser access</strong> provides a sign-in code your phone’s system camera can open in a browser. <strong>Offdesk App</strong> generates an encrypted pairing code for the App’s scanner. Choose one mode; you do not need to scan both codes. Generate a new pairing code on the Mac if it expires.",
        alt: "The Mac phone connection panel with a local address, phone app links and Pair an encrypted device; the sign-in code and link are hidden.",
        caption: "The older screenshot hides its code and sign-in link. In 0.7.1, select Offdesk App and generate your own pairing code.",
        after:
          "After pairing, look for this Mac and its terminal. If there is no terminal to select, create one on the Mac using the previous step. Try a short command from the phone, then quit and reopen the phone App to check it connects again.",
      },
      return: {
        title: "6. Close the app. Come back to your terminal.",
        body: "Quitting the Mac App leaves the Hub and Node services running in the background. Reopening the App lets you return to the terminal. Quitting the App is different from putting the Mac to sleep, shutting it down, or logging out of macOS.",
        extra:
          "Keep the Mac powered on, logged in and connected. A local address works on that network; set up remote access separately when you are ready to use Offdesk away from home. Scanning a code does not make a local address reachable over the internet.",
      },
      cloud: {
        title: "7. Optional: connect away from home with Offdesk Cloud",
        body: "Cloud is currently an invite-only beta. Sign in with GitHub and redeem your invitation in the <a href='https://cloud.offdesk.dev'>Cloud console</a>. On the Mac, choose <strong>Set up remote access</strong>, follow the sign-in steps and verify the computer authorization. Once the Cloud address is ready, pair your phone using the Offdesk App mode.",
        extra:
          "For the full new-user journey, install the latest stable macOS and Android apps from this site. iOS is distributed through TestFlight; available builds depend on your testing group. After setup, turn off the phone’s Wi-Fi and check the terminal over mobile data while the Mac stays online. A paired phone opens <strong>Hub &amp; connection</strong> from its title. Local-network use can skip Cloud and invitations.",
      },
    },
    trouble: "If your screen looks different",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "The Hub has no usable machine yet; your phone does not need to become a host. Check setup on the Mac first. For the older 0.6.3 issue, a manual recovery is to choose Generate a token on this Mac and run the full generated command in this same Mac’s system Terminal. This is a recovery path for the older release, not a required step of normal installation.",
      ],
      [
        "Scanning opens a sign-in page, or the IP address alone does not sign in",
        "An address alone contains no sign-in credentials. Use the complete sign-in link or its ordinary QR code for browser sign-in. Use the App’s scanner with the encrypted pairing code for encrypted pairing. Keep full sign-in links and QR codes out of shared chats.",
      ],
      [
        "The phone cannot connect, or the screen is blank",
        "Check that both devices are on the same local network and that the selected address is reachable from the phone. Guest Wi-Fi may isolate devices. Confirm the terminal works on the Mac and check the phone’s local-network permission. If the screen stays black after scanning, quit and reopen the App, then report the App version, phone model and steps. Reopening should not be required every time.",
      ],
    ] as [string, string][],
    tested: "What did we actually test?",
    testedIntro:
      "On September 7, 2026, we tested on a Mac Mini using a new standard account, offdesk-test, with no Offdesk configuration or services and no installer script run beforehand. This was a clean user account, not a factory-reset Mac. On September 10 we backed up and reset App/Hub configuration in that test account and verified 0.7.1-rc.1 automatic setup, encrypted code generation, terminal input and reopening. That follow-up retained system tools, browser state and old tmux sessions.",
    passed: [
      "DMG download, drag into the user’s Applications folder, and launch from Finder.",
      "Automatic Hub / Node installation, machine registration, live connection and tmux checks, followed by a populated QR code.",
      "Input and output in a real terminal.",
      "Terminal persistence after quitting and reopening the App, and reconnection after restarting only the test Hub.",
    ],
    pending:
      "Not yet completed in this run: physical-phone scanning and cold reopen, test-user logout/login, and Gatekeeper acceptance of the signed, notarized production package. The user authorized the RC’s first launch; that is not proof of production distribution acceptance.",
    known:
      "We also reproduced an onboarding gap: Watching hides the Start terminal action. Step 4 includes the take-control action so you have a clear next step.",
    next: "Keep going",
    nextText: "Get comfortable on the local network first, then read about encrypted connections and remote access.",
    encryption: "Encrypted connections",
    lan: "Local-network troubleshooting",
    allDocs: "All technical docs",
  },
};

export type Dict = typeof en;
export default en;
