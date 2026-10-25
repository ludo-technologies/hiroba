/**
 * Tests for the video panel's layout rules (src/videolayout.ts).
 * Run via `npm test` (compiled first by tsc into .test-build/).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_VIDEO, layoutVideos } from "../.test-build/videolayout.js";

const cam = (key) => ({ key, local: false, mode: "camera" });
const screen = (key) => ({ key, local: false, mode: "screen" });
const me = (mode) => ({ key: LOCAL_VIDEO, local: true, mode });
const keys = (vs) => vs.map((v) => v.key);

test("a 1:1 call keeps the peer large and us in the corner", () => {
  const l = layoutVideos([cam("bob"), me("camera")], null);
  assert.equal(l.stage.key, "bob");
  assert.equal(l.pip.key, LOCAL_VIDEO);
  assert.deepEqual(l.tiles, []);
});

test("our own video alone takes the stage", () => {
  const l = layoutVideos([me("camera")], null);
  assert.equal(l.stage.key, LOCAL_VIDEO);
  assert.equal(l.pip, null);
});

test("two or more peers on camera, nobody sharing, is a grid of everyone", () => {
  const l = layoutVideos([cam("bob"), cam("carol"), me("camera")], null);
  assert.equal(l.stage, null);
  assert.equal(l.pip, null);
  assert.deepEqual(keys(l.tiles), ["bob", "carol", LOCAL_VIDEO]);
});

test("a screen share takes the stage and the cameras line up under it", () => {
  const l = layoutVideos([cam("bob"), screen("carol"), cam("dave"), me("camera")], null);
  assert.equal(l.stage.key, "carol");
  assert.deepEqual(keys(l.tiles), ["bob", "dave", LOCAL_VIDEO]);
});

test("a peer's screen beats our own", () => {
  const l = layoutVideos([me("screen"), cam("bob"), screen("carol")], null);
  assert.equal(l.stage.key, "carol");
});

test("our own screen takes the stage over peers' cameras", () => {
  const l = layoutVideos([cam("bob"), cam("carol"), me("screen")], null);
  assert.equal(l.stage.key, LOCAL_VIDEO);
  assert.deepEqual(keys(l.tiles), ["bob", "carol"]);
});

test("the picked video takes the stage; a pick that is gone is ignored", () => {
  const videos = [screen("carol"), cam("bob"), cam("dave")];
  assert.equal(layoutVideos(videos, "bob").stage.key, "bob");
  assert.deepEqual(keys(layoutVideos(videos, "bob").tiles), ["carol", "dave"]);
  assert.equal(layoutVideos(videos, "gone").stage.key, "carol");
});

test("nothing live, nothing shown", () => {
  assert.deepEqual(layoutVideos([], null), { stage: null, pip: null, tiles: [] });
});
