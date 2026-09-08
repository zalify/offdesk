import type { Config } from "tailwindcss";

const colorVar = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  important: "html",
  theme: {
    extend: {
      colors: {
        background: colorVar("--color-background"),
        "background-secondary": colorVar("--color-background-secondary"),
        surface: colorVar("--color-surface"),
        "surface-hover": colorVar("--color-surface-hover"),
        foreground: colorVar("--color-foreground"),
        "foreground-secondary": colorVar("--color-foreground-secondary"),
        "foreground-muted": colorVar("--color-foreground-muted"),
        accent: colorVar("--color-accent"),
        "accent-dim": colorVar("--color-accent-dim"),
        danger: colorVar("--color-danger"),
        warning: colorVar("--color-warning"),
        success: colorVar("--color-success"),
        border: colorVar("--color-border"),
        "border-active": colorVar("--color-border-active"),
        "on-accent": colorVar("--color-on-accent"),
        "border-outline": "#e8e6dc",
        white: "#ffffff",
      },
      fontFamily: {
        display: [
          "Fredoka Variable",
          "Fredoka",
          "ui-rounded",
          "Nunito Variable",
          "system-ui",
          "sans-serif",
        ],
        sans: [
          "Nunito Variable",
          "Nunito",
          "ui-rounded",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Offdesk Terminal Symbols", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
