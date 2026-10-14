// /sitemap.xml: every page in every language, each with its alternates, so
// search engines can pair the translations (hreflang in the sitemap and in
// each page's <head> say the same thing).
import { locales, pages, pageUrl, type Page } from "../i18n/locales";

export function GET() {
  const urls = (Object.keys(pages) as Page[]).flatMap((page) =>
    locales.map((locale) => {
      const alternates = [
        ...locales.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.htmlLang}" href="${pageUrl(page, l.code)}"/>`),
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${pageUrl(page, "en")}"/>`,
      ];
      return `  <url>\n    <loc>${pageUrl(page, locale.code)}</loc>\n${alternates.join("\n")}\n  </url>`;
    }),
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
