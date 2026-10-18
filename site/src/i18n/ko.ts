import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const ko: Dict = {
  chrome: {
    skip: "본문으로 건너뛰기",
    homeLabel: "Offdesk Dev 홈",
    navLabel: "주 메뉴",
    nav: {
      download: "다운로드",
      how: "작동 방식",
      away: "원격 접속",
      docs: "문서",
      cli: "CLI",
    },
    discordLabel: "Discord의 Offdesk",
    githubLabel: "GitHub의 Offdesk",
    language: "언어",
    languageLabel: "언어: {name}. 다른 언어 선택",
    footer: {
      madeBy: "{zalify} 제작",
      tagline: "셀프 호스팅 원격 터미널",
      gettingStarted: "시작하기",
      tunnel: "터널 가이드",
      security: "보안",
      releases: "릴리스 노트",
    },
    copy: "[복사]",
    copied: "[복사됨]",
    copyFailed: "[⌘C 누르기]",
  },

  home: {
    title: "Offdesk — 에이전트와 내가 함께 쓰는 터미널",
    description:
      "에이전트와 함께 쓰는 셀프 호스팅 원격 터미널. 에이전트는 CLI로 터미널을 다루고, 나는 휴대폰으로 지켜보다 키보드를 넘겨받습니다. Claude Code, Codex 등 tmux의 모든 것. Hub는 MIT 라이선스.",
    hero: {
      title: "에이전트와 내가 함께 쓰는 터미널.",
      lead: "에이전트는 CLI로 터미널을 열고, 입력하고, 읽습니다. 같은 터미널을 휴대폰으로 지켜보다가, 에이전트가 부르면 키보드를 넘겨받으세요.",
      downloadMac: "Mac용 다운로드",
      allDownloads: "전체 다운로드",
      copyInstallLabel: "설치 명령어 복사",
      note: "Mac 앱은 서명과 공증을 거쳤으며 Apple silicon과 Intel을 지원합니다. 한 줄 명령어로 macOS나 Linux에 Hub를 설치할 수 있습니다.",
      figcaption: "예시 그림: 에이전트가 CLI로 연 터미널 하나를 휴대폰에서 지켜보는 모습.",
    },
    proofLabel: "한눈에 보기",
    proof: [
      { key: "모든 프로그램", value: "tmux에서 실행되는 모든 것" },
      { key: "머신", value: "개수 제한 없이, URL 하나로" },
      { key: "트래픽", value: "내 Hub를 거쳐서" },
      { key: "에이전트", value: "open · send · wait · read" },
      { key: "라이선스", value: "셀프 호스팅, Hub MIT" },
    ],
    beats: {
      title: "키보드는 필요한 쪽이 잡습니다.",
      items: [
        {
          label: "01 / 에이전트",
          title: "에이전트가 열고",
          body: "명령어 하나로 내가 가진 어느 머신에서든 터미널을 열고 Claude Code, Codex 등 무엇이든 실행합니다. 모두 자리를 떠나도 계속 실행됩니다.",
        },
        {
          label: "02 / 나",
          title: "나는 같은 화면을 보고",
          body: "대화 기록이 아니라 실시간 터미널을 휴대폰, 노트북, 브라우저에서 봅니다. 에이전트가 멈추고 물어보면 바로 보입니다.",
        },
        {
          label: "03 / 누구든",
          title: "제어권은 주고받고",
          body: "Enter로 답하거나 키보드를 넘겨받으세요. 에이전트의 브라우저에서도 마찬가지입니다. 대신 로그인해 주고 다시 넘겨주면 됩니다.",
        },
      ],
    },
    start: {
      title: "세 단계로 첫 터미널 열기.",
      steps: [
        {
          label: "1단계",
          title: "macOS나 Linux에 Hub 설치하기",
          body: "Mac 앱을 열고 이 머신이 계속 켜 두는 머신이라고 선택하면 Hub가 됩니다. 로그인할 때 자동으로 실행되고, 멈추면 다시 시작됩니다. 셀프 호스팅에는 별도 서비스 계정이 필요 없습니다. 화면이 없는 NAS나 서버에서는 한 줄이면 똑같이 설정됩니다:",
        },
        {
          label: "2단계",
          title: "휴대폰을 페어링하거나 브라우저로 로그인하기",
          body: 'Offdesk App을 선택하면 앱 내 스캐너용 암호화 페어링 코드가 생성됩니다. Browser access를 선택하면 브라우저 로그인 링크가 생성됩니다. 둘 다 Mac 메뉴 막대에서 찾을 수 있으며, 브라우저 접속은 <span class="inline-code">offdesk link</span>를 실행해도 됩니다.',
        },
        {
          label: "3단계",
          title: "같은 tmux 세션에 다시 연결하기",
          body: "책상 앞에서 쓰던 것과 같은 tmux 세션이 실시간으로 이어집니다. Hub는 켜진 채 온라인 상태로 두세요. tmux에서 실행되는 것은 무엇이든 여기서도 실행됩니다.",
        },
      ],
      readGuide: "Mac 가이드 읽기",
      iphone: "iPhone 앱",
      android: "Android 앱",
      orBrowser: "또는 휴대폰의 아무 브라우저",
    },
    download: {
      title: "데스크톱, 휴대폰, 웹용 클라이언트.",
      lead: "데스크톱 앱은 Mac에서는 Hub가 되고, 어디서든 클라이언트가 됩니다. 휴대폰 앱은 브라우저에 보이는 것과 같은 터미널을 감싼 것입니다.",
      mac: {
        body: "Apple silicon과 Intel 겸용 dmg 하나. Developer ID로 서명하고 공증을 받아 App Store 앱처럼 바로 열립니다. 계속 켜 두는 Mac에서는 Hub가 되고, 그 밖의 곳에서는 클라이언트가 됩니다.",
        button: ".dmg 다운로드 →",
        meta: "macOS 11 이상 · 유니버설 · .dmg",
      },
      windows: {
        body: "클라이언트입니다. 다른 곳에 있는 Hub의 터미널을 엽니다. Hub가 출력한 링크를 붙여 넣거나 로그인하세요. Hub에는 tmux가 필요하므로 Windows 머신은 Hub가 될 수 없습니다.",
        button: ".msi 다운로드 →",
      },
      linux: {
        body: "Windows와 마찬가지로 클라이언트입니다. Linux 머신을 Hub로 쓰려면 한 줄 설치를 이용하세요. Hub를 서비스로 실행해 줍니다.",
        button: ".AppImage 다운로드 →",
        meta: "x64 · .AppImage · .deb와 .rpm은 {release}에서",
        release: "릴리스 페이지",
      },
      iphone: {
        body: "TestFlight로 제공됩니다. iPhone이나 iPad에서 초대 링크를 열어 앱을 설치한 다음, Scan QR Code를 선택해 Hub에 연결하세요.",
        button: "베타 참여 →",
      },
      android: {
        body: '직접 설치(사이드로드)하는 APK입니다. 최신 휴대폰이라면 <span class="inline-code">arm64-v8a</span>를, 잘 모르겠다면 <a href="/apk/universal">유니버설</a> 빌드를 받으세요.',
        button: "APK 다운로드 →",
      },
      cli: {
        title: "Hub, Node, CLI",
        body: "NAS, VPS 등 화면이 없는 머신을 위한 바이너리 세 가지. Linux와 macOS, x64와 arm64를 지원합니다.",
      },
    },
    how: {
      title: "Rust Hub. 아웃바운드 WebSocket. 유지되는 tmux.",
      items: [
        {
          title: "Hub",
          body: "Axum으로 만든 Rust 서버로, SQLite 저장소와 내장 웹 UI를 갖추고 있습니다. 클라이언트를 인증하고 터미널 트래픽을 macOS·Linux Node로 라우팅합니다. 바이너리로 설치하거나 Docker로 배포하세요.",
        },
        {
          title: "Node",
          body: "접속하려는 모든 머신에서 실행됩니다. WebSocket으로 Hub에 <em>나가는</em> 연결을 맺으므로, Node에는 인바운드 포트도 공인 IP도 필요 없습니다. 모든 터미널은 그 터미널을 가진 머신의 tmux 세션입니다. 앱이 꺼져도, 네트워크가 끊겨도, 자리를 떠나도 살아 있습니다. Offdesk를 삭제해도 그대로 남습니다.",
        },
        {
          title: "클라이언트",
          body: "React와 xterm.js가 브라우저에서 대화형 터미널을 렌더링합니다. Tauri 앱은 데스크톱과 모바일에 네이티브 암호화 페어링을 더합니다. Rust CLI로는 스크립트에서 접근할 수 있습니다. 클라이언트는 Hub를 통해 터미널 출력을 공유하며, 누가 입력할 수 있는지는 제어권 임대(control lease)로 정해집니다.",
        },
      ],
      note: "한 터미널을 두 화면에서 보는 것은 Hub 하나에 붙은 두 클라이언트가 tmux 세션 하나에 연결된 것입니다. 클라이언트 연결이 끊겨도 Node의 세션은 종료되지 않습니다. Offdesk는 SSH가 아니라 자체 Hub/Node 전송 방식을 씁니다. 접속하려는 머신마다 offdesk-node를 설치하세요.",
    },
    away: {
      title: "LAN에서 셀프 호스팅. 원격 접속은 필요할 때.",
      body: [
        "오픈 소스 Hub를 macOS, Linux, NAS, VPS에서 실행하세요. Node는 그 Hub로 나가는 연결을 맺고, 터미널 세션은 tmux를 실행하는 머신에 남습니다. Hub와 해당 머신들은 켜진 채 온라인 상태를 유지해야 합니다.",
        `Hub 옆에서 cloudflared를 실행하면 공유기 포트를 열지 않고도 HTTPS 엔드포인트를 노출할 수 있습니다. NAT나 CGNAT 뒤에서도 됩니다. 도메인과 터널 인그레스를 설정하거나, 내 기기들 사이에서 Hub에 비공개로 접근하려면 <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a>를 쓰세요.`,
        `페어링된 Offdesk App은 터널을 거치더라도 App과 Hub 사이의 터미널 트래픽을 종단 간 암호화합니다. 일반 브라우저 접속은 HTTPS와 자체 인증을 사용하며, HTTPS는 터널 제공자에서 종료됩니다. App 암호화가 자동으로 적용되지는 않습니다. <a href="${repo}/blob/main/docs/encrypted-connections.md">암호화 연결 가이드</a>를 참고하세요.`,
      ],
      tunnelGuide: "터널 가이드",
      lanSetup: "LAN 설정",
      pairing: "암호화 앱 페어링",
      cloudSetup: "원격 접속 설정",
      homeTitle: "# 집에 있는 머신에서",
      homeBody:
        'Cloudflare 대시보드에서 터널을 만들어 <span class="inline-code">server:4317</span>을 가리키게 하고, 토큰을 <span class="inline-code">.env</span>에 넣은 다음:',
      copyTunnelLabel: "터널 명령어 복사",
      homeAfter:
        "암호화된 App 접속은 App의 스캐너로 암호화 페어링 코드를 스캔하세요. 일반 브라우저 접속은 터널 가이드에 따라 인증을 설정하세요.",
      cloudBadge: "초대 전용 베타",
      cloudBody:
        "offdesk.so의 호스팅형 Offdesk는 선택 사항인 관리형 원격 접속을 제공합니다. 이 서비스는 비공개 소스이지만, 공개 저장소의 Hub, Node, CLI는 MIT 라이선스이고, 웹 UI와 앱은 FSL-1.1-MIT로 소스를 공개합니다. 로컬 커넥터는 암호화된 연결이 닿는지 확인하고, 터널 장애가 계속되면 백오프를 두고 자동으로 재시도합니다. 로컬에서만 쓴다면 Offdesk 계정이 필요 없습니다.",
    },
    more: {
      title: "원격 셸, 모바일 코딩 에이전트, CLI 자동화.",
      machines: {
        title: "macOS·Linux 터미널 관리",
        body: "NAS, VPS, 노트북. Hub를 열고 <strong>Add a machine</strong>을 선택하면 토큰이 들어 있는 한 줄 명령어를 줍니다. 그 머신에 붙여 넣으면 목록에 나타납니다.",
      },
      agents: {
        title: "어떤 에이전트든",
        body: "Offdesk는 에이전트를 감싸지도, 에이전트의 프로토콜을 쓰지도 않습니다. 에이전트가 이미 실행 중인 터미널을 그대로 건넵니다. 내 구독, 내 설정, 내 dotfiles 그대로.",
        anyCli: "모든 CLI",
      },
      phone: {
        title: "휴대폰에서 Claude Code와 Codex 쓰기",
        body: [
          `키 바를 Esc, Tab, Shift+Tab, Shift 조합, Backspace 반복으로 맞춤 설정하세요. 방향키, Enter, 키보드 전환 키는 고정이며, 나머지 키는 설정에서 숨기거나 순서를 바꿀 수 있습니다. <a href="${repo}/blob/main/docs/terminal-keys.md">터미널 키 설정하기</a>. 앱에는 QR 스캐너와 종단 간 암호화 연결이 더해집니다.`,
          `대기 배너에서 지금 보던 화면을 유지한 채 다른 터미널의 확인 요청을 열거나, 현재 선택된 항목에 Enter를 보낼 수 있습니다. <a href="${repo}/blob/main/docs/terminal-attention.md">확인 단축키 알아보기</a>.`,
          "<strong>iPhone 및 iPad:</strong> 아래 링크로 공개 TestFlight 베타에 참여하세요. 앱 업데이트는 TestFlight가 처리합니다.",
        ],
        android: "Android APK",
        universal: "유니버설 빌드",
        iphone: "iPhone · TestFlight",
        heroAlt: "책상 위 머신에서 실행 중인 Claude Code와, 같은 tmux 세션에 연결된 휴대폰",
        iosAlt: "Offdesk iPhone 앱에서 집에 있는 Mac에 연결해 실행 중인 Claude Code",
        stillAlt: "휴대폰의 Offdesk 터미널: 집에 있는 Mac의 Claude Code에 휴대폰 브라우저로 연결한 모습",
        caption: "유지되는 원격 tmux 세션 안의 Claude Code.",
      },
    },
    cli: {
      title: "Offdesk CLI로 원격 터미널 자동화하기.",
      lead: "open, send, wait, read 명령으로 셸 스크립트나 AI 코딩 에이전트에서 원격 tmux 세션을 제어하세요. JSON 출력 덕분에 스크립트에서 터미널 ID를 받아 단계 사이에 결과를 넘길 수 있습니다. 에이전트가 연 터미널에는 에이전트가 열었다는 표시가 붙어 내 터미널과 구분할 수 있습니다.",
      body: `토큰은 등록한 모든 머신에서 원격으로 코드를 실행할 수 있는 권한입니다. 에이전트마다 하나씩 발급하고, 이름을 붙이고, 따로 폐기하세요. <a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "예시 복사",
    },
    compare: {
      title: "다른 도구와의 비교",
      note: "모든 항목은 각 프로젝트의 공식 문서를 기준으로 2026-09-01에 확인했습니다. 출처는 README의 같은 표 아래에 있습니다.",
      project: "프로젝트",
      columns: [
        "모든 터미널 프로그램",
        "Hub당 머신 수",
        "트래픽 경로",
        "에이전트의 CLI 조작",
        "셀프 호스팅",
      ],
      rows: [
        ["tmux에서 실행되는 모든 것", "제한 없음, URL 하나", "내 Hub", "open / send / wait / read", "예, MIT + FSL"],
        ["아니요 — 터미널이 아닌 Claude Code 세션", "여러 머신의 세션을 한 목록에", "Anthropic 서버, 대화 기록도 그곳에 저장", "문서화되지 않음", "아니요"],
        ["예 — vt &lt;임의의 명령어&gt;, vt --shell", "머신마다 서버 하나", "선택: LAN, Tailscale, ngrok, Cloudflare", "명령 실행만 가능", "예, MIT"],
        ["아니요 — claude와 codex를 감쌈", "여러 대, spawn --machine", "기본은 slopus 클라우드, 종단 간 암호화", "create / send / history / wait", "선택 사항, MIT"],
        ["에이전트 세션, 원시 터미널은 문서화되지 않음", "에이전트당 여러 대 동시", "기본은 api.omnara.com", "CLI 및 REST", "선택 사항, Apache-2.0"],
        ["예 — 실제 터미널, 30개 이상의 CLI 에이전트", "여러 대, SSH 워크트리와 orca serve로", "기본은 Orca Relay, LAN에서는 직접 연결", "orca terminal create/send/read/wait", "예, MIT"],
      ],
    },
    close: {
      title: "오늘 밤, Hub를 설치하세요.",
      lead: "macOS나 Linux에 Hub를 설치하고, 머신을 등록하고, 브라우저나 휴대폰에서 유지되는 tmux 세션을 여세요.",
      iphone: "iPhone 앱",
      android: "Android 앱",
    },
  },

  tunnel: {
    title: "Cloudflare Tunnel로 Offdesk 원격 접속하기",
    description:
      "포트를 열지 않고 어디서든 집에 있는 Hub에 접속하세요. Offdesk를 위한 Cloudflare Tunnel 전체 설정 가이드입니다.",
    heading: "Cloudflare Tunnel",
    lead: "NAS나 집에 있는 데스크톱에서 돌리는 Hub를 위한 방법입니다. <code>cloudflared</code>가 Hub 옆에서 실행되며 Cloudflare로 <em>나가는</em> 연결을 맺고, Cloudflare가 내 호스트 이름을 HTTPS로 서비스합니다. 포트 포워딩도, 동적 DNS도, 갱신할 인증서도 필요 없고, 포트 포워딩 자체가 불가능한 CGNAT 뒤에서도 동작합니다.",
    intro: `일반 브라우저 연결에서는 Cloudflare가 HTTPS를 종료하므로 터미널 트래픽을 읽을 수 있습니다. 암호화 App 페어링은 App과 Hub 사이에 암호화를 더하므로, 터널은 암호화된 터미널 내용을 전달합니다. 이 방식은 <a href="${repo}/blob/main/docs/encrypted-connections.md">암호화 연결 가이드</a>를 따르세요. 대신 <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a>을 쓸 수도 있습니다. 바이너리는 같고, 중간에 아무도 없습니다.`,
    needDomain: "Cloudflare 계정에 연결된 도메인이 필요합니다. 무료 플랜으로 충분합니다.",
    create: {
      title: "1. 터널 만들기",
      body: "Cloudflare Zero Trust 대시보드 → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>. 이름을 정한 다음 표시되는 토큰을 복사하세요. 설치 명령어에서 <code>--token</code> 뒤에 오는 긴 문자열입니다. 이 토큰은 자격 증명입니다. 토큰을 가진 사람은 누구든 내 터널로 트래픽을 서비스할 수 있습니다.",
      hostname: "터널에 공개 호스트 이름을 추가하세요:",
      field: "항목",
      value: "값",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code>는 <code>docker-compose.yml</code>에 정의된 Hub의 서비스 이름이며, <code>cloudflared</code>는 이 이름으로 compose 네트워크를 통해 Hub에 접근합니다. Cloudflare에서 내 머신까지의 구간은 터널 안에 있고, <code>cloudflared</code>에서 Hub까지의 구간은 Docker 네트워크를 벗어나지 않으므로 그 구간은 일반 HTTP로 충분합니다.",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>docker-compose.yml</code> 옆의 <code>.env</code>:",
      secretPlaceholder: "openssl rand -hex 32 실행 결과",
      tokenPlaceholder: "1단계에서 받은 토큰",
      oauth: `인터넷에 공개된 Hub는 GitHub나 Google로 로그인합니다. OAuth 콜백 URL은 <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">VPS 가이드</a>와 똑같이 등록하세요. Hub는 <code>OFFDESK_BASE_URL</code>로 콜백 URL을 만들며, 터널을 쓴다고 해서 달라지는 것은 없습니다. 그다음:`,
      profile:
        "<code>cloudflared</code>를 시작하는 것은 <code>tunnel</code> 프로필입니다. 이 프로필이 없으면 Hub만 실행되고, 여전히 <code>127.0.0.1:4317</code>에 바인딩됩니다. 둘 다 실행 중인지 확인하세요:",
    },
    machines: {
      title: "3. 머신",
      body: "브라우저에서 Hub를 열고 <strong>Add host</strong>를 선택하세요. 등록 토큰이 채워진 한 줄 명령어가 표시됩니다. 접속하려는 머신에서:",
      after:
        "Hub와 같은 LAN에 있는 머신도 Cloudflare를 거쳐 돌아옵니다. 이게 신경 쓰인다면 Hub의 LAN 주소로 등록하세요. 머신 에이전트는 Hub에 닿기만 하면 되며, 휴대폰이 같은 Hub에 다른 이름으로 접속한다는 것은 상관하지 않습니다.",
    },
    notes: {
      title: "참고 사항",
      items: [
        "<strong>URL을 아는 사람은 누구나 로그인할 수 있습니다.</strong> VPS 방식과 같습니다. 어떤 GitHub나 Google 계정이든 내 Hub에 계정을 만들 수 있으며, 허용 목록은 없습니다. Cloudflare Access로 호스트 이름 전체 앞에 로그인을 하나 더 둘 수 있지만, 그러면 브라우저가 아닌 모든 것 — <code>offdesk-node</code>, CLI, Android 앱 — 이 각자 Access 서비스 토큰을 가져야 하는데, 머신 에이전트에는 그 토큰을 넣을 곳이 없습니다. Access 정책의 범위를 브라우저 경로로 한정하거나, Access를 쓰지 말고 Hub 자체 로그인에 맡기세요.",
        "<strong>오래 유지되는 WebSocket도 문제없습니다.</strong> 머신 에이전트는 30초마다 ping을 보내고 브라우저는 애플리케이션 계층에서 ping을 보내므로, 경로 중간의 유휴 타임아웃 때문에 터미널이 조용히 끊기지 않습니다.",
        "<strong>데모가 아니라면 퀵 터널은 쓰지 마세요</strong>(<code>cloudflared tunnel --url</code>, <code>*.trycloudflare.com</code> 호스트 이름). 재시작할 때마다 호스트 이름이 바뀌어 OAuth 콜백 URL, 등록된 모든 머신, 이전 주소를 저장해 둔 휴대폰이 모두 무효가 됩니다.",
      ],
    },
    others: `다른 두 방식(Caddy를 앞에 둔 VPS, Tailscale)과 세 방식의 장단점 비교는 <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>에 있습니다.`,
  },

  mac: {
    title: "Mac에서 첫 터미널 열기",
    description: "Mac에 Offdesk를 설치하고, 첫 터미널을 열고, 휴대폰을 연결하는 방법을 스크린샷과 함께 안내합니다.",
    eyebrow: "시작하기 · macOS",
    lead: "계속 켜 두는 Mac을 Hub로 만드세요. 그런 다음 휴대폰에서 그 Mac의 터미널을 여세요. 처음에는 두 기기를 같은 로컬 네트워크에 두고 시작하세요.",
    preview: "스크린샷 안내",
    previewText:
      "이 스크린샷은 Mac Mini에서 0.6.4-rc.1을 테스트하며 찍은 것입니다. 현재 안정 버전에는 개선된 휴대폰 페어링과 원격 접속 설정이 들어 있습니다. 아래 안내는 새 버전을 기준으로 하며, 이전 스크린샷에는 RC 표시와 이전 레이아웃이 그대로 남아 있습니다. 이제 페어링 패널에서 Offdesk App과 Browser access가 분리되어 있습니다. 다운로드 버튼은 안정 버전을 제공합니다.",
    download: "Mac용 다운로드",
    phone: "휴대폰 앱 받기",
    contents: "이 페이지의 내용",
    stepLabel: "{n}단계",
    openScreenshot: "전체 스크린샷 열기",
    before: "시작하기 전에",
    needs: [
      "전원이 계속 켜져 있고 네트워크에 연결된 Mac과, 그 Mac의 macOS 로그인 계정.",
      "같은 로컬 네트워크에 있는 휴대폰과 Mac. 유선으로 연결된 Mac과 같은 공유기의 Wi-Fi에 연결된 휴대폰도 됩니다.",
      "휴대폰의 Offdesk: iPhone / iPad는 TestFlight, Android는 이 사이트의 APK.",
    ],
    terms:
      "Hub는 연결을 관리하고, Node는 머신의 터미널을 사용할 수 있게 해 줍니다. 이 Mac을 Hub로 선택하면 둘 다 설치됩니다. 일반적인 App 설정에서는 install.sh 명령을 따로 실행하거나 Docker를 설치할 필요가 없습니다.",
    steps: {
      install: {
        title: "1. Mac 앱 설치하기",
        body: "<a href='/mac'>Mac 다운로드 페이지</a>에서 디스크 이미지를 받으세요. DMG를 열고 Offdesk Dev를 응용 프로그램 폴더로 드래그한 다음, 설치된 앱을 여세요. 마운트된 디스크 이미지에서 계속 실행하지 마세요.",
        extra:
          "표준 macOS 계정에서는 시스템의 응용 프로그램 폴더에 쓰려면 관리자 암호가 필요할 수 있습니다. 내 홈 디렉터리 안의 응용 프로그램 폴더를 써도 됩니다. 스크린샷의 RC는 테스트 빌드라는 표시입니다.",
        alt: "Offdesk RC와 응용 프로그램 폴더 바로가기가 있는 Mac 디스크 이미지 창.",
        caption: "앱을 응용 프로그램 폴더로 드래그한 다음, 설치된 앱을 실행하세요.",
      },
      choose: {
        title: "2. 이 Mac을 Hub로 만들기",
        body: "<strong>Which machine is this?</strong>에서 <strong>The one that stays on → Set this machine up</strong>을 선택하세요. 휴대폰에서 이 Mac의 터미널에 접속하려면 이 옵션을 선택합니다.",
        extra:
          "다른 곳에 이미 Hub가 있고 이 Mac을 클라이언트로 쓰려는 경우에만 <strong>Just connecting</strong>을 선택하세요. 이 로컬 설정에는 계정을 만들 필요가 없습니다.",
      },
      ready: {
        title: "3. Mac 준비가 끝날 때까지 기다리기",
        body: "새 설정 과정은 휴대폰 연결 화면을 보여 주기 전에 네 가지를 확인합니다. 화면에 주소가 나타났다고 해서 설정이 끝난 것은 아닙니다.",
        checks: [
          "Hub가 실행 중이며 응답합니다.",
          "이 Mac이 Hub에 등록되어 있습니다.",
          "로컬 Node가 온라인 상태입니다.",
          "터미널 도구인 tmux를 사용할 수 있습니다.",
        ],
        extra:
          "준비가 끝나면 <strong>Connect your phone</strong>이 표시됩니다. <strong>Pair an encrypted device</strong>를 선택해 페어링 코드를 생성하세요. 확인에 실패하면 설정 화면의 재시도 버튼을 누르세요. macOS가 Offdesk Dev의 수신 연결 허용 여부를 물으면, 휴대폰으로 접속하려는 Mac에서 허용하세요.",
      },
      terminal: {
        title: "4. 첫 터미널 열기",
        body: "<strong>Open my terminal</strong>을 선택하세요. <strong>No terminals yet</strong>이 보이면 오른쪽 위 컨트롤을 확인하세요. <strong>Watching / Viewing</strong>이라고 표시되어 있으면 클릭해 제어권을 가져온 다음 <strong>Start terminal</strong>을 선택하세요. 다른 기기가 이미 제어권을 갖고 있다면, 정말 넘겨받으려는 것인지 확인하세요.",
        extra:
          "이 줄을 입력하고 Enter를 누르세요. 그 아래에 같은 문구가 출력되어야 합니다. 휴대폰에서 입력하더라도 명령은 Mac에서 실행됩니다.",
        alt: "테스트 계정의 Mac 셸에서 Offdesk로 echo hello from offdesk를 실행하고, 그 아래에 hello from offdesk가 출력된 모습.",
        caption: "입력과 출력이 제대로 동작하는 실제 셸입니다. 터미널을 만들거나 입력할 수 있는지는 제어 상태에 따라 달라집니다.",
      },
      phone: {
        title: "5. 휴대폰 앱으로 스캔하기",
        body: "Mac에서 <strong>Phone</strong> 또는 <strong>Show me</strong>를 선택해 연결 패널을 여세요. <strong>Offdesk App · Recommended</strong>를 선택한 다음 <strong>Pair an encrypted device</strong>를 선택하세요. 휴대폰 App의 연결 화면에서 <strong>Scan QR Code</strong>를 선택하고 새로 생성된 암호화 페어링 코드를 스캔하세요. 카메라 접근을 요청하면 허용하세요.",
        extra:
          "<strong>Browser access</strong>는 휴대폰 기본 카메라로 스캔해 브라우저에서 열 수 있는 로그인 코드를 제공합니다. <strong>Offdesk App</strong>은 App 스캐너용 암호화 페어링 코드를 생성합니다. 한 가지 방식만 고르세요. 두 코드를 모두 스캔할 필요는 없습니다. 페어링 코드가 만료되면 Mac에서 새로 생성하세요.",
        alt: "로컬 주소, 휴대폰 앱 링크, Pair an encrypted device가 있는 Mac의 휴대폰 연결 패널. 로그인 코드와 링크는 가려져 있습니다.",
        caption: "이전 스크린샷은 코드와 로그인 링크를 가렸습니다. 0.7.1에서는 Offdesk App을 선택해 직접 페어링 코드를 생성하세요.",
        after:
          "페어링한 뒤 이 Mac과 그 터미널을 찾으세요. 선택할 터미널이 없으면 이전 단계대로 Mac에서 터미널을 만드세요. 휴대폰에서 짧은 명령을 실행해 본 다음, 휴대폰 App을 종료했다가 다시 열어 다시 연결되는지 확인하세요.",
      },
      return: {
        title: "6. 앱을 닫았다가 터미널로 돌아오기",
        body: "Mac App을 종료해도 Hub와 Node 서비스는 백그라운드에서 계속 실행됩니다. App을 다시 열면 터미널로 돌아갈 수 있습니다. App 종료는 Mac을 잠자기 상태로 두거나, 시스템을 종료하거나, macOS에서 로그아웃하는 것과는 다릅니다.",
        extra:
          "Mac은 전원을 켜 두고, 로그인한 상태로, 네트워크에 연결해 두세요. 로컬 주소는 그 네트워크 안에서 동작합니다. 집 밖에서 Offdesk를 쓸 준비가 되면 원격 접속을 따로 설정하세요. 코드를 스캔한다고 해서 로컬 주소가 인터넷에서 접근 가능해지지는 않습니다.",
      },
      cloud: {
        title: "7. 선택 사항: Offdesk 계정으로 집 밖에서 연결하기",
        body: "Offdesk(offdesk.so)를 통한 원격 접속은 현재 초대 전용 베타입니다. 로그인하고 <a href='https://offdesk.so'>offdesk.so</a>에서 초대를 등록하세요. Mac에서 <strong>Set up remote access</strong>를 선택하고, 로그인 단계를 따라 진행한 뒤 컴퓨터 인증을 확인하세요. 원격 주소가 준비되면 Offdesk App 방식으로 휴대폰을 페어링하세요.",
        extra:
          "처음 사용하는 사람의 전체 과정을 따라 하려면 이 사이트에서 최신 안정 버전의 macOS 앱과 Android 앱을 설치하세요. iOS는 TestFlight로 배포되며, 받을 수 있는 빌드는 테스트 그룹에 따라 다릅니다. 설정을 마친 뒤 Mac은 온라인 상태로 두고 휴대폰의 Wi-Fi를 꺼서 모바일 데이터로 터미널이 열리는지 확인하세요. 페어링된 휴대폰에서는 제목을 눌러 <strong>Hub &amp; connection</strong>을 열 수 있습니다. 로컬 네트워크에서만 쓴다면 Offdesk 계정과 초대는 건너뛰어도 됩니다.",
      },
    },
    trouble: "화면이 다르게 보인다면",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "Hub에 아직 사용할 수 있는 머신이 없다는 뜻입니다. 휴대폰을 호스트로 만들 필요는 없습니다. 먼저 Mac에서 설정을 확인하세요. 이전 0.6.3 버전의 문제라면, 이 Mac에서 Generate a token을 선택하고 생성된 명령 전체를 같은 Mac의 시스템 터미널에서 실행해 수동으로 복구할 수 있습니다. 이는 이전 릴리스를 위한 복구 방법이며, 일반 설치에 필요한 단계가 아닙니다.",
      ],
      [
        "스캔하면 로그인 페이지가 열리거나, IP 주소만으로는 로그인되지 않음",
        "주소에는 로그인 자격 증명이 들어 있지 않습니다. 브라우저 로그인에는 전체 로그인 링크나 그 일반 QR 코드를 쓰세요. 암호화 페어링에는 App의 스캐너로 암호화 페어링 코드를 스캔하세요. 전체 로그인 링크와 QR 코드는 공유 채팅에 올리지 마세요.",
      ],
      [
        "휴대폰이 연결되지 않거나 화면이 비어 있음",
        "두 기기가 같은 로컬 네트워크에 있는지, 선택한 주소에 휴대폰에서 접근할 수 있는지 확인하세요. 게스트 Wi-Fi는 기기끼리 격리할 수 있습니다. Mac에서 터미널이 동작하는지 확인하고, 휴대폰의 로컬 네트워크 권한을 확인하세요. 스캔 후에도 화면이 계속 검은색이라면 App을 종료했다가 다시 열고, App 버전, 휴대폰 모델, 재현 단계를 알려 주세요. 매번 다시 열어야 하는 상황이어서는 안 됩니다.",
      ],
    ] as [string, string][],
    tested: "실제로 무엇을 테스트했나요?",
    testedIntro:
      "2026년 9월 7일, Mac Mini에서 새로 만든 표준 계정 offdesk-test로 테스트했습니다. Offdesk 설정이나 서비스가 없고, 설치 스크립트도 미리 실행하지 않은 상태였습니다. 공장 초기화한 Mac이 아니라 깨끗한 사용자 계정이었습니다. 9월 10일에는 같은 테스트 계정에서 App/Hub 설정을 백업하고 초기화한 뒤, 0.7.1-rc.1의 자동 설정, 암호화 코드 생성, 터미널 입력, 다시 열기를 검증했습니다. 이 후속 테스트에서는 시스템 도구, 브라우저 상태, 이전 tmux 세션이 그대로 남아 있었습니다.",
    passed: [
      "DMG 다운로드, 사용자의 응용 프로그램 폴더로 드래그, Finder에서 실행.",
      "Hub / Node 자동 설치, 머신 등록, 실시간 연결 및 tmux 확인, 이어서 내용이 채워진 QR 코드 표시.",
      "실제 터미널에서의 입력과 출력.",
      "App을 종료했다가 다시 연 뒤의 터미널 유지, 테스트 Hub만 재시작한 뒤의 재연결.",
    ],
    pending:
      "이번 테스트에서 아직 완료하지 못한 항목: 실제 휴대폰에서의 스캔과 완전 종료 후 다시 열기, 테스트 사용자의 로그아웃/로그인, 서명·공증된 정식 배포 패키지의 Gatekeeper 통과. RC의 첫 실행은 사용자가 직접 허용했으며, 이것이 정식 배포 패키지가 통과된다는 증거는 아닙니다.",
    known:
      "온보딩 문제도 하나 재현했습니다. Watching 상태에서는 Start terminal 동작이 숨겨집니다. 다음에 할 일이 분명하도록 4단계에 제어권을 가져오는 동작을 넣었습니다.",
    next: "다음 단계",
    nextText: "먼저 로컬 네트워크에서 익숙해진 다음, 암호화 연결과 원격 접속에 대해 읽어 보세요.",
    encryption: "암호화 연결",
    lan: "로컬 네트워크 문제 해결",
    allDocs: "전체 기술 문서",
  },
};

export default ko;
