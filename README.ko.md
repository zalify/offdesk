<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" alt="Offdesk DEV" height="48">
  </picture>
</p>

<p align="center">
  <img src="docs/media/hero-banner.png" alt="당신과 에이전트가 함께 쓰는 하나의 터미널. 직접 운영하는 하나의 Hub 뒤에서, 모든 머신의 tmux 속 어떤 프로그램이든." width="800">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>한국어</b> ·
  <a href="README.es.md">Español</a>
</p>

# Offdesk DEV — tmux와 AI 코딩 에이전트를 위한 셀프 호스팅 원격 터미널

> 이 문서는 [영어 README](README.md)의 번역본입니다. 두 문서의 내용이 다를 경우
> 영어 README를 기준으로 합니다. 한국어 웹사이트: <https://offdesk.dev/ko/>

**당신과 에이전트가 함께 쓰는 하나의 터미널.** 에이전트는 `offdesk` CLI로
터미널을 열고, 입력하고, 내용을 읽습니다. 당신은 같은 터미널을 휴대폰에서
지켜보다가 에이전트에게 사람이 필요할 때 키보드를 넘겨받으면 됩니다.

**Claude Code, Codex, OpenCode를 비롯한 모든 터미널 프로그램**을 브라우저,
iPhone, Android 휴대폰, 데스크톱 앱에서 사용할 수 있습니다. Offdesk는 직접
운영하는 하나의 Hub를 통해, 내 macOS·Linux 머신에서 계속 살아 있는
**tmux 세션**에 클라이언트를 연결합니다. 명령은 원격 머신에서 실행되고,
클라이언트는 WebSocket 연결로 터미널 입출력을 주고받습니다.

설치되는 앱의 이름은 **Offdesk DEV**이며, 이 README에서는 줄여서 Offdesk라고
부릅니다. 명령줄 도구는 `offdesk`라는 이름을 그대로 씁니다. `offdesk` CLI,
`offdesk-hub` 서버, `offdesk-node` 머신 에이전트가 그것입니다.

휴대폰으로 AI 코딩 에이전트의 진행 상황을 확인하거나, 네트워크가 끊긴 뒤
셸을 그대로 이어 쓰거나, Mac·Linux 서버·NAS·VPS의 터미널을 한 화면에서
관리할 때 쓸 수 있습니다. 단, Hub와 세션이 돌아가는 머신은 계속 켜져 있어야
합니다.

- **지속되는 원격 세션:** 대화형 CLI, 에디터, 빌드 출력, 셸 히스토리까지
  포함해 같은 tmux 터미널에 다시 연결
- **하나의 Hub 뒤에 여러 머신:** 각 `offdesk-node`가 Hub로 아웃바운드 연결을
  맺으므로 노드에는 인바운드 포트도 공인 IP도 필요 없음
- **모바일 터미널 조작:** 균등한 격자로 배치된 키 바. 단축키 구성 변경,
  Shift+Tab, Shift 조합, Backspace 길게 눌러 반복 입력을 지원하며 방향키,
  Enter, 키보드 토글은 고정. 파일 첨부와 QR 코드를 이용한 암호화된 앱 페어링.
  제목 표시줄의 터미널 이름을 탭하면 세션 전환, 옆의 `[f]`, `[b]`, `[m]`은
  각각 파일, 에이전트 브라우저, Machines & Hub
- **CLI 자동화:** `offdesk open / send / wait / read`와 JSON 출력으로 터미널을
  열고, 입력을 보내고, 출력을 기다리고, 결과를 읽기. 에이전트가 연 터미널은
  앱에 그렇게 표시됨
- **셀프 호스팅 배포:** macOS/Linux용 Rust 바이너리 또는 Docker. 저장소는
  SQLite이고 웹 UI는 Hub 바이너리에 내장
- **암호화된 앱 연결:** 페어링한 앱과 Hub 사이의 종단 간 암호화. 일반
  브라우저 접속은 별도의 로그인 흐름을 사용하며, 브라우저로 공개 접속하려면
  HTTPS와 인증이 필요

이 저장소의 Hub, node, CLI, 클라이언트는 모두 **MIT 라이선스**입니다. 셀프
호스팅에는 벤더 계정이 필요 없습니다. 선택 사항인 **Offdesk Cloud**는 관리형
원격 접속을 제공하는 별도의 비공개 소스 서비스입니다. 이 서비스의 오픈 소스
로컬 커넥터는 암호화된 연결 가능 여부를 확인하고, 터널 장애가 계속되면 자동으로
재시작하며, 장애가 길어지면 재시도 간격을 늘립니다.

