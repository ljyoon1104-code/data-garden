import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const sw = readFileSync("dist/sw.js", "utf8"),
  manifest = JSON.parse(readFileSync("dist/manifest.webmanifest", "utf8"));
const cached = JSON.parse(sw.match(/const FILES=(\[[^;]+\]);/)[1]);
const assets = readdirSync("dist/assets");
assert(assets.some((f) => f.startsWith("data.worker-")));
for (const file of assets)
  assert(cached.includes("assets/" + file), `Not precached: ${file}`);
for (const name of [
  "examples/dates.json", "examples/regression.json", "examples/clustering.json", "examples/association.json",
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
])
  assert(cached.includes(name));
for (const base of [
  "https://school.github.io/",
  "https://school.github.io/data/",
  "https://ljyoon1104-code.github.io/data-garden/",
  "https://school.github.io/verification-10/",
]) {
  assert.equal(new URL(manifest.scope, base).href, base);
  assert.equal(new URL(manifest.start_url, base).href, base);
  for (const icon of manifest.icons)
    assert(new URL(icon.src, base).href.startsWith(base));
  for (const src of [
    ...readFileSync("dist/index.html", "utf8").matchAll(
      /(?:src|href)="([^"]+)"/g,
    ),
  ].map((m) => m[1]))
    assert(new URL(src, base).href.startsWith(base), src);
}
console.log(
  `Build verified: ${cached.length} precached files, all workers/assets, root + repository + arbitrary subpaths.`,
);
