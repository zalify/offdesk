import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const fr: Dict = {
  chrome: {
    skip: "aller au contenu",
    homeLabel: "Accueil Offdesk Dev",
    navLabel: "Principal",
    nav: {
      download: "télécharger",
      how: "fonctionnement",
      away: "accès-distant",
      docs: "docs",
      cli: "cli",
    },
    discordLabel: "Offdesk sur Discord",
    githubLabel: "Offdesk sur GitHub",
    language: "langue",
    languageLabel: "Langue : {name}. Choisir une autre langue",
    footer: {
      madeBy: "fait par {zalify}",
      tagline: "terminal distant auto-hébergé",
      gettingStarted: "premiers pas",
      tunnel: "guide du tunnel",
      security: "sécurité",
      releases: "notes de version",
    },
    copy: "[copier]",
    copied: "[copié]",
    copyFailed: "[appuyez sur ⌘C]",
  },

  home: {
    title: "Offdesk — Un terminal, partagé entre vous et vos agents",
    description:
      "Terminal distant auto-hébergé : vos agents IA ouvrent des terminaux, y écrivent et les lisent via la CLI ; vous les suivez depuis votre téléphone et reprenez le clavier. Pour Claude Code, Codex et tout ce qui tourne dans tmux. Hub sous licence MIT.",
    hero: {
      title: "Un terminal, partagé avec vos agents.",
      lead: "Les agents ouvrent des terminaux, y écrivent et les lisent via la CLI. Vous suivez les mêmes depuis votre téléphone, et reprenez le clavier quand ils ont besoin de vous.",
      downloadMac: "télécharger pour mac",
      allDownloads: "tous les téléchargements",
      copyInstallLabel: "Copier la commande d’installation",
      note: "L’app Mac est signée et notarisée, pour Apple silicon et Intel. La commande en une ligne installe le hub sur macOS ou Linux.",
      figcaption: "Illustration : un terminal, ouvert par un agent avec la CLI et suivi depuis un téléphone.",
    },
    proofLabel: "En bref",
    proof: [
      { key: "tout-programme", value: "tout ce qui tourne dans tmux" },
      { key: "machines", value: "illimitées, une seule url" },
      { key: "trafic", value: "via votre propre hub" },
      { key: "agents", value: "open · send · wait · read" },
      { key: "licence", value: "auto-hébergé, Hub MIT" },
    ],
    beats: {
      title: "Le clavier est à qui en a besoin.",
      items: [
        {
          label: "01 / agent",
          title: "votre agent l’ouvre",
          body: "Une commande lance Claude Code, Codex ou n’importe quoi d’autre dans un terminal, sur n’importe laquelle de vos machines. Il continue de tourner quand tout le monde s’en va.",
        },
        {
          label: "02 / vous",
          title: "vous suivez le même",
          body: "Pas une transcription : le terminal en direct, sur votre téléphone, votre portable ou un navigateur. Quand il s’arrête pour vous demander quelque chose, vous le voyez.",
        },
        {
          label: "03 / au choix",
          title: "prenez la main, rendez-la",
          body: "Répondez avec Entrée, ou prenez le clavier. Dans le navigateur de l’agent aussi : connectez-vous à sa place, puis rendez-lui la main.",
        },
      ],
    },
    start: {
      title: "Votre premier terminal en trois étapes.",
      steps: [
        {
          label: "étape 1",
          title: "Installez le hub sur macOS ou Linux",
          body: "Ouvrez l’app Mac, indiquez que c’est la machine qui reste allumée, et elle devient votre hub : lancé à l’ouverture de session, relancé s’il s’arrête. L’auto-hébergement ne demande aucun compte chez un fournisseur. Sur un NAS ou un serveur sans écran, une seule ligne fait la même chose :",
        },
        {
          label: "étape 2",
          title: "Appairez votre téléphone ou connectez-vous depuis un navigateur",
          body: "Choisissez Offdesk App pour générer un code d’appairage chiffré, à lire avec le scanner de l’app. Choisissez Browser access pour obtenir un lien de connexion pour le navigateur. Vous trouverez les deux dans la barre des menus du Mac, ou lancez <span class=\"inline-code\">offdesk link</span> pour l’accès navigateur.",
        },
        {
          label: "étape 3",
          title: "Reconnectez-vous à la même session tmux",
          body: "La même session tmux qu’au bureau, en direct. Gardez le hub allumé et en ligne. Tout ce qui tourne dans tmux tourne ici.",
        },
      ],
      readGuide: "lire le guide mac",
      iphone: "app iphone",
      android: "app android",
      orBrowser: "ou n’importe quel navigateur sur le téléphone",
    },
    download: {
      title: "Des clients pour ordinateur, mobile et web.",
      lead: "L’app de bureau sert de hub sur un Mac, et de client partout. Les apps mobiles enveloppent le même terminal que celui du navigateur.",
      mac: {
        body: "Un seul dmg pour Apple silicon et Intel. Signé avec un Developer ID et notarisé : il s’ouvre comme n’importe quelle app de l’App Store. Sur le Mac qui reste allumé, il devient votre hub ; partout ailleurs, c’est un client.",
        button: "télécharger .dmg →",
        meta: "macOS 11 ou ultérieur · universel · .dmg",
      },
      windows: {
        body: "Un client : il ouvre les terminaux d’un hub situé ailleurs. Collez le lien affiché par le hub, ou connectez-vous. Une machine Windows ne peut pas être le hub, qui a besoin de tmux.",
        button: "télécharger .msi →",
      },
      linux: {
        body: "Un client, comme sur Windows. Pour une machine Linux qui doit servir de hub, passez par l’installation en une ligne : elle exécute le hub en tant que service.",
        button: "télécharger .AppImage →",
        meta: "x64 · .AppImage · .deb et .rpm sur {release}",
        release: "la page des versions",
      },
      iphone: {
        body: "Disponible via TestFlight. Ouvrez l’invitation sur votre iPhone ou iPad, installez l’app, puis choisissez Scan QR Code pour vous connecter à votre hub.",
        button: "rejoindre la bêta →",
      },
      android: {
        body: 'Un APK à installer manuellement. Prenez <span class="inline-code">arm64-v8a</span> sur un téléphone récent, <a href="/apk/universal">universel</a> en cas de doute.',
        button: "télécharger l’apk →",
      },
      cli: {
        title: "Hub, node et CLI",
        body: "Les trois binaires, pour un NAS, un VPS ou toute machine sans écran. Linux et macOS, x64 et arm64.",
      },
    },
    how: {
      title: "Hub en Rust. WebSockets sortants. tmux persistant.",
      items: [
        {
          title: "hub",
          body: "Un serveur Rust construit avec Axum, un stockage SQLite et une interface web intégrée. Il authentifie les clients et achemine le trafic des terminaux vers vos nodes macOS et Linux. Installez un binaire ou déployez avec Docker.",
        },
        {
          title: "node",
          body: "Sur chaque machine que vous voulez atteindre. Il se connecte <em>en sortie</em> au hub par WebSocket : le node n’a besoin ni de port entrant ni d’IP publique. Chaque terminal est une session tmux sur la machine qui l’héberge : il survit à l’app, au réseau, et à votre départ. Désinstallez Offdesk, il est toujours là.",
        },
        {
          title: "client",
          body: "React et xterm.js affichent le terminal interactif dans le navigateur. Les apps Tauri ajoutent l’appairage chiffré natif sur ordinateur et mobile. La CLI en Rust offre un accès scriptable. Les clients partagent la sortie des terminaux via le Hub ; un bail de contrôle détermine qui peut taper.",
        },
      ],
      note: "Deux écrans sur un terminal, ce sont deux clients d’un même hub, attachés à une même session tmux. La déconnexion d’un client ne met pas fin à la session sur le node. Offdesk utilise son propre transport Hub/node, pas SSH : installez offdesk-node sur chaque machine que vous voulez atteindre.",
    },
    away: {
      title: "Hébergez-le sur votre LAN. Ajoutez l’accès distant au besoin.",
      body: [
        "Faites tourner le Hub open source sur macOS, Linux, un NAS ou un VPS. Les Nodes se connectent en sortie à ce Hub ; les sessions de terminal restent sur les machines qui exécutent tmux. Votre Hub et ces machines doivent rester allumés et en ligne.",
        `Lancez cloudflared à côté de votre Hub pour exposer un point d’accès HTTPS sans ouvrir de port sur le routeur, y compris derrière du NAT ou du CGNAT. Configurez votre domaine et l’ingress du tunnel, ou utilisez <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> pour un accès privé au Hub depuis tous vos appareils.`,
        `Les Offdesk Apps appairées chiffrent le trafic des terminaux de bout en bout entre l’App et le Hub, y compris à travers un tunnel. L’accès navigateur ordinaire passe par HTTPS, terminé chez le fournisseur du tunnel, et par sa propre authentification ; il ne bénéficie pas automatiquement du chiffrement de l’App. Voir le <a href="${repo}/blob/main/docs/encrypted-connections.md">guide des connexions chiffrées</a>.`,
      ],
      tunnelGuide: "le guide du tunnel",
      lanSetup: "configuration lan",
      pairing: "appairage chiffré de l’app",
      cloudSetup: "configuration de l’accès distant",
      homeTitle: "# sur la machine à la maison",
      homeBody:
        'Créez le tunnel dans le tableau de bord Cloudflare, pointez-le vers <span class="inline-code">server:4317</span>, mettez son token dans <span class="inline-code">.env</span>, puis :',
      copyTunnelLabel: "Copier les commandes du tunnel",
      homeAfter:
        "Pour l’accès chiffré via l’App, scannez le code d’appairage chiffré avec le scanner de l’App. Pour l’accès navigateur ordinaire, configurez l’authentification comme décrit dans le guide du tunnel.",
      cloudBadge: "bêta sur invitation",
      cloudBody:
        "Offdesk, le service hébergé sur offdesk.so, propose en option un accès distant géré. Ce service n’est pas open source ; dans le dépôt public, le Hub, le node et la CLI sont sous licence MIT, et l’interface web et les apps publient leur code sous FSL-1.1-MIT. Le connecteur local vérifie la joignabilité chiffrée et relance automatiquement, avec un délai croissant, les tunnels qui échouent durablement. L’usage local ne demande aucun compte Offdesk.",
    },
    more: {
      title: "Shells distants, agents de code sur mobile et automatisation CLI.",
      machines: {
        title: "Gérez vos terminaux macOS et Linux",
        body: "Le NAS, le VPS, le portable. Ouvrez le hub, choisissez <strong>Add a machine</strong>, et il vous donne une ligne avec un token dedans. Collez-la sur cette machine ; elle apparaît.",
      },
      agents: {
        title: "Apportez n’importe quel agent",
        body: "Offdesk n’enveloppe pas d’agent et ne parle pas son protocole. Il vous donne le terminal dans lequel l’agent tourne déjà — votre abonnement, votre config, vos dotfiles.",
        anyCli: "toute CLI",
      },
      phone: {
        title: "Claude Code et Codex sur votre téléphone",
        body: [
          `Personnalisez la barre de touches avec Esc, Tab, Shift+Tab, les combinaisons avec Shift et la répétition de Backspace. Les flèches, Enter et le bouton du clavier restent fixes ; masquez ou réordonnez les autres touches dans Settings. <a href="${repo}/blob/main/docs/terminal-keys.md">Configurer les touches du terminal</a>. Les apps ajoutent un scanner de QR code et des connexions chiffrées de bout en bout.`,
          `Une bannière d’attente vous permet d’ouvrir la demande de confirmation d’un autre terminal, ou d’envoyer Entrée à sa sélection actuelle, sans quitter votre vue. <a href="${repo}/blob/main/docs/terminal-attention.md">En savoir plus sur les raccourcis de confirmation</a>.`,
          "<strong>iPhone et iPad :</strong> rejoignez la bêta publique TestFlight via le lien ci-dessous. TestFlight se charge des mises à jour de l’app.",
        ],
        android: "apk android",
        universal: "build universel",
        iphone: "iphone · testflight",
        heroAlt: "Claude Code sur une machine de bureau, pendant qu’un téléphone est attaché à la même session tmux",
        iosAlt: "Claude Code dans l’app Offdesk pour iPhone, attachée au Mac à la maison",
        stillAlt: "Un terminal Offdesk sur un téléphone : Claude Code sur un Mac à la maison, attaché depuis le navigateur du téléphone",
        caption: "Claude Code dans une session tmux distante persistante.",
      },
    },
    cli: {
      title: "Automatisez vos terminaux distants avec la CLI Offdesk.",
      lead: "Utilisez les commandes open, send, wait et read pour piloter des sessions tmux distantes depuis des scripts shell ou des agents de code IA. La sortie JSON permet à vos scripts de récupérer les ID de terminal et de transmettre les résultats d’une étape à l’autre. Un terminal ouvert par un agent est marqué comme tel, pour que vous le distinguiez des vôtres.",
      body: `Un token, c’est de l’exécution de code à distance sur chaque machine enregistrée. Créez-en un par agent, nommez-le, révoquez-le séparément. <a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "Copier l’exemple",
    },
    compare: {
      title: "Comparaison",
      note: "Chaque cellule provient de la documentation du projet concerné, vérifiée le 1er septembre 2026. Les sources figurent sous le même tableau dans le README.",
      project: "Projet",
      columns: [
        "Tout programme de terminal",
        "Machines par hub",
        "Le trafic passe par",
        "Pilotable par des agents via CLI",
        "Auto-hébergé",
      ],
      rows: [
        ["Tout ce qui tourne dans tmux", "Illimitées, une seule URL", "Votre propre hub", "open / send / wait / read", "Oui, MIT + FSL"],
        ["Non — une session Claude Code, pas un terminal", "Sessions de plusieurs machines dans une seule liste", "Serveurs d’Anthropic ; transcription stockée chez eux", "Non documenté", "Non"],
        ["Oui — vt &lt;n’importe quelle commande&gt;, vt --shell", "Un serveur par machine", "Au choix : LAN, Tailscale, ngrok, Cloudflare", "Lance seulement des commandes", "Oui, MIT"],
        ["Non — enveloppe claude et codex", "Plusieurs ; spawn --machine", "Cloud slopus par défaut, chiffré de bout en bout", "create / send / history / wait", "Optionnel, MIT"],
        ["Sessions d’agent ; aucun terminal brut documenté", "Plusieurs à la fois par agent", "api.omnara.com par défaut", "CLI et REST", "Optionnel, Apache-2.0"],
        ["Oui — vrai terminal, 30+ agents CLI", "Plusieurs, via worktrees SSH et orca serve", "Orca Relay par défaut, ou en direct sur le LAN", "orca terminal create/send/read/wait", "Oui, MIT"],
      ],
    },
    close: {
      title: "Installez votre hub ce soir.",
      lead: "Installez le Hub sur macOS ou Linux, enregistrez vos machines et ouvrez des sessions tmux persistantes depuis votre navigateur ou votre téléphone.",
      iphone: "app iphone",
      android: "app android",
    },
  },

  tunnel: {
    title: "Offdesk derrière un Cloudflare Tunnel",
    description:
      "Accédez à votre hub Offdesk à la maison depuis n’importe où, sans ouvrir de port : la configuration complète d’un Cloudflare Tunnel pour ce terminal distant auto-hébergé.",
    heading: "Un Cloudflare Tunnel",
    lead: "Pour un hub sur un NAS ou un ordinateur fixe à la maison. <code>cloudflared</code> tourne à côté du hub et se connecte <em>en sortie</em> à Cloudflare, qui sert ensuite votre nom d’hôte en HTTPS. Pas de redirection de port, pas de DNS dynamique, pas de certificat à renouveler, et ça marche derrière du CGNAT, où rediriger un port n’est même pas possible.",
    intro: `Pour les connexions navigateur ordinaires, Cloudflare termine le HTTPS et peut lire le trafic des terminaux. L’appairage chiffré de l’App ajoute un chiffrement entre l’App et le Hub : le tunnel transporte alors du contenu de terminal chiffré. Suivez le <a href="${repo}/blob/main/docs/encrypted-connections.md">guide des connexions chiffrées</a> pour ce mode. Vous pouvez aussi utiliser un <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a> à la place : mêmes binaires, personne au milieu.`,
    needDomain: "Il vous faut un domaine sur un compte Cloudflare. Le plan gratuit suffit.",
    create: {
      title: "1. Créez le tunnel",
      body: "Tableau de bord Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>. Donnez-lui un nom, puis copiez le token affiché — la longue chaîne après <code>--token</code> dans la commande d’installation. Ce token est un identifiant secret : quiconque le détient peut servir du trafic en se faisant passer pour votre tunnel.",
      hostname: "Ajoutez un nom d’hôte public au tunnel :",
      field: "Champ",
      value: "Valeur",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> est le nom de service du hub dans <code>docker-compose.yml</code> ; c’est ainsi que <code>cloudflared</code> le joint sur le réseau compose. Le trajet de Cloudflare à votre machine passe dans le tunnel ; celui de <code>cloudflared</code> au hub ne quitte jamais le réseau Docker, donc du HTTP simple y suffit.",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>.env</code> à côté de <code>docker-compose.yml</code> :",
      secretPlaceholder: "sortie de : openssl rand -hex 32",
      tokenPlaceholder: "le token de l’étape 1",
      oauth: `Sur un hub exposé à Internet, la connexion passe par GitHub ou Google. Enregistrez les URL de callback OAuth exactement comme dans <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">le guide VPS</a> — le hub les construit à partir de <code>OFFDESK_BASE_URL</code>, et un tunnel n’y change rien. Ensuite :`,
      profile:
        "C’est le profil <code>tunnel</code> qui démarre <code>cloudflared</code> ; sans lui, vous n’avez que le hub, toujours lié à <code>127.0.0.1:4317</code>. Vérifiez que les deux tournent :",
    },
    machines: {
      title: "3. Machines",
      body: "Ouvrez le hub dans un navigateur et choisissez <strong>Add host</strong> : il affiche une ligne avec un token d’enregistrement déjà rempli. Sur la machine que vous voulez atteindre :",
      after:
        "Une machine sur le même LAN que le hub passe quand même par Cloudflare, aller et retour. Si ça vous gêne, enregistrez-la plutôt avec l’adresse LAN du hub — l’agent de la machine a seulement besoin de joindre le hub, et peu lui importe que votre téléphone joigne ce même hub sous un autre nom.",
    },
    notes: {
      title: "Remarques",
      items: [
        "<strong>La connexion est ouverte à quiconque trouve l’URL</strong>, comme avec la voie VPS : n’importe quel compte GitHub ou Google peut créer un compte sur votre hub. Il n’y a pas de liste d’autorisation. Cloudflare Access peut placer une seconde connexion devant tout le nom d’hôte, mais tout ce qui n’est pas un navigateur — <code>offdesk-node</code>, la CLI, l’app Android — a alors besoin de son propre token de service Access, et l’agent de la machine n’a nulle part où le mettre. Limitez la politique Access aux chemins du navigateur, ou laissez-la de côté et comptez sur la connexion propre au hub.",
        "<strong>Les WebSockets de longue durée ne posent pas de problème.</strong> Les agents des machines envoient un ping toutes les 30 secondes et les navigateurs pinguent au niveau applicatif : les délais d’inactivité en chemin ne coupent donc pas les terminaux en silence.",
        "<strong>N’utilisez pas de quick tunnel</strong> (<code>cloudflared tunnel --url</code>, les noms d’hôte <code>*.trycloudflare.com</code>) pour autre chose qu’une démo. Le nom d’hôte change à chaque redémarrage, ce qui invalide vos URL de callback OAuth, chaque machine enregistrée et tout téléphone qui a gardé l’ancien.",
      ],
    },
    others: `Les deux autres voies — un VPS derrière Caddy, et Tailscale — avec les compromis entre les trois : <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>.`,
  },

  mac: {
    title: "Votre premier terminal, depuis un Mac",
    description: "Guide illustré de captures d’écran pour installer Offdesk sur un Mac, ouvrir votre premier terminal et connecter votre téléphone.",
    eyebrow: "Premiers pas · macOS",
    lead: "Faites du Mac qui reste allumé votre hub. Ouvrez ensuite son terminal depuis votre téléphone. Commencez avec les deux appareils sur le même réseau local.",
    preview: "À propos des captures d’écran",
    previewText:
      "Ces captures viennent de notre test de la 0.6.4-rc.1 sur un Mac Mini. La version stable actuelle inclut un appairage du téléphone et une configuration de l’accès distant mis à jour. Les instructions ci-dessous suivent la nouvelle version ; les anciennes captures gardent leurs libellés RC et leur mise en page. Le panneau d’appairage sépare désormais Offdesk App et Browser access. Le bouton de téléchargement fournit la version stable.",
    download: "Télécharger pour Mac",
    phone: "Obtenir l’app mobile",
    contents: "Sur cette page",
    stepLabel: "étape {n}",
    openScreenshot: "Ouvrir la capture en entier",
    before: "Avant de commencer",
    needs: [
      "Un Mac qui peut rester allumé et connecté, et son compte de session macOS.",
      "Votre téléphone et votre Mac sur le même réseau local. Un Mac en filaire et un téléphone sur le Wi-Fi du même routeur, ça marche aussi.",
      "Offdesk sur votre téléphone : TestFlight pour iPhone / iPad, ou l’APK Android de ce site.",
    ],
    terms:
      "Le Hub gère les connexions ; le Node rend les terminaux d’une machine accessibles. Choisir ce Mac comme Hub installe les deux. La configuration normale de l’App n’a besoin ni d’une commande install.sh séparée ni de Docker.",
    steps: {
      install: {
        title: "1. Installez l’app Mac",
        body: "Récupérez l’image disque sur la <a href='/mac'>page de téléchargement Mac</a>. Ouvrez le DMG, glissez Offdesk Dev dans Applications, puis ouvrez la copie installée. Ne continuez pas à la lancer depuis l’image disque montée.",
        extra:
          "Un compte macOS standard peut avoir besoin du mot de passe d’un administrateur pour écrire dans le dossier Applications du système. Vous pouvez aussi utiliser un dossier Applications dans votre dossier personnel. La mention RC sur la capture désigne notre build de test.",
        alt: "La fenêtre de l’image disque Mac, avec Offdesk RC et un raccourci vers le dossier Applications.",
        caption: "Glissez l’app dans Applications, puis lancez la copie installée.",
      },
      choose: {
        title: "2. Faites de ce Mac le hub",
        body: "À l’écran <strong>Which machine is this?</strong>, choisissez <strong>The one that stays on → Set this machine up</strong>. C’est le bon choix si vous voulez que votre téléphone atteigne des terminaux qui tournent sur ce Mac.",
        extra:
          "Choisissez <strong>Just connecting</strong> seulement si vous avez déjà un Hub ailleurs et voulez utiliser ce Mac comme client. Vous n’avez pas besoin de créer de compte pour cette configuration locale.",
      },
      ready: {
        title: "3. Laissez le Mac finir sa préparation",
        body: "La configuration mise à jour vérifie quatre choses avant d’afficher l’écran de connexion du téléphone. Une adresse affichée à l’écran ne prouve pas à elle seule que la configuration est terminée.",
        checks: [
          "Le Hub tourne et répond.",
          "Ce Mac est enregistré auprès du Hub.",
          "Le Node local est en ligne.",
          "L’outil de terminal, tmux, est disponible.",
        ],
        extra:
          "Une fois prêt, vous verrez <strong>Connect your phone</strong>. Choisissez <strong>Pair an encrypted device</strong> pour générer le code d’appairage. Si une vérification échoue, utilisez l’action de nouvel essai sur l’écran de configuration. Si macOS demande si Offdesk Dev peut accepter des connexions entrantes, autorisez-le sur le Mac que votre téléphone doit atteindre.",
      },
      terminal: {
        title: "4. Ouvrez votre premier terminal",
        body: "Choisissez <strong>Open my terminal</strong>. Si vous voyez <strong>No terminals yet</strong>, regardez la commande en haut à droite : si elle indique <strong>Watching / Viewing</strong>, cliquez dessus pour prendre la main, puis choisissez <strong>Start terminal</strong>. Si un autre appareil a déjà la main, assurez-vous de vouloir la reprendre.",
        extra:
          "Tapez cette ligne et appuyez sur Entrée. Les mêmes mots devraient s’afficher juste en dessous. Les commandes s’exécutent sur votre Mac, même quand vous les tapez sur votre téléphone.",
        alt: "Offdesk exécutant echo hello from offdesk dans le shell Mac du compte de test, avec hello from offdesk renvoyé en dessous.",
        caption: "Un vrai shell, avec entrée et sortie fonctionnelles. L’état du contrôle détermine si vous pouvez créer un terminal ou taper.",
      },
      phone: {
        title: "5. Scannez depuis l’app mobile",
        body: "Sur le Mac, choisissez <strong>Phone</strong> ou <strong>Show me</strong> pour ouvrir le panneau de connexion. Sélectionnez <strong>Offdesk App · Recommended</strong>, puis <strong>Pair an encrypted device</strong>. Dans l’écran de connexion de l’App sur le téléphone, choisissez <strong>Scan QR Code</strong> et scannez le code d’appairage chiffré qui vient d’être généré. Autorisez l’accès à l’appareil photo quand on vous le demande.",
        extra:
          "<strong>Browser access</strong> fournit un code de connexion que l’appareil photo du téléphone peut ouvrir dans un navigateur. <strong>Offdesk App</strong> génère un code d’appairage chiffré pour le scanner de l’App. Choisissez un seul mode ; inutile de scanner les deux codes. Générez un nouveau code d’appairage sur le Mac s’il expire.",
        alt: "Le panneau de connexion du téléphone sur le Mac, avec une adresse locale, des liens vers l’app mobile et Pair an encrypted device ; le code et le lien de connexion sont masqués.",
        caption: "L’ancienne capture masque son code et son lien de connexion. Dans la 0.7.1, sélectionnez Offdesk App et générez votre propre code d’appairage.",
        after:
          "Après l’appairage, cherchez ce Mac et son terminal. S’il n’y a aucun terminal à sélectionner, créez-en un sur le Mac comme à l’étape précédente. Essayez une commande courte depuis le téléphone, puis quittez et rouvrez l’App mobile pour vérifier qu’elle se reconnecte.",
      },
      return: {
        title: "6. Fermez l’app. Retrouvez votre terminal.",
        body: "Quitter l’App Mac laisse les services Hub et Node tourner en arrière-plan. Rouvrir l’App vous ramène au terminal. Quitter l’App, ce n’est pas la même chose que mettre le Mac en veille, l’éteindre ou fermer la session macOS.",
        extra:
          "Gardez le Mac allumé, avec la session ouverte et connecté au réseau. Une adresse locale fonctionne sur ce réseau ; configurez l’accès distant séparément quand vous serez prêt à utiliser Offdesk hors de chez vous. Scanner un code ne rend pas une adresse locale joignable depuis Internet.",
      },
      cloud: {
        title: "7. Optionnel : hors de chez vous avec votre compte Offdesk",
        body: "L’accès distant via Offdesk (offdesk.so) est actuellement une bêta sur invitation. Connectez-vous et utilisez votre invitation sur <a href='https://offdesk.so'>offdesk.so</a>. Sur le Mac, choisissez <strong>Set up remote access</strong>, suivez les étapes de connexion et vérifiez l’autorisation de l’ordinateur. Une fois l’adresse distante prête, appairez votre téléphone avec le mode Offdesk App.",
        extra:
          "Pour le parcours complet d’un nouvel utilisateur, installez les dernières apps stables macOS et Android depuis ce site. iOS est distribué via TestFlight ; les builds disponibles dépendent de votre groupe de test. Après la configuration, coupez le Wi-Fi du téléphone et vérifiez le terminal en données mobiles pendant que le Mac reste en ligne. Un téléphone appairé ouvre <strong>Hub &amp; connection</strong> depuis son titre. En réseau local, vous pouvez vous passer du compte Offdesk et des invitations.",
      },
    },
    trouble: "Si votre écran est différent",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "Le Hub n’a pas encore de machine utilisable ; votre téléphone n’a pas besoin de devenir un hôte. Vérifiez d’abord la configuration sur le Mac. Pour l’ancien problème de la 0.6.3, une récupération manuelle consiste à choisir Generate a token sur ce Mac et à exécuter la commande générée en entier dans le Terminal système de ce même Mac. C’est une voie de récupération pour l’ancienne version, pas une étape obligatoire de l’installation normale.",
      ],
      [
        "Le scan ouvre une page de connexion, ou l’adresse IP seule ne suffit pas à se connecter",
        "Une adresse seule ne contient aucun identifiant de connexion. Utilisez le lien de connexion complet ou son QR code ordinaire pour vous connecter dans le navigateur. Utilisez le scanner de l’App avec le code d’appairage chiffré pour l’appairage chiffré. Ne publiez pas les liens de connexion complets ni les QR codes dans des discussions partagées.",
      ],
      [
        "Le téléphone ne se connecte pas, ou l’écran reste vide",
        "Vérifiez que les deux appareils sont sur le même réseau local et que l’adresse choisie est joignable depuis le téléphone. Un Wi-Fi invité peut isoler les appareils. Confirmez que le terminal fonctionne sur le Mac et vérifiez l’autorisation réseau local du téléphone. Si l’écran reste noir après le scan, quittez et rouvrez l’App, puis signalez la version de l’App, le modèle du téléphone et les étapes suivies. Il ne devrait pas être nécessaire de rouvrir l’App à chaque fois.",
      ],
    ] as [string, string][],
    tested: "Qu’avons-nous vraiment testé ?",
    testedIntro:
      "Le 7 septembre 2026, nous avons testé sur un Mac Mini avec un nouveau compte standard, offdesk-test, sans configuration ni service Offdesk et sans aucun script d’installation lancé au préalable. C’était un compte utilisateur vierge, pas un Mac réinitialisé aux réglages d’usine. Le 10 septembre, nous avons sauvegardé puis réinitialisé la configuration App/Hub de ce compte de test, et vérifié dans la 0.7.1-rc.1 la configuration automatique, la génération du code chiffré, la saisie dans le terminal et la réouverture. Ce second test a conservé les outils système, l’état du navigateur et les anciennes sessions tmux.",
    passed: [
      "Téléchargement du DMG, glisser-déposer dans le dossier Applications de l’utilisateur, et lancement depuis le Finder.",
      "Installation automatique du Hub / Node, enregistrement de la machine, vérifications de la connexion en direct et de tmux, puis affichage d’un QR code renseigné.",
      "Entrée et sortie dans un vrai terminal.",
      "Persistance du terminal après avoir quitté et rouvert l’App, et reconnexion après le redémarrage du seul Hub de test.",
    ],
    pending:
      "Pas encore fait lors de ce test : le scan avec un vrai téléphone et la réouverture à froid, la déconnexion/reconnexion de l’utilisateur de test, et l’acceptation par Gatekeeper du paquet de production signé et notarisé. L’utilisateur a autorisé le premier lancement de la RC ; cela ne prouve pas l’acceptation de la distribution de production.",
    known:
      "Nous avons aussi reproduit un manque dans la prise en main : Watching masque l’action Start terminal. L’étape 4 inclut l’action de prise de contrôle pour que vous sachiez clairement quoi faire ensuite.",
    next: "Pour aller plus loin",
    nextText: "Familiarisez-vous d’abord avec le réseau local, puis lisez la doc sur les connexions chiffrées et l’accès distant.",
    encryption: "Connexions chiffrées",
    lan: "Dépannage du réseau local",
    allDocs: "Toute la documentation technique",
  },
};

export default fr;
