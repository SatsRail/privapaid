import { describe, it, expect } from "vitest";
import en from "@/i18n/en.json";
import es from "@/i18n/es.json";
import { t } from "@/i18n";

describe("i18n catalogs", () => {
  it("en and es expose the exact same key set — no locale can drift", () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it("no catalog value is empty", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en:${key}`).not.toBe("");
    }
    for (const [key, value] of Object.entries(es)) {
      expect(value, `es:${key}`).not.toBe("");
    }
  });

  it("both locales declare the same {placeholders} per key", () => {
    const params = (s: string) => (s.match(/\{[a-z_]+\}/gi) ?? []).sort();
    for (const key of Object.keys(en)) {
      expect(
        params((es as Record<string, string>)[key] ?? ""),
        `placeholder mismatch in ${key}`
      ).toEqual(params((en as Record<string, string>)[key]));
    }
  });

  it("t() interpolates params and falls back to the key for unknown ids", () => {
    expect(t("en", "common.error_boundary.retry", { count: 2 })).toBe(
      "Try again (2 left)"
    );
    expect(t("es", "viewer.comments.heading")).toBe("Comentarios");
    expect(t("en", "no.such.key")).toBe("no.such.key");
  });
});
