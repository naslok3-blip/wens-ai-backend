import { readFile } from "node:fs/promises";
const [app, admin, owner, worker, index] = await Promise.all([
  readFile("app.js", "utf8"), readFile("admin.js", "utf8"),
  readFile("owner-panel.js", "utf8"), readFile("worker.js", "utf8"),
  readFile("index.html", "utf8")
]);
const checks = [
  [app, "window.WensPlayVoicePreview", "parent voice preview"],
  [app, "getAdminVoicePreviewDock", "visible admin audio dock"],
  [app, "playbackStarted", "waits for audio playback"],
  [app, "SpeechSynthesisUtterance", "on-device speech fallback"],
  [app, 'utterance.lang = "ar-EG"', "Egyptian Arabic speech locale"],
  [app, "synth.getVoices()", "selects an installed Arabic device voice"],
  [app, "brandAdminEntry", "hidden owner entry preserved in header logo"],
  [app, 'fetch("/api/voice/connect"', "browser WebRTC route"],
  [worker, 'path === "/api/voice/connect"', "Worker voice route"],
  [worker, "https://api.openai.com/v1/realtime/calls", "Realtime upstream"],
  [owner, "WensPlayVoicePreview", "admin calls parent voice preview"],
  [worker, "item.result === 437", "agent verifies calculator result"],
  [worker, '.replace(/\\s+/g, "") === "19*23"', "calculator expression whitespace normalization"],
  [worker, "user_login_events", "persistent successful login history"],
  [worker, 'path === "/api/admin/users"', "owner-only searchable account listing"],
  [admin, "registeredUsersList", "owner account registry UI"],
  [worker, "auditTools: true", "agent captures calculator output"],
  [worker, "base64DecodedSize", "decoded upload size validation"],
  [worker, 'detail: "high"', "PDF high-detail reading"],
  [worker, "gpt-6-luna", "document model"],
  [worker, 'type: "input_file"', "Responses file input"],
  [admin, "/api/admin/test-agent", "admin agent test route"],
  [worker, "/api/admin/test-agent", "Worker agent test route"],
  [admin, "/api/admin/test-document", "admin file test route"],
  [worker, "/api/admin/test-document", "Worker file test route"],
  [worker, "documentAudit", "file extraction audit"],
  [worker, "documentExtractionText", "explicit extracted-document context"],
  [worker, "documentRefusalPattern", "fallback when the model falsely denies uploaded files"],
  [worker, "تم استلام المستندات المرفقة وقراءة محتواها بالفعل", "document context instruction"]
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
if (index.includes('<section class="hero">')) throw new Error("Removed top hero/profile area is still present.");
if (!index.includes('id="voiceBtn" class="voice-input-btn"')) throw new Error("Voice input control must live in the chat composer.");
if (!index.includes('id="voiceStatus"')) throw new Error("Accessible voice status is missing.");
if (app.includes("voiceTestBtn") || app.includes("heroPortrait")) throw new Error("Removed hero controls are still referenced by app.js.");
if (!admin.includes("metricAccountsEntered") || !admin.includes("metricSuccessfulLogins")) throw new Error("Login-history metrics missing from owner panel.");
console.log("Wens feature contracts passed: document reading, calculator validation, login history, account listing, voice fallback and white chat layout.");
