/**
 * One language, one dictionary, a toggle between the two.
 *
 * Albedo shipped all French, hardcoded. This is the retrofit: every user facing
 * string is a key in `fr` and `en`, read through `t()` at the point of use, or
 * written into the markup through `data-i18n`, `data-i18n-title` and
 * `data-i18n-aria`, and a toggle flips the whole interface at once.
 *
 * A key that has no English entry falls back to French, so an untranslated
 * corner of the application stays French rather than showing a bare key.
 */

import fr from "./fr.json";
import en from "./en.json";

const D = { fr, en };

let lang = "fr";

/** Set the language, persist it, and repaint every surface. */
export function setLang(l) {
  const next = l === "en" ? "en" : "fr";
  if (next === lang) return;
  lang = next;
  localStorage.setItem("albedo.lang", lang);
  document.documentElement.lang = lang;
  applyStatic();
  window.dispatchEvent(new Event("i18n"));
}

/** The language that is on right now. */
export function currentLang() {
  return lang;
}

/** The string for the current language, French when the key is missing. */
export function t(key) {
  const s = D[lang]?.[key];
  return s !== undefined ? s : (D.fr[key] ?? key);
}

/** Read the saved language, defaulting to the browser's. */
export function initLang() {
  const saved = localStorage.getItem("albedo.lang");
  lang = saved === "en" ? "en" : "fr";
  if (!saved) {
    const auto = (navigator.language || "").toLowerCase().startsWith("fr") ? "fr" : "en";
    lang = auto;
  }
  document.documentElement.lang = lang;
}

/** Re-read every static string in the markup. */
export function applyStatic() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}
