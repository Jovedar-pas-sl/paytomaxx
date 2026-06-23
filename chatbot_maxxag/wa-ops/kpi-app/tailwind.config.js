/**
 * Tailwind v3 config — ported 1:1 from the inline config the Play CDN used.
 * Compiled to app/static/css/app.css at `docker build` via the standalone CLI
 * (no Node). The CSS variables (--c-*) live in base.html's inline <style>, so the
 * generated utilities resolve their colors there at runtime, identical to before.
 *
 * safelist: classes the dashboard JS toggles at runtime (classList.add/toggle).
 * Tailwind also scans the inline <script> in the templates, so this is a belt-and-
 * suspenders list — keeps the design identical even if a token is only set in JS.
 */
module.exports = {
  darkMode: "class",
  content: ["./app/templates/**/*.html"],
  safelist: [
    "animate-pulse",
    "animate-ping",
    "bg-green", "bg-red", "bg-blue", "bg-amber", "bg-muted-2", "bg-surface-2",
    "bg-accent/15", "bg-amber/15", "bg-blue/15", "bg-red/15", "bg-green/15",
    "text-green", "text-red", "text-amber", "text-blue", "text-accent",
    "text-muted", "text-muted-2", "text-text",
    "border-border-strong",
  ],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--c-surface-2) / <alpha-value>)",
        panel: "rgb(var(--c-surface) / <alpha-value>)",
        border: "rgb(var(--c-border) / <alpha-value>)",
        "border-strong": "rgb(var(--c-border-strong) / <alpha-value>)",
        text: "rgb(var(--c-text) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        "muted-2": "rgb(var(--c-muted-2) / <alpha-value>)",
        accent: "rgb(var(--c-accent) / <alpha-value>)",
        "accent-soft": "rgb(var(--c-accent) / 0.12)",
        green: "rgb(16 185 129 / <alpha-value>)",
        blue: "rgb(var(--c-blue) / <alpha-value>)",
        amber: "rgb(245 158 11 / <alpha-value>)",
        red: "rgb(244 63 94 / <alpha-value>)",
        purple: "rgb(167 139 250 / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Geist", "Inter", "ui-sans-serif", "system-ui"],
        mono: ["Geist Mono", "JetBrains Mono", "ui-monospace"],
      },
      letterSpacing: {
        tight: "-0.01em",
        tighter: "-0.02em",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 1px 2px rgba(0,0,0,0.4)",
        "card-hov": "0 1px 0 0 rgba(255,255,255,0.06) inset, 0 4px 12px rgba(0,0,0,0.5)",
        "ring-accent": "0 0 0 3px rgba(244,63,94,0.2)",
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [require("@tailwindcss/forms"), require("@tailwindcss/typography")],
};
