/**
 * Tests for i18n locale resolution and setLocale (src/i18n.ts).
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { locale, setLocale, t } from "../.test-build/i18n.js";

// Node has no real browser localStorage by default; polyfill a tiny one so
// setLocale can persist and re-read across the module's already-loaded state.
function withLocalStorage(map, fn) {
  const storage = {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = String(v);
    },
    removeItem: (k) => {
      delete map[k];
    },
  };
  const prev = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else {
      Object.defineProperty(globalThis, "localStorage", {
        value: prev,
        configurable: true,
        writable: true,
      });
    }
  }
}

test("setLocale switches the live catalog and is a no-op for the same locale", () => {
  withLocalStorage({}, () => {
    const start = locale;
    const other = start === "ja" ? "en" : "ja";

    assert.equal(setLocale(start), false);

    assert.equal(setLocale(other), true);
    assert.equal(locale, other);
    assert.equal(t.enter, other === "ja" ? "オフィスに入る" : "Enter Hiroba");
    assert.equal(t.fieldLanguage, other === "ja" ? "言語" : "Language");

    // Restore so later tests in the same process see a stable locale.
    setLocale(start);
  });
});

test("setLocale persists the choice under hiroba_locale", () => {
  withLocalStorage({}, () => {
    const start = locale;
    const other = start === "ja" ? "en" : "ja";
    setLocale(other);
    assert.equal(globalThis.localStorage.getItem("hiroba_locale"), other);
    setLocale(start);
  });
});

test("setLocale reaches Spanish and French and rejects unknown locales", () => {
  withLocalStorage({}, () => {
    const start = locale;
    setLocale("es");
    assert.equal(t.fieldLanguage, "Idioma");
    assert.equal(setLocale("fr"), true);
    assert.equal(t.fieldLanguage, "Langue");
    assert.equal(setLocale("de"), false);
    assert.equal(locale, "fr");
    setLocale(start);
  });
});

test("a fresh boot picks the locale from navigator.language's primary subtag", async () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    for (const [language, expected] of [
      ["es-419", "es"],
      ["fr-CA", "fr"],
      ["ja-JP", "ja"],
      ["de-DE", "en"],
    ]) {
      Object.defineProperty(globalThis, "navigator", {
        value: { language },
        configurable: true,
      });
      // A query string forces a new module instance, i.e. a fresh boot.
      const mod = await import(`../.test-build/i18n.js?lang=${language}`);
      assert.equal(mod.locale, expected, language);
    }
  } finally {
    Object.defineProperty(globalThis, "navigator", prev);
  }
});
