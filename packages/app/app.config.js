const { withAndroidManifest } = require("@expo/config-plugins");

const withCleartextTraffic = (config) =>
  withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];
    if (application?.$) {
      application.$["android:usesCleartextTraffic"] = "true";
    }
    return config;
  });

const plugins = ["expo-router"];
if (process.env.OFFDESK_ALLOW_CLEARTEXT === "1") {
  plugins.push(withCleartextTraffic);
}

module.exports = ({ config }) => ({
  ...config,
  name: "Offdesk",
  slug: "offdesk",
  version: process.env.OFFDESK_APP_VERSION || "0.1.0",
  scheme: "offdesk",
  userInterfaceStyle: "automatic",
  platforms: ["web", "android"],
  web: {
    bundler: "metro",
    output: "single",
    headTags: [
      {
        tag: "script",
        // The theme lib/theme.tsx last applied (offdesk:theme-css), painted
        // before the bundle loads; without it, light or dark as before.
        innerHTML: `(function(){try{var r=document.documentElement,m=window.matchMedia('(prefers-color-scheme:dark)').matches,c=JSON.parse(localStorage.getItem('offdesk:theme-css')||'null'),e=c&&(c.fixed||(c.system&&c.system[m?'dark':'light']));if(e&&e.vars){for(var k in e.vars)r.style.setProperty(k,e.vars[k]);r.dataset.theme=e.id;r.classList.toggle('dark',e.scheme==='dark');r.style.colorScheme=e.scheme;return}var t=localStorage.getItem('offdesk:theme');var d=t==='dark'||((t==='system'||!t)&&m);r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light'}catch(x){}})();`,
      },
    ],
  },
  plugins,
  android: {
    package: "dev.offdesk.app",
    permissions: ["REQUEST_INSTALL_PACKAGES"],
  },
  extra: {
    defaultServerUrl:
      process.env.EXPO_PUBLIC_OFFDESK_DEFAULT_SERVER_URL ||
      process.env.OFFDESK_DEFAULT_SERVER_URL ||
      null,
  },
});
