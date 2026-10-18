// Spanish (neutral international, "tú"). Same shape as en.ts; see the notes
// there on HTML, placeholders and what stays in English.

import type { Dict } from "./en";

const repo = "https://github.com/zalify/offdesk";

const es: Dict = {
  chrome: {
    skip: "saltar al contenido",
    homeLabel: "Inicio de Offdesk Dev",
    navLabel: "Principal",
    nav: {
      download: "descargar",
      how: "cómo-funciona",
      away: "acceso-remoto",
      docs: "docs",
      cli: "cli",
    },
    discordLabel: "Offdesk en Discord",
    githubLabel: "Offdesk en GitHub",
    language: "idioma",
    languageLabel: "Idioma: {name}. Elige otro idioma",
    footer: {
      madeBy: "hecho por {zalify}",
      tagline: "terminal remota autoalojada",
      gettingStarted: "primeros pasos",
      tunnel: "guía del túnel",
      security: "seguridad",
      releases: "notas de versión",
    },
    copy: "[copiar]",
    copied: "[copiado]",
    copyFailed: "[pulsa ⌘C]",
  },

  home: {
    title: "Offdesk — Una terminal remota, tuya y de tus agentes",
    description:
      "Terminal remota autoalojada que compartes con tus agentes: ellos la usan con la CLI; tú la ves desde el teléfono y tomas el teclado. Claude Code, Codex, tmux. Hub MIT.",
    hero: {
      title: "Una terminal, tuya y de tus agentes.",
      lead: "Los agentes abren terminales, escriben en ellas y las leen con la CLI. Tú ves las mismas desde el teléfono y tomas el teclado cuando te necesitan.",
      downloadMac: "descargar para mac",
      allDownloads: "todas las descargas",
      copyInstallLabel: "Copiar el comando de instalación",
      note: "La app de Mac está firmada y notarizada, para Apple silicon e Intel. El comando de una línea instala el hub en macOS o Linux.",
      figcaption: "Una ilustración: una terminal que un agente abre con la CLI y que se sigue desde un teléfono.",
    },
    proofLabel: "De un vistazo",
    // Offdesk's own row of the comparison table further down.
    proof: [
      { key: "cualquier-programa", value: "todo lo que corre en tmux" },
      { key: "máquinas", value: "las que quieras, una url" },
      { key: "tráfico", value: "por tu propio hub" },
      { key: "agentes", value: "open · send · wait · read" },
      { key: "licencia", value: "autoalojado, Hub MIT" },
    ],
    beats: {
      title: "Quien necesita el teclado, lo toma.",
      items: [
        {
          label: "01 / agente",
          title: "tu agente la abre",
          body: "Un comando inicia Claude Code, Codex o lo que sea en una terminal de cualquier máquina tuya. Sigue funcionando cuando todos se van.",
        },
        {
          label: "02 / tú",
          title: "tú ves la misma",
          body: "No una transcripción: la terminal en vivo, en tu teléfono, tu portátil o un navegador. Cuando se detiene a preguntar, lo ves.",
        },
        {
          label: "03 / cualquiera",
          title: "toma el control y devuélvelo",
          body: "Responde con Enter o toma el teclado. También en el navegador del agente: inicia sesión por él y devuélveselo.",
        },
      ],
    },
    start: {
      title: "Tu primera terminal en tres pasos.",
      steps: [
        {
          label: "paso 1",
          title: "Instala el hub en macOS o Linux",
          body: "Abre la app de Mac, indica que es la máquina que se queda encendida y se convierte en tu hub: arranca al iniciar sesión y se reinicia si se detiene. Autoalojarlo no requiere cuenta con ningún proveedor. En un NAS o un servidor sin pantalla, una línea hace lo mismo:",
        },
        {
          label: "paso 2",
          title: "Empareja tu teléfono o entra desde un navegador",
          body: 'Elige Offdesk App para generar un código de emparejamiento cifrado para el escáner de la app. Elige Browser access para obtener un enlace de inicio de sesión en el navegador. Encontrarás ambos en la barra de menús del Mac, o ejecuta <span class="inline-code">offdesk link</span> para el acceso por navegador.',
        },
        {
          label: "paso 3",
          title: "Vuelve a la misma sesión de tmux",
          body: "La misma sesión de tmux que en tu escritorio, en vivo. Mantén el hub encendido y conectado. Todo lo que corre en tmux corre aquí.",
        },
      ],
      readGuide: "leer la guía de mac",
      iphone: "app de iphone",
      android: "app de android",
      orBrowser: "o cualquier navegador del teléfono",
    },
    download: {
      title: "Clientes para escritorio, teléfono y web.",
      lead: "La app de escritorio es el hub en un Mac y un cliente en todas partes. Las apps del teléfono envuelven la misma terminal que muestra el navegador.",
      mac: {
        body: "Un solo dmg para Apple silicon e Intel. Firmado con un Developer ID y notarizado, así que se abre como cualquier app de la App Store. En el Mac que se queda encendido se convierte en tu hub; en cualquier otro, es un cliente.",
        button: "descargar .dmg →",
        meta: "macOS 11 o posterior · universal · .dmg",
      },
      windows: {
        body: "Un cliente: abre las terminales de un hub que está en otra parte. Pega el enlace que imprimió el hub o inicia sesión. Un equipo con Windows no puede ser el hub, que necesita tmux.",
        button: "descargar .msi →",
      },
      linux: {
        body: "Un cliente, como en Windows. Si un equipo Linux va a ser el hub, lo indicado es la instalación de una línea: ejecuta el hub como servicio.",
        button: "descargar .AppImage →",
        meta: "x64 · .AppImage · .deb y .rpm en {release}",
        release: "la página de la versión",
      },
      iphone: {
        body: "Disponible a través de TestFlight. Abre la invitación en tu iPhone o iPad, instala la app y luego elige Scan QR Code para conectarte a tu hub.",
        button: "unirse a la beta →",
      },
      android: {
        body: 'Un APK para instalar manualmente. Elige <span class="inline-code">arm64-v8a</span> en un teléfono moderno, o <a href="/apk/universal">universal</a> si tienes dudas.',
        button: "descargar apk →",
      },
      cli: {
        title: "Hub, node y CLI",
        body: "Los tres binarios, para un NAS, un VPS o cualquier máquina sin pantalla. Linux y macOS, x64 y arm64.",
      },
    },
    how: {
      title: "Hub en Rust. WebSockets salientes. tmux persistente.",
      items: [
        {
          title: "hub",
          body: "Un servidor en Rust hecho con Axum, almacenamiento SQLite y una interfaz web integrada. Autentica a los clientes y dirige el tráfico de las terminales hacia tus nodes de macOS y Linux. Instala un binario o despliégalo con Docker.",
        },
        {
          title: "node",
          body: "En cada máquina a la que quieras llegar. Se conecta <em>hacia fuera</em> al hub por WebSocket, así que el node no necesita puertos de entrada ni IP pública. Cada terminal es una sesión de tmux en la máquina a la que pertenece: sobrevive a la app, a la red y a que te vayas. Desinstala Offdesk y sigue ahí.",
        },
        {
          title: "cliente",
          body: "React y xterm.js muestran la terminal interactiva en el navegador. Las apps de Tauri añaden emparejamiento cifrado nativo en escritorio y móvil. La CLI en Rust ofrece acceso programable. Los clientes comparten la salida de la terminal a través del Hub; una concesión de control decide quién puede escribir.",
        },
      ],
      note: "Dos pantallas en una terminal son dos clientes de un mismo hub, conectados a una misma sesión de tmux. Si un cliente se desconecta, la sesión sigue viva en el node. Offdesk usa su propio transporte Hub/node, no SSH: instala offdesk-node en cada máquina a la que quieras llegar.",
    },
    away: {
      title: "Autoalójalo en tu LAN. Añade acceso remoto cuando lo necesites.",
      body: [
        "Ejecuta el Hub de código abierto en macOS, Linux, un NAS o un VPS. Los Nodes se conectan hacia fuera a ese Hub; las sesiones de terminal se quedan en las máquinas que ejecutan tmux. Tu Hub y esas máquinas deben seguir encendidos y conectados.",
        `Ejecuta cloudflared junto a tu Hub para exponer un endpoint HTTPS sin abrir puertos en el router, incluso detrás de NAT o CGNAT. Configura tu dominio y el ingress del túnel, o usa <a href="${repo}/blob/main/docs/setup-public.md#tailscale">Tailscale</a> para acceder de forma privada al Hub desde tus dispositivos.`,
        `Las Offdesk Apps emparejadas cifran el tráfico de la terminal de extremo a extremo entre la App y el Hub, también a través de un túnel. El acceso normal por navegador usa HTTPS y su propia autenticación, que termina en el proveedor del túnel; no obtiene automáticamente el cifrado de la App. Consulta la <a href="${repo}/blob/main/docs/encrypted-connections.md">guía de conexiones cifradas</a>.`,
      ],
      tunnelGuide: "la guía del túnel",
      lanSetup: "configuración lan",
      pairing: "emparejamiento cifrado de la app",
      cloudSetup: "configuración de cloud",
      homeTitle: "# en la máquina de casa",
      homeBody:
        'Crea el túnel en el panel de Cloudflare, apúntalo a <span class="inline-code">server:4317</span>, pon su token en <span class="inline-code">.env</span> y:',
      copyTunnelLabel: "Copiar los comandos del túnel",
      homeAfter:
        "Para el acceso cifrado con la App, escanea el código de emparejamiento cifrado con el escáner de la App. Para el acceso normal por navegador, configura la autenticación como se describe en la guía del túnel.",
      cloudBadge: "beta solo por invitación",
      cloudBody:
        "Offdesk Cloud, opcional, ofrece acceso remoto gestionado. Su servicio es de código cerrado; en el repositorio público, el Hub, el node y la CLI tienen licencia MIT, y la interfaz web y las apps publican su código bajo FSL-1.1-MIT. El conector local comprueba que la conexión cifrada sea alcanzable y reintenta automáticamente, con backoff, los fallos persistentes del túnel. El uso local no necesita cuenta de Cloud.",
    },
    more: {
      title: "Shells remotas, agentes de código en el teléfono y automatización con la CLI.",
      machines: {
        title: "Gestiona terminales de macOS y Linux",
        body: "El NAS, el VPS, el portátil. Abre el hub, elige <strong>Add a machine</strong> y te da una línea con un token dentro. Pégala en esa máquina y aparece.",
      },
      agents: {
        title: "Usa cualquier agente",
        body: "Offdesk no envuelve a ningún agente ni habla su protocolo. Te da la terminal en la que el agente ya se ejecuta: tu suscripción, tu configuración, tus dotfiles.",
        anyCli: "cualquier CLI",
      },
      phone: {
        title: "Usa Claude Code y Codex desde tu teléfono",
        body: [
          `Personaliza la barra de teclas con Esc, Tab, Shift+Tab, combinaciones con Shift y Backspace con repetición. Las flechas, Enter y el botón del teclado quedan fijos; oculta o reordena las demás teclas en Settings. <a href="${repo}/blob/main/docs/terminal-keys.md">Configura las teclas de la terminal</a>. Las apps añaden un escáner de QR y conexiones cifradas de extremo a extremo.`,
          `Un aviso de espera te permite abrir la solicitud de confirmación de otra terminal o enviar Enter a su selección actual sin perder tu vista. <a href="${repo}/blob/main/docs/terminal-attention.md">Lee sobre los atajos de confirmación</a>.`,
          "<strong>iPhone y iPad:</strong> únete a la beta pública de TestFlight con el enlace de abajo. TestFlight se encarga de las actualizaciones de la app.",
        ],
        android: "apk de android",
        universal: "build universal",
        iphone: "iphone · testflight",
        heroAlt: "Claude Code en una máquina de escritorio mientras un teléfono está conectado a la misma sesión de tmux",
        iosAlt: "Claude Code en la app de Offdesk para iPhone, conectada al Mac de casa",
        stillAlt: "Una terminal de Offdesk en un teléfono: Claude Code en un Mac de casa, conectado desde el navegador del teléfono",
        caption: "Claude Code en una sesión de tmux remota y persistente.",
      },
    },
    cli: {
      title: "Automatiza terminales remotas con la CLI de Offdesk.",
      lead: "Usa los comandos open, send, wait y read para controlar sesiones remotas de tmux desde scripts de shell o agentes de código con IA. La salida JSON permite a tus scripts capturar los ID de las terminales y pasar resultados entre pasos. Una terminal que abre un agente queda marcada como abierta por un agente, para que la distingas de las tuyas.",
      body: `Un token es ejecución remota de código en cada máquina que hayas registrado. Crea uno por agente, ponle nombre y revócalo por separado. <a href="${repo}/blob/main/SECURITY.md">SECURITY.md</a>`,
      copyLabel: "Copiar el ejemplo",
    },
    compare: {
      title: "Cómo se compara",
      note: "Cada celda sale de la documentación del propio proyecto, revisada el 2026-09-01. Las fuentes están bajo la misma tabla en el README.",
      project: "Proyecto",
      columns: [
        "Cualquier programa de terminal",
        "Máquinas por hub",
        "El tráfico pasa por",
        "Los agentes lo controlan por CLI",
        "Autoalojado",
      ],
      // One row per project, in the order of the table in the template; names
      // stay in English and live in the template.
      rows: [
        ["Todo lo que corre en tmux", "Las que quieras, una URL", "Tu propio hub", "open / send / wait / read", "Sí, MIT + FSL"],
        ["No — una sesión de Claude Code, no una terminal", "Sesiones de varias máquinas en una lista", "Servidores de Anthropic; la transcripción se guarda allí", "No documentado", "No"],
        ["Sí — vt &lt;cualquier comando&gt;, vt --shell", "Un servidor por máquina", "Tú eliges: LAN, Tailscale, ngrok, Cloudflare", "Solo lanza comandos", "Sí, MIT"],
        ["No — envuelve claude y codex", "Varias; spawn --machine", "Nube de slopus por defecto, cifrado de extremo a extremo", "create / send / history / wait", "Opcional, MIT"],
        ["Sesiones de agente; no documenta terminal directa", "Varias a la vez por agente", "api.omnara.com por defecto", "CLI y REST", "Opcional, Apache-2.0"],
        ["Sí — terminal real, 30+ agentes CLI", "Varias, vía worktrees por SSH y orca serve", "Orca Relay por defecto, o directo en la LAN", "orca terminal create/send/read/wait", "Sí, MIT"],
      ],
    },
    close: {
      title: "Configura tu hub esta noche.",
      lead: "Instala el Hub en macOS o Linux, registra tus máquinas y abre sesiones de tmux persistentes desde el navegador o el teléfono.",
      iphone: "app de iphone",
      android: "app de android",
    },
  },

  tunnel: {
    title: "Offdesk detrás de un Cloudflare Tunnel",
    description:
      "Accede a tu hub de casa desde cualquier lugar sin abrir puertos: la configuración completa de Cloudflare Tunnel para Offdesk, la terminal remota autoalojada.",
    heading: "Un Cloudflare Tunnel",
    lead: "Para un hub en un NAS o un equipo de escritorio en casa. <code>cloudflared</code> se ejecuta junto al hub y se conecta <em>hacia fuera</em> a Cloudflare, que luego sirve tu nombre de host por HTTPS. Sin redirección de puertos, sin DNS dinámico, sin certificados que renovar, y funciona detrás de CGNAT, donde ni siquiera es posible redirigir un puerto.",
    intro: `En las conexiones normales por navegador, Cloudflare termina el HTTPS y puede leer el tráfico de la terminal. El emparejamiento cifrado de la App añade cifrado entre la App y el Hub, así que el túnel transporta contenido de terminal cifrado. Para ese modo, sigue la <a href="${repo}/blob/main/docs/encrypted-connections.md">guía de conexiones cifradas</a>. También puedes usar una <a href="${repo}/blob/main/docs/setup-public.md#tailscale">tailnet</a>: los mismos binarios, sin nadie en medio.`,
    needDomain: "Necesitas un dominio en una cuenta de Cloudflare. Basta con el plan gratuito.",
    create: {
      title: "1. Crea el túnel",
      body: "Panel de Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel → <strong>Cloudflared</strong>. Ponle nombre y copia el token que te muestra: la cadena larga que va después de <code>--token</code> en el comando de instalación. Ese token es una credencial: quien lo tenga puede servir tráfico como si fuera tu túnel.",
      hostname: "Añade un nombre de host público al túnel:",
      field: "Campo",
      value: "Valor",
      subdomain: "Subdomain / domain",
      serviceType: "Service type",
      url: "URL",
      after:
        "<code>server</code> es el nombre de servicio del hub en <code>docker-compose.yml</code>; así es como <code>cloudflared</code> lo alcanza por la red de compose. El tramo de Cloudflare a tu máquina va dentro del túnel; el tramo de <code>cloudflared</code> al hub nunca sale de la red de Docker, así que ahí basta con HTTP sin cifrar.",
    },
    hub: {
      title: "2. Hub",
      envIntro: "<code>.env</code> junto a <code>docker-compose.yml</code>:",
      // Placeholders inside the .env example; the angle brackets are added
      // by the template.
      secretPlaceholder: "salida de: openssl rand -hex 32",
      tokenPlaceholder: "el token del paso 1",
      oauth: `En un hub expuesto a internet, el inicio de sesión se hace con GitHub o Google. Registra las URL de callback de OAuth exactamente como en <a href="${repo}/blob/main/docs/setup-public.md#2-oauth-callback-urls">la guía del VPS</a>: el hub las construye a partir de <code>OFFDESK_BASE_URL</code>, y un túnel no cambia nada de eso. Después:`,
      profile:
        "El perfil <code>tunnel</code> es el que inicia <code>cloudflared</code>; sin él solo tienes el hub, que sigue escuchando en <code>127.0.0.1:4317</code>. Comprueba que ambos estén activos:",
    },
    machines: {
      title: "3. Máquinas",
      body: "Abre el hub en un navegador y elige <strong>Add host</strong>: muestra una línea con un token de registro ya incluido. En la máquina a la que quieres llegar:",
      after:
        "Una máquina en la misma LAN que el hub igualmente sale a Cloudflare y vuelve. Si eso te molesta, regístrala con la dirección LAN del hub: el agente de la máquina solo necesita llegar al hub, y le da igual que tu teléfono llegue al mismo hub con otro nombre.",
    },
    notes: {
      title: "Notas",
      items: [
        "<strong>Cualquiera que encuentre la URL puede iniciar sesión</strong>, igual que con un VPS: cualquier cuenta de GitHub o Google puede crear una cuenta en tu hub. No hay lista de permitidos. Cloudflare Access puede poner un segundo inicio de sesión delante de todo el nombre de host, pero entonces todo lo que no es un navegador —<code>offdesk-node</code>, la CLI, la app de Android— necesita su propio token de servicio de Access, y el agente de la máquina no tiene dónde ponerlo. O limitas la política de Access a las rutas del navegador, o la dejas desactivada y confías en el inicio de sesión del propio hub.",
        "<strong>Los WebSockets de larga duración no son un problema.</strong> Los agentes de las máquinas envían un ping cada 30 segundos y los navegadores hacen ping en la capa de aplicación, así que los tiempos de espera por inactividad a lo largo del camino no cortan las terminales sin avisar.",
        "<strong>No uses un quick tunnel</strong> (<code>cloudflared tunnel --url</code>, los nombres de host <code>*.trycloudflare.com</code>) para nada que no sea una demo. El nombre de host cambia en cada reinicio, lo que invalida tus URL de callback de OAuth, cada máquina registrada y cualquier teléfono que tenga guardado el anterior.",
      ],
    },
    others: `Las otras dos vías —un VPS detrás de Caddy, y Tailscale— con las ventajas y desventajas de las tres: <a href="${repo}/blob/main/docs/setup-public.md">docs/setup-public.md</a>.`,
  },

  mac: {
    title: "Tu primera terminal, desde un Mac",
    description:
      "Guía con capturas de pantalla para instalar Offdesk en un Mac, abrir tu primera terminal remota y conectar tu teléfono, paso a paso.",
    eyebrow: "Primeros pasos · macOS",
    lead: "Convierte en tu hub el Mac que se queda encendido. Después, abre su terminal desde tu teléfono. Empieza con ambos dispositivos en la misma red local.",
    preview: "Sobre las capturas",
    previewText:
      "Estas capturas son de nuestra prueba de 0.6.4-rc.1 en un Mac Mini. La versión estable actual incluye el emparejamiento del teléfono y la configuración de Cloud actualizados. Las instrucciones siguen la nueva versión; las capturas antiguas conservan sus etiquetas de RC y su diseño. El panel de emparejamiento ahora separa Offdesk App de Browser access. El botón de descarga ofrece la versión estable.",
    download: "Descargar para Mac",
    phone: "Consigue la app del teléfono",
    contents: "En esta página",
    stepLabel: "paso {n}",
    openScreenshot: "Abrir la captura completa",
    before: "Antes de empezar",
    needs: [
      "Un Mac que pueda quedarse encendido y conectado, y su cuenta de usuario de macOS.",
      "Tu teléfono y tu Mac en la misma red local. También funciona un Mac conectado por cable con un teléfono conectado por Wi-Fi al mismo router.",
      "Offdesk en tu teléfono: TestFlight para iPhone / iPad, o el APK de Android de este sitio.",
    ],
    terms:
      "El Hub gestiona las conexiones; el Node pone a disposición las terminales de una máquina. Elegir este Mac como Hub instala ambos. La configuración normal de la App no necesita un comando install.sh aparte ni Docker.",
    // Each step's title starts with its number, "1. …": the template splits
    // it into the step label and the heading.
    steps: {
      install: {
        title: "1. Instala la app de Mac",
        body: "Descarga la imagen de disco desde la <a href='/mac'>página de descarga para Mac</a>. Abre el DMG, arrastra Offdesk Dev a Aplicaciones y abre la copia instalada. No la sigas ejecutando desde la imagen de disco montada.",
        extra:
          "Una cuenta estándar de macOS puede necesitar la contraseña de un administrador para escribir en la carpeta Aplicaciones del sistema. También puedes usar una carpeta Aplicaciones dentro de tu carpeta de inicio. La etiqueta RC de la captura identifica nuestra build de prueba.",
        alt: "La ventana de la imagen de disco del Mac con Offdesk RC y un alias de la carpeta Aplicaciones.",
        caption: "Arrastra la app a Aplicaciones y abre la copia instalada.",
      },
      choose: {
        title: "2. Convierte este Mac en el hub",
        body: "En <strong>Which machine is this?</strong>, elige <strong>The one that stays on → Set this machine up</strong>. Elige esta opción si quieres que tu teléfono llegue a las terminales que se ejecutan en este Mac.",
        extra:
          "Elige <strong>Just connecting</strong> solo si ya tienes un Hub en otro lugar y quieres usar este Mac como cliente. No necesitas crear una cuenta para esta configuración local.",
      },
      ready: {
        title: "3. Deja que el Mac termine de prepararse",
        body: "La configuración actualizada comprueba cuatro cosas antes de mostrar la pantalla de conexión del teléfono. Que aparezca una dirección en pantalla no demuestra por sí solo que la configuración haya terminado.",
        checks: [
          "El Hub está en marcha y responde.",
          "Este Mac está registrado en el Hub.",
          "El Node local está en línea.",
          "La herramienta de terminal, tmux, está disponible.",
        ],
        extra:
          "Cuando esté listo, verás <strong>Connect your phone</strong>. Elige <strong>Pair an encrypted device</strong> para generar el código de emparejamiento. Si falla una comprobación, usa la acción de reintentar de la pantalla de configuración. Si macOS pregunta si Offdesk Dev puede aceptar conexiones entrantes, permítelo en el Mac al que quieres que llegue tu teléfono.",
      },
      terminal: {
        title: "4. Abre tu primera terminal",
        body: "Elige <strong>Open my terminal</strong>. Si ves <strong>No terminals yet</strong>, mira el control de arriba a la derecha: si dice <strong>Watching / Viewing</strong>, haz clic en él para tomar el control y luego elige <strong>Start terminal</strong>. Si otro dispositivo ya tiene el control, asegúrate de que de verdad quieres quitárselo.",
        extra:
          "Escribe esta línea y pulsa Enter. Deberías ver las palabras devueltas debajo. Los comandos se ejecutan en tu Mac, incluso cuando los escribes en tu teléfono.",
        alt: "Offdesk ejecutando echo hello from offdesk en la shell del Mac de la cuenta de prueba, con hello from offdesk devuelto debajo.",
        caption: "Una shell real, con entrada y salida que funcionan. El estado del control determina si puedes crear una terminal o escribir.",
      },
      phone: {
        title: "5. Escanea desde la app del teléfono",
        body: "En el Mac, elige <strong>Phone</strong> o <strong>Show me</strong> para abrir el panel de conexión. Selecciona <strong>Offdesk App · Recommended</strong> y luego <strong>Pair an encrypted device</strong>. En la pantalla de conexión de la App del teléfono, elige <strong>Scan QR Code</strong> y escanea el código de emparejamiento cifrado recién generado. Permite el acceso a la cámara cuando te lo pida.",
        extra:
          "<strong>Browser access</strong> ofrece un código de inicio de sesión que la cámara del sistema de tu teléfono puede abrir en un navegador. <strong>Offdesk App</strong> genera un código de emparejamiento cifrado para el escáner de la App. Elige un modo; no hace falta escanear los dos códigos. Si el código de emparejamiento caduca, genera uno nuevo en el Mac.",
        alt: "El panel de conexión del teléfono en el Mac, con una dirección local, enlaces a las apps del teléfono y Pair an encrypted device; el código y el enlace de inicio de sesión están ocultos.",
        caption: "La captura antigua oculta su código y su enlace de inicio de sesión. En 0.7.1, selecciona Offdesk App y genera tu propio código de emparejamiento.",
        after:
          "Tras emparejar, busca este Mac y su terminal. Si no hay ninguna terminal que seleccionar, crea una en el Mac siguiendo el paso anterior. Prueba un comando corto desde el teléfono y luego cierra y vuelve a abrir la App del teléfono para comprobar que se reconecta.",
      },
      return: {
        title: "6. Cierra la app. Vuelve a tu terminal.",
        body: "Al salir de la App de Mac, los servicios Hub y Node siguen funcionando en segundo plano. Al volver a abrir la App puedes regresar a la terminal. Salir de la App no es lo mismo que poner el Mac en reposo, apagarlo o cerrar la sesión de macOS.",
        extra:
          "Mantén el Mac encendido, con la sesión iniciada y conectado. Una dirección local funciona en esa red; configura el acceso remoto por separado cuando quieras usar Offdesk fuera de casa. Escanear un código no hace que una dirección local sea accesible desde internet.",
      },
      cloud: {
        title: "7. Opcional: conéctate fuera de casa con Offdesk Cloud",
        body: "Cloud es por ahora una beta solo por invitación. Inicia sesión y canjea tu invitación en la <a href='https://offdesk.so'>consola de Cloud</a>. En el Mac, elige <strong>Set up remote access</strong>, sigue los pasos de inicio de sesión y verifica la autorización del equipo. Cuando la dirección de Cloud esté lista, empareja tu teléfono con el modo Offdesk App.",
        extra:
          "Para el recorrido completo de un usuario nuevo, instala las últimas apps estables de macOS y Android desde este sitio. iOS se distribuye por TestFlight; las builds disponibles dependen de tu grupo de pruebas. Tras la configuración, desactiva la conexión Wi-Fi del teléfono y comprueba la terminal con datos móviles mientras el Mac sigue en línea. Un teléfono emparejado abre <strong>Hub &amp; connection</strong> desde su título. Si solo usas la red local, puedes prescindir de Cloud y de las invitaciones.",
      },
    },
    trouble: "Si tu pantalla se ve distinta",
    faqs: [
      [
        "Connect a machine / Generate a token",
        "El Hub aún no tiene ninguna máquina utilizable; tu teléfono no necesita convertirse en host. Revisa primero la configuración en el Mac. Para el problema antiguo de 0.6.3, una recuperación manual es elegir Generate a token en este Mac y ejecutar el comando generado completo en la Terminal del sistema de ese mismo Mac. Es una vía de recuperación para la versión antigua, no un paso obligatorio de la instalación normal.",
      ],
      [
        "Al escanear se abre una página de inicio de sesión, o la dirección IP sola no inicia sesión",
        "Una dirección por sí sola no contiene credenciales de inicio de sesión. Usa el enlace de inicio de sesión completo o su código QR normal para iniciar sesión en el navegador. Usa el escáner de la App con el código de emparejamiento cifrado para el emparejamiento cifrado. No pongas enlaces de inicio de sesión completos ni códigos QR en chats compartidos.",
      ],
      [
        "El teléfono no se conecta o la pantalla está en blanco",
        "Comprueba que ambos dispositivos estén en la misma red local y que la dirección seleccionada sea accesible desde el teléfono. Las redes Wi-Fi de invitados pueden aislar los dispositivos. Confirma que la terminal funciona en el Mac y revisa el permiso de red local del teléfono. Si la pantalla sigue en negro tras escanear, cierra y vuelve a abrir la App, y luego informa de la versión de la App, el modelo de teléfono y los pasos. No debería hacer falta volver a abrirla cada vez.",
      ],
    ] as [string, string][],
    tested: "¿Qué probamos exactamente?",
    testedIntro:
      "El 7 de septiembre de 2026 hicimos la prueba en un Mac Mini con una cuenta estándar nueva, offdesk-test, sin configuración ni servicios de Offdesk y sin haber ejecutado antes ningún script de instalación. Era una cuenta de usuario limpia, no un Mac restaurado de fábrica. El 10 de septiembre hicimos una copia de seguridad y restablecimos la configuración de App/Hub en esa cuenta de prueba, y verificamos en 0.7.1-rc.1 la configuración automática, la generación del código cifrado, la entrada en la terminal y la reapertura. Esa segunda prueba conservó las herramientas del sistema, el estado del navegador y las sesiones antiguas de tmux.",
    passed: [
      "Descarga del DMG, arrastre a la carpeta Aplicaciones del usuario y apertura desde Finder.",
      "Instalación automática de Hub / Node, registro de la máquina, comprobaciones de conexión en vivo y de tmux, seguidas de un código QR ya generado.",
      "Entrada y salida en una terminal real.",
      "Persistencia de la terminal tras salir y volver a abrir la App, y reconexión tras reiniciar solo el Hub de prueba.",
    ],
    pending:
      "Aún sin completar en esta prueba: escaneo con un teléfono físico y reapertura en frío, cierre e inicio de sesión del usuario de prueba, y aceptación por Gatekeeper del paquete de producción firmado y notarizado. El usuario autorizó el primer arranque de la RC; eso no demuestra que la distribución de producción sea aceptada.",
    known:
      "También reprodujimos un fallo en la configuración inicial: Watching oculta la acción Start terminal. El paso 4 incluye la acción de tomar el control para que tengas claro el siguiente paso.",
    next: "Sigue adelante",
    nextText: "Primero familiarízate con la red local y luego lee sobre las conexiones cifradas y el acceso remoto.",
    encryption: "Conexiones cifradas",
    lan: "Solución de problemas en red local",
    allDocs: "Toda la documentación técnica",
  },
};

export default es;
