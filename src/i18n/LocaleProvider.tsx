"use client";

import { createContext, useCallback, useState } from "react";
import { t as translate, type Locale, type TranslatorFn } from "./index";

interface LocaleContextValue {
  locale: Locale;
  t: TranslatorFn;
  setLocale: (locale: Locale) => void;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  // English fallback outside a provider (isolated renders, class components
  // before mount) — never surface raw translation keys to the user.
  t: (key: string, params?: Record<string, string | number>) =>
    translate("en", key, params),
  setLocale: () => {},
});

interface LocaleProviderProps {
  locale: Locale;
  children: React.ReactNode;
  /** If true, setLocale will persist the choice to a cookie (viewer area). */
  allowSwitch?: boolean;
}

export default function LocaleProvider({
  locale: initialLocale,
  children,
  allowSwitch = false,
}: LocaleProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const t: TranslatorFn = useCallback(
    (key: string, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    [locale]
  );

  const setLocale = useCallback(
    (newLocale: Locale) => {
      if (!allowSwitch) return;
      setLocaleState(newLocale);
      // Persist to cookie for server-side reading
      document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`;
    },
    [allowSwitch]
  );

  return (
    <LocaleContext.Provider value={{ locale, t, setLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}
