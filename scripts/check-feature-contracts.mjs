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
  [app, 'utterance.lang = preferredVoice.lang || "ar-EG"', "selected Egyptian Arabic voice locale"],
  [app, "synth.getVoices()", "selects installed device voices"],
  [app, "egyptianVoices.length", "does not fall back to generic MSA voices"],
  [app, "cleanRepeatedReplyText", "legacy repeated replies cleaned in chat UI"],
  [worker, "cleanRepeatedResponseText(finalText)", "model output deduplicated before save and response"],
  [worker, "projectTargetMentioned", "polite app and game requests routed to project generation"],
  [worker, "const maxTurns = deepThink ? 6 : 4", "reduced default agent round trips"],
  [worker, 'voiceEngine: "device"', "free device voice is the default"],
  [admin, 'voiceEngine: "device"', "admin defaults to free device voice"],
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
  [worker, "create_web_project", "AI web app and game creation tool"],
  [worker, '"@cf/zai-org/glm-4.7-flash"', "fast dedicated project-generation model"],
  [worker, "projectCreationIntent", "deterministic app and game generation dispatch"],
  [worker, "quota_or_billing", "project generation quota diagnostics"],
  [worker, "inference_timeout", "project inference timeout diagnostics"],

  [worker, "generated_projects", "per-user saved generated projects"],
  [worker, "generatedProjectRoute(request", "authenticated project preview and download route"],
  [worker, "Content-Security-Policy", "sandboxed project preview security policy"],
  [worker, "generatedProjects", "project result returned to chat"],
  [worker, "generated_project_revisions", "saved project version history"],
  [worker, "async function listWebProjects", "list saved user projects"],
  [worker, "async function editWebProject", "edit existing saved user projects"],
  [worker, "async function listWebProjectRevisions", "list saved project revisions"],
  [worker, "async function restoreWebProjectRevision", "restore saved project revisions"],
  [worker, 'fn("list_web_projects"', "agent can list saved projects"],
  [worker, 'fn("edit_web_project"', "agent can edit saved projects"],
  [worker, 'fn("list_web_project_revisions"', "agent can list project versions"],
  [worker, 'fn("restore_web_project_revision"', "agent can restore project versions"],
  [worker, 'if (name === "edit_web_project")', "edit tool dispatch is connected"],
  [worker, 'if (name === "restore_web_project_revision")', "restore tool dispatch is connected"],
  [worker, 'name === "edit_web_project"', "project edit tool is allowlisted"],
  [worker, '["create_web_project","edit_web_project","restore_web_project_revision"].includes(name)', "edited and restored projects return in chat"],
  [worker, "idx_project_revisions_owner_time", "revision queries are indexed by project and owner"],
  [worker, "ORDER BY created_at DESC LIMIT 10", "project revisions are retained up to ten versions"],
  [app, "generated-project-preview", "in-chat interactive project preview"],
  [app, 'setAttribute("sandbox","allow-scripts")', "isolated generated project iframe"],
  [index, "إنشاء تطبيق أو لعبة", "chat tool shortcut for apps and games"],

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
console.log("Wens feature contracts passed: document reading, agent routing, project editing and rollback, reply deduplication, Egyptian voice handling and admin features.");
