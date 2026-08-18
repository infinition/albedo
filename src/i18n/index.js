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

/**
 * Fold another module's dictionary into these ones.
 *
 * A mode that arrives as a lazy chunk brings its own strings with it. Leaving
 * them in the two startup dictionaries measurably broke the rule this whole
 * application is built around: `fr.json` and `en.json` are imported at startup,
 * so the retopology prose, hint paragraphs and all, was parsed by every process
 * that opened the window, including every Explorer thumbnail job. Sixteen
 * kilobytes of it, for a mode most of those processes never reach.
 *
 * The keys travel with the code that says them instead, and land here the
 * moment that code is loaded.
 */
export function register(tables) {
  for (const [l, table] of Object.entries(tables)) {
    if (D[l]) Object.assign(D[l], table);
  }
}

/**
 * The BCP 47 tag for the language that is on, for `Intl` and `toLocaleString`.
 *
 * Four modules had grown their own `toLocaleString("fr-FR")`, which meant a
 * triangle count kept French grouping — thin spaces — under an English
 * interface, and the toggle that flips every string on screen left the numbers
 * behind. The locale is a property of the language, so it is answered here.
 */
export function locale() {
  return lang === "fr" ? "fr-FR" : "en-GB";
}

/** A number, grouped the way the current language groups them. */
export function num(v) {
  return Number(v ?? 0).toLocaleString(locale());
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

/**
 * Re-read every static string under one root.
 *
 * A root rather than the document, because not every surface is in the
 * document. A mode that arrives as a lazy chunk builds its markup long after
 * startup, and the groups it lends the shared bar sit in a detached div while
 * the mode is closed: `document.querySelectorAll` cannot see either, so both
 * would keep the language they were written in whatever the toggle says.
 */
export function applyStaticIn(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

/** Re-read every static string in the markup. */
export function applyStatic() {
  applyStaticIn(document);
}
