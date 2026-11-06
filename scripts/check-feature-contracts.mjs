import { readFile } from "node:fs/promises";
const [app, admin, owner, worker] = await Promise.all([
  readFile("app.js", "utf8"), readFile("admin.js", "utf8"),
  readFile("owner-panel.js", "utf8"), readFile("worker.js", "utf8")
]);
const checks = [
  [app, "window.WensPlayVoicePreview", "parent voice preview"],
  [app, "getAdminVoicePreviewDock", "visible admin audio dock"],
  [app, "playbackStarted", "waits for audio playback"],
  [app, 'fetch("/api/voice/connect"', "browser WebRTC route"],
  [worker, 'path === "/api/voice/connect"', "Worker voice route"],
  [worker, "https://api.openai.com/v1/realtime/calls", "Realtime upstream"],
  [owner, "WensPlayVoicePreview", "admin calls parent voice preview"],
  [worker, "item.result === 437", "agent verifies calculator result"],
  [worker, "auditTools: true", "agent captures calculator output"],
  [worker, "base64DecodedSize", "decoded upload size validation"],
  [worker, 'detail: "high"', "PDF high-detail reading"],
  [worker, "gpt-6-luna", "document model"],
  [worker, 'type: "input_file"', "Responses file input"],
  [admin, "/api/admin/test-agent", "admin agent test route"],
  [worker, "/api/admin/test-agent", "Worker agent test route"],
  [admin, "/api/admin/test-document", "admin file test route"],
  [worker, "/api/admin/test-document", "Worker file test route"],
  [worker, "documentAudit", "file extraction audit"]
];
for (const [source, token, label] of checks) {
  if (!source.includes(token)) throw new Error("Missing feature contract: " + label);
}
for (const mime of [
  'pdf: "application/pdf"',
  'docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"',
  'xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"'
]) {
  if (!admin.includes(mime) || !worker.includes(mime)) throw new Error("MIME mismatch: " + mime);
}
if (!admin.includes("file.size > 8 * 1024 * 1024")) throw new Error("Browser 8 MiB limit missing.");
if (!worker.includes("decodedBytes > 8 * 1024 * 1024")) throw new Error("Server 8 MiB limit missing.");
if (!worker.includes("documentBytesTotal + decodedBytes > 10 * 1024 * 1024")) throw new Error("Server 10 MiB combined limit missing.");
if (!owner.includes("/api/admin/status") || !owner.includes("/api/admin/diagnostics")) throw new Error("Owner panel route mismatch.");
console.log("Wens feature contracts passed: audio playback, calculator result, and PDF/DOCX/XLSX handling.");
