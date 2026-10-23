import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import fr from "../locales/fr.json";

const saved = (() => {
  try {
    return localStorage.getItem("sh-lang");
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  // English unless the user picked another language.
  lng: saved ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
  // Keys are the English text itself (flat keys such as "nav.projects" keep working).
  keySeparator: false,
  nsSeparator: false,
});

/** Translates outside React hooks. The app remounts when the language changes (see App.tsx). */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options) as string;
}

export function setLanguage(lng: "en" | "fr") {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem("sh-lang", lng);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lng;
}

export default i18n;
