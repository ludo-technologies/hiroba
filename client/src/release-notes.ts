/**
 * release-notes.ts — The "What's new" an update offer carries.
 *
 * Each release's notes are written in `client/release-notes/<version>.md`.
 * The release workflow appends that file to the GitHub Release body, which
 * tauri-action also writes into latest.json as `notes`, so the update the
 * app finds (`Update.body`) is the release boilerplate followed by one
 * section per language:
 *
 *     ## English
 *
 *     - Opening an invite link now takes you straight into the new office.
 *
 *     ## 日本語
 *
 *     - 招待リンクを開くと、そのまま新しいオフィスに入るようになりました。
 *
 * A section is a bullet list, one line per item, in plain text: the app shows
 * it as written, with no Markdown rendering. English and Japanese are required;
 * a UI language with no section of its own reads the English one.
 * tests/release-notes.test.mjs parses every file, and the release workflow
 * runs it, so a release can't ship notes the app can't read.
 */

import type { Locale } from "./i18n.js";

/** Heading that opens each language's section. */
const HEADINGS: Record<Locale, string> = {
  en: "English",
  ja: "日本語",
  es: "Español",
  fr: "Français",
};

const REQUIRED: readonly Locale[] = ["en", "ja"];

const LOCALE_BY_HEADING = new Map(
  (Object.keys(HEADINGS) as Locale[]).map((loc) => [HEADINGS[loc], loc]),
);

export type ReleaseNotes = Partial<Record<Locale, string[]>> & { en: string[] };

/**
 * Split a release body into each language's items. Text before the first
 * heading (the release boilerplate) is skipped; an unknown heading, a
 * non-bullet line inside a section, or a missing required language throws.
 */
export function parseReleaseNotes(body: string): ReleaseNotes {
  const sections: Partial<Record<Locale, string[]>> = {};
  let items: string[] | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      const loc = LOCALE_BY_HEADING.get(line.slice(3).trim());
      if (!loc) throw new Error(`release notes: unknown section "${line}"`);
      if (sections[loc]) throw new Error(`release notes: "${line}" appears twice`);
      items = sections[loc] = [];
    } else if (items === null || line === "") {
      continue;
    } else if (line.startsWith("- ")) {
      items.push(line.slice(2).trim());
    } else {
      throw new Error(`release notes: not a one-line bullet: "${line}"`);
    }
  }
  for (const loc of REQUIRED) {
    if (!sections[loc]?.length) throw new Error(`release notes: no "## ${HEADINGS[loc]}" items`);
  }
  return sections as ReleaseNotes;
}

/** The items to show in `locale`: its own section, else the English one. */
export function notesIn(notes: ReleaseNotes, locale: Locale): string[] {
  return notes[locale] ?? notes.en;
}
