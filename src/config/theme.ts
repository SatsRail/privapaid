import type { CSSProperties } from "react";

// Shared by server rendering and the admin preview. Empty optional colors
// inherit the palette, so existing installations keep their chosen branding.
export const COLOR_FIELDS = [
  { key: "theme_primary", token: "primary", column: "themePrimary", label: "primary", group: "base" },
  { key: "theme_bg", token: "bg", column: "themeBg", label: "bg", group: "base" },
  { key: "theme_bg_secondary", token: "bgSecondary", column: "themeBgSecondary", label: "surface", group: "base" },
  { key: "theme_text", token: "text", column: "themeText", label: "text", group: "base" },
  { key: "theme_text_secondary", token: "textSecondary", column: "themeTextSecondary", label: "muted", group: "base" },
  { key: "theme_heading", token: "heading", column: "themeHeading", label: "headings", group: "base" },
  { key: "theme_border", token: "border", column: "themeBorder", label: "borders", group: "base" },
  { key: "theme_primary_text", token: "primaryText", column: "themePrimaryText", label: "primary_text", group: "navigation" },
  { key: "theme_link", token: "link", column: "themeLink", label: "link", group: "navigation" },
  { key: "theme_nav_bg", token: "navBg", column: "themeNavBg", label: "nav_bg", group: "navigation" },
  { key: "theme_nav_text", token: "navText", column: "themeNavText", label: "nav_text", group: "navigation" },
  { key: "theme_hover", token: "hover", column: "themeHover", label: "hover", group: "navigation" },
  { key: "theme_media_bg", token: "mediaBg", column: "themeMediaBg", label: "media_bg", group: "media" },
  { key: "theme_media_text", token: "mediaText", column: "themeMediaText", label: "media_text", group: "media" },
  { key: "theme_success", token: "success", column: "themeSuccess", label: "success", group: "status" },
  { key: "theme_warning", token: "warning", column: "themeWarning", label: "warning", group: "status" },
  { key: "theme_error", token: "error", column: "themeError", label: "error", group: "status" },
] as const;

type ColorField = (typeof COLOR_FIELDS)[number];
type BaseToken = Extract<ColorField, { group: "base" }>["token"];
type ExtraToken = Exclude<ColorField["token"], BaseToken>;
export type ThemeColorValues = Record<ColorField["key"], string>;
type ThemeSettings = Partial<Record<ColorField["column"], string | null>>;
export type ThemeConfig = Record<BaseToken, string> & Partial<Record<ExtraToken, string | null>> & {
  font: string;
  logo: string;
};

export const DEFAULT_THEME: ThemeConfig = {
  primary: "#3b82f6", bg: "#0a0a0a", bgSecondary: "#18181b",
  text: "#ededed", textSecondary: "#a1a1aa", heading: "#fafafa", border: "#27272a",
  font: "Geist", logo: "",
};

export const isHexColor = (value: string): boolean => /^#[\da-f]{6}$/i.test(value);

function rgb(hex: string): number[] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((n) => {
    const c = n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function contrastText(bg: string): string {
  return contrastRatio(bg, "#ffffff") > contrastRatio(bg, "#000000") ? "#ffffff" : "#000000";
}

function mix(a: string, b: string, weight: number): string {
  const other = rgb(b);
  return "#" + rgb(a).map((n, i) => Math.round(n * (1 - weight) + other[i] * weight).toString(16).padStart(2, "0")).join("");
}

function readableAccent(accent: string, backgrounds: string[]): string {
  const contrast = (color: string) => Math.min(...backgrounds.map((bg) => contrastRatio(color, bg)));
  const target = contrast("#000000") > contrast("#ffffff") ? "#000000" : "#ffffff";
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(accent, target, step / 100);
    if (contrast(candidate) >= 4.5) return candidate;
  }
  return target;
}

export function resolveTheme(input: ThemeConfig) {
  // Invalid in-progress hex edits must not make the preview unreadable.
  const base = { ...DEFAULT_THEME, ...input };
  for (const field of COLOR_FIELDS) {
    if (field.group === "base" && !isHexColor(base[field.token])) {
      base[field.token] = DEFAULT_THEME[field.token];
    }
  }
  const dark = luminance(base.bg) < 0.18;
  const navBg = input.navBg && isHexColor(input.navBg) ? input.navBg : base.bg;
  const mediaBg = input.mediaBg && isHexColor(input.mediaBg) ? input.mediaBg : "#000000";
  const defaults: Record<ExtraToken, string> = {
    link: readableAccent(base.primary, [base.bg, base.bgSecondary]),
    primaryText: contrastText(base.primary), navBg,
    navText: contrastRatio(base.text, navBg) >= 4.5 ? base.text : contrastText(navBg),
    hover: mix(base.bgSecondary, base.text, 0.09), mediaBg, mediaText: contrastText(mediaBg),
    success: dark ? "#4ade80" : "#15803d",
    warning: dark ? "#facc15" : "#a16207",
    error: dark ? "#f87171" : "#b91c1c",
  };
  const extras = { ...defaults };
  for (const key of Object.keys(defaults) as ExtraToken[]) {
    const value = input[key];
    if (value && isHexColor(value)) extras[key] = value;
  }
  return { ...base, ...extras };
}

export function themeFromSettings(settings: ThemeSettings): ThemeConfig {
  const colors = Object.fromEntries(COLOR_FIELDS.map(({ token, column, group }) => [
    token, settings[column] || (group === "base" ? DEFAULT_THEME[token as BaseToken] : null),
  ]));
  return { ...DEFAULT_THEME, ...colors };
}

export function colorsFromSettings(settings: ThemeSettings): ThemeColorValues {
  return Object.fromEntries(COLOR_FIELDS.map(({ key, column, token, group }) => [
    key, settings[column] || (group === "base" ? DEFAULT_THEME[token as BaseToken] : ""),
  ])) as ThemeColorValues;
}

export function themeFromColors(colors: ThemeColorValues, font = DEFAULT_THEME.font): ThemeConfig {
  return { ...DEFAULT_THEME, ...Object.fromEntries(COLOR_FIELDS.map(({ key, token }) => [token, colors[key]])), font };
}

export function themeStyles(theme: ThemeConfig): CSSProperties {
  const resolved = resolveTheme(theme);
  return {
    ...Object.fromEntries(COLOR_FIELDS.map(({ token }) => [
      `--theme-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, resolved[token],
    ])),
    "--theme-error-text": contrastText(resolved.error),
    "--theme-backdrop": "color-mix(in srgb, var(--theme-media-bg) 75%, transparent)",
    colorScheme: luminance(resolved.bg) < 0.18 ? "dark" : "light",
  } as CSSProperties;
}
