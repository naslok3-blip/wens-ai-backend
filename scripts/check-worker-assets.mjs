import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const read = path => readFile(resolve(process.cwd(), path), "utf8");

const worker = await read("worker.js");

function parseEmbeddedMap(mapName, format) {
  const startMarker = `const ${mapName} = new Map([`;
  const start = worker.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing ${mapName} in worker.js`);

  const endMarker = mapName === "WENS_HOTFIX_ASSETS" ? "\n\nexport default" : "\n]);";
  const end = worker.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Could not find end of ${mapName}`);

  const block = worker.slice(start, end);
  const expression = format === "json"
    ? /\[\s*("(?:\\.|[^"\\])*")\s*,\s*\{\s*"body"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"type"\s*:\s*("(?:\\.|[^"\\])*")\s*\}\s*\]/gs
    : /\[\s*("(?:\\.|[^"\\])*")\s*,\s*\{\s*body\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*type\s*:\s*("(?:\\.|[^"\\])*")\s*\}\s*\]/gs;

  const entries = new Map();
  for (const match of block.matchAll(expression)) {
    entries.set(JSON.parse(match[1]), JSON.parse(match[2]));
  }
  return entries;
}

const hotfix = parseEmbeddedMap("WENS_HOTFIX_ASSETS", "json");
const inline = parseEmbeddedMap("INLINE_ASSETS", "js");

const checks = [
  ["/", "public/index.html"],
  ["/index.html", "public/index.html"],
  ["/app.js", "public/app.js"],
  ["/style.css", "public/style.css"],
  ["/admin.html", "public/admin.html"],
  ["/admin.js", "public/admin.js"],
  ["/admin.css", "public/admin.css"],
  ["/owner-panel", "public/admin.html"],
  ["/owner-panel/", "public/admin.html"],
  ["/owner-panel.js", "public/owner-panel.js"],
  ["/owner-panel.css", "public/owner-panel.css"],
];

const errors = [];
const hotfixRoutes = new Set(["/", "/index.html", "/app.js", "/style.css", "/owner-panel.js", "/owner-panel.css"]);
for (const [route, file] of checks) {
  const expected = await read(file);
  for (const [mapName, entries, required] of [
    ["WENS_HOTFIX_ASSETS", hotfix, hotfixRoutes.has(route)],
    ["INLINE_ASSETS", inline, true],
  ]) {
    if (!required) continue;
    const actual = entries.get(route);
    if (actual === undefined) {
      errors.push(`${mapName} is missing ${route}`);
    } else if (actual !== expected) {
      errors.push(`${mapName} ${route} differs from ${file} (${actual.length} vs ${expected.length} characters)`);
    }
  }
}

const mirrors = [
  ["index.html", "public/index.html"],
  ["app.js", "public/app.js"],
  ["admin.html", "public/admin.html"],
  ["admin.js", "public/admin.js"],
  ["admin.css", "public/admin.css"],
  ["owner-panel.js", "public/owner-panel.js"],
];
for (const [source, published] of mirrors) {
  if ((await read(source)) !== (await read(published))) {
    errors.push(`${source} differs from ${published}`);
  }
}

if (errors.length) {
  console.error("Wens embedded/published asset verification FAILED:");
  for (const error of errors) console.error(` - ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Wens asset verification passed: ${checks.length} routes match both Worker maps, and ${mirrors.length} source/public mirrors match.`);
}
