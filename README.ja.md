<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" alt="Offdesk Dev" height="48">
  </picture>
</p>

<p align="center">
  <img src="docs/media/hero-banner.png" alt="ひとつのターミナルを、あなたとエージェントで共有する。tmux で動くあらゆるプログラムを、すべてのマシンで、自分で運用するひとつの Hub の向こうに。" width="800">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a>
</p>

# Offdesk Dev — tmux と AI コーディングエージェントのためのセルフホスト型リモートターミナル

> この文書は [英語版 README](README.md) の翻訳です。内容が食い違う場合は英語版が正となります。日本語のウェブサイト: [offdesk.dev/ja](https://offdesk.dev/ja/)

**ひとつのターミナルを、あなたとエージェントで共有する。** エージェントは `offdesk` CLI でターミナルを開き、入力し、出力を読み取ります。あなたは同じターミナルをスマートフォンから見守り、エージェントに助けが必要なときはキーボードを引き継げます。

**Claude Code、Codex、OpenCode をはじめ、あらゆるターミナルプログラム**に、ブラウザ、iPhone、Android スマートフォン、デスクトップアプリからアクセスできます。Offdesk は、自分の macOS / Linux マシン上で動き続ける **tmux セッション**に、セルフホストのハブ（Hub）ひとつを介してクライアントをつなぎます。コマンドはリモートマシン上で実行され、クライアントはターミナルの入出力を WebSocket 接続でやり取りします。

アプリは **Offdesk Dev** という名前でインストールされます。この README ではプロジェクトを略して Offdesk と呼びます。コマンドラインツールは `offdesk` の名前を引き継いでいます。`offdesk` CLI、`offdesk-hub` サーバー、`offdesk-node`
マシンエージェントです。

スマートフォンから AI コーディングエージェントの様子を確認したり、ネットワークが切れたあとにシェルを再開したり、Mac、Linux サーバー、NAS、VPS のターミナルをひとつの画面で管理したりできます。Hub とセッションを動かすマシンは起動したままにしておく必要があります。

- **永続的なリモートセッション:** 対話型 CLI、エディタ、ビルド出力、シェル履歴を含め、同じ tmux ターミナルに再接続できます。
- **ひとつの Hub に複数のマシン:** 各 `offdesk-node` は Hub へ外向きに接続するため、ノード側に受信ポートやグローバル IP は不要です。
- **モバイル向けのターミナル操作:** キーが均等なグリッドに並ぶキーバーを備え、ショートカットキーのカスタマイズ、Shift+Tab、Shift との組み合わせ、Backspace の長押しリピートに対応します。矢印キー、Enter、キーボード表示の切り替えは固定位置です。ファイル添付や、QR コードによる App の暗号化ペアリングにも対応します。タイトルバーのターミナル名をタップするとセッションを切り替えられ、その横の `[f]`、`[b]`、`[m]` でファイル、エージェントブラウザ、Machines & Hub を開けます。
- **CLI による自動化:** `offdesk open / send / wait / read` と JSON 出力で、ターミナルを開き、入力を送り、出力を待ち、結果を読み取れます。エージェントが開いたターミナルには、アプリ上でその旨が表示されます。
- **セルフホスト:** macOS / Linux 上の Rust バイナリまたは Docker で動作します。ストレージは SQLite で、Web UI は Hub のバイナリに組み込まれています。
- **App の暗号化接続:** ペアリングした App と Hub の間はエンドツーエンドで暗号化されます。通常のブラウザアクセスは別のサインイン方式を使い、ブラウザから公開アクセスする場合は HTTPS と認証が必要です。

このリポジトリの Hub、node、CLI、プロトコルと暗号化の crate は **MIT ライセンス**で、Web UI とデスクトップ・スマホアプリは **FSL-1.1-MIT** でソースを公開しています（[ライセンス](#ライセンス)）。セルフホストにベンダーのアカウントは不要です。オプションの **Offdesk Cloud** は、マネージドなリモートアクセスを提供する別のクローズドソースのサービスです。そのオープンソースのローカルコネクタは暗号化された経路の到達性を確認し、トンネルの障害が続いた場合は自動で再起動します（障害が長引く場合はバックオフします）。

質問、うまくいかなかったセットアップ、ほしい機能などは[Discord](https://discord.gg/aFUu6VMzc) へどうぞ。

## ダウンロード

| | | |
|---|---|---|
| **macOS** | [offdesk.dev/mac](https://offdesk.dev/mac) | Apple シリコンと Intel 共通の dmg ひとつ。署名・公証済み。Hub にもなれます。 |
| **Windows** | [offdesk.dev/windows](https://offdesk.dev/windows) | x64 `.msi`。クライアントです。 |
| **Linux** | [offdesk.dev/linux](https://offdesk.dev/linux) | x64 `.AppImage`。`.deb` と `.rpm` は[リリースページ](https://offdesk.dev/desktop)にあります。クライアントです。 |
| **iPhone / iPad** | [TestFlight に参加](https://testflight.apple.com/join/rV4ktaGv) | 暗号化ペアリングには App を使います。ブラウザでは Hub のサインインリンクを使えます。 |
| **Android** | [offdesk.dev/apk](https://offdesk.dev/apk) | `arm64-v8a`。迷ったら [`/apk/universal`](https://offdesk.dev/apk/universal)。 |
| **Hub、node、CLI** | `curl -fsSL https://offdesk.dev/install \| sh` | Linux と macOS、x64 と arm64。NAS、VPS など画面のないマシン向けです。 |

どのリンクも、それぞれの種類の最新リリースを指します。Windows はデスクトップクライアントです。Linux では、tmux を別途インストールすれば Hub も動かせます。

## ドキュメント

- [macOS のインストールとスマートフォンのペアリング](https://offdesk.dev/ja/docs/mac)
- [LAN でのセットアップ](docs/setup-lan.md)と、[HTTPS、OAuth、Tailscale による外部からのアクセス](docs/setup-public.md)
- [App のエンドツーエンド暗号化接続](docs/encrypted-connections.md)と[オプションの Offdesk Cloud のセットアップ](docs/managed-connections.md)
- [localhost の Web プレビュー](docs/web-previews.md): 専用のプレビュードメインと HTTPS の受け口を使う、オプトインの転送機能です。ターミナルの E2EE とは別系統です
- [HTML ファイルのプレビュー](docs/html-file-previews.md): マシン上の `.html`
  ファイルを、デスクトップアプリや Android アプリでページとして開けます
- [ターミナルキーのカスタマイズ](docs/terminal-keys.md): キーの配置、Shift との組み合わせ、システムキーボードを開き直さずに行う後方削除
- [エージェントブラウザ](docs/agent-browser.md): マシン上のヘッドレス Chromium。エージェントが `offdesk browser` で操作し、人の手が必要になったらあなたに引き渡します
- [ソースからのビルド](docs/building.md) · [セキュリティモデル](SECURITY.md)
- [リリースノートとバージョン履歴](https://github.com/zalify/offdesk/releases)

## インストール

まずは図解付きの Mac セットアップガイドから:
[日本語](https://offdesk.dev/ja/docs/mac) · [English](https://offdesk.dev/docs/mac) ·
[简体中文](https://offdesk.dev/zh/docs/mac)。実際の App のスクリーンショット、スマートフォンのペアリング、最初のターミナルを開くまでの手順、そしてクリーンなアカウントで行ったテストの範囲を載せています。

インストール先は、起動したままにしておくマシン（Mac や NAS）です。たいていは、最初にアクセスしたいマシンでもあります。

**Mac の場合:** [offdesk.dev/mac](https://offdesk.dev/mac) からアプリをダウンロードします（署名・公証済み、Apple シリコンと Intel 共通の dmg ひとつ）。開くと、質問はひとつだけ。「これはどのマシンですか?」です。**The one that stays on**
を選ぶと、Hub、node、tmux を、ログイン時に起動し停止しても再起動するサービスとしてインストールし、このマシンを登録して、スマートフォンで読み取るコードを表示します。アプリはメニューバーに常駐し、そこからスマートフォン用のコード、Hub のアドレス、**Add a machine** にアクセスできます。**Just connecting** を選ぶと、スマートフォンと同じように、別の場所にある Hub のクライアントになります。

**NAS、VPS など画面のないマシンの場合:**

```bash
curl -fsSL https://offdesk.dev/install | sh
```

この 1 行で、3 つのバイナリ（**hub**、**offdesk-node** エージェント、**CLI**）を `~/.local/bin` にインストールします（Linux / macOS、x64 / arm64）。続けて Hub をログイン時に起動し停止しても再起動するサービスとして立ち上げ、このマシンを登録し、サインイン用のリンクを表示します。

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

スマートフォンでコードを読み取るか、このマシンでリンクを開けば（ターミナルの前にいる場合は自動でブラウザが開きます）、あなたは Hub のオーナーとして、このマシンのターミナルを開いた状態になります。Web UI はバイナリに含まれているので、ほかにインストールするものも、設定することもありません。Mac では、Hub の動作中はマシンがアイドルスリープしないようにもします（無効にするには `--allow-idle-sleep`。ディスプレイとフタの動作には影響しません）。

リンクとコードをもう一度表示するには、そのマシンの任意のターミナルで次を実行します。

```bash
offdesk-hub link
```

（CLI のセットアップ後は `offdesk link` でも同じことができます。このマシンに Hub がない場合は、リモートの Hub のアドレスを開きます。）

このリンクを持っている人は誰でもサインインできるため、共有のターミナルには表示しないでください。GitHub または Google によるサインインを設定すると、リンクは表示されなくなります。Hub に外部ネットワークから到達できるようになった時点で設定しておくべきです: [docs/setup-public.md](docs/setup-public.md)。

リンクのアドレスは、同じ Wi-Fi 上のスマートフォンから到達できるものが選ばれます。VPN や TUN モードのプロキシがあっても惑わされません。それでも到達できないアドレスが表示される場合は、`OFFDESK_BASE_URL=http://<このマシンの LAN IP>:4317` を付けて Hub を起動してください。

インストーラーのフラグ: `--no-service` はバイナリをインストールして終了します。その後、同じ `offdesk-hub service install` を自分で実行できます。`--node-only`、`--hub-only`、`--cli-only` はバイナリをひとつだけインストールします。`--prefix <dir>` は別の場所にインストールします。`--system` は `/usr/local/bin` を使います（sudo を求めるのはこの手順だけです）。`offdesk-hub` を単独で実行すると、Hub がフォアグラウンドで動きます。Docker で使う場合やログを見たい場合に便利です。ソースからビルドする場合は [docs/building.md](docs/building.md) を参照してください。

### Docker を使う場合

NAS ではたいていこちらが向いています。

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

`127.0.0.1:4317` にバインドし、データベースを `offdesk-data` ボリュームに保存します。ここでは `JWT_SECRET` を自分で設定してください。コンテナに生成させると値はボリューム内に保存され、ボリュームを失うと全員がサインアウトされます。

## 仕組み

Hub は、クライアントと登録済みノードの間でターミナルの通信を中継します。各ノードは Hub への外向きの WebSocket 接続を維持し、ローカルで tmux を動かします。Hub と、使用中のセッションを持つノードは、どちらもオンラインのままにしておく必要があります。

| コンポーネント | 技術 | 役割 |
| --- | --- | --- |
| Hub | Rust, Axum, SQLite | 認証、マシンの登録管理、ターミナルのルーティング、組み込みの Web UI |
| Node | Rust, tmux, WebSocket | 各 macOS / Linux マシン上の永続的なターミナル |
| Web クライアント | React, TypeScript, xterm.js | ブラウザでの対話的なターミナル描画 |
| ネイティブアプリ | Tauri、共通の Web UI | デスクトップ / モバイルのクライアント、QR ペアリング、暗号化されたネイティブ通信 |
| CLI | Rust、JSON 出力 | 開発者とコーディングエージェントのための、スクリプトから使えるターミナル操作 |

1. **Hub** — `offdesk-hub`。起動したままにしておくマシンで動くひとつのプロセスで、隣に SQLite、Web UI は組み込み済みです。あなたのすべてのマシンを把握しており、クライアントが知っておくべきアドレスはこれだけです。
2. **Node** — `offdesk-node` と tmux。アクセスしたいすべてのマシン（Hub 自身のマシンも含む）で動きます。Hub へ外向きに接続して WebSocket をひとつ開いたままにするので、受信ポートもグローバル IP も要りません。ホテルのルーターの内側のノートパソコンも、自宅の NAT の内側の NAS も、同じ一覧に並びます。すべてのターミナルは、それを持つマシン上の tmux セッションです。アプリが閉じても、ネットワークが切れても、あなたが席を離れても生き続けます。Offdesk をアンインストールしても、ssh で入って `tmux attach` すれば、セッションはそのまま残っています。
3. **クライアント** — Hub と通信するものすべて。ブラウザのタブ、iPhone や Android のアプリ、デスクトップアプリ、`offdesk` CLI、別のマシンで動く別のエージェント。クライアントがノードに直接触れることはありません。Hub にマシンを要求し、Hub がクライアントと tmux の間でバイト列を仲介します。だからこそ、ふたつの画面でひとつのターミナルを共有できます。最後に入力した人がキーボードを持ち、ほかの人はリアルタイムで見守ります。

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

ひとつのターミナルをふたつの画面で見るのは、同じ図が 2 回描かれているだけです。机のブラウザもスマートフォンも、ひとつの Hub のクライアントとして、ひとつの tmux
セッションにアタッチしています。

**誰が入力できるか。** 机とスマートフォンは同じ tmux セッションにアタッチし、同じバイト列を見ています。誰が入力できるかはコントロールリース（control lease）が決めます。リースは（ユーザー、マシン）単位で保持され、入力を送ると取得されます。最後に書き込んだ人が勝ち、順番待ちはありません。ほかの人は出力を受け取り続けますが、キー入力、リサイズ、画像の貼り付けは破棄されます。切断されたのではなく、リアルタイムで見守っている状態です。読み取りと待機ではリースを取得しません。リースはメモリ上にしかないため、Hub を再起動すると失われます。tmux は `window-size manual` で動いているので、スマートフォンがアタッチしても机の画面サイズは変わりません。

### マシンを追加する

Hub が動くマシンは、インストール時に登録されます。ほかにアクセスしたいマシンがあれば、ブラウザで Hub を開き、マシンスイッチャーで **Add a machine** を選びます（マシンがまだない新しい Hub では、自動的にそのページが開きます）。トークンが埋め込まれた 1 行が表示されます。

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://192.168.1.10:4317/ws/machine --token <token>
```

これを新しいマシンのターミナルに貼り付けます。エージェントだけをインストールし、マシンをあなたの Hub に登録し、エージェントをサービスとして動かし続けます（Linux では systemd のユーザーサービス、macOS では launchd エージェント）。tmux は必須です。エージェントは起動時に tmux の有無を確認し、なければ終了します。

`<token>` は登録トークンです。Hub は新しいマシンごとにトークンを発行し、ノードとあなたの Hub を結びつけるのはこのトークンだけです。手で入力する必要はなく、ページに表示される行に含まれています。各トークンは 1 回だけ使え、発行から 24 時間で失効します。次のマシンには新しいトークンを生成してください。同じ行で、マシンをある Hub
から別の Hub へ移すこともできます。また、インストール時に Hub のマシンが以前から所属していた別の Hub に残された場合は、この行で登録し直せます。

手動で行う場合は、`offdesk-node register --hub-url … --token …` に続けて `offdesk-node service install` を実行します。登録すると、インストール済みのエージェントサービスが再起動され、新しい Hub がすぐに有効になります。

`service install` により、再起動後も動き続けます（Linux では systemd のユーザーサービス、macOS では launchd エージェント）。代わりに `offdesk-node start` を使うとフォアグラウンドで動きます。

macOS では、到達可能な状態を保つため、動作中のノードはデフォルトでシステムの自動アイドルスリープを防ぎます。ディスプレイがオフになることはありますし、ノートパソコンのフタを閉じる、スリープを選ぶ、バッテリー残量が極端に少なくなる、といった場合は Mac がスリープすることがあります。無効にするには、`~/Library/Application Support/offdesk/machine.json` に `"prevent_idle_sleep": false` を追加し、`offdesk-node service restart` でノードを再起動してください（フォアグラウンドのノードなら、停止してから起動し直します）。

## 2 つの構成

どちらの構成でもバイナリは同じです。違いは、スマートフォンからすでに Hub のアドレスに到達できるかどうかだけです。

- **自宅で、机から離れて** — Hub は Mac か NAS に置き、スマートフォンは同じ Wi-Fi につなぎます。TLS もドメインも不要です。→ [docs/setup-lan.md](docs/setup-lan.md)
- **外出先から** — Hub を Caddy の背後の VPS に置く、自宅で Cloudflare Tunnel の背後に置く、または tailnet 上に置きます。ガイドでは、最終的に誰があなたの通信を読めることになるかという観点で、これらを比較しています。→ [docs/setup-public.md](docs/setup-public.md)

## トラブルシューティング

- [ローカルネットワークでは動くのに、リモート接続が Unreachable になる](docs/troubleshooting/remote-connection.md)

## スマートフォンで使う

ブラウザだけでクライアントとして完結します。Hub の URL を開けば、どのスマートフォンからでも使えます。Ctrl-C、Esc、Tab、矢印キーを備えたキーバー付きの、本物のターミナルです。エージェントは質問してきますし、ビルドには Ctrl-C が必要だからです。キーは均等なグリッドに並び、`↑` は `↓` の真上にあります。矢印キー、Enter、キーボード表示の切り替えは動きません。それ以外のキーは Settings で並べ替えられます（[ターミナルキーのカスタマイズ](docs/terminal-keys.md)）。

タイトルバーには、いま開いているターミナル、そのマシン、そしてあなたが操作中か閲覧中かが表示されます。ターミナル名をタップするとセッションスイッチャーが開き、そこから新しいターミナルも作れます。その横の `[f]` でマシンのファイル（最も幅の狭いスマートフォンでは `[m]` メニューから）、`[b]` でエージェントブラウザ、`[m]` で Machines & Hub を開きます。

別のターミナルの Claude Code や Codex が確認を求めると、タイトルバーの下の帯に表示されます。ターミナルをタップすると開き、その `[enter]` をタップすると、いまの画面のまま、現在選択されている選択肢で確定します。いま開いているターミナルの場合は、代わりにキーの上に待機中のカードが表示されます。検出の限界や、どのコンポーネントの更新が必要かについては、[ターミナルの通知と入力の挙動](docs/terminal-attention.md)を参照してください。

パッケージ化されたクライアントも 3 つあります。

- **iPhone / iPad** — [公開 TestFlight ベータ](https://testflight.apple.com/join/rV4ktaGv)に参加してください。App で **Scan QR Code** を開き、Hub の暗号化ペアリングコードを読み取ります。暗号化接続では App 自身の署名済みインターフェースを使います。インターフェースはデスクトップ版や Android 版と同じくネット経由で更新され（0.9.2 以降）、App 本体は TestFlight で更新します。ひとつのビルドでどの Hub
  にも接続できます。LAN 上の Hub への接続を妨げうる設定がスマートフォンに 2 つあり、該当する場合はアプリがその名前を表示します。ローカルネットワークと、中国で販売された端末ではワイヤレスデータです。`v*` タグからビルドされ、Hub と一緒に公開されます。
- **Android** — [offdesk.dev/apk](https://offdesk.dev/apk) から APK を入手します。このリンクは常に最新のアプリビルドを指します（ユニバーサル版は `/apk/universal`）。最近の端末なら `arm64-v8a`、迷ったら `universal` を選んでください。サイドロードして使います。アプリ内の更新チェック、クリップボード、暗号化ペアリングに対応しています。初回起動時に Hub が表示するコード（インストール時のターミナル、Phone ボタンの中、または `offdesk-hub link`）を読み取ると、サインインが完了します。ひとつの APK でどの Hub にも接続でき、Hub に関する情報は何も組み込まれていません。アドレスを手入力したり、サインインリンクを貼り付けたりすることもできます。
- **デスクトップ** — macOS（[offdesk.dev/mac](https://offdesk.dev/mac)、署名・公証済み）、Windows（[/windows](https://offdesk.dev/windows)）、Linux
  （[/linux](https://offdesk.dev/linux)）。自動アップデート付きです。tmux 風のタブ、誰がターミナルを開いたかを示すペインヘッダー、あなたを待っているターミナルを示すステータスラインを備えています。Mac では Hub にもなれます（[インストール](#インストール)を参照）。Windows と Linux ではクライアントとして動き、Hub のリンクを尋ねます。`v*` タグからビルドされ、Hub と一緒に公開されます。

いずれも自分でビルドする場合は [docs/building.md](docs/building.md) を参照してください。

### 好きなエージェントを使う

Offdesk はエージェントをラップせず、そのプロトコルも話しません。エージェントがすでに動いているターミナルを、あなた自身のサブスクリプション、設定、dotfiles のまま手渡します。tmux で動くものは何でもここで動きます。Claude Code、Codex、OpenCode、Gemini CLI、Aider、vim、htop、1 時間かかるビルド。ターミナルへのアクセスに、エージェント固有の連携は必要ありません。

Linux と macOS では、Codex がターミナルのタイトルにプロジェクト名しか出さない場合でも、ノードがローカルの Codex セッション名を認識してターミナル一覧に表示します。Codex の設定変更は不要です。そのペインの Codex プロセスが開いているセッションのメタデータを読み取ります。セッションを特定できない場合やメタデータを取得できない場合は、通常のターミナルタイトルが使われます。

## エージェント向け

トークンがひとつあれば、どのエージェントもあなたのどのマシンでも操作できます。どのスクリプトも、どのマシンのどのエージェントも、Hub に登録されたほかのマシンでターミナルを **open** し、キー入力を **send** し、**wait** で待ち、**read** で読み取れます。エージェントのセッションではなくターミナルなので、操作する対象は、あなたが手で実行していたものとまったく同じです。

```bash
T=$(offdesk open nas --cwd ~/projects/foo --cmd claude --json | jq -r .id)
offdesk send $T "fix the type errors in src/auth.ts; stop when tests pass"
offdesk wait $T --silence 5000 --timeout 600     # プロンプトを待つなら --pattern '❯'
offdesk read $T --lines 80                       # 結果を回収する
offdesk kill $T --yes
```

### CLI のセットアップ

CLI はインストーラーがすでに配置しています。Web UI で API トークンを作成し（Settings → API tokens → Create）、設定ファイルに書くか、

```toml
# ~/.config/offdesk/config.toml  (chmod 600)
# macOS: ~/Library/Application Support/offdesk/config.toml
url   = "https://your-hub.example.com"
token = "odk_..."
```

`OFFDESK_URL` と `OFFDESK_TOKEN` を export します。`--url` と `--token` はどちらよりも優先されます。

### コマンド

```
offdesk machines [--all] [--json]               # マシンを一覧表示（デフォルトはオンラインのみ、--all でオフラインも含む）
offdesk machines rm <id|name> [--yes]           # 登録済みのマシンを削除する
offdesk ls [--machine <id>] [--json]            # ターミナルを一覧表示: id、タイトル、グループ、cwd、サイズ、到達可否、開いた人
offdesk open <machine> --cwd <dir> [--cmd <shell command>] [--group <name>] [--label <name>] [--json]
offdesk read <term> [--lines N] [--json]        # 現在の画面をテキストとして取得する
offdesk read --all [--machine <id>] [--lines N] [--json] [--concurrency N] [--include-unreachable]
                                                # すべてのターミナルの画面を 1 回の呼び出しでまとめて取得する
offdesk send <term> <text...> [--no-enter]      # テキストを入力する（デフォルトで Enter を付加）
offdesk key  <term> <KEY>...                    # Enter Esc Tab BTab Up Down Left Right C-c C-d F1-F12 ...
offdesk wait <term> [--pattern <regex>] [--silence <ms>] [--timeout <sec>]
offdesk kill <term> [--yes]
offdesk layout equalize --group <name|cwd:path> [--machine <id>] [--json]
                                                # グループのペイン分割を均等にする。Web クライアントは即座に反映
offdesk layout rotate --group <name|cwd:path> [--machine <id>] [--json]
                                                # すべての分割を左右と上下で切り替える
offdesk browser open [URL] [--machine M] [--json]   # ノードのヘッドレス Chromium でタブを開き、その id を表示する
offdesk browser ls [--machine M] [--json]           # エージェントブラウザを一覧表示
offdesk browser goto|snapshot|click|fill|upload|press|dialog|wait|screenshot|close <browser> ...
                                                # ブラウザを操作する。docs/agent-browser.md を参照
offdesk browser handoff <browser> --reason "Please log in" [--wait]   # 人に助けを求める
offdesk browser wait-control <browser>          # 人が操作している間は待機する（タイムアウトで exit 1）
offdesk browser take <browser> --reason "..." [--force]   # 人から操作を取り戻す
offdesk mcp                                     # エージェントブラウザを stdio 上の MCP ツールとして提供: claude mcp add offdesk -- offdesk mcp
offdesk fetch <path>... [--plain]               # このマシンのファイル / フォルダのクリックでダウンロードできるリンク（OSC 8）を表示。1 ファイル最大 20 MiB。Hub のトークン不要
offdesk link [--no-open]                        # Hub をブラウザで開く。Hub のマシンではサインインリンクとコードを表示
```

- マシンとターミナルは **id のプレフィックス**（`ls` の最初の列）で指定します。プレフィックスがあいまいな場合は候補が表示されます。
- CLI が開いたターミナルには、アプリと `ls` で「opened by agent」と表示されます。名前は `--label`、なければ API トークンの名前になるので、自分で開いたものと区別できます。アプリで開いたターミナルには何も表示されません。
- 終了コード: `0` 成功または待機条件を満たした · `1` 待機がタイムアウトした ·
  `2` 使い方 / 設定 / ネットワークのエラー · `3` 人がブラウザを操作しているためエージェントブラウザのコマンドが拒否された。出力を伴うすべてのコマンドで `--json` を使えます。
- `--lines N` は、テキストモードでも JSON モードでも「現在の画面で描画された最後の N 行」（末尾の空行を除いたもの）を意味します。JSON では `lines_total`（切り出し前の行数）と `truncated` も返します。
- 表示・シリアライズされる出力はすべてサニタイズされます。制御バイトは除去され、`\n`/`\t` と Unicode は保持されます。`jq` にそのままパイプできます。
- `send` はテキストを入力したあと、Enter を **遅延させた別フレーム**として送ります（150 ms ＋改行 1 つにつき 60 ms、上限 800 ms）。複数行の連続入力を貼り付けとして扱う TUI アプリでも、確実に送信されるようにするためです。`--no-enter` を付けるとテキストのフレームだけを送ります。
- `read --all --json` はデフォルトで **到達可能なターミナルのみ**を返し、トップレベルに `skipped_unreachable_count` を含めます。`--include-unreachable`
  を付けると、それらの `{"error":"unreachable"}` エントリも含まれます。取得された各エントリには `pane_title`、`title_source`（`osc`/`process`/`none`）、`foreground_process`（`{has_foreground_process, process_name}`、取得に失敗した場合は null）、`activity`（`active`/`quiet`/`idle`）、`idle_ms` が含まれます。activity は取得時間内に観測したものだけです。`cwd` は作成時のものではなく、現在の値（tmux の `pane_current_path`）です。

### 知っておくべき挙動

1. **`send`/`key` は操作権を取得します**（最後に書き込んだ人が勝ち）。同じアカウントのほかのクライアントは、人が取り戻すまで閲覧専用になります。人が入力しているかもしれない場合は、先に読み取ってください。CLI は `open` と `kill`
   でもリースを取得します。
2. **`read`/`wait` は純粋な観察者です。** 操作権を取得せず、ほかのクライアントの邪魔もしません。tmux は `window-size manual` で動くので、アタッチしても誰の表示サイズも変わりません。
3. **`read` が見るのは現在の画面だけです。** tmux にアタッチしたときの再描画から画面を再構成します。スクロールバックは見えません。長い出力は、セッション内のエージェントにファイルへ書き出させ、そのファイルを読んでください。
4. **`read` を繰り返してポーリングしないでください。** 呼び出しのたびにアタッチが発生し、約 1 秒かかります。代わりに `wait` で条件を待ってください。
5. **すべてのターミナルを見渡すには `read --all` を使ってください。** N 個の CLI
   プロセスで `read` をループしないでください。N×（TLS ＋アタッチ）のコストがかかり、stdout を並行して読み出さない呼び出し側は、パイプのバッファでデッドロックすることがあります。
6. `REACHABLE=no` のターミナルはオフラインのマシンのもので、アタッチできません。`read --all` はそれらをスキップし、その数を stderr に、JSON では `skipped_unreachable_count` として報告します。
7. **トークンは、登録されたすべてのマシンでのリモートコード実行を意味します。**
   エージェントごとに発行して名前を付け、使い終わったら個別に失効させてください。

## 他ツールとの比較

複数のマシンを 1 か所に集約するツールが渡してくれるのはチャットです。本物のターミナルを渡してくれるツールは、マシンごとにサーバーを 1 つ動かします。下の表の各セルは、各ベンダーの公式ドキュメントに基づいています。確認日は 2026-09-01 です。これらの製品は変化が速いので、どの行も頼る前に確認し直してください。

| | 任意のターミナルプログラム | Hub あたりのマシン数 | 通信の経由先 | エージェントが CLI で操作できるか | セルフホスト |
|---|---|---|---|---|---|
| **Offdesk** | tmux で動くものなら何でも | 何台でも、URL はひとつ | 自分の Hub | `open` / `send` / `wait` / `read` | 可能、MIT |
| Claude Code Remote Control | 不可 — ターミナルではなく Claude Code のセッション | 複数のマシンのセッションを 1 つの一覧に表示 | Anthropic のサーバー。トランスクリプトもそこに保存 | ドキュメントなし | 不可 |
| VibeTunnel | 可能 — `vt <any command>`、`vt --shell` | マシンごとにサーバー 1 つ | 選択可: LAN、Tailscale、ngrok、Cloudflare | コマンドの起動のみ。実行中のセッションへの send/read/wait はなし | 可能、MIT |
| Happy Coder | 不可 — `claude` と `codex` をラップ | 複数。`spawn --machine`、`machines` | デフォルトは slopus のクラウド、エンドツーエンド暗号化 | `create` / `send` / `history` / `wait` | 任意、MIT |
| Omnara | エージェントのセッション。生のターミナルについてはドキュメントなし | エージェントごとに複数を同時に | デフォルトは `api.omnara.com` | CLI と REST: `POST .../inputs`、SSE タイムライン | 任意、Apache-2.0 |
| Orca | 可能 — 本物のターミナル、30 以上の CLI エージェント | マシンごとにサーバー 1 つ。SSH worktree でほかのマシンに接続 | デフォルトは Orca Relay、または LAN で直接 | `orca terminal create/send/read/wait` | 可能、MIT |

各セルの出典は[英語版 README](README.md#how-it-compares) の表の下にあるコメントに記載しています。

### この表からわかること

この分野は 2 つに分かれます。そしてその違いは、品質の差ではありません。

**集約はできるが、会話になる。** Claude Code Remote Control、Happy Coder、Omnara はいずれも、複数のマシンを 1 か所に集約できます。そこで得られるのはターミナルではなくエージェントのセッションです。エージェントだけが目的なら、それは正しいトレードオフです。

**本物のターミナルだが、マシンごとにサーバーが 1 つ。** VibeTunnel と Orca はどちらも本物のターミナルを提供します。どちらもマシンごとにサーバーを 1 つ動かします。VibeTunnel は設計上そうなっており、Orca は Remote Orca Server が 1 台のホストに結びつき、ほかのマシンには SSH で接続するためです。

Offdesk はその組み合わせです。自分のどのマシンから離れても、自分で運用するサーバーを通じて、スマートフォンから本物のターミナルを引き継げます。ほかの 5 つはいずれも、エージェント、マシン、サーバーの 3 つのうちどれかひとつが欠けています。

この表が裏付けるのはこの主張だけで、「より優れている」よりもずっと狭いものです。並列の git worktree、差分レビュー、エージェントを囲むブラウザやエミュレーターの仕組みがほしいなら、**Orca** は Offdesk よりはるかに多くのことができ、こちらも MIT
です。1 台のマシンのターミナルを最小限のセットアップでブラウザから使いたいなら、**VibeTunnel** のほうが運用するものが少なくて済みます。Claude Code しか使わず、セットアップをゼロにしたいなら、**Remote Control** はすでにあなたの CLI に入っています。

## セキュリティ

**トークンは、登録されたすべてのマシンでのリモートコード実行を意味します。**
トークンはターミナルを開いて入力でき、ターミナルではシェルが実行できることなら何でも実行できます。API キーではなく、SSH 鍵と同じように扱ってください。

その影響を抑えるために Hub が用意しているもの:

- **エージェントごとにトークンを 1 つ。** どのトークンにも、作成時に自分で決めた名前が付きます。
- **個別に失効。** トークンを 1 つ削除しても、ほかのトークンには影響しません。
- **最終使用日時。** 各トークンは最後に認証した日時を記録するので、どれが使われているかがわかります。
- トークンは SHA-256 ハッシュとして保存されます。平文は作成時に 1 度だけ表示され、あとから取り出すことはできません。

Hub が表示するサインインリンクは、持っている人なら誰でもサインインできます。パスワードと同じように扱ってください。コントロールリースはセキュリティ境界ではなく、有効なトークンを持つ人を止めることはできません。

脅威モデル、コントロールリースが防げることと防げないこと、Hub が SQLite に保存する内容については [SECURITY.md](SECURITY.md) を参照してください。

## よくある質問

**Offdesk は SSH クライアントですか?** Offdesk は独自の Hub/node 間の WebSocket
通信を使います。マシンに `offdesk-node` をインストールすると、そのマシンの tmux
セッションが Hub を通じて使えるようになります。Offdesk が任意の SSH サーバーに接続することはありません。そのマシンの管理や tmux セッションへのアタッチには、別途 SSH を使うこともできます。

**ブラウザやスマートフォンの接続が切れても、ターミナルは残りますか?** tmux はノード上で動いているので、クライアントを閉じたりネットワークが切れたりしてもセッションは終了しません。Hub とノードに再び到達できるようになれば、同じターミナルに再接続できます。ホストのシャットダウンや再起動は別です。tmux は再起動をまたいで実行中のプロセスを保持しません。

**アカウントは必要ですか?** セルフホストにベンダーのアカウントは不要です。インストール時にローカルユーザーとサインインリンクが作成されます。オプションの Offdesk Cloud は、マネージドなリモートアクセスのために別のサインインを使います。

**通信は offdesk.dev を経由しますか?** LAN での直接接続は、あなたの Hub に向かいます。オプションの Offdesk Cloud は、App の暗号化された通信を `*.cloud.offdesk.dev`
配下のマネージドなアドレス経由でルーティングします。自分で管理するトンネルを使う場合は、そのプロバイダーを経由します。[暗号化ペアリング](docs/encrypted-connections.md)は App と Hub の間のターミナルの内容を保護します。通常のブラウザ用サインインリンクは別のモードです。

**Claude Code 専用ですか?** これはターミナルです。Claude Code、Codex、OpenCode、1 時間かかるビルド、vim。tmux で動くものは何でもここで動き、Offdesk はそれが何かを知りませんし、気にもしません。

**iPhone はどうですか?** アプリがあります（現在は TestFlight で提供）。[スマートフォンで使う](#スマートフォンで使う)を参照してください。アプリがなくても、ブラウザだけでクライアントとして完結します。カメラで Hub のコードを読み取り、ページをホーム画面に追加してください。Android にもアプリがあります。暗号化ペアリングのコードはアプリ内のスキャナーで読み取り、ブラウザで接続するときは通常のサインインリンクを使ってください。

**2 人が同時に入力したらどうなりますか?** 誰が入力できるかはコントロールリースが決めます。入力を送るとリースが取得され、最後に書き込んだ人が勝ち、順番待ちはありません。ほかの人は出力を受け取り続けるので、切断されるのではなく、リアルタイムで見守ることになります。

## コミュニティ

質問やセットアップの相談は [Discord](https://discord.gg/aFUu6VMzc) へ、バグは GitHub の [issues](https://github.com/zalify/offdesk/issues) へどうぞ。

## ライセンス

`crates/` 以下（Hub、node、CLI、プロトコルと暗号化の crate）と `packages/shared` は MIT ライセンスです。Web UI（`packages/app`）とデスクトップ・Android・iOS アプリ（`packages/desktop`）は Functional Source License（FSL-1.1-MIT）です。閲覧、監査、ビルド、改変、利用（業務での利用を含む）はできますが、競合製品として提供することはできません。各バージョンはリリースの 2 年後に MIT になります。0.25.0 までのバージョンはすべて MIT です。[LICENSE](LICENSE) と [TRADEMARKS.md](TRADEMARKS.md) を参照してください。オプションの Offdesk Cloud サービスは別途管理されており、ここには含まれていません。
