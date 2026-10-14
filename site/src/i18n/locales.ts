// The languages the site is published in, and the URLs of every page in
// each. English lives at the root; every other language under /<code>/.
//
// To add a language: add it here, add src/i18n/<code>.ts typed as `Dict`,
// register it in src/i18n/index.ts, and add a :lang() font stack in
// src/styles/global.css if its script needs one. Pages, hreflang, the
// switcher and the sitemap all follow from this list.

export const locales = [
  { code: "en", htmlLang: "en", og: "en_US", name: "english" },
  { code: "zh", htmlLang: "zh-CN", og: "zh_CN", name: "简体中文" },
  { code: "de", htmlLang: "de", og: "de_DE", name: "deutsch" },
  { code: "fr", htmlLang: "fr", og: "fr_FR", name: "français" },
  { code: "ja", htmlLang: "ja", og: "ja_JP", name: "日本語" },
  { code: "ko", htmlLang: "ko", og: "ko_KR", name: "한국어" },
  { code: "es", htmlLang: "es", og: "es_ES", name: "español" },
] as const;

export type Locale = (typeof locales)[number]["code"];
export const defaultLocale: Locale = "en";
/** Every language but English, for the /<code>/… routes. */
export const prefixedLocales = locales.filter((l) => l.code !== defaultLocale).map((l) => l.code);

export const origin = "https://offdesk.dev";

/** The site's pages, by English path. Every page exists in every language. */
export const pages = {
  home: "/",
  tunnel: "/tunnel/",
  mac: "/docs/mac/",
} as const;
export type Page = keyof typeof pages;

export function localeInfo(code: Locale) {
  return locales.find((l) => l.code === code)!;
}

/**
 * A site path in a language: "/" -> "/de/", "/tunnel/" -> "/de/tunnel/",
 * "/#download" -> "/de/#download". Paths end in a slash because that is how
 * the static host serves directories; without it every link is a redirect.
 */
export function localize(path: string, locale: Locale): string {
  return locale === defaultLocale ? path : `/${locale}${path}`;
}

/** The absolute URL of a page in a language. */
export function pageUrl(page: Page, locale: Locale): string {
  return origin + localize(pages[page], locale);
}
