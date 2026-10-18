// Japanese. Same shape as en.ts (see the comments there).
//
// Style: body copy in です・ます; headings and labels as noun phrases or plain
// form. Full-width punctuation (、。「」：). A half-width space separates
// Japanese from Latin words and numbers, but never sits next to full-width
// punctuation. Dates are written the Japanese way (2026年9月7日).

import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const ja: Dict = {
  chrome: {
    skip: "本文へスキップ",
    homeLabel: "Offdesk Dev ホーム",
    navLabel: "メイン",
    nav: {
      download: "ダウンロード",
      how: "仕組み",
      away: "リモートアクセス",
      docs: "ドキュメント",
      cli: "CLI",
    },
    discordLabel: "Offdesk の Discord",
    githubLabel: "Offdesk の GitHub",
    language: "言語",
    languageLabel: "言語：{name}。別の言語を選択",
    footer: {
      madeBy: "{zalify} が開発",
      tagline: "セルフホストのリモートターミナル",
      gettingStarted: "はじめに",
      tunnel: "トンネルガイド",
      security: "セキュリティ",
      releases: "リリースノート",
    },
    copy: "[コピー]",
    copied: "[コピー済み]",
    copyFailed: "[⌘C を押す]",
  },

  home: {
    title: "Offdesk — あなたとエージェントで共有するひとつのターミナル",
    description:
      "エージェントが CLI で開いて操作するターミナルを、スマホから見守り、必要なときに引き継げます。Claude Code や Codex など tmux で動くものすべてに使える、セルフホストのリモートターミナル。Hub は MIT ライセンス。",
    hero: {
      title: "ひとつのターミナルを、あなたとエージェントで。",
      lead: "エージェントは CLI でターミナルを開き、入力し、出力を読みます。あなたは同じターミナルをスマホから見守り、呼ばれたらキーボードを引き継ぎます。",
      downloadMac: "Mac 版をダウンロード",
      allDownloads: "すべてのダウンロード",
      copyInstallLabel: "インストールコマンドをコピー",
      note: "Mac アプリは署名・公証済みで、Apple silicon と Intel に対応しています。ワンライナーは macOS または Linux に Hub をインストールします。",
      figcaption: "イメージ図：エージェントが CLI で開いたターミナルを、スマホから見守る様子。",
    },
    proofLabel: "概要",
    // Offdesk's own row of the comparison table further down.
    proof: [
      { key: "対応プログラム", value: "tmux で動くものなら何でも" },
      { key: "マシン", value: "台数無制限、URL はひとつ" },
      { key: "通信経路", value: "自分の Hub を経由" },
      { key: "エージェント", value: "open · send · wait · read" },
      { key: "ライセンス", value: "セルフホスト、Hub は MIT" },
    ],
    beats: {
      title: "キーボードは、必要な側が握る。",
      items: [
        {
          label: "01 / エージェント",
          title: "エージェントが開く",
          body: "コマンドひとつで、手持ちのどのマシンでも Claude Code や Codex など何でもターミナルで起動できます。誰もいなくなっても動き続けます。",
        },
        {
          label: "02 / あなた",
          title: "同じターミナルを見る",
          body: "書き起こしではなく、生のターミナルをスマホ、ノート PC、ブラウザで。エージェントが手を止めて質問すれば、すぐにわかります。",
        },
        {
          label: "03 / どちらでも",
          title: "操作を引き継ぎ、また返す",
          body: "Enter で答えるか、キーボードを引き継ぎます。エージェントのブラウザでも同じです。代わりにサインインして、また返せます。",
        },
      ],
    },
    start: {
      title: "3 ステップで最初のターミナルへ。",
      steps: [
        {
          label: "ステップ 1",
          title: "macOS または Linux に Hub をインストール",
          body: "Mac アプリを開き、このマシンが常時稼働するマシンだと選ぶと、それが Hub になります。ログイン時に起動し、止まっても再起動します。セルフホストならベンダーのアカウントは不要です。NAS や画面のないサーバーでは、1 行で同じことができます：",
        },
        {
          label: "ステップ 2",
          title: "スマホをペアリングするか、ブラウザからサインイン",
          body: 'Offdesk App を選ぶと、アプリ内スキャナー用の暗号化ペアリングコードを生成します。Browser access を選ぶと、ブラウザ用のサインインリンクを生成します。どちらも Mac のメニューバーにあります。ブラウザアクセスなら <span class="inline-code">offdesk link</span> を実行しても構いません。',
        },
        {
          label: "ステップ 3",
          title: "同じ tmux セッションに再接続",
          body: "デスクと同じ tmux セッションに、リアルタイムで。Hub はスリープさせず、オンラインのままにしてください。tmux で動くものは、ここでも動きます。",
        },
      ],
      readGuide: "Mac ガイドを読む",
      iphone: "iPhone アプリ",
      android: "Android アプリ",
      orBrowser: "またはスマホのブラウザで",
    },
    download: {
      title: "デスクトップ、スマホ、Web 向けのクライアント。",
      lead: "デスクトップアプリは Mac では Hub として動き、どこでもクライアントとして使えます。スマホアプリは、ブラウザに表示されるのと同じターミナルを包んだものです。",
      mac: {
        body: "Apple silicon と Intel 共通の dmg ひとつ。Developer ID で署名・公証済みなので、App Store のアプリと同じように開けます。常時稼働の Mac では Hub に、それ以外ではクライアントになります。",
        button: ".dmg をダウンロード →",
        meta: "macOS 11 以降 · ユニバーサル · .dmg",
      },
      windows: {
        body: "クライアントです。別の場所にある Hub のターミナルを開きます。Hub が表示したリンクを貼り付けるか、サインインしてください。Hub には tmux が必要なため、Windows マシンは Hub になれません。",
        button: ".msi をダウンロード →",
      },
      linux: {
        body: "Windows と同じくクライアントです。Linux マシンを Hub にするなら、1 行のインストールを使ってください。Hub をサービスとして実行します。",
        button: ".AppImage をダウンロード →",
        meta: "x64 · .AppImage · .deb と .rpm は{release}で入手",
        release: "リリースページ",
      },
      iphone: {
        body: "TestFlight で配信しています。iPhone または iPad で招待を開いてアプリをインストールし、Scan QR Code を選んで Hub に接続します。",
        button: "ベータに参加 →",
      },
      android: {
        body: 'サイドロード用の APK です。最近のスマホなら <span class="inline-code">arm64-v8a</span>、わからなければ <a href="/apk/universal">ユニバーサル版</a>を選んでください。',
        button: "APK をダウンロード →",
      },
      cli: {
        title: "Hub、Node、CLI",
        body: "NAS、VPS、画面のないマシン向けの 3 つのバイナリ。Linux と macOS、x64 と arm64 に対応しています。",
      },
    },
    how: {
      title: "Rust 製 Hub。外向き WebSocket。永続する tmux。",
      items: [
        {
          title: "Hub",
          body: "Axum で構築した Rust サーバーで、SQLite にデータを保存し、Web UI を内蔵しています。クライアントを認証し、ターミナルの通信を macOS や Linux の Node に振り分けます。バイナリをインストールするか、Docker でデプロイします。",
        },
        {
          title: "Node",
          body: "接続したいすべてのマシンで動きます。WebSocket で Hub へ<em>外向きに</em>接続するため、Node には受信ポートもパブリック IP も不要です。各ターミナルは、それを持つマシン上の tmux セッションです。アプリが閉じても、ネットワークが切れても、あなたが離れても残ります。Offdesk をアンインストールしても、まだそこにあります。",
        },
        {
          title: "クライアント",
          body: "React と xterm.js が、インタラクティブなターミナルをブラウザに描画します。Tauri アプリは、デスクトップとモバイルにネイティブの暗号化ペアリングを加えます。Rust 製の CLI でスクリプトから操作できます。クライアントは Hub を通じてターミナル出力を共有し、誰が入力できるかは制御リースで決まります。",
        },
      ],
      note: "ひとつのターミナルを 2 つの画面で開くと、ひとつの Hub に 2 つのクライアントがつながり、ひとつの tmux セッションにアタッチします。クライアントが切断しても、Node 上のセッションは終了しません。Offdesk は SSH ではなく独自の Hub/Node 間通信を使います。接続したい各マシンに offdesk-node をインストールしてください。",
    },
    away: {
      title: "LAN でセルフホスト。リモートアクセスは必要になってから。",
      body: [
        "オープンソースの Hub を macOS、Linux、NAS、VPS で動かします。Node はその Hub へ外向きに接続し、ターミナルセッションは tmux を動かすマシンに残ります。Hub とそれらのマシンは、起動したままオンラインにしておく必要があります。",
        `Hub の隣で cloudflared を動かせば、ルーターのポートを開けずに HTTPS エンドポイントを公開できます。NAT や CGNAT の内側でも使えます。ドメインとトンネルの ingress を設定するか、<a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> を使って、手持ちのデバイスから Hub にプライベートにアクセスします。`,
        `ペアリング済みの Offdesk App は、トンネル経由でも App と Hub の間でターミナルの通信をエンドツーエンドで暗号化します。通常のブラウザアクセスは HTTPS と独自の認証を使い、その HTTPS はトンネル事業者のところで終端します。App の暗号化が自動で付くわけではありません。詳しくは<a href="${repo}/blob/main/docs/encrypted-connections.md">暗号化接続ガイド</a>を参照してください。`,
      ],
      tunnelGuide: "トンネルガイド",
      lanSetup: "LAN セットアップ",
      pairing: "アプリの暗号化ペアリング",
      cloudSetup: "Cloud セットアップ",
      homeTitle: "# 自宅のマシンで",
      homeBody:
        'Cloudflare のダッシュボードでトンネルを作成し、<span class="inline-code">server:4317</span> に向けて、トークンを <span class="inline-code">.env</span> に書き込んだら、次を実行します：',
      copyTunnelLabel: "トンネルのコマンドをコピー",
      homeAfter:
        "App で暗号化アクセスするには、App のスキャナーで暗号化ペアリングコードを読み取ります。通常のブラウザアクセスでは、トンネルガイドのとおりに認証を設定してください。",
      cloudBadge: "招待制ベータ",
      cloudBody:
        "オプションの Offdesk Cloud は、マネージドなリモートアクセスを提供します。このサービスはクローズドソースですが、公開リポジトリの Hub、Node、CLI は MIT ライセンスで、Web UI とアプリは FSL-1.1-MIT でソースを公開しています。ローカルコネクタは暗号化された到達性を確認し、トンネルの障害が続くとバックオフしながら自動で再試行します。ローカルで使うだけなら Cloud アカウントは不要です。",
    },
    more: {
      title: "リモートシェル、モバイルからのコーディングエージェント、CLI 自動化。",
      machines: {
        title: "macOS と Linux のターミナルを管理",
        body: "NAS、VPS、ノート PC。Hub を開いて <strong>Add a machine</strong> を選ぶと、トークン入りの 1 行が渡されます。それを対象のマシンに貼り付ければ、一覧に現れます。",
      },
      agents: {
        title: "どんなエージェントでも",
        body: "Offdesk はエージェントをラップせず、そのプロトコルも話しません。エージェントがすでに動いているターミナルを、そのまま渡します。サブスクリプションも設定も dotfiles も、あなたのものそのままです。",
        anyCli: "任意の CLI",
      },
      phone: {
        title: "スマホから Claude Code と Codex を使う",
        body: [
          `キーバーは Esc、Tab、Shift+Tab、Shift の組み合わせ、Backspace のリピートでカスタマイズできます。矢印、Enter、キーボード切り替えは固定で、ほかのキーは Settings で非表示にしたり並べ替えたりできます。<a href="${repo}/blob/main/docs/terminal-keys.md">ターミナルキーを設定する</a>。アプリには QR スキャナーとエンドツーエンド暗号化接続も備わっています。`,
          `確認待ちのバナーから、今の画面を保ったまま、別のターミナルの確認リクエストを開いたり、現在の選択肢に Enter を送ったりできます。<a href="${repo}/blob/main/docs/terminal-attention.md">確認ショートカットについて読む</a>。`,
          "<strong>iPhone と iPad：</strong>下のリンクから公開 TestFlight ベータに参加してください。アプリのアップデートは TestFlight が行います。",
        ],
        android: "Android APK",
        universal: "ユニバーサル版",
        iphone: "iPhone · TestFlight",
        heroAlt: "デスクのマシンで動く Claude Code と、同じ tmux セッションにアタッチしたスマホ",
        iosAlt: "Offdesk の iPhone アプリで、自宅の Mac にアタッチした Claude Code",
        stillAlt: "スマホに表示した Offdesk のターミナル：自宅の Mac で動く Claude Code に、スマホのブラウザからアタッチ",
        caption: "永続するリモート tmux セッションで動く Claude Code。",
      },
    },
    cli: {
      title: "Offdesk CLI でリモートターミナルを自動化。",
      lead: "open、send、wait、read の各コマンドで、シェルスクリプトや AI コーディングエージェントからリモートの tmux セッションを操作できます。JSON 出力を使えば、スクリプトでターミナル ID を取得し、ステップ間で結果を受け渡せます。エージェントが開いたターミナルにはその印が付くので、自分で開いたものと見分けられます。",
      body: `トークンは、登録したすべてのマシンでのリモートコード実行権限です。エージェントごとに発行して名前を付け、個別に失効させてください。<a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "サンプルをコピー",
    },
    compare: {
      title: "ほかのプロジェクトとの比較",
      note: "各セルは、それぞれのプロジェクト自身のドキュメントに基づいています（2026年9月1日に確認）。出典は README の同じ表の下にあります。",
      project: "プロジェクト",
      columns: [
        "任意のターミナルプログラム",
        "Hub あたりのマシン数",
        "通信の経路",
        "CLI からエージェントが操作",
        "セルフホスト",
      ],
      // One row per project, in the order of the table in the template; names
      // stay in English and live in the template.
      rows: [
        ["tmux で動くものなら何でも", "台数無制限、URL はひとつ", "自分の Hub", "open / send / wait / read", "対応、MIT + FSL"],
        ["非対応 — ターミナルではなく Claude Code のセッション", "複数マシンのセッションをひとつの一覧に", "Anthropic のサーバー。トランスクリプトもそこに保存", "記載なし", "非対応"],
        ["対応 — vt &lt;任意のコマンド&gt;、vt --shell", "マシンごとに 1 サーバー", "LAN、Tailscale、ngrok、Cloudflare から選択", "コマンドの起動のみ", "対応、MIT"],
        ["非対応 — claude と codex をラップ", "複数、spawn --machine", "デフォルトは slopus のクラウド、エンドツーエンド暗号化", "create / send / history / wait", "オプション、MIT"],
        ["エージェントのセッション。生のターミナルは記載なし", "エージェントごとに複数を同時に", "デフォルトは api.omnara.com", "CLI と REST", "オプション、Apache-2.0"],
        ["対応 — 本物のターミナル、30 以上の CLI エージェント", "複数、SSH ワークツリーと orca serve 経由", "デフォルトは Orca Relay、または LAN で直接接続", "orca terminal create/send/read/wait", "対応、MIT"],
      ],
    },
    close: {
      title: "今夜、Hub を立ち上げよう。",
      lead: "macOS か Linux に Hub をインストールし、マシンを登録して、ブラウザやスマホから永続する tmux セッションを開きましょう。",
      iphone: "iPhone アプリ",
      android: "Android アプリ",
    },
  },

  tunnel: {
    title: "Cloudflare Tunnel 経由で Offdesk を使う",
    description:
      "ポートを開けずに、自宅の Hub にどこからでもアクセス。Offdesk を Cloudflare Tunnel で使うためのセットアップ手順をひととおり解説します。",
    heading: "Cloudflare Tunnel",
    lead: "NAS や自宅のデスクトップで動く Hub 向けです。<code>cloudflared</code> は Hub の隣で動き、Cloudflare へ<em>外向きに</em>接続します。Cloudflare はそのホスト名を HTTPS で配信します。ポートフォワーディングも、ダイナミック DNS も、証明書の更新も不要で、ポート開放がそもそもできない CGNAT の内側でも動きます。",
    intro: `通常のブラウザ接続では、Cloudflare が HTTPS を終端するため、ターミナルの通信を読める状態になります。App の暗号化ペアリングを使うと App と Hub の間に暗号化が加わり、トンネルを流れるターミナルの内容は暗号化されたままになります。このモードについては<a href="${repo}/blob/main/docs/encrypted-connections.md">暗号化接続ガイド</a>に従ってください。代わりに <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a> を使うこともできます。バイナリは同じで、間に誰も入りません。`,
    needDomain: "Cloudflare アカウントにドメインが必要です。無料プランで十分です。",
    create: {
      title: "1. トンネルを作成",
      body: "Cloudflare Zero Trust ダッシュボード → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>。名前を付けたら、表示されるトークンをコピーします。インストールコマンドの <code>--token</code> の後ろにある長い文字列です。このトークンは認証情報です。持っている人は誰でも、あなたのトンネルとして通信を配信できます。",
      hostname: "トンネルにパブリックホスト名を追加します：",
      field: "項目",
      value: "値",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> は <code>docker-compose.yml</code> における Hub のサービス名で、<code>cloudflared</code> は compose ネットワーク上でこの名前を使って Hub に到達します。Cloudflare からあなたのマシンまではトンネルの中を通り、<code>cloudflared</code> から Hub までは Docker ネットワークの外に出ないので、そこは平文の HTTP で問題ありません。",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>docker-compose.yml</code> の隣に置く <code>.env</code>：",
      // Placeholders inside the .env example; the angle brackets are added
      // by the template.
      secretPlaceholder: "openssl rand -hex 32 の出力",
      tokenPlaceholder: "ステップ 1 のトークン",
      oauth: `インターネット上の Hub には、GitHub か Google でサインインします。OAuth のコールバック URL は、<a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">VPS ガイド</a>のとおり正確に登録してください。Hub は <code>OFFDESK_BASE_URL</code> からこれらを組み立てるので、トンネルを使ってもそこは変わりません。続いて：`,
      profile:
        "<code>tunnel</code> プロファイルが <code>cloudflared</code> を起動します。指定しないと Hub だけが起動し、<code>127.0.0.1:4317</code> にバインドされたままです。両方が起動していることを確認します：",
    },
    machines: {
      title: "3. マシン",
      body: "ブラウザで Hub を開き、<strong>Add host</strong> を選ぶと、登録トークン入りの 1 行が表示されます。接続したいマシンで次を実行します：",
      after:
        "Hub と同じ LAN にあるマシンでも、通信はいったん Cloudflare を経由して戻ってきます。気になる場合は、代わりに Hub の LAN アドレスで登録してください。マシン側のエージェントは Hub に到達できればよく、スマホが同じ Hub に別の名前で到達していても関係ありません。",
    },
    notes: {
      title: "注意点",
      items: [
        "<strong>URL を見つけた人なら誰でもサインインできます。</strong>VPS の場合と同じく、GitHub か Google のアカウントがあれば誰でもあなたの Hub にアカウントを作成できます。許可リストはありません。Cloudflare Access でホスト名全体の前に 2 つ目のログインを置くこともできますが、その場合ブラウザ以外のもの（<code>offdesk-node</code>、CLI、Android アプリ）はそれぞれ専用の Access サービストークンが必要になり、マシン側のエージェントにはそれを設定する場所がありません。Access のポリシーをブラウザのパスだけに限定するか、Access を使わずに Hub 自身のサインインに任せてください。",
        "<strong>長時間の WebSocket 接続も問題ありません。</strong>マシン側のエージェントは 30 秒ごとに ping を送り、ブラウザはアプリケーション層で ping を送るので、経路上のアイドルタイムアウトでターミナルが黙って切れることはありません。",
        "<strong>デモ以外でクイックトンネルは使わないでください</strong>（<code>cloudflared tunnel --url</code>、<code>*.trycloudflare.com</code> のホスト名）。再起動のたびにホスト名が変わり、OAuth のコールバック URL、登録済みのすべてのマシン、古いホスト名を保存したスマホがすべて使えなくなります。",
      ],
    },
    others: `残りの 2 つの方法（Caddy の背後に置く VPS と Tailscale）と、3 つの方法それぞれのトレードオフ：<a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>。`,
  },

  mac: {
    title: "Mac で最初のターミナルを開く",
    description: "Mac に Offdesk をインストールし、最初のターミナルを開いて、スマホを接続するまでをスクリーンショット付きで解説するガイド。",
    eyebrow: "はじめに · macOS",
    lead: "常時稼働する Mac を Hub にして、そのターミナルをスマホから開きます。まずは両方のデバイスを同じローカルネットワークにつないで始めましょう。",
    preview: "スクリーンショットについて",
    previewText:
      "これらのスクリーンショットは、Mac Mini で 0.6.4-rc.1 をテストしたときのものです。現在の安定版では、スマホのペアリングと Cloud のセットアップが更新されています。以下の手順は新しいバージョンに沿っており、古いスクリーンショットには RC の表記と当時のレイアウトが残っています。ペアリングパネルでは、Offdesk App と Browser access が分かれるようになりました。ダウンロードボタンからは安定版を入手できます。",
    download: "Mac 版をダウンロード",
    phone: "スマホアプリを入手",
    contents: "このページの内容",
    stepLabel: "ステップ {n}",
    openScreenshot: "スクリーンショットを拡大",
    before: "始める前に",
    needs: [
      "電源を入れたままネットワークにつないでおける Mac と、その macOS のログインアカウント。",
      "同じローカルネットワーク上のスマホと Mac。有線接続の Mac と、同じルーターの Wi-Fi につないだスマホでも構いません。",
      "スマホに入れた Offdesk：iPhone / iPad なら TestFlight、Android ならこのサイトの APK。",
    ],
    terms:
      "Hub は接続を管理し、Node はマシンのターミナルを使えるようにします。この Mac を Hub に選ぶと、両方がインストールされます。通常の App のセットアップでは、install.sh コマンドや Docker を別途使う必要はありません。",
    // Each step's title starts with its number, "1. …": the template splits
    // it into the step label and the heading.
    steps: {
      install: {
        title: "1. Mac アプリをインストール",
        body: "<a href='/mac'>Mac のダウンロードページ</a>からディスクイメージを入手します。DMG を開いて Offdesk Dev を「アプリケーション」フォルダにドラッグし、インストールしたほうを開きます。マウントしたディスクイメージから起動したままにしないでください。",
        extra:
          "macOS の標準アカウントでは、システムの「アプリケーション」フォルダへの書き込みに管理者のパスワードが必要な場合があります。自分のホームディレクトリ内の「アプリケーション」フォルダを使うこともできます。スクリーンショットの RC は、テスト用ビルドであることを示しています。",
        alt: "Offdesk RC と「アプリケーション」フォルダへのショートカットが入った、Mac のディスクイメージのウィンドウ。",
        caption: "アプリを「アプリケーション」にドラッグし、インストールしたほうを起動します。",
      },
      choose: {
        title: "2. この Mac を Hub にする",
        body: "<strong>Which machine is this?</strong> で <strong>The one that stays on → Set this machine up</strong> を選びます。この Mac で動くターミナルにスマホからアクセスしたい場合は、こちらを選んでください。",
        extra:
          "<strong>Just connecting</strong> を選ぶのは、すでに別の場所に Hub があり、この Mac をクライアントとして使いたい場合だけです。このローカルセットアップでは、アカウントを作成する必要はありません。",
      },
      ready: {
        title: "3. Mac の準備が終わるまで待つ",
        body: "更新されたセットアップでは、スマホの接続画面を表示する前に 4 つの項目を確認します。画面にアドレスが表示されただけでは、セットアップが完了したとは限りません。",
        checks: [
          "Hub が起動して応答している。",
          "この Mac が Hub に登録されている。",
          "ローカルの Node がオンラインになっている。",
          "ターミナルツールの tmux が使える。",
        ],
        extra:
          "準備ができると <strong>Connect your phone</strong> が表示されます。<strong>Pair an encrypted device</strong> を選んでペアリングコードを生成してください。確認に失敗した場合は、セットアップ画面の再試行を使ってください。Offdesk Dev に受信接続を許可するか macOS に聞かれたら、スマホからアクセスしたい Mac では許可してください。",
      },
      terminal: {
        title: "4. 最初のターミナルを開く",
        body: "<strong>Open my terminal</strong> を選びます。<strong>No terminals yet</strong> と表示された場合は、右上のコントロールを確認してください。<strong>Watching / Viewing</strong> と表示されていれば、クリックして操作権を取得してから <strong>Start terminal</strong> を選びます。ほかのデバイスがすでに操作権を持っている場合は、本当に引き継ぐつもりか確認してください。",
        extra:
          "次の行を入力して Enter を押します。その下に同じ言葉が返ってくるはずです。スマホから入力しても、コマンドは Mac 上で実行されます。",
        alt: "テストアカウントの Mac のシェルで echo hello from offdesk を実行し、その下に hello from offdesk が返ってきた Offdesk の画面。",
        caption: "入出力が機能する本物のシェル。ターミナルを作成したり入力したりできるかは、操作権の状態で決まります。",
      },
      phone: {
        title: "5. スマホアプリでスキャン",
        body: "Mac で <strong>Phone</strong> または <strong>Show me</strong> を選び、接続パネルを開きます。<strong>Offdesk App · Recommended</strong> を選んでから、<strong>Pair an encrypted device</strong> を選びます。スマホの App の接続画面で <strong>Scan QR Code</strong> を選び、生成されたばかりの暗号化ペアリングコードを読み取ります。カメラへのアクセスを求められたら許可してください。",
        extra:
          "<strong>Browser access</strong> は、スマホの標準カメラでブラウザから開けるサインインコードを表示します。<strong>Offdesk App</strong> は、App のスキャナー用の暗号化ペアリングコードを生成します。どちらか一方のモードを選んでください。両方のコードを読み取る必要はありません。ペアリングコードの有効期限が切れたら、Mac で新しく生成してください。",
        alt: "ローカルアドレス、スマホアプリへのリンク、Pair an encrypted device が表示された Mac のスマホ接続パネル。サインインコードとリンクは非表示。",
        caption: "古いスクリーンショットでは、コードとサインインリンクを隠しています。0.7.1 では Offdesk App を選び、自分のペアリングコードを生成してください。",
        after:
          "ペアリングしたら、この Mac とそのターミナルを探します。選べるターミナルがない場合は、前のステップの手順で Mac 上に作成してください。スマホから短いコマンドを試し、スマホの App を終了して開き直し、再接続できることを確認します。",
      },
      return: {
        title: "6. アプリを閉じて、ターミナルに戻る。",
        body: "Mac の App を終了しても、Hub と Node のサービスはバックグラウンドで動き続けます。App を開き直せばターミナルに戻れます。App の終了は、Mac のスリープ、シャットダウン、macOS からのログアウトとは異なります。",
        extra:
          "Mac は電源を入れ、ログインしたまま、ネットワークにつないでおいてください。ローカルアドレスはそのネットワーク内で使えます。外出先で Offdesk を使う準備ができたら、リモートアクセスを別途セットアップしてください。コードを読み取っても、ローカルアドレスがインターネットから到達可能になるわけではありません。",
      },
      cloud: {
        title: "7. オプション：Offdesk Cloud で外出先から接続",
        body: "Cloud は現在、招待制のベータです。GitHub でサインインし、<a href='https://cloud.offdesk.dev'>Cloud コンソール</a>で招待を使ってください。Mac で <strong>Set up remote access</strong> を選び、サインインの手順に従って、コンピュータの認可を確認します。Cloud のアドレスが準備できたら、Offdesk App モードでスマホをペアリングします。",
        extra:
          "新規ユーザーとしての一連の流れを試すには、このサイトから最新の安定版の macOS アプリと Android アプリをインストールしてください。iOS は TestFlight で配信しており、利用できるビルドはテストグループによって異なります。セットアップ後、Mac をオンラインにしたままスマホの Wi-Fi をオフにし、モバイルデータ通信でターミナルを確認します。ペアリング済みのスマホでは、タイトルから <strong>Hub &amp; connection</strong> を開けます。ローカルネットワークで使うだけなら、Cloud も招待も不要です。",
      },
    },
    trouble: "画面が違って見える場合",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "Hub にまだ使えるマシンがありません。スマホをホストにする必要はありません。まず Mac のセットアップを確認してください。古い 0.6.3 の問題については、この Mac で Generate a token を選び、生成されたコマンド全体を同じ Mac のシステムの「ターミナル」で実行すれば、手動で復旧できます。これは古いリリース向けの復旧手順で、通常のインストールに必要な手順ではありません。",
      ],
      [
        "スキャンするとサインインページが開く、または IP アドレスだけではサインインできない",
        "アドレスだけにはサインイン用の認証情報が含まれていません。ブラウザでサインインするには、完全なサインインリンクか、その通常の QR コードを使ってください。暗号化ペアリングには、App のスキャナーで暗号化ペアリングコードを読み取ります。完全なサインインリンクや QR コードは、共有チャットに貼らないでください。",
      ],
      [
        "スマホが接続できない、または画面が空白になる",
        "両方のデバイスが同じローカルネットワークにあり、選択したアドレスにスマホから到達できるか確認してください。ゲスト Wi-Fi ではデバイスが分離されることがあります。Mac でターミナルが動くことを確かめ、スマホのローカルネットワークの権限を確認してください。スキャン後も画面が黒いままなら、App を終了して開き直し、App のバージョン、スマホの機種、手順を報告してください。毎回開き直さなければならないのは想定外の動作です。",
      ],
    ] as [string, string][],
    tested: "実際に何をテストしたか",
    testedIntro:
      "2026年9月7日、Mac Mini 上で新しく作成した標準アカウント offdesk-test を使ってテストしました。Offdesk の設定やサービスはなく、事前にインストーラースクリプトも実行していません。これはクリーンなユーザーアカウントであり、工場出荷状態にリセットした Mac ではありません。9月10日には、同じテストアカウントで App/Hub の設定をバックアップしてリセットし、0.7.1-rc.1 の自動セットアップ、暗号化コードの生成、ターミナル入力、開き直しを検証しました。この追加テストでは、システムツール、ブラウザの状態、古い tmux セッションは残したままでした。",
    passed: [
      "DMG のダウンロード、ユーザーの「アプリケーション」フォルダへのドラッグ、Finder からの起動。",
      "Hub / Node の自動インストール、マシンの登録、ライブ接続と tmux のチェック、その後の QR コードの表示。",
      "本物のターミナルでの入出力。",
      "App を終了して開き直した後のターミナルの永続性と、テスト用 Hub だけを再起動した後の再接続。",
    ],
    pending:
      "今回のテストで未完了の項目：実機のスマホでのスキャンとコールドスタートでの開き直し、テストユーザーのログアウト / ログイン、署名・公証済みの製品版パッケージを Gatekeeper が受け入れるかの確認。RC の初回起動はユーザーが許可したもので、製品版の配布が受け入れられることの証明にはなりません。",
    known:
      "オンボーディングの不備も再現しました。Watching の状態では Start terminal のアクションが表示されません。次にすべきことが明確になるよう、ステップ 4 に操作権を取得する手順を入れています。",
    next: "次のステップ",
    nextText: "まずはローカルネットワークで使い慣れてから、暗号化接続とリモートアクセスについて読んでください。",
    encryption: "暗号化接続",
    lan: "ローカルネットワークのトラブルシューティング",
    allDocs: "技術ドキュメント一覧",
  },
};

export default ja;
