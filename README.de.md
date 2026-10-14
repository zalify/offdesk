<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" alt="Offdesk DEV" height="48">
  </picture>
</p>

<p align="center">
  <img src="docs/media/hero-banner.png" alt="Ein Terminal, geteilt von dir und deinen Agents. Jedes Programm in tmux, auf all deinen Rechnern, hinter einem Hub, den du selbst betreibst." width="800">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <b>Deutsch</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a>
</p>

# Offdesk DEV — selbst gehostetes Remote-Terminal für tmux und KI-Coding-Agents

> Dies ist eine Übersetzung. Maßgeblich ist das englische [README.md](README.md),
> falls die beiden voneinander abweichen. Website auf Deutsch:
> [offdesk.dev/de](https://offdesk.dev/de/).

**Ein Terminal, geteilt von dir und deinen Agents.** Agents öffnen Terminals
über die `offdesk` CLI, tippen hinein und lesen sie aus; du verfolgst dieselben
Terminals auf deinem Smartphone und übernimmst die Tastatur, wenn sie dich
brauchen.

Greif auf **Claude Code, Codex, OpenCode oder jedes andere Terminalprogramm**
zu – aus dem Browser, vom iPhone, vom Android-Smartphone oder aus der
Desktop-App. Offdesk verbindet Clients über einen einzigen, selbst gehosteten
Hub mit dauerhaften **tmux-Sessions** auf deinen eigenen macOS- und
Linux-Rechnern. Befehle laufen auf dem entfernten Rechner; die Clients
übertragen Terminal-Ein- und -Ausgabe über WebSocket-Verbindungen.

Die App wird als **Offdesk DEV** installiert; dieses README nennt das Projekt
kurz Offdesk. Die Kommandozeilenwerkzeuge behalten den Namen `offdesk`: die
`offdesk` CLI, der Server `offdesk-hub` und der Rechner-Agent `offdesk-node`.

Damit schaust du vom Smartphone nach einem KI-Coding-Agent, setzt eine Shell
nach einem Verbindungsabbruch fort oder verwaltest Terminals auf Mac,
Linux-Server, NAS und VPS über eine einzige Oberfläche. Die Rechner, auf denen
dein Hub und deine Sessions laufen, müssen online bleiben.

- **Dauerhafte Remote-Sessions:** Verbinde dich wieder mit demselben
  tmux-Terminal, samt interaktiven CLIs, Editoren, Build-Ausgabe und
  Shell-History.
- **Mehrere Rechner hinter einem Hub:** Jeder `offdesk-node` baut die
  Verbindung zum Hub von sich aus auf; Nodes brauchen weder einen eingehenden
  Port noch eine öffentliche IP.
- **Terminal-Steuerung auf dem Smartphone:** eine Tastenleiste als
  gleichmäßiges Raster, mit anpassbaren Kurzbefehlstasten, Shift+Tab,
  Shift-Kombinationen und wiederholender Backspace-Taste; Pfeiltasten, Enter
  und der Tastatur-Schalter bleiben fest. Dazu Dateianhänge und verschlüsseltes
  Pairing der App per QR-Code. Tippe in der Titelleiste auf den Namen des
  Terminals, um die Session zu wechseln; `[f]`, `[b]` und `[m]` daneben öffnen
  Dateien, den Agent-Browser sowie Machines & Hub.
- **Automatisierung per CLI:** Terminal öffnen, Eingaben senden, auf Ausgabe
  warten und Ergebnisse lesen – mit `offdesk open / send / wait / read` und
  JSON-Ausgabe. Terminals, die ein Agent geöffnet hat, sind in den Apps als
  solche gekennzeichnet.
- **Selbst gehostet:** Rust-Binaries oder Docker auf macOS/Linux, mit
  SQLite-Speicher und der Web-UI direkt im Hub-Binary.
- **Verschlüsselte App-Verbindungen:** Ende-zu-Ende-Verschlüsselung zwischen
  gekoppelten Apps und dem Hub. Normaler Browserzugriff nutzt einen eigenen
  Anmeldeweg; öffentlicher Browserzugriff erfordert HTTPS und Authentifizierung.

Hub, node, CLI und Clients in diesem Repository stehen unter der
**MIT-Lizenz**. Selbst hosten geht ohne Konto beim Anbieter. Das optionale
**Offdesk Cloud** bietet verwalteten Fernzugriff als separaten,
Closed-Source-Dienst. Sein quelloffener lokaler Connector prüft die
verschlüsselte Erreichbarkeit und startet nach anhaltenden Tunnel-Ausfällen
automatisch neu, mit Backoff bei längeren Störungen.

Fragen, Setups, die nicht funktioniert haben, Wünsche:
[Discord](https://discord.gg/aFUu6VMzc).

## Download

| | | |
|---|---|---|
| **macOS** | [offdesk.dev/mac](https://offdesk.dev/mac) | Ein dmg für Apple Silicon und Intel, signiert und notarisiert. Kann der Hub sein. |
| **Windows** | [offdesk.dev/windows](https://offdesk.dev/windows) | x64 `.msi`. Ein Client. |
| **Linux** | [offdesk.dev/linux](https://offdesk.dev/linux) | x64 `.AppImage`; `.deb` und `.rpm` auf [der Release-Seite](https://offdesk.dev/desktop). Ein Client. |
| **iPhone / iPad** | [Über TestFlight beitreten](https://testflight.apple.com/join/rV4ktaGv) | Die App für verschlüsseltes Pairing nutzen; ein Browser kann den Anmeldelink des Hubs verwenden. |
| **Android** | [offdesk.dev/apk](https://offdesk.dev/apk) | `arm64-v8a`; im Zweifel [`/apk/universal`](https://offdesk.dev/apk/universal). |
| **Hub, node, CLI** | `curl -fsSL https://offdesk.dev/install \| sh` | Linux und macOS, x64 und arm64. Für ein NAS, einen VPS, alles ohne Bildschirm. |

Jeder Link zeigt auf das neueste Release seiner Art. Windows ist ein
Desktop-Client; Linux kann auch einen Hub betreiben, wenn tmux separat
installiert ist.

## Dokumentation

- [Installation unter macOS und Pairing mit dem Smartphone](https://offdesk.dev/de/docs/mac)
- [Einrichtung im LAN](docs/setup-lan.md) und [öffentlicher Zugriff mit HTTPS, OAuth oder Tailscale](docs/setup-public.md)
- [Ende-zu-Ende-verschlüsselte App-Verbindungen](docs/encrypted-connections.md) und
  [optionale Einrichtung von Offdesk Cloud](docs/managed-connections.md)
- [Web-Vorschau für localhost](docs/web-previews.md): optionale Weiterleitung über
  eine eigene Preview-Domain und HTTPS-Ingress, getrennt von der
  Terminal-E2EE
- [Vorschau von HTML-Dateien](docs/html-file-previews.md): eine `.html`-Datei
  eines Rechners als Seite in der Desktop- oder Android-App öffnen
- [Terminal-Tasten anpassen](docs/terminal-keys.md): Anordnung der Tasten,
  Shift-Kombinationen und Löschen nach links, ohne die Systemtastatur erneut
  zu öffnen
- [Agent-Browser](docs/agent-browser.md): ein Headless-Chromium auf einem
  Rechner, den Agents mit `offdesk browser` steuern und dir übergeben, wenn sie
  einen Menschen brauchen
- [Aus dem Quellcode bauen](docs/building.md) · [Sicherheitsmodell](SECURITY.md)
- [Release Notes und Versionsgeschichte](https://github.com/zalify/offdesk/releases)

## Installation

Am besten startest du mit der bebilderten Mac-Anleitung:
[Deutsch](https://offdesk.dev/de/docs/mac) ·
[English](https://offdesk.dev/docs/mac) ·
[简体中文](https://offdesk.dev/zh/docs/mac). Sie enthält echte Screenshots der
App, das Pairing mit dem Smartphone, die ersten Schritte im Terminal und den
Umfang unserer Tests mit frischen Benutzerkonten.

Installiert wird auf dem Rechner, der immer läuft – einem Mac, einem NAS. Das
ist meist auch der erste Rechner, den du erreichen willst.

**Auf einem Mac:** Lade die App von [offdesk.dev/mac](https://offdesk.dev/mac)
herunter (signiert und notarisiert, ein dmg für Apple Silicon und Intel). Beim
Öffnen stellt sie eine einzige Frage: Welcher Rechner ist das? Wählst du **The
one that stays on**, installiert sie Hub, node und tmux als Dienste, die beim
Login starten und neu starten, falls sie beendet werden, registriert diesen
Rechner und zeigt den Code, den dein Smartphone scannt. Die App bleibt in der
Menüleiste; dort findest du den Code fürs Smartphone, die Hub-Adresse und
**Add a machine**. Wählst du **Just connecting**, ist sie – wie das Smartphone
– ein Client eines Hubs, der woanders läuft.

**Auf einem NAS, einem VPS oder allem ohne Bildschirm:**

```bash
curl -fsSL https://offdesk.dev/install | sh
```

Diese eine Zeile installiert die drei Binaries – den **Hub**, den
**offdesk-node**-Agent und die **CLI** – nach `~/.local/bin`, für Linux und
macOS auf x64 und arm64. Danach startet sie den Hub als Dienst, der beim Login
startet und neu startet, falls er beendet wird, registriert diesen Rechner
dort und gibt einen Link aus, der dich anmeldet:

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

Scanne den Code mit dem Smartphone oder öffne den Link auf diesem Rechner
(sitzt du am Terminal, öffnet er sich von selbst im Browser) – schon bist du
Eigentümer des Hubs und siehst ein Terminal auf diesem Rechner. Die Web-UI
steckt im Binary; es gibt nichts weiter zu installieren und nichts zu
konfigurieren. Auf einem Mac verhindert der Hub außerdem, dass der Rechner
während des Betriebs in den Ruhezustand geht (abschalten mit
`--allow-idle-sleep`; Bildschirm und Zuklappen sind davon nicht betroffen).

Um Link und Code erneut anzuzeigen, in einem beliebigen Terminal auf diesem
Rechner:

```bash
offdesk-hub link
```

(`offdesk link` macht dasselbe, sobald die CLI eingerichtet ist, und öffnet die
Adresse eines entfernten Hubs, wenn auf diesem Rechner kein Hub läuft.)

Der Link meldet jeden an, der ihn hat – zeig ihn also nicht in geteilten
Terminals. Er wird nicht mehr ausgegeben, sobald du die Anmeldung über GitHub
oder Google eingerichtet hast. Das willst du in dem Moment, in dem der Hub von
außerhalb deines Netzwerks erreichbar ist:
[docs/setup-public.md](docs/setup-public.md).

Die Adresse im Link ist die, die ein Smartphone in deinem WLAN erreicht; ein
VPN oder ein Proxy im TUN-Modus führt sie nicht in die Irre. Gibt der Hub
trotzdem eine Adresse aus, die du nicht erreichst, starte ihn mit
`OFFDESK_BASE_URL=http://<LAN-IP dieses Rechners>:4317`.

Optionen des Installers: `--no-service` installiert nur die Binaries und hört
dann auf; `offdesk-hub service install` führst du anschließend selbst aus.
`--node-only`, `--hub-only` und `--cli-only` installieren jeweils ein Binary;
`--prefix <dir>` installiert woanders hin; `--system` nutzt `/usr/local/bin`
(dieser Schritt, und nur dieser, fragt nach sudo). `offdesk-hub` allein
startet den Hub im Vordergrund – für Docker und um die Logs mitzulesen. Lieber
aus dem Quellcode bauen: [docs/building.md](docs/building.md).

### Oder mit Docker

Das, was ein NAS meist will:

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

Das bindet `127.0.0.1:4317` und legt die Datenbank im Volume `offdesk-data`
ab. Setz `JWT_SECRET` hier selbst – ein Container, der selbst eins erzeugt,
speichert es im Volume, und geht das Volume verloren, sind alle abgemeldet.

## So funktioniert es

Der Hub leitet den Terminal-Verkehr zwischen Clients und registrierten Nodes
weiter. Jeder Node hält eine ausgehende WebSocket-Verbindung zum Hub und
betreibt tmux lokal. Sowohl der Hub als auch die Nodes, die aktive Sessions
bereitstellen, müssen online bleiben.

| Komponente | Technologie | Aufgabe |
| --- | --- | --- |
| Hub | Rust, Axum, SQLite | Authentifizierung, Rechner-Verzeichnis, Terminal-Routing, eingebettete Web-UI |
| Node | Rust, tmux, WebSocket | Dauerhafte Terminals auf jedem macOS- oder Linux-Rechner |
| Web-Client | React, TypeScript, xterm.js | Interaktive Terminal-Darstellung im Browser |
| Native Apps | Tauri, gemeinsame Web-UI | Desktop-/Mobil-Client, QR-Pairing, verschlüsselter nativer Transport |
| CLI | Rust, JSON-Ausgabe | Skriptbare Terminal-Steuerung für Entwickler und Coding-Agents |

1. **Hub** – `offdesk-hub`. Ein Prozess auf dem Rechner, der immer läuft,
   SQLite daneben, die Web-UI fest eingebaut. Er kennt jeden deiner Rechner
   und ist die einzige Adresse, die ein Client je braucht.
2. **Node** – `offdesk-node`, plus tmux. Auf jedem Rechner, den du erreichen
   willst, auch auf dem des Hubs. Er wählt sich beim Hub ein und hält einen
   WebSocket offen, deshalb braucht auf ihm nichts einen eingehenden Port oder
   eine öffentliche IP: Ein Laptop hinter dem Router eines Hotels und ein NAS
   hinter dem NAT zu Hause erscheinen in derselben Liste. Jedes Terminal ist
   eine tmux-Session auf dem Rechner, dem es gehört. Es überlebt die App, das
   Netzwerk und dich, wenn du weggehst. Deinstalliere Offdesk, logg dich per
   ssh ein, `tmux attach` – und deine Sessions sind noch da.
3. **Client** – alles, was mit dem Hub spricht. Ein Browser-Tab, die iPhone-
   oder Android-App, die Desktop-App, die `offdesk` CLI, ein anderer Agent auf
   einem anderen Rechner. Ein Client spricht nie direkt mit einem Node; er
   fragt den Hub nach einem Rechner, und der Hub vermittelt die Bytes zwischen
   ihm und tmux. Deshalb können sich zwei Bildschirme ein Terminal teilen: Wer
   zuletzt getippt hat, hat die Tastatur, alle anderen schauen live zu.

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

Zwei Bildschirme an einem Terminal sind dasselbe Bild zweimal: Der Browser am
Schreibtisch und das Smartphone sind beide Clients desselben Hubs, verbunden
mit derselben tmux-Session.

**Wer tippen darf.** Schreibtisch und Smartphone hängen an derselben
tmux-Session und sehen dieselben Bytes. Der Control-Lease entscheidet, wer
tippen darf: Er gilt pro (Benutzer, Rechner), und wer Eingaben sendet,
übernimmt ihn – der letzte Schreiber gewinnt, keine Warteschlange. Alle
anderen erhalten weiter die Ausgabe, aber ihre Tastenanschläge,
Größenänderungen und eingefügten Bilder werden verworfen: Sie schauen live zu
und sind nicht getrennt. Lesen und Warten übernehmen den Lease nie. Der Lease
liegt nur im Speicher und überlebt keinen Neustart des Hubs. Weil tmux mit
`window-size manual` läuft, ändert ein verbundenes Smartphone nie die Größe
am Schreibtisch.

### Einen Rechner hinzufügen

Der Rechner, auf dem der Hub läuft, wird bei der Installation registriert. Für
jeden weiteren Rechner öffnest du den Hub im Browser und wählst im
Rechner-Umschalter **Add a machine** (ein frischer Hub ohne Rechner landet von
selbst auf dieser Seite). Dort steht eine Zeile, in die ein Token bereits
eingesetzt ist:

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://192.168.1.10:4317/ws/machine --token <token>
```

Füge sie in ein Terminal auf dem neuen Rechner ein. Sie installiert nur den
Agent, registriert den Rechner bei deinem Hub und hält den Agent als Dienst am
Laufen – als systemd-User-Service unter Linux, als launchd-Agent unter macOS.
tmux ist Pflicht; der Agent prüft beim Start, ob es vorhanden ist, und beendet
sich andernfalls.

`<token>` ist ein Registrierungs-Token: Der Hub erzeugt für jeden neuen
Rechner eines, und es ist das Einzige, was einen Node an deinen Hub bindet. Du
tippst es nicht von Hand ab; es steht in der Zeile, die die Seite anzeigt.
Jedes Token funktioniert genau einmal und läuft 24 Stunden nach der Ausgabe
ab; für den nächsten Rechner erzeugst du ein neues. Mit derselben Zeile
ziehst du einen Rechner auch von einem Hub zu einem anderen um, und sie
registriert den Rechner des Hubs neu, falls die Installation ihn bei einem Hub
belassen hat, zu dem er schon gehörte.

Von Hand ist die Zeile `offdesk-node register --hub-url … --token …`, gefolgt
von `offdesk-node service install`. Die Registrierung startet einen bereits
installierten Agent-Dienst neu, sodass der neue Hub sofort greift.

`service install` hält ihn über Neustarts hinweg am Laufen – als
systemd-User-Service unter Linux, als launchd-Agent unter macOS.
`offdesk-node start` startet ihn stattdessen im Vordergrund.

Unter macOS verhindert ein laufender Node standardmäßig den automatischen
Ruhezustand bei Inaktivität, damit er erreichbar bleibt. Der Bildschirm kann
sich trotzdem ausschalten, und Zuklappen, die Auswahl von „Ruhezustand“ oder
ein kritisch niedriger Akkustand können den Mac trotzdem schlafen legen. Zum
Abschalten füge `"prevent_idle_sleep": false` in
`~/Library/Application Support/offdesk/machine.json` ein und starte den Node
mit `offdesk-node service restart` neu (oder beende einen Node im
Vordergrund und starte ihn wieder).

## Zwei Setups

In beiden Fällen dieselben Binaries. Die einzige Frage ist, ob dein Smartphone
die Adresse des Hubs schon erreichen kann.

- **Zu Hause, weg vom Schreibtisch** – Hub auf deinem Mac oder NAS,
  Smartphone im selben WLAN. Kein TLS, keine Domain. →
  [docs/setup-lan.md](docs/setup-lan.md)
- **Unterwegs** – Hub auf einem VPS hinter Caddy, zu Hause hinter einem
  Cloudflare Tunnel oder in deinem Tailnet. Die Anleitung vergleicht die
  Varianten danach, wer am Ende deinen Datenverkehr mitlesen kann. →
  [docs/setup-public.md](docs/setup-public.md)

## Fehlerbehebung

- [Lokales Netzwerk funktioniert, aber die Remote-Verbindung ist „Unreachable“](docs/troubleshooting/remote-connection.md)

## Auf dem Smartphone

Der Browser ist bereits der vollständige Client. Öffne die URL des Hubs und du
bist drin, auf jedem Smartphone. Ein vollwertiges Terminal mit einer
Tastenleiste für Ctrl-C, Esc, Tab und die Pfeiltasten – denn Agents stellen
Fragen, und Builds brauchen ein Ctrl-C. Die Tasten bilden ein gleichmäßiges
Raster: `↑` sitzt über `↓`, und Pfeiltasten, Enter und der Tastatur-Schalter
bewegen sich nie. Den Rest kannst du in den Einstellungen umsortieren
([Terminal-Tasten anpassen](docs/terminal-keys.md)).

Die Titelleiste zeigt das Terminal, in dem du gerade bist, seinen Rechner und
ob du die Kontrolle hast oder zuschaust. Tippe auf den Namen des Terminals,
um den Session-Umschalter zu öffnen; dort startest du auch neue Terminals.
Daneben öffnet `[f]` die Dateien des Rechners (auf den schmalsten Smartphones
über das Menü `[m]`), `[b]` den Agent-Browser und `[m]` Machines & Hub.

Fragt Claude Code oder Codex in einem anderen Terminal nach einer Bestätigung,
erscheint es in einer Leiste unter der Titelleiste. Tippe auf ein Terminal, um
es zu öffnen, oder auf sein `[enter]`, um die gerade ausgewählte Option zu
bestätigen, ohne deine aktuelle Ansicht zu verlassen. Für das Terminal, in dem
du gerade bist, erscheint stattdessen eine Warte-Karte über den Tasten.
Grenzen der Erkennung und welche Komponenten aktualisiert werden müssen,
beschreibt [Terminal-Hinweise und Eingabeverhalten](docs/terminal-attention.md).

Außerdem gibt es drei paketierte Clients:

- **iPhone / iPad** – tritt der [öffentlichen TestFlight-Beta](https://testflight.apple.com/join/rV4ktaGv) bei.
  Öffne in der App **Scan QR Code** und scanne den verschlüsselten
  Pairing-Code des Hubs. Verschlüsselte Verbindungen nutzen die signierte
  Oberfläche der App; sie aktualisiert sich wie bei Desktop und Android über
  das Netz (ab 0.9.2), die App selbst über TestFlight. Ein Build funktioniert mit jedem Hub. Zwei Schalter auf dem
  Smartphone können einem Hub im LAN im Weg stehen, und die App nennt sie,
  wenn das passiert: Lokales Netzwerk und, auf in China verkauften Geräten,
  WLAN & mobile Daten. Gebaut aus `ios-v*`-Tags.
- **Android** – ein APK von [offdesk.dev/apk](https://offdesk.dev/apk), das
  immer auf den neuesten App-Build zeigt (`/apk/universal` für den
  universellen); nimm `arm64-v8a` auf einem aktuellen Smartphone, im Zweifel
  `universal`. Per Sideloading installieren; es bietet Update-Prüfung in der
  App, Zwischenablage und verschlüsseltes Pairing. Beim ersten Start scannt es
  den Code, den der Hub zeigt – im Terminal bei der Installation, unter dem
  Phone-Button oder per `offdesk-hub link` – und ist angemeldet. Ein APK
  funktioniert mit jedem Hub; nichts über einen Hub ist hineinkompiliert. Die
  Adresse lässt sich auch eintippen und der Anmeldelink einfügen.
- **Desktop** – macOS ([offdesk.dev/mac](https://offdesk.dev/mac), signiert
  und notarisiert), Windows ([/windows](https://offdesk.dev/windows)) und
  Linux ([/linux](https://offdesk.dev/linux)), mit Auto-Updater. Tabs im
  tmux-Stil, Pane-Header, die zeigen, wer ein Terminal geöffnet hat, und eine
  Statuszeile, die ein Terminal zeigt, das auf dich wartet. Auf einem Mac
  kann die App der Hub sein – siehe [Installation](#installation); unter
  Windows und Linux ist sie ein Client und fragt nach dem Link des Hubs.
  Gebaut aus `desktop-v*`-Tags.

Alle selbst bauen: [docs/building.md](docs/building.md).

### Bring deinen eigenen Agent mit

Offdesk kapselt keinen Agent und spricht nicht sein Protokoll. Es gibt dir das
Terminal, in dem der Agent ohnehin schon läuft – mit deinem eigenen Abo,
deiner eigenen Konfiguration, deinen eigenen Dotfiles. Alles, was in tmux
läuft, läuft hier: Claude Code, Codex, OpenCode, Gemini CLI, Aider, vim, htop,
ein Build, der eine Stunde dauert. Für den Terminal-Zugriff ist keine
agentspezifische Integration nötig.

Unter Linux und macOS erkennt der Node für die Terminal-Liste außerdem lokale
Codex-Session-Namen, selbst wenn Codex nur den Projektnamen in den
Terminal-Titel schreibt. Dafür musst du an der Codex-Konfiguration nichts
ändern. Der Node liest die Metadaten der Session, die der Codex-Prozess in
diesem Pane offen hält; lässt sich die Session nicht zuordnen oder fehlen ihre
Metadaten, wird der normale Terminal-Titel verwendet.

## Für Agents

Ein Token, und jeder Agent kann jeden deiner Rechner steuern. Jedes Skript und
jeder Agent auf jedem Rechner kann auf jedem anderen bei deinem Hub
registrierten Rechner ein Terminal **öffnen** (`open`), Tastenanschläge
hinein**senden** (`send`), darauf **warten** (`wait`) und es wieder
**auslesen** (`read`). Keine Agent-Session, sondern ein Terminal – was du steuerst, ist genau
das, was du auch von Hand ausgeführt hättest.

```bash
T=$(offdesk open nas --cwd ~/projects/foo --cmd claude --json | jq -r .id)
offdesk send $T "fix the type errors in src/auth.ts; stop when tests pass"
offdesk wait $T --silence 5000 --timeout 600     # oder --pattern '❯', um auf einen Prompt zu warten
offdesk read $T --lines 80                       # das Ergebnis einsammeln
offdesk kill $T --yes
```

### Die CLI einrichten

Der Installer hat sie bereits abgelegt. Erstelle in der Web-UI ein API-Token
(Settings → API tokens → Create) und schreib es entweder in eine
Konfigurationsdatei:

```toml
# ~/.config/offdesk/config.toml  (chmod 600)
# macOS: ~/Library/Application Support/offdesk/config.toml
url   = "https://your-hub.example.com"
token = "odk_..."
```

oder exportiere `OFFDESK_URL` und `OFFDESK_TOKEN`. `--url` und `--token`
haben Vorrang vor beidem.

### Befehle

```
offdesk machines [--all] [--json]               # Rechner auflisten (Standard: online; --all auch offline)
offdesk machines rm <id|name> [--yes]           # einen registrierten Rechner entfernen
offdesk ls [--machine <id>] [--json]            # Terminals auflisten: id, title, group, cwd, size, reachable, opened by
offdesk open <machine> --cwd <dir> [--cmd <shell command>] [--group <name>] [--label <name>] [--json]
offdesk read <term> [--lines N] [--json]        # den aktuellen Bildschirm als Text erfassen
offdesk read --all [--machine <id>] [--lines N] [--json] [--concurrency N] [--include-unreachable]
                                                # die Bildschirme aller Terminals in einem Aufruf erfassen
offdesk send <term> <text...> [--no-enter]      # Text tippen (Enter wird standardmäßig angehängt)
offdesk key  <term> <KEY>...                    # Enter Esc Tab BTab Up Down Left Right C-c C-d F1-F12 ...
offdesk wait <term> [--pattern <regex>] [--silence <ms>] [--timeout <sec>]
offdesk kill <term> [--yes]
offdesk layout equalize --group <name|cwd:path> [--machine <id>] [--json]
                                                # Pane-Aufteilung einer Gruppe gleichmäßig verteilen; Web-Clients aktualisieren live
offdesk layout rotate --group <name|cwd:path> [--machine <id>] [--json]
                                                # jede Teilung zwischen nebeneinander und übereinander umschalten
offdesk browser open [URL] [--machine M] [--json]   # einen Tab im Headless-Chromium eines Nodes öffnen; gibt seine id aus
offdesk browser ls [--machine M] [--json]           # Agent-Browser auflisten
offdesk browser goto|snapshot|click|fill|upload|press|dialog|wait|screenshot|close <browser> ...
                                                # steuern; siehe docs/agent-browser.md
offdesk browser handoff <browser> --reason "Please log in" [--wait]   # einen Menschen um Hilfe bitten
offdesk browser wait-control <browser>          # blockieren, solange ein Mensch ihn steuert (exit 1 bei Timeout)
offdesk browser take <browser> --reason "..." [--force]   # die Kontrolle von einem Menschen zurückholen
offdesk mcp                                     # der Agent-Browser als MCP-Tools über stdio: claude mcp add offdesk -- offdesk mcp
offdesk fetch <path>... [--plain]               # anklickbare Download-Links (OSC 8) für Dateien/Ordner auf diesem Rechner ausgeben; max. 20 MiB pro Datei; kein Hub-Token nötig
offdesk link [--no-open]                        # den Hub im Browser öffnen; auf dem Rechner des Hubs Anmeldelink + Code
```

- Rechner und Terminals werden über ein **ID-Präfix** angesprochen (erste
  Spalte von `ls`); bei mehrdeutigen Präfixen werden die Kandidaten
  aufgelistet.
- Terminals, die die CLI öffnet, sind in den Apps und in `ls` als „opened by
  agent“ gekennzeichnet, benannt nach `--label` oder sonst nach dem Namen des
  API-Tokens – so unterscheidest du sie von deinen eigenen. In einer App
  geöffnete Terminals werden nicht gekennzeichnet.
- Exit-Codes: `0` Erfolg oder Wartebedingung erfüllt · `1` Warten
  abgelaufen · `2` Fehler bei Aufruf, Konfiguration oder Netzwerk · `3` ein
  Befehl an den Agent-Browser wurde abgelehnt, weil ein Mensch den Browser
  steuert. `--json` bei jedem Befehl, der etwas ausgibt.
- `--lines N` bedeutet „die letzten N gerenderten Zeilen des aktuellen
  Bildschirms“ (nach dem Entfernen abschließender Leerzeilen), im Text- wie im
  JSON-Modus; JSON meldet zusätzlich `lines_total` (Anzahl vor dem
  Zuschneiden) und `truncated`.
- Jede ausgegebene und serialisierte Ausgabe wird bereinigt – Steuerbytes
  entfernt, `\n`/`\t` und Unicode bleiben erhalten. Kann bedenkenlos an `jq`
  gepipt werden.
- `send` tippt den Text und schickt Enter dann als **separaten, verzögerten
  Frame** (150 ms plus 60 ms pro Zeilenumbruch, höchstens 800 ms), damit
  TUI-Apps, die mehrzeilige Eingaben als Einfügen behandeln, trotzdem
  absenden. `--no-enter` schickt nur den Text-Frame.
- `read --all --json` listet standardmäßig **nur erreichbare Terminals**, mit
  `skipped_unreachable_count` auf oberster Ebene; `--include-unreachable`
  bringt ihre `{"error":"unreachable"}`-Einträge zurück. Jeder erfasste
  Eintrag enthält `pane_title`, `title_source` (`osc`/`process`/`none`),
  `foreground_process` (`{has_foreground_process, process_name}`, null, wenn
  die Abfrage fehlschlägt), `activity` (`active`/`quiet`/`idle`) und
  `idle_ms` – die Aktivität wird nur während des Erfassungsfensters
  beobachtet. `cwd` ist live (tmux `pane_current_path`), nicht der Wert beim
  Anlegen.

### Semantik, die du kennen musst

1. **`send`/`key` übernehmen die Kontrolle** (der letzte Schreiber gewinnt).
   Andere Clients desselben Kontos können dann nur noch zuschauen, bis ein
   Mensch die Kontrolle zurückholt. Lies zuerst, wenn ein Mensch gerade tippen
   könnte. Die CLI übernimmt den Lease auch für `open` und `kill`.
2. **`read`/`wait` sind reine Beobachter.** Sie übernehmen nie die Kontrolle
   und stören keine anderen Clients – tmux läuft mit `window-size manual`,
   daher ändert ein Attach bei niemandem die Größe der Ansicht.
3. **`read` sieht nur den aktuellen Bildschirm**, rekonstruiert aus dem
   Repaint beim tmux-Attach. Den Scrollback sieht es nicht. Bei langen
   Ausgaben lass den Agent in der Session eine Datei schreiben und lies diese.
4. **Kein Polling mit wiederholtem `read`** – jeder Aufruf kostet einen
   Attach, etwa eine Sekunde. Warte stattdessen mit `wait` auf die Bedingung.
5. **Für einen Überblick über alle Terminals nimm `read --all`.** Starte nicht
   N CLI-Prozesse in einer Schleife über `read`: Das kostet N×(TLS + Attach),
   und ein Konsument, der stdout nicht parallel ausliest, kann am Pipe-Puffer
   hängen bleiben.
6. Terminals mit `REACHABLE=no` gehören zu Rechnern, die offline sind, und
   lassen sich nicht verbinden. `read --all` überspringt sie und meldet die
   Anzahl auf stderr und als `skipped_unreachable_count` im JSON.
7. **Ein Token bedeutet Remote Code Execution auf jedem registrierten
   Rechner.** Erzeuge eines pro Agent, gib ihm einen Namen und widerrufe es
   einzeln, wenn du fertig bist.

## Im Vergleich

Die Werkzeuge, die mehrere Rechner an einem Ort bündeln, geben dir einen Chat;
die, die dir ein echtes Terminal geben, brauchen einen Server pro Rechner.
Jede Zelle unten stammt aus der eigenen Dokumentation des Anbieters. Stand
2026-09-01; diese Produkte entwickeln sich schnell, prüf also nach, bevor du
dich auf eine Zeile verlässt.

| | Beliebiges Terminalprogramm | Rechner pro Hub | Datenverkehr läuft über | Agents können es per CLI steuern | Selbst gehostet |
|---|---|---|---|---|---|
| **Offdesk** | Alles, was in tmux läuft | Beliebig viele, eine URL | Deinen eigenen Hub | `open` / `send` / `wait` / `read` | Ja, MIT |
| Claude Code Remote Control | Nein – eine Claude-Code-Session, kein Terminal | Sessions von mehreren Rechnern in einer Liste | Die Server von Anthropic; das Transkript wird dort gespeichert | Nicht dokumentiert | Nein |
| VibeTunnel | Ja – `vt <any command>`, `vt --shell` | Ein Server pro Rechner | Deine Wahl: LAN, Tailscale, ngrok, Cloudflare | Startet nur Befehle; kein send/read/wait für eine laufende Session | Ja, MIT |
| Happy Coder | Nein – kapselt `claude` und `codex` | Mehrere; `spawn --machine`, `machines` | Standardmäßig die slopus-Cloud, Ende-zu-Ende-verschlüsselt | `create` / `send` / `history` / `wait` | Optional, MIT |
| Omnara | Agent-Sessions; kein rohes Terminal dokumentiert | Mehrere gleichzeitig pro Agent | Standardmäßig `api.omnara.com` | CLI und REST: `POST .../inputs`, SSE-Timeline | Optional, Apache-2.0 |
| Orca | Ja – echtes Terminal, über 30 CLI-Agents | Ein Server pro Rechner; SSH-Worktrees reichen von dort aus weiter | Standardmäßig Orca Relay oder direkt im LAN | `orca terminal create/send/read/wait` | Ja, MIT |

Die Quellen für jede Zelle stehen im [englischen README](README.md#how-it-compares).

### Was die Tabelle aussagt

Das Feld teilt sich in zwei Lager, und die Trennlinie hat nichts mit Qualität
zu tun.

**Alles an einem Ort, aber als Unterhaltung.** Bei Claude Code Remote Control,
Happy Coder und Omnara melden sich mehrere Rechner an einer Stelle. Was du
dort bekommst, ist eine Agent-Session, kein Terminal – der richtige Tausch,
wenn du nur den Agent wolltest.

**Ein echtes Terminal, aber ein Server pro Rechner.** VibeTunnel und Orca
geben dir beide ein echtes Terminal. Beide betreiben einen Server pro Rechner:
VibeTunnel so gewollt, Orca, weil ein Remote Orca Server an einen einzelnen
Host gebunden ist und andere Rechner per SSH erreicht.

Offdesk ist die Kombination: Geh von jedem deiner Rechner weg und mach am
Smartphone im echten Terminal weiter, über einen Server, den du selbst
betreibst. Jedes der fünf anderen lässt eines dieser drei weg – den Agent,
den Rechner oder den Server.

Das ist die einzige Aussage, die diese Tabelle stützt, und sie ist enger als
„besser“. Willst du parallele Git-Worktrees, Diff-Review und ein Browser- und
Emulator-Harness rund um deine Agents, kann **Orca** weit mehr als Offdesk und
steht ebenfalls unter MIT. Willst du das Terminal eines einzigen Rechners mit
so wenig Einrichtung wie möglich im Browser, ist **VibeTunnel** schlanker im
Betrieb. Steuerst du immer nur Claude Code und willst null Einrichtung,
steckt **Remote Control** schon in deiner CLI.

## Sicherheit

**Ein Token bedeutet Remote Code Execution auf jedem registrierten
Rechner.** Es öffnet Terminals und tippt hinein, und ein Terminal führt aus,
was deine Shell ausführt. Behandle es wie einen SSH-Schlüssel, nicht wie einen
API-Schlüssel.

Was der Hub dir an die Hand gibt, um das einzugrenzen:

- **Ein Token pro Agent.** Jedes Token trägt einen Namen, den du beim
  Erstellen wählst.
- **Einzeln widerrufen.** Wer ein Token löscht, lässt die anderen unberührt.
- **Zuletzt verwendet.** Jedes Token speichert, wann es sich zuletzt
  authentifiziert hat, damit du siehst, welche noch aktiv sind.
- Tokens werden als SHA-256-Hashes gespeichert. Der Klartext wird einmal beim
  Erstellen angezeigt und lässt sich nicht wiederherstellen.

Der Anmeldelink, den der Hub ausgibt, meldet jeden an, der ihn hat; behandle
ihn wie ein Passwort. Der Control-Lease ist keine Sicherheitsgrenze und hält
niemanden auf, der ein gültiges Token besitzt.

Bedrohungsmodell, was der Control-Lease verhindert und was nicht, und was der
Hub in SQLite speichert: [SECURITY.md](SECURITY.md).

## Fragen und Antworten

**Ist Offdesk ein SSH-Client?** Offdesk nutzt seinen eigenen
WebSocket-Transport zwischen Hub und node. Installiere `offdesk-node` auf
einem Rechner, um dessen tmux-Sessions über den Hub bereitzustellen; Offdesk
verbindet sich nicht mit beliebigen SSH-Servern. Du kannst SSH aber weiterhin
separat nutzen, um den Rechner zu verwalten oder dich an seine tmux-Sessions
anzuhängen.

**Überleben Terminals einen Verbindungsabbruch von Browser oder Smartphone?**
tmux läuft auf dem Node, deshalb beendet das Schließen eines Clients oder der
Verlust seiner Netzwerkverbindung die Session nicht. Verbinde dich wieder mit
demselben Terminal, sobald Hub und Node wieder erreichbar sind. Ein
Herunterfahren oder Neustart des Rechners ist etwas anderes: tmux bewahrt
laufende Prozesse nicht über einen Neustart hinweg.

**Brauche ich ein Konto?** Selbst hosten geht ohne Konto beim Anbieter: Die
Installation legt einen lokalen Benutzer und einen Anmeldelink an. Das
optionale Offdesk Cloud nutzt eine eigene Anmeldung für den verwalteten
Fernzugriff.

**Läuft mein Datenverkehr über offdesk.dev?** Direkte LAN-Verbindungen gehen
an deinen Hub. Das optionale Offdesk Cloud leitet verschlüsselten App-Verkehr
über eine verwaltete Adresse unter `*.cloud.offdesk.dev`. Ein selbst
verwalteter Tunnel läuft über dessen Anbieter.
[Verschlüsseltes Pairing](docs/encrypted-connections.md) schützt
Terminal-Inhalte zwischen App und Hub; ein normaler Anmeldelink im Browser ist
ein anderer Modus.

**Ist das nur für Claude Code?** Es ist ein Terminal. Claude Code, Codex,
OpenCode, ein Build, der eine Stunde dauert, oder vim – was in tmux läuft,
läuft hier, und Offdesk weiß weder noch kümmert es sich darum, was es ist.

**Und das iPhone?** Es gibt eine App, vorerst über TestFlight – siehe
[Auf dem Smartphone](#auf-dem-smartphone). Ohne sie ist der Browser der
vollständige Client: Scanne den Code des Hubs mit der Kamera und füge die
Seite zum Home-Bildschirm hinzu. Für Android gibt es ebenfalls eine App.
Verschlüsselte Pairing-Codes scannst du mit dem Scanner in der App; im Browser
verbindest du dich über den normalen Anmeldelink.

**Was, wenn zwei Leute gleichzeitig tippen?** Der Control-Lease entscheidet,
wer tippen darf. Wer Eingaben sendet, übernimmt ihn – der letzte Schreiber
gewinnt, keine Warteschlange. Alle anderen erhalten weiter die Ausgabe und
schauen live zu, statt getrennt zu werden.

## Community

[Discord](https://discord.gg/aFUu6VMzc) für Fragen und Setups; GitHub
[Issues](https://github.com/zalify/offdesk/issues) für Bugs.

## Lizenz

Der Code in diesem Repository steht unter der MIT-Lizenz. Siehe
[LICENSE](LICENSE). Der optionale Dienst Offdesk Cloud wird separat gepflegt
und ist hier nicht enthalten.