질문, 잘 되지 않은 설정, 원하는 기능은
[Discord](https://discord.gg/aFUu6VMzc)로 알려 주세요.

## 다운로드

| | | |
|---|---|---|
| **macOS** | [offdesk.dev/mac](https://offdesk.dev/mac) | Apple silicon과 Intel 공용 dmg 하나, 서명 및 공증 완료. Hub로 쓸 수 있음 |
| **Windows** | [offdesk.dev/windows](https://offdesk.dev/windows) | x64 `.msi`. 클라이언트 |
| **Linux** | [offdesk.dev/linux](https://offdesk.dev/linux) | x64 `.AppImage`. `.deb`와 `.rpm`은 [릴리스 페이지](https://offdesk.dev/desktop)에서. 클라이언트 |
| **iPhone / iPad** | [TestFlight 참여](https://testflight.apple.com/join/rV4ktaGv) | 암호화 페어링은 앱으로. 브라우저에서는 Hub 로그인 링크 사용 가능 |
| **Android** | [offdesk.dev/apk](https://offdesk.dev/apk) | `arm64-v8a`. 잘 모르겠다면 [`/apk/universal`](https://offdesk.dev/apk/universal) |
| **Hub, node, CLI** | `curl -fsSL https://offdesk.dev/install \| sh` | Linux와 macOS, x64와 arm64. NAS, VPS 등 화면 없는 모든 머신용 |

모든 링크는 해당 종류의 최신 릴리스를 가리킵니다. Windows는 데스크톱
클라이언트 전용이고, Linux는 tmux를 따로 설치하면 Hub도 운영할 수 있습니다.

## 문서

- [macOS 설치와 휴대폰 페어링](https://offdesk.dev/ko/docs/mac)
- [LAN 설정](docs/setup-lan.md)과 [HTTPS, OAuth, Tailscale을 이용한 공개 접속](docs/setup-public.md)
- [종단 간 암호화된 앱 연결](docs/encrypted-connections.md)과
  [선택 사항인 Offdesk Cloud 설정](docs/managed-connections.md)
- [localhost 웹 미리보기](docs/web-previews.md): 전용 미리보기 도메인과 HTTPS
  인그레스를 쓰는 옵트인 포워딩. 터미널 E2EE와는 별개
- [HTML 파일 미리보기](docs/html-file-previews.md): 머신에 있는 `.html` 파일을
  데스크톱 또는 Android 앱에서 페이지로 열기
- [터미널 키 사용자 지정](docs/terminal-keys.md): 키 배치, Shift 조합, 시스템
  키보드를 다시 열지 않고 뒤로 지우기
- [에이전트 브라우저](docs/agent-browser.md): 에이전트가 `offdesk browser`로
  조작하고, 사람이 필요할 때 당신에게 넘기는 머신의 헤드리스 Chromium
- [소스에서 빌드](docs/building.md) · [보안 모델](SECURITY.md)
- [릴리스 노트와 버전 기록](https://github.com/zalify/offdesk/releases)

## 설치

그림으로 설명한 Mac 설정 가이드부터 보세요:
[한국어](https://offdesk.dev/ko/docs/mac) · [English](https://offdesk.dev/docs/mac) ·
[简体中文](https://offdesk.dev/zh/docs/mac). 실제 앱 스크린샷, 휴대폰 페어링,
첫 터미널을 여는 단계, 그리고 새 계정 환경에서 테스트한 범위가 담겨 있습니다.

설치는 항상 켜 두는 머신(Mac이나 NAS)에서 합니다. 대개 그 머신이 가장 먼저
접속하고 싶은 머신이기도 합니다.

**Mac:** [offdesk.dev/mac](https://offdesk.dev/mac)에서 앱을 내려받습니다
(서명 및 공증 완료, Apple silicon과 Intel 공용 dmg 하나). 앱을 열면 질문을
하나 합니다. 이 머신은 어떤 머신인가요? **The one that stays on**을 고르면
Hub, node, tmux를 로그인 시 실행되고 멈추면 다시 시작되는 서비스로 설치하고,
이 머신을 등록한 뒤, 휴대폰으로 스캔할 코드를 보여 줍니다. 앱은 메뉴 막대에
남고, 휴대폰용 코드, Hub 주소, **Add a machine**이 그곳에 있습니다.
**Just connecting**을 고르면 휴대폰처럼 다른 곳에 있는 Hub의 클라이언트가
됩니다.

**NAS, VPS 등 화면 없는 머신:**

```bash
curl -fsSL https://offdesk.dev/install | sh
```

이 한 줄이 세 바이너리, 즉 **Hub**, **offdesk-node** 에이전트, **CLI**를
x64·arm64의 Linux와 macOS에서 `~/.local/bin`에 설치합니다. 이어서 Hub를
로그인 시 실행되고 멈추면 다시 시작되는 서비스로 띄우고, 이 머신을 Hub에
등록한 다음, 바로 로그인되는 링크를 출력합니다:

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

휴대폰으로 코드를 스캔하거나 이 머신에서 링크를 열면(터미널 앞에 있다면
브라우저에서 알아서 열립니다) Hub의 소유자로서 이 머신의 터미널을 보게
됩니다. 웹 UI는 바이너리 안에 들어 있으므로 따로 설치하거나 설정할 것이
없습니다. Mac에서는 Hub가 실행되는 동안 머신이 유휴 상태로 잠자기에 들지
않도록 막습니다(해제하려면 `--allow-idle-sleep`. 디스플레이와 덮개 동작에는
영향이 없습니다).

링크와 코드를 다시 보려면 그 머신의 아무 터미널에서:

```bash
offdesk-hub link
```

(CLI를 설정하고 나면 `offdesk link`도 같은 일을 하며, 이 머신에 Hub가 없을
때는 원격 Hub의 주소를 엽니다.)

이 링크는 가진 사람 누구나 로그인시키므로 공유 터미널에 남기지 마세요.
GitHub 또는 Google 로그인을 설정하면 더 이상 출력되지 않습니다. Hub가
외부 네트워크에서 접근 가능해지는 순간 반드시 설정해야 합니다:
[docs/setup-public.md](docs/setup-public.md).

링크의 주소는 같은 Wi-Fi에 있는 휴대폰이 접근할 수 있는 주소이며, VPN이나
TUN 모드 프록시가 있어도 잘못 고르지 않습니다. 그래도 접근할 수 없는 주소가
출력된다면 `OFFDESK_BASE_URL=http://<this machine's LAN IP>:4317`로 Hub를
시작하세요.

설치 스크립트 플래그: `--no-service`는 바이너리만 설치하고 멈추며, 이후
`offdesk-hub service install`은 직접 실행하면 됩니다. `--node-only`,
`--hub-only`, `--cli-only`는 바이너리 하나만 설치합니다. `--prefix <dir>`는
다른 위치에 설치하고, `--system`은 `/usr/local/bin`을 사용합니다(이 단계에서만
sudo를 요청합니다). `offdesk-hub`를 단독으로 실행하면 Hub가 포그라운드에서
돌아가므로 Docker에서 쓰거나 로그를 지켜볼 때 좋습니다. 소스에서 빌드하려면:
[docs/building.md](docs/building.md).

### Docker로 설치하기

NAS라면 보통 이 방법이 좋습니다:

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

`127.0.0.1:4317`에 바인딩하고 데이터베이스는 `offdesk-data` 볼륨에
저장합니다. 여기서는 `JWT_SECRET`을 직접 지정하세요. 컨테이너가 직접 생성한
값은 볼륨에 저장되므로, 볼륨을 잃으면 모두 로그아웃됩니다.

## 작동 방식

Hub는 클라이언트와 등록된 노드 사이에서 터미널 트래픽을 중계합니다. 각
노드는 Hub로 향하는 아웃바운드 WebSocket 연결을 유지하고 로컬에서 tmux를
실행합니다. Hub와, 사용 중인 세션을 제공하는 노드는 모두 계속 켜져 있어야
합니다.

| 구성 요소 | 기술 | 역할 |
| --- | --- | --- |
| Hub | Rust, Axum, SQLite | 인증, 머신 레지스트리, 터미널 라우팅, 내장 웹 UI |
| Node | Rust, tmux, WebSocket | 각 macOS·Linux 머신의 지속되는 터미널 |
| 웹 클라이언트 | React, TypeScript, xterm.js | 브라우저에서 대화형 터미널 렌더링 |
| 네이티브 앱 | Tauri, 공유 웹 UI | 데스크톱/모바일 클라이언트, QR 페어링, 암호화된 네이티브 전송 |
| CLI | Rust, JSON 출력 | 개발자와 코딩 에이전트를 위한 스크립트 가능한 터미널 제어 |

1. **Hub** — `offdesk-hub`. 항상 켜 두는 머신에서 도는 프로세스 하나로, 옆에
   SQLite가 있고 웹 UI가 내장되어 있습니다. 내 모든 머신을 알고 있으며,
   클라이언트가 알아야 할 주소는 이것 하나뿐입니다.
2. **Node** — `offdesk-node`와 tmux. Hub가 도는 머신을 포함해, 접속하려는 모든
   머신에 설치합니다. Hub로 먼저 연결해 WebSocket 하나를 열어 두므로 인바운드
   포트나 공인 IP가 전혀 필요 없습니다. 호텔 공유기 뒤의 노트북도, 집 NAT 뒤의
   NAS도 한 목록에 나타납니다. 모든 터미널은 그것을 소유한 머신의 tmux
   세션입니다. 앱이 꺼져도, 네트워크가 끊겨도, 자리를 떠나도 살아 있습니다.
   Offdesk를 제거하고 ssh로 들어가 `tmux attach`를 해도 세션은 그대로 있습니다.
3. **Client** — Hub와 통신하는 모든 것. 브라우저 탭, iPhone·Android 앱, 데스크톱
   앱, `offdesk` CLI, 다른 머신의 또 다른 에이전트. 클라이언트는 노드에 직접
   닿지 않습니다. Hub에 머신을 요청하면 Hub가 클라이언트와 tmux 사이에서
   바이트를 중계합니다. 그래서 두 화면이 하나의 터미널을 공유할 수 있습니다.
   마지막으로 입력한 쪽이 키보드를 잡고, 나머지는 실시간으로 지켜봅니다.

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

한 터미널을 두 화면에서 보는 것은 같은 그림이 두 번 있는 것일 뿐입니다. 책상의
브라우저와 휴대폰은 둘 다 하나의 Hub에 연결된 클라이언트이고, 같은 tmux
세션에 붙어 있습니다.

**누가 입력할 수 있는가.** 책상과 휴대폰은 같은 tmux 세션에 붙어 같은 바이트를
봅니다. 누가 입력할 수 있는지는 제어 리스(control lease)가 정합니다. 리스는
(사용자, 머신) 단위로 유지되며, 입력을 보내면 리스를 가져옵니다. 마지막
입력자가 이기고, 대기열은 없습니다. 나머지 클라이언트는 출력을 계속 받지만
키 입력, 크기 조정, 이미지 붙여넣기는 버려집니다. 연결이 끊긴 것이 아니라
실시간으로 지켜보는 상태입니다. 읽기와 대기는 리스를 가져오지 않습니다.
리스는 메모리에만 있으므로 Hub를 재시작하면 사라집니다. tmux가
`window-size manual`로 실행되므로 휴대폰이 붙어도 책상 쪽 화면 크기는 바뀌지
않습니다.

### 머신 추가하기

Hub가 도는 머신은 설치 과정에서 등록됩니다. 접속하려는 다른 머신이 있다면
브라우저에서 Hub를 열고 머신 전환기에서 **Add a machine**을 고르세요(아직
머신이 없는 새 Hub는 처음부터 그 페이지가 열립니다). 토큰이 채워진 한 줄이
표시됩니다:

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://192.168.1.10:4317/ws/machine --token <token>
```

새 머신의 터미널에 붙여 넣으세요. 에이전트만 설치하고, 머신을 Hub에 등록한
뒤, 에이전트를 서비스로 계속 실행합니다. Linux에서는 systemd 사용자 서비스,
macOS에서는 launchd 에이전트입니다. tmux는 필수이며, 에이전트는 시작할 때
tmux를 확인하고 없으면 종료합니다.

`<token>`은 등록 토큰입니다. Hub가 새 머신마다 하나씩 발급하며, 노드를 내
Hub에 묶는 유일한 수단입니다. 직접 입력할 필요는 없고, 페이지에 표시된 줄에
들어 있습니다. 각 토큰은 한 번만 쓸 수 있고 발급 후 24시간이 지나면
만료됩니다. 다음 머신을 위해서는 새로 발급하세요. 같은 줄로 머신을 다른
Hub로 옮길 수도 있고, 설치 시 Hub가 도는 머신이 원래 속해 있던 Hub에 그대로
남았다면 그 머신을 다시 등록할 수도 있습니다.

직접 하려면 `offdesk-node register --hub-url … --token …` 다음에
`offdesk-node service install`을 실행합니다. 등록하면 이미 설치된 에이전트
서비스가 재시작되므로 새 Hub가 바로 적용됩니다.

`service install`은 재부팅 후에도 계속 실행되게 합니다. Linux에서는 systemd
사용자 서비스, macOS에서는 launchd 에이전트입니다. 대신 포그라운드에서
실행하려면 `offdesk-node start`를 씁니다.

macOS에서는 실행 중인 노드가 기본적으로 시스템의 자동 유휴 잠자기를 막아
계속 접속할 수 있게 합니다. 디스플레이는 꺼질 수 있으며, 노트북 덮개를 닫거나
잠자기를 선택하거나 배터리가 매우 부족하면 Mac은 여전히 잠자기에 들어갑니다.
해제하려면 `~/Library/Application Support/offdesk/machine.json`에
`"prevent_idle_sleep": false`를 추가한 뒤 `offdesk-node service restart`로
노드를 재시작하세요(포그라운드 노드라면 멈췄다가 다시 시작).

## 두 가지 구성

어느 쪽이든 바이너리는 같습니다. 유일한 차이는 휴대폰이 이미 Hub 주소에
접근할 수 있느냐입니다.

- **집에서, 책상을 떠나서** — Hub는 Mac이나 NAS에, 휴대폰은 같은 Wi-Fi에.
  TLS도 도메인도 필요 없음. → [docs/setup-lan.md](docs/setup-lan.md)
- **집 밖에서** — Caddy 뒤의 VPS, Cloudflare Tunnel 뒤의 집 서버, 또는 tailnet
  위의 Hub. 가이드는 각 방식을 결국 누가 내 트래픽을 읽을 수 있게 되는지를
  기준으로 비교합니다. → [docs/setup-public.md](docs/setup-public.md)

## 문제 해결

- [로컬 네트워크에서는 되는데 원격 연결이 Unreachable일 때](docs/troubleshooting/remote-connection.md)

## 휴대폰에서

브라우저만으로 완전한 클라이언트가 됩니다. 어떤 휴대폰이든 Hub의 URL을 열면
바로 쓸 수 있습니다. Ctrl-C, Esc, Tab, 방향키가 있는 키 바를 갖춘 온전한
터미널입니다. 에이전트는 질문을 하고, 빌드는 Ctrl-C가 필요하니까요. 키는
균등한 격자로 배치되어 `↑`가 `↓` 바로 위에 있고, 방향키, Enter, 키보드 토글은
움직이지 않습니다. 나머지 키는 Settings에서 재배치할 수 있습니다
([터미널 키 사용자 지정](docs/terminal-keys.md)).

제목 표시줄에는 현재 터미널, 그 터미널의 머신, 그리고 내가 제어 중인지
지켜보는 중인지가 표시됩니다. 터미널 이름을 탭하면 세션 전환기가 열리고, 새
터미널도 여기서 엽니다. 그 옆의 `[f]`는 머신의 파일(가장 좁은 휴대폰에서는
`[m]` 메뉴 안에 있음), `[b]`는 에이전트 브라우저, `[m]`은 Machines & Hub를
엽니다.

다른 터미널의 Claude Code나 Codex가 확인을 요청하면 제목 표시줄 아래 띠에
표시됩니다. 터미널을 탭하면 그 터미널이 열리고, 옆의 `[enter]`를 탭하면 지금
보던 화면을 유지한 채 현재 선택된 옵션을 확정합니다. 지금 보고 있는 터미널이
기다리는 중이라면 대신 키 위에 대기 카드가 나타납니다. 감지 한계와 어떤 구성
요소를 업데이트해야 하는지는
[터미널 알림과 입력 동작](docs/terminal-attention.md)을 참고하세요.

패키지된 클라이언트도 세 가지 있습니다:

- **iPhone / iPad** — [공개 TestFlight 베타](https://testflight.apple.com/join/rV4ktaGv)에
  참여하세요. 앱에서 **Scan QR Code**를 열고 Hub의 암호화 페어링 코드를
  스캔합니다. 암호화된 연결은 앱의 서명된 인터페이스를 사용하며,
  인터페이스는 데스크톱·Android 앱처럼 무선으로 업데이트됩니다(0.9.2부터). 앱 자체는
  TestFlight로 업데이트하세요. 빌드 하나로 어떤 Hub에나
  연결됩니다. 휴대폰의 두 가지 설정이 LAN의 Hub 접속을 막을 수 있는데, 그럴
  때는 앱이 해당 설정을 알려 줍니다. 로컬 네트워크(Local Network), 그리고
  중국에서 판매된 휴대폰의 무선 데이터(Wireless Data)입니다. `v*` 태그에서
  빌드되어 Hub와 함께 배포됩니다.
- **Android** — [offdesk.dev/apk](https://offdesk.dev/apk)의 APK. 항상 최신 앱
  빌드를 가리킵니다(유니버설 빌드는 `/apk/universal`). 최신 휴대폰이라면
  `arm64-v8a`, 잘 모르겠다면 `universal`을 받으세요. 사이드로드해 설치하며,
  앱 내 업데이트 확인, 클립보드, 암호화 페어링을 지원합니다. 처음 실행하면
  Hub가 보여 주는 코드(설치 시 터미널, Phone 버튼 아래, 또는
  `offdesk-hub link`)를 스캔하는 것만으로 로그인됩니다. APK 하나로 어떤 Hub에나
  연결되며, Hub에 관한 정보는 전혀 컴파일되어 있지 않습니다. 주소를 직접
  입력하거나 로그인 링크를 붙여 넣을 수도 있습니다.
- **데스크톱** — macOS([offdesk.dev/mac](https://offdesk.dev/mac), 서명 및
  공증 완료), Windows([/windows](https://offdesk.dev/windows)), Linux
  ([/linux](https://offdesk.dev/linux)). 자동 업데이트 지원. tmux 스타일 탭,
  터미널을 누가 열었는지 보여 주는 창(pane) 헤더, 나를 기다리는 터미널을
  알려 주는 상태 줄을 갖췄습니다. Mac에서는 Hub가 될 수 있고([설치](#설치)
  참고), Windows와 Linux에서는 클라이언트로서 Hub의 링크를 묻습니다.
  `v*` 태그에서 빌드되어 Hub와 함께 배포됩니다.

직접 빌드하려면: [docs/building.md](docs/building.md).

### 쓰던 에이전트를 그대로

Offdesk는 에이전트를 감싸거나 에이전트의 프로토콜을 다루지 않습니다.
에이전트가 이미 돌고 있는 터미널을, 내 구독, 내 설정, 내 dotfiles 그대로
건네줄 뿐입니다. tmux에서 돌아가는 것은 무엇이든 여기서 돌아갑니다. Claude
Code, Codex, OpenCode, Gemini CLI, Aider, vim, htop, 한 시간 걸리는 빌드까지.
터미널 접속에 에이전트별 연동은 필요 없습니다.

Linux와 macOS에서는 Codex가 터미널 제목에 프로젝트 이름만 넣는 경우에도,
노드가 로컬 Codex 세션 이름을 인식해 터미널 목록에 표시합니다. Codex 설정을
바꿀 필요는 없습니다. 해당 창의 Codex 프로세스가 열어 둔 세션의 메타데이터를
읽으며, 세션을 식별할 수 없거나 메타데이터를 읽을 수 없으면 일반 터미널
제목을 사용합니다.

## 에이전트를 위한 기능

토큰 하나면 어떤 에이전트든 내 모든 머신을 조작할 수 있습니다. 어떤
스크립트든, 어느 머신의 어떤 에이전트든 Hub에 등록된 다른 머신에서 터미널을
**열고**(open), 키 입력을 **보내고**(send), **기다리고**(wait), 내용을
**읽을**(read) 수 있습니다. 에이전트 세션이 아니라 터미널이므로, 무엇을
조작하든 직접 손으로 실행했을 것과 똑같습니다.

```bash
T=$(offdesk open nas --cwd ~/projects/foo --cmd claude --json | jq -r .id)
offdesk send $T "fix the type errors in src/auth.ts; stop when tests pass"
offdesk wait $T --silence 5000 --timeout 600     # 프롬프트를 기다리려면 --pattern '❯'
offdesk read $T --lines 80                       # 결과 수집
offdesk kill $T --yes
```

### CLI 설정

CLI는 설치 스크립트가 이미 설치해 두었습니다. 웹 UI에서 API 토큰을 만든
다음(Settings → API tokens → Create), 설정 파일에 적거나:

```toml
# ~/.config/offdesk/config.toml  (chmod 600)
# macOS: ~/Library/Application Support/offdesk/config.toml
url   = "https://your-hub.example.com"
token = "odk_..."
```

`OFFDESK_URL`과 `OFFDESK_TOKEN`을 export하세요. `--url`과 `--token`은 둘 다보다
우선합니다.

### 명령

```
offdesk machines [--all] [--json]               # 머신 목록 (기본: 온라인만, --all이면 오프라인 포함)
offdesk machines rm <id|name> [--yes]           # 등록된 머신 삭제
offdesk ls [--machine <id>] [--json]            # 터미널 목록: id, title, group, cwd, size, reachable, opened by
offdesk open <machine> --cwd <dir> [--cmd <shell command>] [--group <name>] [--label <name>] [--json]
offdesk read <term> [--lines N] [--json]        # 현재 화면을 텍스트로 캡처
offdesk read --all [--machine <id>] [--lines N] [--json] [--concurrency N] [--include-unreachable]
                                                # 모든 터미널의 화면을 한 번에 일괄 캡처
offdesk send <term> <text...> [--no-enter]      # 텍스트 입력 (기본으로 Enter 추가)
offdesk key  <term> <KEY>...                    # Enter Esc Tab BTab Up Down Left Right C-c C-d F1-F12 ...
offdesk wait <term> [--pattern <regex>] [--silence <ms>] [--timeout <sec>]
offdesk kill <term> [--yes]
offdesk layout equalize --group <name|cwd:path> [--machine <id>] [--json]
                                                # 그룹의 창 분할을 균등하게 재조정, 웹 클라이언트에 실시간 반영
offdesk layout rotate --group <name|cwd:path> [--machine <id>] [--json]
                                                # 모든 분할을 좌우 배치와 상하 배치 사이에서 전환
offdesk browser open [URL] [--machine M] [--json]   # 노드의 헤드리스 Chromium 탭 열기, id 출력
offdesk browser ls [--machine M] [--json]           # 에이전트 브라우저 목록
offdesk browser goto|snapshot|click|fill|upload|press|dialog|wait|screenshot|close <browser> ...
                                                # 브라우저 조작, docs/agent-browser.md 참고
offdesk browser handoff <browser> --reason "Please log in" [--wait]   # 사람에게 도움 요청
offdesk browser wait-control <browser>          # 사람이 제어하는 동안 대기 (타임아웃 시 exit 1)
offdesk browser take <browser> --reason "..." [--force]   # 사람에게서 제어권 되찾기
offdesk mcp                                     # 에이전트 브라우저를 stdio MCP 도구로 제공: claude mcp add offdesk -- offdesk mcp
offdesk fetch <path>... [--plain]               # 이 머신의 파일/폴더에 대한 클릭 다운로드 링크(OSC 8) 출력, 파일당 최대 20 MiB, Hub 토큰 불필요
offdesk link [--no-open]                        # 브라우저에서 Hub 열기, Hub 머신에서는 로그인 링크와 코드
```

- 머신과 터미널은 **id 접두사**(`ls`의 첫 번째 열)로 지정합니다. 접두사가
  모호하면 후보를 나열합니다.
- CLI가 연 터미널은 앱과 `ls`에 "opened by agent"로 표시되고, `--label` 또는
  API 토큰 이름으로 구분되므로 내가 연 터미널과 구별할 수 있습니다. 앱에서 연
  터미널에는 표시가 없습니다.
- 종료 코드: `0` 성공 또는 대기 조건 충족 · `1` 대기 시간 초과 · `2` 사용법/
  설정/네트워크 오류 · `3` 사람이 브라우저를 제어하고 있어 에이전트 브라우저
  명령이 거부됨. 출력이 있는 모든 명령에서 `--json`을 쓸 수 있습니다.
- `--lines N`은 텍스트와 JSON 모드 모두에서 "현재 화면에 렌더링된 마지막 N줄"
  (끝의 빈 줄을 제거한 뒤)을 뜻합니다. JSON에는 `lines_total`(자르기 전 줄 수)과
  `truncated`도 포함됩니다.
- 출력되고 직렬화되는 모든 결과는 정제됩니다. 제어 바이트는 제거하고 `\n`/`\t`와
  유니코드는 유지하므로 `jq`로 안전하게 파이프할 수 있습니다.
- `send`는 텍스트를 입력한 뒤 Enter를 **지연된 별도 프레임**으로 보냅니다(150
  ms + 줄바꿈당 60 ms, 최대 800 ms). 여러 줄이 한꺼번에 들어오면 붙여넣기로
  처리하는 TUI 앱에서도 제출되도록 하기 위해서입니다. `--no-enter`는 텍스트
  프레임만 보냅니다.
- `read --all --json`은 기본적으로 **접근 가능한 터미널만** 나열하고, 최상위에
  `skipped_unreachable_count`를 둡니다. `--include-unreachable`을 쓰면 해당
  터미널의 `{"error":"unreachable"}` 항목이 다시 포함됩니다. 캡처된 각 항목에는
  `pane_title`, `title_source`(`osc`/`process`/`none`), `foreground_process`
  (`{has_foreground_process, process_name}`, 조회 실패 시 null),
  `activity`(`active`/`quiet`/`idle`), `idle_ms`가 들어 있습니다. activity는
  캡처하는 동안에만 관찰한 값입니다. `cwd`는 생성 시점이 아니라 현재 값(tmux
  `pane_current_path`)입니다.

### 꼭 알아야 할 동작 방식

1. **`send`/`key`는 제어권을 가져옵니다**(last-writer-wins). 같은 계정의 다른
   클라이언트는 사람이 다시 가져갈 때까지 보기 전용이 됩니다. 사람이 입력 중일
   수 있다면 먼저 읽으세요. CLI는 `open`과 `kill`에서도 리스를 가져옵니다.
2. **`read`/`wait`는 순수한 관찰자입니다.** 제어권을 가져오지도, 다른
   클라이언트를 방해하지도 않습니다. tmux가 `window-size manual`로 실행되므로
   붙어도 누구의 화면 크기도 바뀌지 않습니다.
3. **`read`는 현재 화면만 봅니다.** tmux가 attach할 때 다시 그리는 화면으로
   재구성하므로 스크롤백은 볼 수 없습니다. 출력이 길다면 세션 안의 에이전트가
   파일로 쓰게 하고 그 파일을 읽으세요.
4. **`read`를 반복해 폴링하지 마세요.** 호출할 때마다 attach 비용이 약 1초
   듭니다. 대신 조건이 충족될 때까지 `wait`로 기다리세요.
5. **모든 터미널을 한눈에 보려면 `read --all`을 쓰세요.** CLI 프로세스 N개를
   돌려 `read`를 반복하지 마세요. N×(TLS + attach)의 비용이 들고, stdout을 동시에
   비우지 않는 소비자는 파이프 버퍼에서 교착 상태에 빠질 수 있습니다.
6. `REACHABLE=no`인 터미널은 오프라인 머신에 속해 있어 attach할 수 없습니다.
   `read --all`은 이를 건너뛰고, 그 수를 stderr와 JSON의
   `skipped_unreachable_count`로 알려 줍니다.
7. **토큰은 등록된 모든 머신에서의 원격 코드 실행 권한입니다.** 에이전트마다
   하나씩 발급하고, 이름을 붙이고, 다 쓰면 개별적으로 폐기하세요.

## 다른 도구와의 비교

여러 머신을 한곳에 모아 주는 도구는 채팅을 건네주고, 진짜 터미널을 건네주는
도구는 머신마다 서버를 하나씩 돌립니다. 아래 표의 모든 칸은 각 벤더의 공식
문서를 근거로 합니다. 2026-09-01에 확인했으며, 이 제품들은 빠르게 바뀌므로
어떤 행에 의존하기 전에 다시 확인하세요.

| | 모든 터미널 프로그램 | Hub당 머신 수 | 트래픽 경로 | 에이전트의 CLI 조작 | 셀프 호스팅 |
|---|---|---|---|---|---|
| **Offdesk** | tmux에서 도는 것은 무엇이든 | 개수 제한 없음, URL 하나 | 내가 운영하는 Hub | `open` / `send` / `wait` / `read` | 가능, MIT |
| Claude Code Remote Control | 불가 — 터미널이 아닌 Claude Code 세션 | 여러 머신의 세션을 한 목록에 | Anthropic 서버, 대화 기록도 그곳에 저장 | 문서화되지 않음 | 불가 |
| VibeTunnel | 가능 — `vt <any command>`, `vt --shell` | 머신마다 서버 하나 | 선택 가능: LAN, Tailscale, ngrok, Cloudflare | 명령 실행만 가능, 실행 중인 세션에 send/read/wait 불가 | 가능, MIT |
| Happy Coder | 불가 — `claude`와 `codex`를 감쌈 | 여러 대, `spawn --machine`, `machines` | 기본은 slopus 클라우드, 종단 간 암호화 | `create` / `send` / `history` / `wait` | 선택 사항, MIT |
| Omnara | 에이전트 세션, 원시 터미널은 문서화되지 않음 | 에이전트당 동시에 여러 대 | 기본은 `api.omnara.com` | CLI와 REST: `POST .../inputs`, SSE 타임라인 | 선택 사항, Apache-2.0 |
| Orca | 가능 — 진짜 터미널, 30개 이상의 CLI 에이전트 | 머신마다 서버 하나, SSH worktree로 다른 머신에 접근 | 기본은 Orca Relay, 또는 LAN에서 직접 | `orca terminal create/send/read/wait` | 가능, MIT |

각 칸의 출처는 [영어 README](README.md#how-it-compares)에 있습니다.

### 표가 말해 주는 것

이 분야는 둘로 나뉘며, 그 갈림은 품질의 문제가 아닙니다.

**여러 머신을 모으지만, 대화형.** Claude Code Remote Control, Happy Coder,
Omnara는 모두 여러 머신을 한곳에 모아 줍니다. 하지만 그곳에서 얻는 것은
터미널이 아니라 에이전트 세션입니다. 원하는 것이 에이전트뿐이라면 올바른
선택입니다.

**진짜 터미널이지만, 머신마다 서버 하나.** VibeTunnel과 Orca는 모두 진짜
터미널을 제공합니다. 둘 다 머신마다 서버를 하나씩 돌립니다. VibeTunnel은
설계상 그렇고, Orca는 Remote Orca Server가 단일 호스트에 묶여 있어 다른
머신에는 SSH로 접근하기 때문입니다.

Offdesk는 이 둘의 조합입니다. 내 어떤 머신에서든 자리를 떠나, 내가 운영하는
서버를 거쳐 휴대폰에서 진짜 터미널을 이어받을 수 있습니다. 나머지 다섯 도구는
각각 에이전트, 머신, 서버 셋 중 하나를 포기합니다.

이 표가 뒷받침하는 주장은 이것뿐이며, "더 낫다"보다 훨씬 좁은 주장입니다.
병렬 git worktree, diff 리뷰, 에이전트를 둘러싼 브라우저와 에뮬레이터
하네스가 필요하다면 **Orca**가 Offdesk보다 훨씬 많은 일을 하고, 역시 MIT입니다.
최소한의 설정으로 한 머신의 터미널을 브라우저에서 쓰고 싶다면
**VibeTunnel**이 더 가볍게 운영할 수 있습니다. Claude Code만 쓰고 설정이 전혀
없기를 원한다면 **Remote Control**이 이미 CLI에 들어 있습니다.

## 보안

**토큰은 등록된 모든 머신에서의 원격 코드 실행 권한입니다.** 토큰으로
터미널을 열고 입력할 수 있으며, 터미널은 셸이 실행하는 것이라면 무엇이든
실행합니다. API 키가 아니라 SSH 키처럼 다루세요.

이를 통제하기 위해 Hub가 제공하는 것:

- **에이전트마다 토큰 하나.** 모든 토큰에는 만들 때 직접 정한 이름이 붙습니다.
- **개별 폐기.** 토큰 하나를 삭제해도 다른 토큰에는 영향이 없습니다.
- **마지막 사용 시각.** 모든 토큰은 마지막으로 인증된 시각을 기록하므로 어떤
  토큰이 실제로 쓰이고 있는지 알 수 있습니다.
- 토큰은 SHA-256 해시로 저장됩니다. 평문은 만들 때 한 번만 보여 주며, 다시
  복구할 수 없습니다.

Hub가 출력하는 로그인 링크는 가진 사람 누구나 로그인시키므로 비밀번호처럼
다루세요. 제어 리스는 보안 경계가 아니며, 유효한 토큰을 가진 사람을 막지
못합니다.

위협 모델, 제어 리스가 막는 것과 막지 못하는 것, Hub가 SQLite에 저장하는
내용: [SECURITY.md](SECURITY.md).

## 자주 묻는 질문

**Offdesk는 SSH 클라이언트인가요?** Offdesk는 자체 Hub/node WebSocket 전송을
사용합니다. 머신에 `offdesk-node`를 설치하면 그 머신의 tmux 세션이 Hub를 통해
노출됩니다. Offdesk는 임의의 SSH 서버에 접속하지 않습니다. 그 머신을
관리하거나 tmux 세션에 붙기 위해 SSH를 따로 쓰는 것은 여전히 가능합니다.

**브라우저나 휴대폰 연결이 끊겨도 터미널이 유지되나요?** tmux가 노드에서
돌기 때문에 클라이언트를 닫거나 네트워크가 끊겨도 세션은 끝나지 않습니다.
Hub와 노드에 다시 접근할 수 있게 되면 같은 터미널에 다시 연결하면 됩니다.
호스트를 종료하거나 재부팅하는 것은 다릅니다. tmux는 재부팅 후까지 실행 중인
프로세스를 보존하지 않습니다.

**계정이 필요한가요?** 셀프 호스팅에는 벤더 계정이 필요 없습니다. 설치하면
로컬 사용자와 로그인 링크가 만들어집니다. 선택 사항인 Offdesk Cloud는 관리형
원격 접속을 위해 별도의 로그인을 사용합니다.

**트래픽이 offdesk.dev를 거치나요?** LAN 직접 연결은 내 Hub로 갑니다. 선택
사항인 Offdesk Cloud는 암호화된 앱 트래픽을 `*.cloud.offdesk.dev` 아래의 관리형
주소를 통해 전달합니다. 직접 관리하는 터널은 해당 제공업체를 거칩니다.
[암호화 페어링](docs/encrypted-connections.md)은 앱과 Hub 사이의 터미널 내용을
보호하며, 일반 브라우저 로그인 링크는 이와 다른 방식입니다.

**Claude Code 전용인가요?** 터미널입니다. Claude Code, Codex, OpenCode, 한 시간
걸리는 빌드, vim 등 tmux에서 도는 것은 무엇이든 여기서 돌고, Offdesk는 그것이
무엇인지 알지도 신경 쓰지도 않습니다.

**iPhone은요?** 앱이 있으며, 지금은 TestFlight로 배포합니다.
[휴대폰에서](#휴대폰에서)를 참고하세요. 앱 없이도 브라우저만으로 완전한
클라이언트가 됩니다. 카메라로 Hub의 코드를 스캔하고 페이지를 홈 화면에
추가하세요. Android 앱도 있습니다. 암호화 페어링 코드는 앱 안의 스캐너로
스캔하고, 브라우저로 접속할 때는 일반 로그인 링크를 쓰세요.

**두 사람이 동시에 입력하면요?** 누가 입력할 수 있는지는 제어 리스가 정합니다.
입력을 보내면 리스를 가져옵니다. 마지막 입력자가 이기고, 대기열은 없습니다.
나머지는 출력을 계속 받으므로 연결이 끊기지 않고 실시간으로 지켜보게 됩니다.

## 커뮤니티

질문과 설정 관련 이야기는 [Discord](https://discord.gg/aFUu6VMzc)에서, 버그는
GitHub [issues](https://github.com/zalify/offdesk/issues)에 올려 주세요.

## 라이선스

이 저장소의 코드는 MIT 라이선스입니다. [LICENSE](LICENSE)를 참고하세요.
선택 사항인 Offdesk Cloud 서비스는 별도로 유지 관리되며 이 저장소에 포함되어
있지 않습니다.
