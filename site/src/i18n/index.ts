// The dictionaries, by language. Each one is typed as `Dict` (the shape of
// en.ts), so a missing or misspelt key is a type error in the editor; the
// check below also fails the build, since `astro build` does not type-check.
import en, { type Dict } from "./en";
import zh from "./zh";
import de from "./de";
import fr from "./fr";
import ja from "./ja";
import ko from "./ko";
import es from "./es";
import { locales, type Locale } from "./locales";

export type { Dict };
export * from "./locales";

const dictionaries: Record<Locale, Dict> = { en, zh, de, fr, ja, ko, es };

/** Every key and array length of `want`, compared with `got`; problems as paths. */
function shapeErrors(want: unknown, got: unknown, path: string, out: string[]): string[] {
  if (typeof want === "string") {
    if (typeof got !== "string") out.push(`${path}: expected a string`);
    else if (!got.trim()) out.push(`${path}: empty`);
    else {
      // Placeholders the template fills in must survive translation.
      for (const p of want.match(/\{[a-z]+\}/g) ?? []) {
        if (!got.includes(p)) out.push(`${path}: lost the placeholder ${p}`);
      }
    }
  } else if (Array.isArray(want)) {
    if (!Array.isArray(got)) out.push(`${path}: expected an array`);
    else if (got.length !== want.length) out.push(`${path}: ${got.length} items, en has ${want.length}`);
    else want.forEach((item, i) => shapeErrors(item, got[i], `${path}[${i}]`, out));
  } else if (want && typeof want === "object") {
    if (!got || typeof got !== "object") {
      out.push(`${path}: expected an object`);
      return out;
    }
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const key of keys) {
      if (!(key in want)) out.push(`${path}.${key}: not in en.ts`);
      else if (!(key in got)) out.push(`${path}.${key}: missing`);
      else shapeErrors((want as Record<string, unknown>)[key], (got as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
  }
  return out;
}

const problems = locales.flatMap(({ code }) => shapeErrors(en, dictionaries[code], code, []));
if (problems.length) {
  throw new Error(`Translations do not match en.ts:\n  ${problems.join("\n  ")}`);
}

export function t(locale: Locale): Dict {
  return dictionaries[locale];
}

/** "made by {zalify}" -> ["made by ", ""] around the placeholder, for markup in between. */
export function around(text: string, placeholder: string): [string, string] {
  const [before, after = ""] = text.split(`{${placeholder}}`);
  return [before, after];
}
