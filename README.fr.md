<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo.svg" alt="Offdesk Dev" height="48">
  </picture>
</p>

<p align="center">
  <img src="docs/media/hero-banner.png" alt="Un terminal, partagé entre vous et vos agents. N'importe quel programme dans tmux, sur toutes vos machines, derrière un seul hub que vous hébergez." width="800">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <b>Français</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a>
</p>

# Offdesk Dev — terminal distant auto-hébergé pour tmux et les agents de code IA

> Ceci est une traduction. En cas de divergence, le [README anglais](README.md)
> fait foi. Site web en français : [offdesk.dev/fr](https://offdesk.dev/fr/).

**Un terminal, partagé entre vous et vos agents.** Les agents ouvrent des
terminaux, y tapent et les lisent via la CLI `offdesk` ; vous suivez ces mêmes
terminaux depuis votre téléphone et reprenez le clavier quand ils ont besoin de
vous.

Accédez à **Claude Code, Codex, OpenCode ou n'importe quel programme en
terminal** depuis un navigateur, un iPhone, un téléphone Android ou l'app de
bureau. Offdesk relie les clients à des **sessions tmux** persistantes sur vos
propres machines macOS et Linux, via un seul Hub auto-hébergé. Les commandes
s'exécutent sur la machine distante ; les clients échangent les entrées et
sorties du terminal par des connexions WebSocket.

L'app s'installe sous le nom **Offdesk Dev** ; ce README parle simplement
d'Offdesk. Les outils en ligne de commande gardent le nom `offdesk` : la CLI
`offdesk`, le serveur `offdesk-hub` et l'agent machine `offdesk-node`.

Servez-vous-en pour surveiller un agent de code IA depuis votre téléphone,
reprendre un shell après une coupure réseau, ou gérer les terminaux d'un Mac,
d'un serveur Linux, d'un NAS et d'un VPS depuis une seule interface. Les
machines qui font tourner votre Hub et vos sessions doivent rester allumées.

- **Sessions distantes persistantes :** retrouvez le même terminal tmux, avec
  ses CLI interactives, ses éditeurs, la sortie de vos builds et l'historique
  du shell.
- **Plusieurs machines derrière un seul Hub :** chaque `offdesk-node` se
  connecte en sortie au Hub ; les nodes n'ont besoin ni de port entrant ni
  d'IP publique.
- **Contrôles du terminal sur mobile :** une barre de touches disposée en
  grille régulière, avec des raccourcis personnalisables, Shift+Tab, les
  combinaisons avec Shift et la répétition de Backspace ; les flèches, Enter et
  le bouton du clavier restent fixes. Pièces jointes, et appairage chiffré de
  l'App par QR code. Touchez le nom du terminal dans la barre de titre pour
  changer de session ; `[f]`, `[b]` et `[m]` à côté ouvrent les fichiers, le
  navigateur de l'agent, et Machines & Hub.
- **Automatisation par la CLI :** ouvrez un terminal, envoyez des entrées,
  attendez une sortie et lisez le résultat avec `offdesk open / send / wait /
  read`, en JSON si besoin. Les terminaux ouverts par un agent sont signalés
  comme tels dans les apps.
- **Déploiement auto-hébergé :** binaires Rust ou Docker sur macOS/Linux,
  stockage SQLite et interface web intégrée au binaire du Hub.
- **Connexions chiffrées de l'App :** chiffrement de bout en bout entre les
  Apps appairées et le Hub. L'accès par simple navigateur passe par une
  connexion distincte ; l'accès public par navigateur exige HTTPS et une
  authentification.

Le Hub, le node, la CLI et les crates de protocole et de chiffrement de ce
dépôt sont sous **licence MIT** ; l'interface web et les apps de bureau et
mobiles publient leur code sous **FSL-1.1-MIT** ([Licence](#licence)).
L'auto-hébergement ne demande aucun compte chez un éditeur. Le service hébergé
**Offdesk** ([offdesk.so](https://offdesk.so)), optionnel, fournit un accès distant géré sous forme de service séparé et
propriétaire. Son connecteur local, open source, vérifie l'accessibilité
chiffrée et redémarre automatiquement après des échecs prolongés du tunnel,
avec un délai croissant lors des longues pannes.

Questions, installations qui n'ont pas marché, fonctionnalités que vous
aimeriez voir : [Discord](https://discord.gg/aFUu6VMzc).

## Téléchargement

| | | |
|---|---|---|
| **macOS** | [offdesk.dev/mac](https://offdesk.dev/mac) | Un seul dmg pour Apple silicon et Intel, signé et notarié. Peut servir de hub. |
| **Windows** | [offdesk.dev/windows](https://offdesk.dev/windows) | `.msi` x64. Un client. |
| **Linux** | [offdesk.dev/linux](https://offdesk.dev/linux) | `.AppImage` x64 ; `.deb` et `.rpm` sur [la page des versions](https://offdesk.dev/desktop). Un client. |
| **iPhone / iPad** | [Rejoindre TestFlight](https://testflight.apple.com/join/rV4ktaGv) | Utilisez l'App pour l'appairage chiffré ; un navigateur peut utiliser le lien de connexion du Hub. |
| **Android** | [offdesk.dev/apk](https://offdesk.dev/apk) | `arm64-v8a` ; [`/apk/universal`](https://offdesk.dev/apk/universal) en cas de doute. |
| **Hub, node, CLI** | `curl -fsSL https://offdesk.dev/install \| sh` | Linux et macOS, x64 et arm64. Pour un NAS, un VPS, tout ce qui n'a pas d'écran. |

Chaque lien suit la dernière version de son type. Windows est un client de
bureau ; Linux peut aussi héberger un Hub, à condition d'installer tmux
séparément.

## Documentation

- [Installation sur macOS et appairage du téléphone](https://offdesk.dev/fr/docs/mac)
- [Installation sur le réseau local](docs/setup-lan.md) et [accès public avec HTTPS, OAuth ou Tailscale](docs/setup-public.md)
- [Connexions chiffrées de bout en bout de l'App](docs/encrypted-connections.md) et
  [accès distant optionnel via Offdesk (offdesk.so)](docs/managed-connections.md)
- [Aperçus web de localhost](docs/web-previews.md) : un transfert à activer
  soi-même, avec un domaine d'aperçu dédié et une entrée HTTPS, distinct du
  chiffrement de bout en bout du terminal
- [Aperçus de fichiers HTML](docs/html-file-previews.md) : ouvrir un fichier
  `.html` d'une machine comme une page dans l'app de bureau ou Android
- [Personnaliser les touches du terminal](docs/terminal-keys.md) : placement des
  touches, combinaisons avec Shift et effacement arrière sans rouvrir le
  clavier système
- [Navigateur de l'agent](docs/agent-browser.md) : un Chromium headless sur une
  machine, que les agents pilotent avec `offdesk browser` et vous confient
  quand ils ont besoin d'une personne
- [Compiler depuis les sources](docs/building.md) · [Modèle de sécurité](SECURITY.md)
- [Notes de version et historique](https://github.com/zalify/offdesk/releases)

## Installation

Commencez par le guide illustré d'installation sur Mac :
[français](https://offdesk.dev/fr/docs/mac) ·
[English](https://offdesk.dev/docs/mac) ·
[简体中文](https://offdesk.dev/zh/docs/mac). Il contient de vraies captures
d'écran de l'App, l'appairage du téléphone, les étapes du premier terminal et
le périmètre de nos tests sur un compte vierge.

L'installation se fait sur la machine qui reste allumée — un Mac, un NAS —, qui
est généralement aussi la première machine que vous voulez joindre.

**Sur un Mac :** téléchargez l'app sur [offdesk.dev/mac](https://offdesk.dev/mac)
(signée et notariée, un seul dmg pour Apple silicon et Intel). Au premier
lancement, elle pose une seule question : quelle machine est-ce ? Choisissez
**The one that stays on** et elle installe le hub, le node et tmux comme
services qui démarrent à l'ouverture de session et redémarrent s'ils
s'arrêtent, enregistre cette machine et affiche le code que votre téléphone
scanne. L'app reste dans la barre des menus, où se trouvent le code pour le
téléphone, l'adresse du hub et **Add a machine**. Choisissez **Just
connecting** et elle devient un client d'un hub situé ailleurs, comme le
téléphone.

**Sur un NAS, un VPS ou tout ce qui n'a pas d'écran :**

```bash
curl -fsSL https://offdesk.dev/install | sh
```

Cette seule ligne installe les trois binaires — le **hub**, l'agent
**offdesk-node** et la **CLI** — dans `~/.local/bin`, pour Linux et macOS sur
x64 et arm64. Elle démarre ensuite le hub comme service lancé à l'ouverture de
session et relancé s'il s'arrête, y enregistre cette machine, et affiche un
lien qui vous connecte :

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

Scannez le code avec votre téléphone, ou ouvrez le lien sur cette machine (il
s'ouvre tout seul dans votre navigateur si vous êtes devant le terminal) : vous
voilà propriétaire du hub, devant un terminal de cette machine. L'interface web
est dans le binaire ; il n'y a rien d'autre à installer ni à configurer. Sur un
Mac, le hub empêche aussi la mise en veille pour inactivité tant qu'il tourne
(`--allow-idle-sleep` pour désactiver ce comportement ; l'écran et le capot ne
sont pas concernés).

Pour revoir le lien et le code, depuis n'importe quel terminal de cette
machine :

```bash
offdesk-hub link
```

(`offdesk link` fait de même une fois la CLI configurée, et ouvre l'adresse
d'un hub distant quand il n'y a pas de hub sur cette machine.)

Le lien connecte quiconque le possède : ne l'affichez pas sur un terminal
partagé. Il cesse d'être affiché dès que vous configurez la connexion GitHub ou
Google — ce que vous voudrez faire dès que le hub est joignable depuis
l'extérieur de votre réseau : [docs/setup-public.md](docs/setup-public.md).

L'adresse du lien est celle qu'un téléphone sur votre Wi-Fi peut joindre ; un
VPN ou un proxy en mode TUN ne la fausse pas. S'il affiche malgré tout une
adresse injoignable, lancez le hub avec
`OFFDESK_BASE_URL=http://<this machine's LAN IP>:4317` (l'IP de cette machine
sur le réseau local).

Options de l'installateur : `--no-service` installe les binaires et s'arrête là,
à vous ensuite de lancer `offdesk-hub service install` ; `--node-only`,
`--hub-only` et `--cli-only` n'installent qu'un binaire ; `--prefix <dir>`
installe ailleurs ; `--system` utilise `/usr/local/bin` (cette étape, et elle
seule, demande sudo). `offdesk-hub` seul lance le hub au premier plan, pour
Docker ou pour suivre les logs. Pour compiler depuis les sources :
[docs/building.md](docs/building.md).

### Ou avec Docker

Ce qu'un NAS demande généralement :

```bash
git clone https://github.com/zalify/offdesk && cd offdesk
JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

Le conteneur écoute sur `127.0.0.1:4317` et garde sa base de données dans le
volume `offdesk-data`. Définissez `JWT_SECRET` vous-même ici : un conteneur qui
en génère un le stocke dans le volume, et perdre le volume déconnecte tout le
monde.

## Fonctionnement

Le Hub achemine le trafic des terminaux entre les clients et les nodes
enregistrés. Chaque node maintient une connexion WebSocket sortante vers le Hub
et exécute tmux localement. Le Hub et les nodes qui servent des sessions
actives doivent rester en ligne.

| Composant | Technologie | Rôle |
| --- | --- | --- |
| Hub | Rust, Axum, SQLite | Authentification, registre des machines, routage des terminaux, interface web intégrée |
| Node | Rust, tmux, WebSocket | Terminaux persistants sur chaque machine macOS ou Linux |
| Client web | React, TypeScript, xterm.js | Rendu interactif du terminal dans le navigateur |
| Apps natives | Tauri, interface web partagée | Client de bureau et mobile, appairage par QR code, transport natif chiffré |
| CLI | Rust, sortie JSON | Contrôle des terminaux par script, pour les développeurs et les agents de code |

1. **Hub** — `offdesk-hub`. Un processus sur la machine qui reste allumée,
   SQLite à côté, l'interface web intégrée. Il connaît toutes vos machines, et
   c'est la seule adresse dont un client a besoin.
2. **Node** — `offdesk-node`, et tmux. Sur chaque machine que vous voulez
   joindre, y compris celle du hub. Il appelle le hub et garde un WebSocket
   ouvert : rien sur la machine n'a besoin de port entrant ni d'IP publique.
   Un portable derrière le routeur d'un hôtel et un NAS derrière la box de la
   maison apparaissent dans la même liste. Chaque terminal est une session tmux
   sur la machine qui le possède. Il survit à l'app, au réseau et à votre
   départ. Désinstallez Offdesk, connectez-vous en ssh, `tmux attach` : vos
   sessions sont toujours là.
3. **Client** — tout ce qui parle au hub. Un onglet de navigateur, l'app iPhone
   ou Android, l'app de bureau, la CLI `offdesk`, un autre agent sur une autre
   machine. Un client ne touche jamais un node directement ; il demande une
   machine au hub, et le hub fait transiter les octets entre lui et tmux. C'est
   pourquoi deux écrans peuvent partager un terminal : le dernier qui a tapé a
   le clavier, les autres regardent en direct.

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

Deux écrans sur un terminal, c'est le même schéma deux fois : le navigateur du
bureau et le téléphone sont tous deux clients du même hub, attachés à la même
session tmux.

**Qui peut taper.** Le bureau et le téléphone s'attachent à la même session
tmux et voient les mêmes octets. Le bail de contrôle (control lease) décide qui
peut taper : il est détenu par couple (utilisateur, machine), et envoyer une
entrée le prend — le dernier qui écrit gagne, sans file d'attente. Les autres
continuent de recevoir la sortie, mais leurs frappes, redimensionnements et
collages d'images sont ignorés : ils regardent en direct, sans être déconnectés.
Lire et attendre ne prennent jamais le bail. Le bail est gardé en mémoire et ne
survit donc pas à un redémarrage du hub. Comme tmux tourne avec
`window-size manual`, un téléphone qui s'attache ne redimensionne jamais
l'écran du bureau.

### Ajouter une machine

La machine qui héberge le hub est enregistrée par l'installation. Pour chaque
autre machine à joindre, ouvrez le hub dans un navigateur et choisissez
**Add a machine** dans le sélecteur de machines (un hub neuf, sans machine,
arrive directement sur cette page). Elle affiche une ligne, jeton déjà rempli :

```bash
curl -fsSL https://offdesk.dev/install | sh -s -- --hub-url ws://192.168.1.10:4317/ws/machine --token <token>
```

Collez-la dans un terminal de la nouvelle machine. Elle installe l'agent seul,
enregistre la machine auprès de votre hub et fait tourner l'agent comme
service — un service utilisateur systemd sous Linux, un agent launchd sous
macOS. tmux est requis ; l'agent le vérifie au démarrage et s'arrête s'il
manque.

`<token>` est un jeton d'enregistrement : le hub en émet un pour chaque
nouvelle machine, et c'est la seule chose qui lie un node à votre hub. Vous ne
le tapez pas à la main ; il figure dans la ligne affichée par la page. Chaque
jeton ne sert qu'une fois et expire 24 heures après son émission ; générez-en un
autre pour la machine suivante. La même ligne permet aussi de déplacer une
machine d'un hub à un autre, et de réenregistrer la machine du hub si
l'installation l'a laissée sur un hub auquel elle appartenait déjà.

À la main, la ligne revient à `offdesk-node register --hub-url … --token …`
suivi de `offdesk-node service install`. L'enregistrement redémarre un service
d'agent déjà installé, si bien que le nouveau hub est pris en compte
immédiatement.

`service install` le maintient en marche après un redémarrage — un service
utilisateur systemd sous Linux, un agent launchd sous macOS.
`offdesk-node start` le lance plutôt au premier plan.

Sous macOS, un node en marche empêche par défaut la mise en veille automatique
pour inactivité, afin de rester joignable. L'écran peut quand même s'éteindre,
et fermer le capot d'un portable, choisir Suspendre ou une batterie presque
vide peuvent quand même mettre le Mac en veille. Pour désactiver ce
comportement, ajoutez `"prevent_idle_sleep": false` à
`~/Library/Application Support/offdesk/machine.json`, puis redémarrez le node
avec `offdesk-node service restart` (ou arrêtez et relancez un node au premier
plan).

## Deux configurations

Les mêmes binaires dans les deux cas. La seule question est de savoir si votre
téléphone peut déjà joindre l'adresse du hub.

- **À la maison, loin du bureau** — le hub sur votre Mac ou votre NAS, le
  téléphone sur le même Wi-Fi. Ni TLS ni nom de domaine.
  → [docs/setup-lan.md](docs/setup-lan.md)
- **Hors de chez vous** — le hub sur un VPS derrière Caddy, à la maison
  derrière un Cloudflare Tunnel, ou sur votre tailnet. Le guide les compare
  selon qui finit par pouvoir lire votre trafic.
  → [docs/setup-public.md](docs/setup-public.md)

## Dépannage

- [Le réseau local fonctionne, mais la connexion distante est injoignable (Remote connection is Unreachable)](docs/troubleshooting/remote-connection.md)

## Sur votre téléphone

Le navigateur suffit comme client. Ouvrez l'URL du hub et vous y êtes, sur
n'importe quel téléphone. Un vrai terminal, avec une barre de touches pour
Ctrl-C, Esc, Tab et les flèches, parce que les agents posent des questions et
qu'un build a parfois besoin d'un Ctrl-C. Les touches forment une grille
régulière : `↑` est au-dessus de `↓`, et les flèches, Enter et le bouton du
clavier ne bougent jamais. Le reste se réorganise dans les réglages
([personnaliser les touches du terminal](docs/terminal-keys.md)).

La barre de titre indique le terminal où vous êtes, sa machine, et si vous avez
le contrôle ou si vous regardez. Touchez le nom du terminal pour ouvrir le
sélecteur de sessions, d'où l'on crée aussi de nouveaux terminaux. À côté,
`[f]` ouvre les fichiers de la machine (depuis le menu `[m]` sur les
téléphones les plus étroits), `[b]` le navigateur de l'agent, et `[m]`
Machines & Hub.

Quand Claude Code ou Codex demande une confirmation dans un autre terminal, un
bandeau sous la barre de titre l'affiche. Touchez un terminal pour l'ouvrir, ou
son `[enter]` pour valider l'option sélectionnée sans quitter votre vue
actuelle. Pour le terminal où vous êtes, une carte d'attente apparaît plutôt
au-dessus des touches. Voir
[signalement et saisie dans les terminaux](docs/terminal-attention.md) pour les
limites de la détection et les composants à mettre à jour.

Trois clients empaquetés sont aussi disponibles :

- **iPhone / iPad** — rejoignez la [bêta publique TestFlight](https://testflight.apple.com/join/rV4ktaGv).
  Ouvrez **Scan QR Code** dans l'App et scannez le code d'appairage chiffré du
  Hub. Les connexions chiffrées utilisent l'interface signée de l'App, mise à jour
  à distance comme sur ordinateur et Android (à partir de 0.9.2) ; l'App
  elle-même se met à jour via TestFlight.
  Un même build fonctionne avec n'importe quel hub. Deux réglages du téléphone
  peuvent bloquer l'accès à un hub sur le réseau local, et l'app les nomme le
  cas échéant : Réseau local et, sur les téléphones vendus en Chine, Données
  sans fil. Compilée à partir des tags `v*` et publiée avec le hub.
- **Android** — un APK sur [offdesk.dev/apk](https://offdesk.dev/apk), qui
  pointe toujours vers le build le plus récent (`/apk/universal` pour la
  version universelle) ; prenez `arm64-v8a` sur un téléphone récent,
  `universal` en cas de doute. Installez-le manuellement ; il propose la
  vérification des mises à jour dans l'app, le presse-papiers et l'appairage
  chiffré. Au premier lancement, il scanne le code que montre le hub — dans le
  terminal à l'installation, sous le bouton Phone, ou via `offdesk-hub link` —
  et vous êtes connecté ; un même APK fonctionne avec n'importe quel hub, rien
  d'un hub n'y est compilé. On peut aussi taper l'adresse et coller le lien de
  connexion.
- **Bureau** — macOS ([offdesk.dev/mac](https://offdesk.dev/mac), signée et
  notariée), Windows ([/windows](https://offdesk.dev/windows)) et Linux
  ([/linux](https://offdesk.dev/linux)), avec mise à jour automatique. Des
  onglets façon tmux, des en-têtes de volet qui indiquent qui a ouvert un
  terminal, et une ligne d'état qui signale un terminal qui vous attend. Sur un
  Mac, elle peut servir de hub — voir [Installation](#installation) ; sous
  Windows et Linux, c'est un client, qui demande le lien du hub. Compilée à
  partir des tags `v*` et publiée avec le hub.

Pour compiler l'un d'eux vous-même : [docs/building.md](docs/building.md).

### Apportez votre propre agent

Offdesk n'enveloppe aucun agent et ne parle pas son protocole. Il vous donne le
terminal dans lequel l'agent tourne déjà, avec votre abonnement, votre
configuration, vos dotfiles. Tout ce qui tourne dans tmux tourne ici : Claude
Code, Codex, OpenCode, Gemini CLI, Aider, vim, htop, un build d'une heure. Aucune
intégration propre à un agent n'est nécessaire pour accéder au terminal.

Sous Linux et macOS, le node reconnaît aussi les noms des sessions Codex locales
pour la liste des terminaux, même quand Codex ne met que le nom du projet dans
le titre du terminal. Cela ne demande aucune modification de la configuration
de Codex. Il lit les métadonnées de la session tenue ouverte par le processus
Codex de ce volet ; si la session ne peut pas être identifiée ou si ses
métadonnées sont indisponibles, le titre normal du terminal est utilisé.

## Pour les agents

Un jeton, et n'importe quel agent peut piloter n'importe laquelle de vos
machines. N'importe quel script, ou n'importe quel agent sur n'importe quelle
machine, peut **ouvrir** (open) un terminal sur une autre machine enregistrée
sur votre hub, y **envoyer** (send) des frappes, l'**attendre** (wait) et le
**lire** (read). Pas une session d'agent : un terminal, donc ce que vous
pilotez est exactement ce que vous auriez lancé à la main.

```bash
T=$(offdesk open nas --cwd ~/projects/foo --cmd claude --json | jq -r .id)
offdesk send $T "fix the type errors in src/auth.ts; stop when tests pass"
offdesk wait $T --silence 5000 --timeout 600     # ou --pattern '❯' pour attendre une invite
offdesk read $T --lines 80                       # récupérer le résultat
offdesk kill $T --yes
```

### Configurer la CLI

L'installateur l'a déjà mise en place. Créez un jeton d'API dans l'interface
web (Settings → API tokens → Create), puis écrivez-le dans un fichier de
configuration :

```toml
# ~/.config/offdesk/config.toml  (chmod 600)
# macOS : ~/Library/Application Support/offdesk/config.toml
url   = "https://your-hub.example.com"
token = "odk_..."
```

ou exportez `OFFDESK_URL` et `OFFDESK_TOKEN`. `--url` et `--token` priment sur
les deux.

### Commandes

```
offdesk machines [--all] [--json]               # lister les machines (par défaut : en ligne ; --all inclut celles hors ligne)
offdesk machines rm <id|name> [--yes]           # oublier une machine enregistrée
offdesk ls [--machine <id>] [--json]            # lister les terminaux : id, titre, groupe, cwd, taille, joignable, ouvert par
offdesk open <machine> --cwd <dir> [--cmd <shell command>] [--group <name>] [--label <name>] [--json]
offdesk read <term> [--lines N] [--json]        # capturer l'écran actuel en texte
offdesk read --all [--machine <id>] [--lines N] [--json] [--concurrency N] [--include-unreachable]
                                                # capturer l'écran de tous les terminaux en un seul appel
offdesk send <term> <text...> [--no-enter]      # taper du texte (Enter ajouté par défaut)
offdesk key  <term> <KEY>...                    # Enter Esc Tab BTab Up Down Left Right C-c C-d F1-F12 ...
offdesk wait <term> [--pattern <regex>] [--silence <ms>] [--timeout <sec>]
offdesk kill <term> [--yes]
offdesk layout equalize --group <name|cwd:path> [--machine <id>] [--json]
                                                # répartir également les volets d'un groupe ; les clients web se mettent à jour en direct
offdesk layout rotate --group <name|cwd:path> [--machine <id>] [--json]
                                                # basculer chaque division entre côte à côte et empilé
offdesk browser open [URL] [--machine M] [--json]   # ouvrir un onglet du Chromium headless d'un node ; affiche son id
offdesk browser ls [--machine M] [--json]           # lister les navigateurs d'agent
offdesk browser goto|snapshot|click|fill|upload|press|dialog|wait|screenshot|close <browser> ...
                                                # le piloter ; voir docs/agent-browser.md
offdesk browser handoff <browser> --reason "Please log in" [--wait]   # demander de l'aide à une personne
offdesk browser wait-control <browser>          # bloquer tant qu'une personne le contrôle (sortie 1 si délai dépassé)
offdesk browser take <browser> --reason "..." [--force]   # reprendre le contrôle à une personne
offdesk mcp                                     # le navigateur de l'agent comme outils MCP sur stdio : claude mcp add offdesk-dev -- offdesk mcp
offdesk fetch <path>... [--plain]               # afficher des liens cliquables (OSC 8) pour télécharger des fichiers/dossiers de cette machine ; 20 Mio max par fichier ; aucun jeton du hub requis
offdesk link [--no-open]                        # ouvrir le hub dans un navigateur ; sur la machine du hub, le lien de connexion + le code
```

- Machines et terminaux se désignent par **préfixe d'id** (première colonne de
  `ls`) ; un préfixe ambigu liste les candidats.
- Les terminaux ouverts par la CLI sont marqués « opened by agent » dans les
  apps et dans `ls`, nommés d'après `--label` ou, à défaut, le nom du jeton
  d'API, pour que vous les distinguiez des vôtres. Les terminaux ouverts dans
  une app ne sont pas marqués.
- Codes de sortie : `0` succès ou condition d'attente remplie · `1` délai
  d'attente dépassé · `2` erreur d'utilisation, de configuration ou réseau ·
  `3` une commande du navigateur de l'agent a été refusée parce qu'une personne
  contrôle le navigateur. `--json` sur toute commande qui affiche quelque chose.
- `--lines N` signifie « les N dernières lignes affichées de l'écran actuel »
  (après suppression des lignes vides finales), en mode texte comme en JSON ;
  le JSON indique aussi `lines_total` (nombre avant découpage) et `truncated`.
- Toute sortie affichée ou sérialisée est assainie — octets de contrôle
  supprimés, `\n`/`\t` et Unicode conservés. On peut la passer à `jq` sans
  risque.
- `send` tape le texte, puis envoie Enter dans une **trame séparée et
  différée** (150 ms plus 60 ms par saut de ligne, plafonné à 800 ms), afin
  que les applications TUI qui traitent les rafales multilignes comme des
  collages valident quand même. `--no-enter` n'envoie que la trame de texte.
- `read --all --json` ne liste par défaut que les **terminaux joignables**,
  avec `skipped_unreachable_count` au premier niveau ; `--include-unreachable`
  rétablit leurs entrées `{"error":"unreachable"}`. Chaque entrée capturée
  comporte `pane_title`, `title_source` (`osc`/`process`/`none`),
  `foreground_process` (`{has_foreground_process, process_name}`, null si la
  recherche échoue), `activity` (`active`/`quiet`/`idle`) et `idle_ms` —
  l'activité n'est observée que pendant la fenêtre de capture. `cwd` est le
  répertoire courant réel (tmux `pane_current_path`), pas celui de la création.

### Sémantique à connaître

1. **`send`/`key` prennent le contrôle** (le dernier qui écrit gagne). Les
   autres clients du même compte passent en lecture seule jusqu'à ce qu'un
   humain reprenne la main. Lisez d'abord si quelqu'un est peut-être en train
   de taper. La CLI prend aussi le bail pour `open` et `kill`.
2. **`read`/`wait` ne font qu'observer.** Ils ne prennent jamais le contrôle et
   ne dérangent jamais les autres clients — tmux tourne avec
   `window-size manual`, donc s'attacher ne redimensionne la vue de personne.
3. **`read` ne voit que l'écran actuel**, reconstitué à partir du rafraîchissement
   de tmux à l'attachement. Il ne voit pas l'historique de défilement. Pour une
   longue sortie, demandez à l'agent de la session d'écrire un fichier et
   lisez-le.
4. **Ne sondez pas en répétant `read`** — chaque appel coûte un attachement,
   environ une seconde. Gardez plutôt un `wait` ouvert sur la condition.
5. **Pour une vue d'ensemble de tous les terminaux, utilisez `read --all`.** Ne
   bouclez pas N processus CLI sur `read` : cela fait N×(TLS + attachement), et
   un consommateur qui ne vide pas stdout en parallèle peut se bloquer sur le
   tampon du pipe.
6. Les terminaux `REACHABLE=no` appartiennent à des machines hors ligne et ne
   peuvent pas être attachés. `read --all` les ignore et indique leur nombre sur
   stderr et dans `skipped_unreachable_count` en JSON.
7. **Un jeton, c'est l'exécution de code à distance sur chaque machine
   enregistrée.** Créez-en un par agent, nommez-le, et révoquez-le
   individuellement quand vous avez terminé.

## Comparaison

Les outils qui rassemblent plusieurs machines en un seul endroit vous donnent
une conversation ; ceux qui vous donnent un vrai terminal font tourner un
serveur par machine. Chaque cellule ci-dessous provient de la documentation de
l'éditeur concerné. Vérifié le 2026-09-01 ; ces produits évoluent vite, revérifiez
avant de vous fier à une ligne.

| | N'importe quel programme en terminal | Machines par hub | Le trafic passe par | Pilotable par des agents via une CLI | Auto-hébergé |
|---|---|---|---|---|---|
| **Offdesk** | Tout ce qui tourne dans tmux | Autant que vous voulez, une seule URL | Votre propre hub | `open` / `send` / `wait` / `read` | Oui, MIT |
| Claude Code Remote Control | Non — une session Claude Code, pas un terminal | Les sessions de plusieurs machines dans une liste | Les serveurs d'Anthropic, qui stockent la transcription | Non documenté | Non |
| VibeTunnel | Oui — `vt <any command>`, `vt --shell` | Un serveur par machine | Au choix : réseau local, Tailscale, ngrok, Cloudflare | Lance des commandes uniquement ; pas de send/read/wait sur une session en cours | Oui, MIT |
| Happy Coder | Non — enveloppe `claude` et `codex` | Plusieurs ; `spawn --machine`, `machines` | Le cloud slopus par défaut, chiffré de bout en bout | `create` / `send` / `history` / `wait` | En option, MIT |
| Omnara | Sessions d'agent ; aucun terminal brut documenté | Plusieurs à la fois par agent | `api.omnara.com` par défaut | CLI et REST : `POST .../inputs`, timeline SSE | En option, Apache-2.0 |
| Orca | Oui — un vrai terminal, plus de 30 agents CLI | Un serveur par machine ; les worktrees SSH partent de lui | Orca Relay par défaut, ou en direct sur le réseau local | `orca terminal create/send/read/wait` | Oui, MIT |

Les sources de chaque cellule figurent dans le [README anglais](README.md#how-it-compares).

### Ce que dit le tableau

Le paysage se divise en deux, et la ligne de partage n'est pas une question de
qualité.

**Tout converge, mais vers une conversation.** Claude Code Remote Control,
Happy Coder et Omnara permettent tous à plusieurs machines de remonter vers un
même endroit. Ce que vous y trouvez, c'est une session d'agent, pas un
terminal — le bon compromis si l'agent est tout ce que vous vouliez.

**Un vrai terminal, mais un serveur par machine.** VibeTunnel et Orca vous
donnent tous deux un véritable terminal. Tous deux font tourner un serveur par
machine : VibeTunnel par conception, Orca parce qu'un Remote Orca Server est lié
à un seul hôte et atteint les autres machines par SSH.

Offdesk réunit les deux : quittez n'importe laquelle de vos machines et
retrouvez le vrai terminal sur votre téléphone, via un serveur que vous
hébergez. Chacun des cinq autres renonce à l'un de ces trois éléments —
l'agent, la machine ou le serveur.

C'est la seule affirmation que ce tableau étaye, et elle est plus étroite que
« meilleur ». Si vous voulez des worktrees git en parallèle, la revue de diffs
et un environnement navigateur et émulateur autour de vos agents, **Orca** en
fait bien plus qu'Offdesk et est lui aussi sous MIT. Si vous voulez le terminal
d'une seule machine dans un navigateur avec le moins de configuration possible,
**VibeTunnel** est plus léger à faire tourner. Si vous ne pilotez que Claude
Code et ne voulez rien configurer, **Remote Control** est déjà dans votre CLI.

## Sécurité

**Un jeton, c'est l'exécution de code à distance sur chaque machine
enregistrée.** Il ouvre des terminaux et y tape, et un terminal exécute tout ce
qu'exécute votre shell. Traitez-le comme une clé SSH, pas comme une clé d'API.

Ce que le hub vous donne pour le circonscrire :

- **Un jeton par agent.** Chaque jeton porte un nom choisi à sa création.
- **Révocation individuelle.** Supprimer un jeton n'affecte pas les autres.
- **Dernière utilisation.** Chaque jeton enregistre la dernière fois qu'il s'est
  authentifié, pour savoir lesquels servent encore.
- Les jetons sont stockés sous forme de hachages SHA-256. Le texte en clair
  n'est affiché qu'une fois, à la création, et ne peut pas être récupéré.

Le lien de connexion affiché par le hub connecte quiconque le possède ;
traitez-le comme un mot de passe. Le bail de contrôle n'est pas une frontière de
sécurité, et il n'arrête personne qui détient un jeton valide.

Modèle de menaces, ce que le bail de contrôle empêche ou non, et ce que le hub
conserve dans SQLite : [SECURITY.md](SECURITY.md).

## Questions fréquentes

**Offdesk est-il un client SSH ?** Offdesk utilise son propre transport
WebSocket entre Hub et node. Installez `offdesk-node` sur une machine pour
exposer ses sessions tmux via le Hub ; Offdesk ne se connecte pas à un serveur
SSH quelconque. Vous pouvez toujours utiliser SSH à côté pour administrer cette
machine ou vous attacher à ses sessions tmux.

**Les terminaux survivent-ils à la déconnexion d'un navigateur ou d'un
téléphone ?** tmux tourne sur le node : fermer un client ou perdre sa
connexion réseau ne termine pas la session. Reconnectez-vous au même terminal
dès que le Hub et le node sont de nouveau joignables. Un arrêt ou un
redémarrage de la machine, c'est autre chose : tmux ne conserve pas les
processus en cours à travers un redémarrage.

**Faut-il un compte ?** L'auto-hébergement ne demande aucun compte chez un
éditeur : l'installation crée un utilisateur local et un lien de connexion.
L'accès distant optionnel via le service hébergé Offdesk (offdesk.so) utilise
une connexion distincte.

**Mon trafic passe-t-il par offdesk.dev ?** Les connexions directes sur le
réseau local vont à votre Hub. L'accès distant optionnel via Offdesk (offdesk.so)
fait passer le trafic chiffré de l'App par une adresse gérée sous `*.relay.offdesk.cloud`. Un tunnel que
vous gérez vous-même passe par son fournisseur.
[L'appairage chiffré](docs/encrypted-connections.md) protège le contenu du
terminal entre l'App et le Hub ; un lien de connexion ordinaire dans un
navigateur relève d'un autre mode.

**Est-ce seulement pour Claude Code ?** C'est un terminal. Claude Code, Codex,
OpenCode, un build d'une heure ou vim — tout ce qui tourne dans tmux tourne ici,
et Offdesk ne sait pas lequel et ne s'en soucie pas.

**Et sur iPhone ?** Il existe une app, sur TestFlight pour l'instant — voir
[Sur votre téléphone](#sur-votre-téléphone). Sans elle, le navigateur suffit
comme client : scannez le code du hub avec l'appareil photo, puis ajoutez la
page à l'écran d'accueil. Android a aussi son app. Utilisez le scanner intégré à
l'app pour les codes d'appairage chiffré, et le lien de connexion ordinaire pour
vous connecter depuis un navigateur.

**Et si deux personnes tapent en même temps ?** Le bail de contrôle décide qui
peut taper. Envoyer une entrée le prend — le dernier qui écrit gagne, sans file
d'attente. Les autres continuent de recevoir la sortie : ils regardent en
direct au lieu d'être déconnectés.

## Communauté

[Discord](https://discord.gg/aFUu6VMzc) pour les questions et les installations ;
les [issues](https://github.com/zalify/offdesk/issues) GitHub pour les bugs.

## Licence

Tout ce qui se trouve dans `crates/` (le Hub, le node, la CLI et les crates de
protocole et de chiffrement) et `packages/shared` est sous licence MIT.
L'interface web (`packages/app`) et les apps de bureau, Android et iOS
(`packages/desktop`) sont sous Functional Source License, FSL-1.1-MIT : vous
pouvez les lire, les auditer, les compiler, les modifier et les utiliser, y
compris au travail, mais pas les proposer comme produit concurrent, et chaque
version passe sous MIT deux ans après sa sortie. Les versions jusqu'à 0.25.0
sont entièrement sous MIT. Voir [LICENSE](LICENSE) et
[TRADEMARKS.md](TRADEMARKS.md). Le service
hébergé optionnel Offdesk (offdesk.so) est maintenu séparément et n'est pas
inclus ici.
