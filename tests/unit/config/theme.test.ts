import { describe, expect, it } from "vitest";
import { THEME_PRESETS } from "@/config/theme-presets";
import { COLOR_FIELDS, DEFAULT_THEME, colorsFromSettings, contrastRatio, resolveTheme, themeFromColors, themeFromSettings, themeStyles } from "@/config/theme";

describe("theme resolution", () => {
  it.each(THEME_PRESETS)("keeps $id preset text readable on page and card surfaces", ({ colors }) => {
    const p = resolveTheme(themeFromColors(colors));
    for (const bg of [p.bg, p.bgSecondary]) {
      for (const fg of [p.text, p.textSecondary, p.heading, p.link]) {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(p.primaryText, p.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p.navText, p.navBg)).toBeGreaterThanOrEqual(4.5);
  });
  it("preserves an existing instance palette and inherits optional navigation colors", () => {
    const stored = { themeBg: "#faf8f2", themeText: "#292524", themePrimary: "#fbbf24" };
    const theme = resolveTheme(themeFromSettings(stored));
    expect(theme.bg).toBe(stored.themeBg);
    expect(theme.navBg).toBe(stored.themeBg);
    expect(theme.navText).toBe(stored.themeText);
    expect(theme.primaryText).toBe("#000000");
    expect(colorsFromSettings(stored).theme_nav_bg).toBe("");
  });

  it.each(["#ffffff", "#000000", "#fbbf24", "#7c3aed", "#3b82f6"])("chooses readable automatic button text for %s", (primary) => {
    const theme = resolveTheme({ ...DEFAULT_THEME, primary });
    expect(contrastRatio(theme.primary, theme.primaryText)).toBeGreaterThanOrEqual(4.5);
  });

  it("uses suitable automatic status colors for light and dark backgrounds", () => {
    for (const bg of ["#ffffff", "#0a0a0a"]) {
      const theme = resolveTheme({ ...DEFAULT_THEME, bg });
      for (const token of ["success", "warning", "error"] as const) {
        expect(contrastRatio(theme[token], bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps pale brand colors readable as links and prices on light surfaces", () => {
    const theme = resolveTheme({ ...DEFAULT_THEME, primary: "#f5c451", bg: "#f8f6f1", bgSecondary: "#eeebe4" });
    expect(theme.primary).toBe("#f5c451");
    expect(contrastRatio(theme.link, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.link, theme.bgSecondary)).toBeGreaterThanOrEqual(4.5);
  });

  it("round-trips every color through the settings, form, and CSS paths", () => {
    for (const field of COLOR_FIELDS) {
      const settings = { [field.column]: "#bada55" };
      const form = colorsFromSettings(settings);
      const fromForm = themeFromColors(form);
      const fromDb = themeFromSettings(settings);
      const cssName = `--theme-${field.token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(themeStyles(fromForm)).toMatchObject({ [cssName]: "#bada55" });
      expect(themeStyles(fromDb)).toEqual(themeStyles(fromForm));
    }
  });

  it("restores inheritance after an override is cleared, and follows later base changes", () => {
    const theme = { ...DEFAULT_THEME, navBg: "#fafafa", primaryText: "#112233" };
    expect(resolveTheme(theme).navBg).toBe("#fafafa");
    const reset = resolveTheme({ ...theme, bg: "#f9fafb", navBg: null, primary: "#000000", primaryText: "" });
    expect(reset.navBg).toBe("#f9fafb");
    expect(reset.primaryText).toBe("#ffffff");
  });

  it("keeps a valid preview during incomplete hex edits", () => {
    const theme = resolveTheme({ ...DEFAULT_THEME, bg: "#fff", primary: "", mediaText: "#zzzzzz" });
    expect(theme.bg).toBe(DEFAULT_THEME.bg);
    expect(theme.primary).toBe(DEFAULT_THEME.primary);
    expect(theme.mediaText).toBe("#ffffff");
  });

  it("automatically adapts text when header and player backgrounds change", () => {
    const theme = resolveTheme({ ...DEFAULT_THEME, navBg: "#ffffff", mediaBg: "#fafafa" });
    expect(theme.navText).toBe("#000000");
    expect(theme.mediaText).toBe("#000000");
  });
});
