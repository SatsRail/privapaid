"use client";

import { useLocale } from "@/i18n/useLocale";

export default function Footer() {
  const { t } = useLocale();
  return (
    <footer
      style={{
        borderTop: "1px solid var(--theme-border)",
        padding: "16px 24px",
        textAlign: "center",
        fontSize: "12px",
        color: "var(--theme-text-secondary)",
      }}
    >
      <span>
        {t("viewer.footer.credit")}{" "}
        <a
          href="https://www.privapaid.com/"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--theme-text)", textDecoration: "underline" }}
        >
          PrivaPaid
        </a>{" "}
        <span className="mt-1 block sm:ml-2 sm:mt-0 sm:inline">{t("viewer.footer.description")}</span>
      </span>
    </footer>
  );
}
