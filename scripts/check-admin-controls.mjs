import { readFile } from "node:fs/promises";

const html = await readFile("admin.html", "utf8");
const js = await readFile("admin.js", "utf8");
const worker = await readFile("worker.js", "utf8");

const ids = [...html.matchAll(/\\bid="([^"]+)"/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) {
  throw new Error("Duplicate admin element IDs: " + [...new Set(duplicates)].join(", "));
}

const available = new Set(ids);
const referenced = [...js.matchAll(/\\$\\("([^"]+)"\\)/g)].map(match => match[1]);
const missing = [...new Set(referenced)].filter(id => !available.has(id));
if (missing.length) {
  throw new Error("Admin JavaScript references missing HTML IDs: " + missing.join(", "));
}

const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
for (const tab of tabs) {
  if (!available.has("tab-" + tab)) throw new Error("Missing admin tab container: tab-" + tab);
}

for (const route of ["/api/admin/diagnostics", "/api/admin/test-agent", "/api/admin/test-document"]) {
  if (!js.includes(route) || !worker.includes(route)) {
    throw new Error("Control center route is missing from admin JS or Worker: " + route);
  }
}

for (const id of [
  "metricUsers", "metricSessions", "metricMessages", "metricTasks", "metricTools",
  "testAgentBtn", "documentTestFile", "documentTestConsent", "testDocumentBtn", "voiceConfirmBtn"
]) {
  if (!available.has(id)) throw new Error("Required control-center element is missing: " + id);
}

console.log(
  "Wens control-center validation passed: " +
  tabs.length + " tabs, " + ids.length + " unique HTML IDs, " +
  new Set(referenced).size + " JS references, and 3 owner-only test routes."
);
