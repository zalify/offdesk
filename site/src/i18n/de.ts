import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const de: Dict = {
  chrome: {
    skip: "zum inhalt springen",
    homeLabel: "Offdesk Dev – Startseite",
    navLabel: "Hauptnavigation",
    nav: {
      download: "download",
      how: "funktionsweise",
      away: "fernzugriff",
      docs: "docs",
      cli: "cli",
    },
    discordLabel: "Offdesk auf Discord",
    githubLabel: "Offdesk auf GitHub",
    language: "sprache",
    languageLabel: "Sprache: {name}. Andere Sprache wählen",
    footer: {
      madeBy: "gemacht von {zalify}",
      tagline: "selbst gehostetes remote-terminal",
      gettingStarted: "erste schritte",
      tunnel: "tunnel-anleitung",
      security: "sicherheit",
      releases: "versionshinweise",
    },
    copy: "[kopieren]",
    copied: "[kopiert]",
    copyFailed: "[⌘C drücken]",
  },

  home: {
    title: "Offdesk — Ein Terminal für dich und deine Agents",
    description:
      "Selbst gehostetes Remote-Terminal für dich und deine Agents: Claude Code, Codex und alles in tmux. Agents nutzen die CLI, du übernimmst vom Handy. Hub unter MIT-Lizenz.",
    hero: {
      title: "Ein Terminal, das du mit deinen Agents teilst.",
      lead: "Agents öffnen Terminals über die CLI, tippen hinein und lesen sie aus. Du siehst dieselben Terminals auf dem Handy und übernimmst die Tastatur, wenn sie dich brauchen.",
      downloadMac: "download für mac",
      allDownloads: "alle downloads",
      copyInstallLabel: "Installationsbefehl kopieren",
      note: "Die Mac-App ist signiert und notarisiert, für Apple silicon und Intel. Der Einzeiler installiert den Hub auf macOS oder Linux.",
      figcaption: "Eine Illustration: ein Terminal, von einem Agent per CLI geöffnet und vom Handy aus beobachtet.",
    },
    proofLabel: "Auf einen Blick",
    proof: [
      { key: "jedes programm", value: "alles, was in tmux läuft" },
      { key: "rechner", value: "beliebig viele, eine url" },
      { key: "traffic", value: "über deinen eigenen hub" },
      { key: "agents", value: "open · send · wait · read" },
      { key: "lizenz", value: "selbst gehostet, Hub MIT" },
    ],
    beats: {
      title: "Wer die Tastatur braucht, nimmt sie sich.",
      items: [
        {
          label: "01 / agent",
          title: "dein Agent öffnet es",
          body: "Ein Befehl startet Claude Code, Codex oder irgendetwas anderes in einem Terminal auf einem deiner Rechner. Es läuft weiter, wenn alle weggehen.",
        },
        {
          label: "02 / du",
          title: "du siehst dasselbe",
          body: "Kein Transkript, sondern das Live-Terminal: auf dem Handy, dem Laptop oder im Browser. Wenn es anhält und fragt, siehst du es.",
        },
        {
          label: "03 / beide",
          title: "übernehmen, zurückgeben",
          body: "Antworte mit Enter oder übernimm die Tastatur. Auch im Browser des Agents: Melde dich für ihn an und gib ihn dann zurück.",
        },
      ],
    },
    start: {
      title: "Dein erstes Terminal in drei Schritten.",
      steps: [
        {
          label: "schritt 1",
          title: "Hub auf macOS oder Linux installieren",
          body: "Öffne die Mac-App, gib an, dass dies der Rechner ist, der immer an bleibt, und er wird dein Hub: startet bei der Anmeldung, startet neu, wenn er stoppt. Selbst hosten braucht kein Konto bei einem Anbieter. Auf einem NAS oder einem Server ohne Bildschirm erledigt eine Zeile dasselbe:",
        },
        {
          label: "schritt 2",
          title: "Handy koppeln oder im Browser anmelden",
          body: 'Wähle Offdesk App, um einen verschlüsselten Kopplungscode für den Scanner in der App zu erzeugen. Wähle Browser access für einen Anmeldelink im Browser. Beides findest du in der Mac-Menüleiste, oder führe <span class="inline-code">offdesk link</span> für den Browserzugriff aus.',
        },
        {
          label: "schritt 3",
          title: "Mit derselben tmux-Session verbinden",
          body: "Dieselbe tmux-Session wie am Schreibtisch, live. Halte den Hub wach und online. Alles, was in tmux läuft, läuft auch hier.",
        },
      ],
      readGuide: "mac-anleitung lesen",
      iphone: "iphone-app",
      android: "android-app",
      orBrowser: "oder ein beliebiger browser auf dem handy",
    },
    download: {
      title: "Clients für Desktop, Handy und Web.",
      lead: "Die Desktop-App ist auf dem Mac der Hub und überall ein Client. Die Handy-Apps umhüllen dasselbe Terminal, das der Browser zeigt.",
      mac: {
        body: "Eine DMG für Apple silicon und Intel. Mit einer Developer ID signiert und notarisiert, öffnet sie sich wie alles aus dem App Store. Auf dem Mac, der immer an bleibt, wird sie dein Hub; überall sonst ist sie ein Client.",
        button: ".dmg herunterladen →",
        meta: "macOS 11 oder neuer · universal · .dmg",
      },
      windows: {
        body: "Ein Client: Er öffnet die Terminals eines Hubs, der woanders läuft. Füge den Link ein, den der Hub ausgegeben hat, oder melde dich an. Ein Windows-Rechner kann nicht der Hub sein, denn der braucht tmux.",
        button: ".msi herunterladen →",
      },
      linux: {
        body: "Ein Client, wie unter Windows. Soll ein Linux-Rechner der Hub sein, ist die Einzeiler-Installation der richtige Weg: Sie betreibt den Hub als Dienst.",
        button: ".AppImage herunterladen →",
        meta: "x64 · .AppImage · .deb und .rpm auf {release}",
        release: "der Release-Seite",
      },
      iphone: {
        body: "Verfügbar über TestFlight. Öffne die Einladung auf deinem iPhone oder iPad, installiere die App und wähle dann Scan QR Code, um dich mit deinem Hub zu verbinden.",
        button: "beta beitreten →",
      },
      android: {
        body: 'Eine APK zum Sideloaden. Nimm <span class="inline-code">arm64-v8a</span> auf einem aktuellen Handy, <a href="/apk/universal">universal</a>, wenn du unsicher bist.',
        button: "apk herunterladen →",
      },
      cli: {
        title: "Hub, Node und CLI",
        body: "Die drei Binaries, für ein NAS, einen VPS oder jeden Rechner ohne Bildschirm. Linux und macOS, x64 und arm64.",
      },
    },
    how: {
      title: "Rust-Hub. Ausgehende WebSockets. Persistentes tmux.",
      items: [
        {
          title: "hub",
          body: "Ein Rust-Server mit Axum, SQLite als Speicher und eingebetteter Web-UI. Er authentifiziert Clients und leitet den Terminal-Traffic an deine macOS- und Linux-Nodes weiter. Installiere ein Binary oder deploye mit Docker.",
        },
        {
          title: "node",
          body: "Auf jedem Rechner, den du erreichen willst. Er baut die Verbindung zum Hub per WebSocket <em>nach außen</em> auf, deshalb braucht der Node weder einen eingehenden Port noch eine öffentliche IP. Jedes Terminal ist eine tmux-Session auf dem Rechner, dem es gehört: Sie überdauert die App, das Netzwerk und dein Weggehen. Deinstallierst du Offdesk, ist sie immer noch da.",
        },
        {
          title: "client",
          body: "React und xterm.js rendern das interaktive Terminal im Browser. Tauri-Apps ergänzen native verschlüsselte Kopplung auf Desktop und Mobilgeräten. Die Rust-CLI bietet skriptbaren Zugriff. Clients teilen die Terminalausgabe über den Hub; eine Steuerungs-Lease legt fest, wer tippen darf.",
        },
      ],
      note: "Zwei Bildschirme an einem Terminal sind zwei Clients eines Hubs, verbunden mit einer tmux-Session. Trennt sich ein Client, endet die Session auf dem Node nicht. Offdesk nutzt einen eigenen Hub/Node-Transport, nicht SSH: Installiere offdesk-node auf jedem Rechner, den du erreichen willst.",
    },
    away: {
      title: "Selbst hosten im LAN. Fernzugriff, wenn du ihn brauchst.",
      body: [
        "Betreibe den Open-Source-Hub auf macOS, Linux, einem NAS oder einem VPS. Nodes verbinden sich ausgehend mit diesem Hub; die Terminal-Sessions bleiben auf den Rechnern, auf denen tmux läuft. Dein Hub und diese Rechner müssen wach und online bleiben.",
        `Starte cloudflared neben deinem Hub, um einen HTTPS-Endpunkt bereitzustellen, ohne einen Port am Router zu öffnen – auch hinter NAT oder CGNAT. Konfiguriere deine Domain und den Tunnel-Ingress, oder nutze <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> für privaten Zugriff auf den Hub von all deinen Geräten.`,
        `Gekoppelte Offdesk Apps verschlüsseln den Terminal-Traffic Ende-zu-Ende zwischen App und Hub, auch durch einen Tunnel. Normaler Browserzugriff nutzt HTTPS und eine eigene Authentifizierung, die der Tunnelanbieter terminiert; er bekommt die App-Verschlüsselung nicht automatisch. Siehe die <a href="${repo}/blob/main/docs/encrypted-connections.md">Anleitung zu verschlüsselten Verbindungen</a>.`,
      ],
      tunnelGuide: "tunnel-anleitung",
      lanSetup: "lan-einrichtung",
      pairing: "verschlüsselte app-kopplung",
      cloudSetup: "fernzugriff einrichten",
      homeTitle: "# auf dem rechner zu hause",
      homeBody:
        'Erstelle den Tunnel im Cloudflare-Dashboard, richte ihn auf <span class="inline-code">server:4317</span>, leg sein Token in <span class="inline-code">.env</span> ab, und dann:',
      copyTunnelLabel: "Tunnel-Befehle kopieren",
      homeAfter:
        "Für verschlüsselten App-Zugriff scannst du den verschlüsselten Kopplungscode mit dem Scanner der App. Für normalen Browserzugriff richtest du die Authentifizierung ein, wie in der Tunnel-Anleitung beschrieben.",
      cloudBadge: "beta nur auf einladung",
      cloudBody:
        "Das gehostete Offdesk unter offdesk.so bietet optional verwalteten Fernzugriff. Der Dienst ist Closed Source; im öffentlichen Repository stehen Hub, Node und CLI unter MIT-Lizenz, Web-UI und Apps sind unter FSL-1.1-MIT im Quellcode einsehbar. Der lokale Connector prüft die verschlüsselte Erreichbarkeit und versucht es bei anhaltenden Tunnelfehlern automatisch mit Backoff erneut. Lokale Nutzung braucht kein Offdesk-Konto.",
    },
    more: {
      title: "Remote-Shells, mobile Coding-Agents und CLI-Automatisierung.",
      machines: {
        title: "macOS- und Linux-Terminals verwalten",
        body: "Das NAS, der VPS, der Laptop. Öffne den Hub, wähle <strong>Add a machine</strong>, und er gibt dir eine Zeile mit einem Token darin. Füge sie auf diesem Rechner ein; er taucht auf.",
      },
      agents: {
        title: "Bring jeden Agent mit",
        body: "Offdesk umhüllt keinen Agent und spricht nicht sein Protokoll. Es gibt dir das Terminal, in dem der Agent ohnehin läuft – dein Abo, deine Konfiguration, deine Dotfiles.",
        anyCli: "jede CLI",
      },
      phone: {
        title: "Claude Code und Codex vom Handy aus nutzen",
        body: [
          `Passe die Tastenleiste an: Esc, Tab, Shift+Tab, Shift-Kombinationen und Backspace mit Wiederholung. Pfeiltasten, Enter und der Tastatur-Umschalter bleiben fest; die übrigen Tasten blendest du unter Settings aus oder ordnest sie um. <a href="${repo}/blob/main/docs/terminal-keys.md">Terminal-Tasten konfigurieren</a>. Die Apps bringen einen QR-Scanner und Ende-zu-Ende-verschlüsselte Verbindungen mit.`,
          `Ein Warte-Banner lässt dich die Bestätigungsanfrage eines anderen Terminals öffnen oder Enter an dessen aktuelle Auswahl senden, ohne deine Ansicht zu verlassen. <a href="${repo}/blob/main/docs/terminal-attention.md">Mehr zu Bestätigungs-Shortcuts</a>.`,
          "<strong>iPhone und iPad:</strong> Tritt über den Link unten der öffentlichen TestFlight-Beta bei. TestFlight kümmert sich um App-Updates.",
        ],
        android: "android-apk",
        universal: "universal-build",
        iphone: "iphone · testflight",
        heroAlt: "Claude Code auf einem Schreibtischrechner, während ein Handy mit derselben tmux-Session verbunden ist",
        iosAlt: "Claude Code in der Offdesk-iPhone-App, verbunden mit dem Mac zu Hause",
        stillAlt: "Ein Offdesk-Terminal auf einem Handy: Claude Code auf einem Mac zu Hause, verbunden über den Browser des Handys",
        caption: "Claude Code in einer persistenten Remote-tmux-Session.",
      },
    },
    cli: {
      title: "Remote-Terminals mit der Offdesk CLI automatisieren.",
      lead: "Steuere entfernte tmux-Sessions mit den Befehlen open, send, wait und read aus Shell-Skripten oder von KI-Coding-Agents. Dank JSON-Ausgabe können deine Skripte Terminal-IDs erfassen und Ergebnisse zwischen Schritten weitergeben. Ein Terminal, das ein Agent öffnet, ist als von einem Agent geöffnet markiert, damit du es von deinen eigenen unterscheiden kannst.",
      body: `Ein Token bedeutet Remote Code Execution auf jedem Rechner, den du registriert hast. Erzeuge eins pro Agent, gib ihm einen Namen, widerrufe es einzeln. <a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "Beispiel kopieren",
    },
    compare: {
      title: "Im Vergleich",
      note: "Jede Zelle stammt aus der Dokumentation des jeweiligen Projekts, Stand 2026-09-01. Die Quellen stehen unter derselben Tabelle im README.",
      project: "Projekt",
      columns: [
        "Beliebiges Terminalprogramm",
        "Rechner pro Hub",
        "Traffic läuft über",
        "Agents steuern es per CLI",
        "Selbst gehostet",
      ],
      rows: [
        ["Alles, was in tmux läuft", "Beliebig viele, eine URL", "Deinen eigenen Hub", "open / send / wait / read", "Ja, MIT + FSL"],
        ["Nein – eine Claude-Code-Session, kein Terminal", "Sessions mehrerer Rechner in einer Liste", "Server von Anthropic; Transkript wird dort gespeichert", "Nicht dokumentiert", "Nein"],
        ["Ja – vt &lt;beliebiger Befehl&gt;, vt --shell", "Ein Server pro Rechner", "Deine Wahl: LAN, Tailscale, ngrok, Cloudflare", "Startet nur Befehle", "Ja, MIT"],
        ["Nein – umhüllt claude und codex", "Mehrere; spawn --machine", "Standardmäßig slopus-Cloud, Ende-zu-Ende-verschlüsselt", "create / send / history / wait", "Optional, MIT"],
        ["Agent-Sessions; kein rohes Terminal dokumentiert", "Mehrere gleichzeitig pro Agent", "Standardmäßig api.omnara.com", "CLI und REST", "Optional, Apache-2.0"],
        ["Ja – echtes Terminal, 30+ CLI-Agents", "Mehrere, über SSH-Worktrees und orca serve", "Standardmäßig Orca Relay, oder direkt im LAN", "orca terminal create/send/read/wait", "Ja, MIT"],
      ],
    },
    close: {
      title: "Richte heute Abend deinen Hub ein.",
      lead: "Installiere den Hub auf macOS oder Linux, registriere deine Rechner und öffne persistente tmux-Sessions im Browser oder auf dem Handy.",
      iphone: "iphone-app",
      android: "android-app",
    },
  },

  tunnel: {
    title: "Offdesk hinter einem Cloudflare Tunnel",
    description:
      "Erreiche deinen Hub zu Hause von überall, ohne einen Port zu öffnen: die komplette Einrichtung eines Cloudflare Tunnels für das Remote-Terminal Offdesk.",
    heading: "Ein Cloudflare Tunnel",
    lead: "Für einen Hub auf einem NAS oder einem Desktop-Rechner zu Hause. <code>cloudflared</code> läuft neben dem Hub und baut die Verbindung zu Cloudflare <em>nach außen</em> auf; Cloudflare liefert dann deinen Hostnamen über HTTPS aus. Keine Portweiterleitung, kein dynamisches DNS, kein Zertifikat zu erneuern, und es funktioniert hinter CGNAT, wo eine Portweiterleitung gar nicht möglich ist.",
    intro: `Bei normalen Browserverbindungen terminiert Cloudflare HTTPS und kann den Terminal-Traffic lesen. Verschlüsselte App-Kopplung fügt Verschlüsselung zwischen App und Hub hinzu, sodass der Tunnel verschlüsselte Terminalinhalte transportiert. Folge für diesen Modus der <a href="${repo}/blob/main/docs/encrypted-connections.md">Anleitung zu verschlüsselten Verbindungen</a>. Du kannst stattdessen auch ein <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a> nutzen: dieselben Binaries, niemand dazwischen.`,
    needDomain: "Du brauchst eine Domain in einem Cloudflare-Konto. Der kostenlose Plan reicht.",
    create: {
      title: "1. Tunnel erstellen",
      body: "Cloudflare Zero Trust Dashboard → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>. Gib ihm einen Namen und kopiere dann das angezeigte Token – die lange Zeichenkette nach <code>--token</code> im Installationsbefehl. Dieses Token ist ein Zugangsschlüssel: Wer es besitzt, kann Traffic als dein Tunnel ausliefern.",
      hostname: "Füge dem Tunnel einen öffentlichen Hostnamen hinzu:",
      field: "Feld",
      value: "Wert",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> ist der Dienstname des Hubs in <code>docker-compose.yml</code>; darüber erreicht <code>cloudflared</code> ihn im Compose-Netzwerk. Der Weg von Cloudflare zu deinem Rechner liegt im Tunnel; der Weg von <code>cloudflared</code> zum Hub verlässt nie das Docker-Netzwerk, also ist einfaches HTTP dort in Ordnung.",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>.env</code> neben <code>docker-compose.yml</code>:",
      secretPlaceholder: "Ausgabe von: openssl rand -hex 32",
      tokenPlaceholder: "das Token aus Schritt 1",
      oauth: `Bei einem Hub im Internet meldest du dich über GitHub oder Google an. Registriere die OAuth-Callback-URLs genau wie in <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">der VPS-Anleitung</a> – der Hub baut sie aus <code>OFFDESK_BASE_URL</code>, und ein Tunnel ändert daran nichts. Dann:`,
      profile:
        "Erst das Profil <code>tunnel</code> startet <code>cloudflared</code>; ohne es läuft nur der Hub, weiterhin an <code>127.0.0.1:4317</code> gebunden. Prüfe, ob beide laufen:",
    },
    machines: {
      title: "3. Rechner",
      body: "Öffne den Hub im Browser und wähle <strong>Add host</strong>: Er zeigt eine Zeile mit bereits eingesetztem Registrierungstoken. Auf dem Rechner, den du erreichen willst:",
      after:
        "Ein Rechner im selben LAN wie der Hub geht trotzdem über Cloudflare hinaus und wieder zurück. Wenn dich das stört, registriere ihn stattdessen mit der LAN-Adresse des Hubs – der Agent auf dem Rechner muss nur den Hub erreichen, und es ist ihm egal, dass dein Handy denselben Hub unter einem anderen Namen erreicht.",
    },
    notes: {
      title: "Hinweise",
      items: [
        "<strong>Die Anmeldung steht jedem offen, der die URL findet</strong>, genau wie beim VPS-Weg: Jedes GitHub- oder Google-Konto kann auf deinem Hub ein Konto anlegen. Es gibt keine Allowlist. Cloudflare Access kann einen zweiten Login vor den ganzen Hostnamen setzen, aber dann braucht alles, was kein Browser ist – <code>offdesk-node</code>, die CLI, die Android-App –, ein eigenes Access-Service-Token, und der Agent auf dem Rechner hat keinen Platz dafür. Beschränke die Access-Richtlinie entweder auf die Browser-Pfade, oder lass sie weg und verlass dich auf die Anmeldung des Hubs.",
        "<strong>Langlebige WebSockets sind kein Problem.</strong> Die Agents auf den Rechnern pingen alle 30 Sekunden und Browser pingen auf Anwendungsebene, sodass Leerlauf-Timeouts unterwegs keine Terminals stillschweigend trennen.",
        "<strong>Nutze keinen Quick Tunnel</strong> (<code>cloudflared tunnel --url</code>, die Hostnamen <code>*.trycloudflare.com</code>) für etwas anderes als eine Demo. Der Hostname ändert sich bei jedem Neustart, was deine OAuth-Callback-URLs, jeden registrierten Rechner und jedes Handy, das den alten gespeichert hat, ungültig macht.",
      ],
    },
    others: `Die beiden anderen Wege – ein VPS hinter Caddy und Tailscale – samt den Abwägungen zwischen allen dreien: <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>.`,
  },

  mac: {
    title: "Dein erstes Terminal auf dem Mac",
    description:
      "Schritt-für-Schritt-Anleitung mit Screenshots: Offdesk auf dem Mac installieren, das erste Terminal öffnen und dein Handy verbinden.",
    eyebrow: "Erste Schritte · macOS",
    lead: "Mach den Mac, der immer an bleibt, zu deinem Hub. Öffne dann sein Terminal vom Handy aus. Starte mit beiden Geräten im selben lokalen Netzwerk.",
    preview: "Zu den Screenshots",
    previewText:
      "Diese Screenshots stammen aus unserem Test von 0.6.4-rc.1 auf einem Mac Mini. Die aktuelle stabile Version bringt eine überarbeitete Handy-Kopplung und Einrichtung des Fernzugriffs. Die Anleitung unten folgt der neuen Version; die älteren Screenshots zeigen noch ihre RC-Bezeichnungen und ihr Layout. Das Kopplungsfenster trennt jetzt Offdesk App von Browser access. Der Download-Button liefert die stabile Version.",
    download: "Für Mac herunterladen",
    phone: "Handy-App holen",
    contents: "Auf dieser Seite",
    stepLabel: "schritt {n}",
    openScreenshot: "Screenshot in voller Größe öffnen",
    before: "Bevor du anfängst",
    needs: [
      "Ein Mac, der eingeschaltet und verbunden bleiben kann, und sein macOS-Benutzerkonto.",
      "Handy und Mac im selben lokalen Netzwerk. Ein per Kabel angeschlossener Mac und ein Handy im WLAN desselben Routers funktionieren auch.",
      "Offdesk auf deinem Handy: TestFlight für iPhone / iPad oder die Android-APK von dieser Website.",
    ],
    terms:
      "Der Hub verwaltet die Verbindungen; der Node stellt die Terminals eines Rechners bereit. Wählst du diesen Mac als Hub, wird beides installiert. Die normale Einrichtung per App braucht keinen separaten install.sh-Befehl und kein Docker.",
    steps: {
      install: {
        title: "1. Mac-App installieren",
        body: "Lade das Disk-Image von der <a href='/mac'>Mac-Downloadseite</a>. Öffne die DMG, zieh Offdesk Dev in den Ordner „Programme“ (Applications) und öffne dann die installierte Kopie. Starte die App nicht dauerhaft aus dem eingebundenen Disk-Image.",
        extra:
          "Mit einem Standard-Benutzerkonto brauchst du eventuell das Passwort eines Administrators, um in den Ordner „Programme“ des Systems zu schreiben. Du kannst auch einen Programme-Ordner in deinem eigenen Benutzerordner verwenden. „RC“ im Screenshot kennzeichnet unseren Test-Build.",
        alt: "Das Fenster des Mac-Disk-Images mit Offdesk RC und einer Verknüpfung zum Ordner Applications.",
        caption: "Zieh die App in „Programme“ und starte dann die installierte Kopie.",
      },
      choose: {
        title: "2. Diesen Mac zum Hub machen",
        body: "Wähle bei <strong>Which machine is this?</strong> die Option <strong>The one that stays on → Set this machine up</strong>. Das ist die richtige Wahl, wenn dein Handy Terminals erreichen soll, die auf diesem Mac laufen.",
        extra:
          "Wähle <strong>Just connecting</strong> nur, wenn du schon einen Hub woanders hast und diesen Mac als Client nutzen willst. Für diese lokale Einrichtung brauchst du kein Konto.",
      },
      ready: {
        title: "3. Den Mac fertig einrichten lassen",
        body: "Die überarbeitete Einrichtung prüft vier Dinge, bevor sie den Bildschirm für die Handy-Verbindung zeigt. Dass eine Adresse auf dem Bildschirm erscheint, heißt allein noch nicht, dass die Einrichtung fertig ist.",
        checks: [
          "Der Hub läuft und antwortet.",
          "Dieser Mac ist beim Hub registriert.",
          "Der lokale Node ist online.",
          "Das Terminal-Tool tmux ist verfügbar.",
        ],
        extra:
          "Sobald alles bereit ist, siehst du <strong>Connect your phone</strong>. Wähle <strong>Pair an encrypted device</strong>, um den Kopplungscode zu erzeugen. Schlägt eine Prüfung fehl, nutze die Wiederholen-Aktion auf dem Einrichtungsbildschirm. Fragt macOS, ob Offdesk Dev eingehende Verbindungen annehmen darf, erlaube es auf dem Mac, den dein Handy erreichen soll.",
      },
      terminal: {
        title: "4. Erstes Terminal öffnen",
        body: "Wähle <strong>Open my terminal</strong>. Siehst du <strong>No terminals yet</strong>, schau auf das Bedienelement oben rechts: Steht dort <strong>Watching / Viewing</strong>, klick darauf, um die Steuerung zu übernehmen, und wähle dann <strong>Start terminal</strong>. Hat bereits ein anderes Gerät die Steuerung, vergewissere dich, dass du wirklich übernehmen willst.",
        extra:
          "Tippe diese Zeile ein und drück Enter. Die Wörter sollten darunter zurückkommen. Befehle laufen auf deinem Mac, auch wenn du sie auf dem Handy tippst.",
        alt: "Offdesk führt echo hello from offdesk in der Mac-Shell des Testkontos aus, darunter erscheint hello from offdesk.",
        caption: "Eine echte Shell mit funktionierender Ein- und Ausgabe. Der Steuerungsstatus bestimmt, ob du ein Terminal erstellen oder tippen kannst.",
      },
      phone: {
        title: "5. Mit der Handy-App scannen",
        body: "Wähle auf dem Mac <strong>Phone</strong> oder <strong>Show me</strong>, um das Verbindungsfenster zu öffnen. Wähle <strong>Offdesk App · Recommended</strong> und dann <strong>Pair an encrypted device</strong>. Wähle im Verbindungsbildschirm der Handy-App <strong>Scan QR Code</strong> und scanne den neu erzeugten verschlüsselten Kopplungscode. Erlaube den Kamerazugriff, wenn du gefragt wirst.",
        extra:
          "<strong>Browser access</strong> liefert einen Anmeldecode, den die System-Kamera deines Handys in einem Browser öffnen kann. <strong>Offdesk App</strong> erzeugt einen verschlüsselten Kopplungscode für den Scanner der App. Wähle einen Modus; du musst nicht beide Codes scannen. Ist der Kopplungscode abgelaufen, erzeuge auf dem Mac einen neuen.",
        alt: "Das Fenster zur Handy-Verbindung auf dem Mac mit lokaler Adresse, Links zur Handy-App und Pair an encrypted device; Anmeldecode und Link sind verdeckt.",
        caption: "Der ältere Screenshot verdeckt Code und Anmeldelink. Wähle in 0.7.1 Offdesk App und erzeuge deinen eigenen Kopplungscode.",
        after:
          "Suche nach dem Koppeln diesen Mac und sein Terminal. Gibt es kein Terminal zur Auswahl, erstelle eins auf dem Mac wie im vorigen Schritt. Probiere einen kurzen Befehl vom Handy aus, beende dann die Handy-App und öffne sie neu, um zu prüfen, ob sie sich wieder verbindet.",
      },
      return: {
        title: "6. App schließen. Zurück zum Terminal.",
        body: "Beendest du die Mac-App, laufen die Dienste von Hub und Node im Hintergrund weiter. Öffnest du die App wieder, kommst du zurück zum Terminal. Die App zu beenden ist etwas anderes, als den Mac in den Ruhezustand zu versetzen, ihn auszuschalten oder dich von macOS abzumelden.",
        extra:
          "Lass den Mac eingeschaltet, angemeldet und verbunden. Eine lokale Adresse funktioniert in diesem Netzwerk; richte den Fernzugriff separat ein, wenn du Offdesk unterwegs nutzen willst. Einen Code zu scannen macht eine lokale Adresse nicht über das Internet erreichbar.",
      },
      cloud: {
        title: "7. Optional: mit deinem Offdesk-Konto von unterwegs verbinden",
        body: "Fernzugriff über Offdesk (offdesk.so) ist derzeit eine Beta nur auf Einladung. Melde dich an und löse deine Einladung auf <a href='https://offdesk.so'>offdesk.so</a> ein. Wähle auf dem Mac <strong>Set up remote access</strong>, folge den Anmeldeschritten und bestätige die Autorisierung des Computers. Sobald die Fernzugriffsadresse bereit ist, koppelst du dein Handy im Modus Offdesk App.",
        extra:
          "Für den kompletten Ablauf als neuer Nutzer installierst du die neuesten stabilen macOS- und Android-Apps von dieser Website. iOS wird über TestFlight verteilt; welche Builds verfügbar sind, hängt von deiner Testgruppe ab. Schalte nach der Einrichtung das WLAN des Handys aus und prüfe das Terminal über mobile Daten, während der Mac online bleibt. Ein gekoppeltes Handy öffnet <strong>Hub &amp; connection</strong> über seinen Titel. Im lokalen Netzwerk kannst du das Offdesk-Konto und Einladungen überspringen.",
      },
    },
    trouble: "Wenn dein Bildschirm anders aussieht",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "Der Hub hat noch keinen nutzbaren Rechner; dein Handy muss kein Host werden. Prüfe zuerst die Einrichtung auf dem Mac. Für das ältere Problem in 0.6.3 gibt es einen manuellen Ausweg: Wähle auf diesem Mac Generate a token und führe den vollständigen erzeugten Befehl im System-Terminal desselben Macs aus. Das ist ein Rettungsweg für die ältere Version, kein Pflichtschritt der normalen Installation.",
      ],
      [
        "Scannen öffnet eine Anmeldeseite, oder die IP-Adresse allein meldet nicht an",
        "Eine Adresse allein enthält keine Anmeldedaten. Nutze für die Anmeldung im Browser den vollständigen Anmeldelink oder seinen normalen QR-Code. Nutze für die verschlüsselte Kopplung den Scanner der App mit dem verschlüsselten Kopplungscode. Teile vollständige Anmeldelinks und QR-Codes nicht in gemeinsamen Chats.",
      ],
      [
        "Das Handy kann sich nicht verbinden, oder der Bildschirm bleibt leer",
        "Prüfe, ob beide Geräte im selben lokalen Netzwerk sind und die gewählte Adresse vom Handy aus erreichbar ist. Gast-WLAN kann Geräte voneinander isolieren. Stell sicher, dass das Terminal auf dem Mac funktioniert, und prüfe die Berechtigung für das lokale Netzwerk auf dem Handy. Bleibt der Bildschirm nach dem Scannen schwarz, beende die App und öffne sie neu; melde dann App-Version, Handymodell und die Schritte. Das Neuöffnen sollte nicht jedes Mal nötig sein.",
      ],
    ] as [string, string][],
    tested: "Was haben wir tatsächlich getestet?",
    testedIntro:
      "Am 7. September 2026 haben wir auf einem Mac Mini mit einem neuen Standardkonto, offdesk-test, getestet – ohne Offdesk-Konfiguration oder -Dienste und ohne vorher ausgeführtes Installationsskript. Das war ein sauberes Benutzerkonto, kein auf Werkseinstellungen zurückgesetzter Mac. Am 10. September haben wir in diesem Testkonto die App-/Hub-Konfiguration gesichert und zurückgesetzt und bei 0.7.1-rc.1 die automatische Einrichtung, die Erzeugung verschlüsselter Codes, die Terminal-Eingabe und das erneute Öffnen geprüft. Bei diesem Folgetest blieben Systemtools, Browserzustand und alte tmux-Sessions erhalten.",
    passed: [
      "DMG herunterladen, in den Programme-Ordner des Benutzers ziehen und aus dem Finder starten.",
      "Automatische Installation von Hub / Node, Registrierung des Rechners, Prüfung der Live-Verbindung und von tmux, danach ein ausgefüllter QR-Code.",
      "Ein- und Ausgabe in einem echten Terminal.",
      "Das Terminal bleibt nach Beenden und erneutem Öffnen der App erhalten, und die Verbindung kommt nach einem Neustart nur des Test-Hubs wieder.",
    ],
    pending:
      "In diesem Durchlauf noch nicht abgeschlossen: Scannen mit einem echten Handy und Kaltstart der App, Ab- und Anmelden des Testbenutzers sowie die Gatekeeper-Freigabe des signierten, notarisierten Produktionspakets. Der Benutzer hat den ersten Start des RC freigegeben; das ist kein Nachweis, dass die Produktionsverteilung akzeptiert wird.",
    known:
      "Außerdem haben wir eine Lücke im Onboarding reproduziert: Watching verbirgt die Aktion Start terminal. Schritt 4 enthält deshalb die Aktion zum Übernehmen der Steuerung, damit du einen klaren nächsten Schritt hast.",
    next: "Weiter geht’s",
    nextText: "Mach dich zuerst im lokalen Netzwerk vertraut, lies dann über verschlüsselte Verbindungen und Fernzugriff.",
    encryption: "Verschlüsselte Verbindungen",
    lan: "Fehlerbehebung im lokalen Netzwerk",
    allDocs: "Alle technischen Docs",
  },
};

export default de;
