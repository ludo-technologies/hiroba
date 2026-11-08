/**
 * Tests for release-notes parsing (src/release-notes.ts), plus the gate on
 * every file in release-notes/: the release workflow runs this suite before
 * it builds, so a release can't ship notes the update banner can't read.
 * Run via `npm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { notesIn, parseReleaseNotes } from "../.test-build/release-notes.js";

const DIR = new URL("../release-notes/", import.meta.url);

test("every release-notes file is named for a version and parses", () => {
  const files = readdirSync(DIR);
  assert.ok(files.length > 0, "release-notes/ is empty");
  for (const name of files) {
    assert.match(name, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\.md$/, name);
    assert.doesNotThrow(() => parseReleaseNotes(readFileSync(new URL(name, DIR), "utf8")), name);
  }
});

// What the app receives: the release boilerplate, then the notes file.
const BODY = [
  "Desktop installers for Hiroba v9.9.9.",
  "",
  "- a dash in the boilerplate is not a note",
  "",
  "## English",
  "",
  "- One",
  "- Two",
  "",
  "## 日本語",
  "",
  "- いち",
  "- に",
  "",
].join("\n");

test("each language's items are read, skipping the boilerplate before them", () => {
  const notes = parseReleaseNotes(BODY);
  assert.deepEqual(notesIn(notes, "en"), ["One", "Two"]);
  assert.deepEqual(notesIn(notes, "ja"), ["いち", "に"]);
});

test("a language without its own section reads the English one", () => {
  assert.deepEqual(notesIn(parseReleaseNotes(BODY), "fr"), ["One", "Two"]);
});

test("notes the banner couldn't show as written are refused", () => {
  const cases = [
    [BODY.replace("## 日本語", "## Japanese"), /unknown section/],
    [BODY.replace("- Two", "  wrapped onto a second line"), /one-line bullet/],
    [BODY.replace("- Two", "**Two**"), /one-line bullet/],
    [BODY.replace(/## 日本語[\s\S]*/, ""), /日本語/],
    [`${BODY}\n## English\n\n- Again\n`, /twice/],
    [BODY.replace(/- One\n- Two\n/, ""), /English/],
  ];
  for (const [body, why] of cases) assert.throws(() => parseReleaseNotes(body), why);
});
