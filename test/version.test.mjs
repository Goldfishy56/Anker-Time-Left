import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP_VERSION, CHANGELOG } from "../js/changelog.js";

test("changelog is newest first with unique versions", () => {
  const versions = CHANGELOG.map((r) => r.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => b - a));
  assert.equal(new Set(versions).size, versions.length);
});

test("cache-busting ?v= matches the changelog version everywhere", () => {
  for (const f of ["index.html", "js/app.js", "js/ble.js", "js/estimator.js"]) {
    const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    const tags = [...src.matchAll(/\?v=(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(tags.length, `${f} has versioned imports`);
    assert.deepEqual([...new Set(tags)], [APP_VERSION], `${f} uses ?v=${APP_VERSION}`);
  }
});
