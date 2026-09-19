import { colorsFromSettings, type ThemeColorValues } from "./theme";

// Starting points, not locked themes. Apply only color fields: identity, font,
// integrations, and instance defaults are never changed by a preset.
export const THEME_PRESETS: { id: string; colors: ThemeColorValues }[] = [
  { id: "rose", colors: colorsFromSettings({
    themePrimary: "#c9506b", themeBg: "#08080d", themeBgSecondary: "#111119",
    themeText: "#e5e5ef", themeTextSecondary: "#a1a1b5", themeHeading: "#ffffff",
    themeBorder: "#30303e",
  }) },
  { id: "teal", colors: colorsFromSettings({
    themePrimary: "#2dd4bf", themeBg: "#091211", themeBgSecondary: "#12201e",
    themeText: "#e3efec", themeTextSecondary: "#9ab5ad", themeHeading: "#f5fffc",
    themeBorder: "#304b43",
  }) },
  { id: "paper", colors: colorsFromSettings({
    themePrimary: "#a63450", themeBg: "#faf8f5", themeBgSecondary: "#ffffff",
    themeText: "#29252b", themeTextSecondary: "#6b626e", themeHeading: "#1e1822",
    themeBorder: "#d4ccd3",
  }) },
];
