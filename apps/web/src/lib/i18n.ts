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
  lng: saved ?? (navigator.language?.startsWith("fr") ? "fr" : "en"),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

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
