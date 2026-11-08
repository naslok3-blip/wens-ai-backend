import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
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
  [app, 'utterance.lang = preferredVoice?.lang || "ar-EG"', "Egyptian-first device locale with Arabic fallback"],
  [app, "synth.getVoices()", "selects installed device voices"],
  [app, "femaleVoice(egyptianVoices)", "prefers installed Egyptian voices before Arabic fallback"],
  [app, "cleanRepeatedReplyText", "legacy repeated replies cleaned in chat UI"],
  [worker, "cleanRepeatedResponseText(finalText)", "model output deduplicated before save and response"],
  [worker, "hasProjectTarget", "project target terms are normalized before routing"],
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


  [app, "const arabicVoices = voices.filter", "Arabic voice fallback when an Egyptian device voice is unavailable"],
  [app, "utterance.voice = preferredVoice", "device speech uses an available voice when present"],
  [app, "صوت عربي متاح على الهاتف", "speech UI identifies the Arabic fallback honestly"],

  [worker, "function isLiveDataRequest(message)", "changing information is routed through mandatory live verification"],
  [worker, 'executeAgentTool("search_web", { query: searchQuery }, env, user)', "live verification searches before model response"],
  [worker, "hasVerifiableLiveSources(liveSearch, goldPriceRequest ? 2 : 1)", "gold prices require multiple timestamped sources"],
  [worker, "STRICT LIVE-DATA VERIFICATION RULE:", "live source-grounding instructions block invented current values"],
  [worker, "function isProjectCreationIntent(message)", "explicit project-creation intent detector"],
  [worker, "const projectCreationIntent = isProjectCreationIntent(message);", "project-creation intent routes to project builder"],
  [worker, "autoSpeak: true", "Worker enables automatic voice replies by default"],
  [app, "autoSpeak: true", "chat enables automatic voice replies by default"],
  [admin, "autoSpeak: true", "owner settings enable automatic voice replies by default"],
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

const intentStart = worker.indexOf("function isProjectCreationIntent(message) {");
const intentEnd = worker.indexOf("\nasync function handleAgent", intentStart);
if (intentStart < 0 || intentEnd < 0) throw new Error("Project intent detector could not be isolated for tests.");
const isProjectCreationIntent = runInNewContext(worker.slice(intentStart, intentEnd) + "\nisProjectCreationIntent");
const projectIntentCases = [
  ["إنشاء تطبيقات", true],
  ["إنشاء تطبيق بسيط لإدارة المخزن", true],
  ["عاوز إنشاء تطبيق", true],
  ["عايزك تعملي تطبيق موبايل", true],
  ["ممكن تعملي برنامج حسابات", true],
  ["ابنيلي لعبة بسيطة", true],
  ["create a web app", true],
  ["ازاي اتعلم إنشاء تطبيقات؟", false],
  ["اشرح خطوات إنشاء تطبيق", false],
  ["مش عاوز إنشاء تطبيق", false],
  ["عايز أتكلم معاك", false]
];
for (const [message, expected] of projectIntentCases) {
  const actual = isProjectCreationIntent(message);
  if (actual !== expected) throw new Error("Project intent mismatch for: " + message + " (expected " + expected + ", got " + actual + ")");
}
console.log("Wens app/game intent tests passed for Arabic creation phrases and non-creation questions.");


const liveStart = worker.indexOf("function normalizeLiveDataText(value) {");
const liveEnd = worker.indexOf("\nasync function handleAgent", liveStart);
if (liveStart < 0 || liveEnd < 0) throw new Error("Live-data detector could not be isolated for tests.");
const liveHelpers = runInNewContext(worker.slice(liveStart, liveEnd) + "\n({ isLiveDataRequest, isEgyptGoldPriceRequest, hasVerifiableLiveSources })", { URL });
const liveIntentCases = [
  ["سعر الذهب اليوم في مصر", true],
  ["سعر الذهب", true],
  ["كام الدولار دلوقتي", true],
  ["الطقس في القاهرة الآن", true],
  ["سعر اليورو", true],
  ["اشرح لي ما هو الذهب", false],
  ["what is gold", false],
  ["علمني حساب النسبة المئوية", false]
];
for (const [message, expected] of liveIntentCases) {
  const actual = liveHelpers.isLiveDataRequest(message);
  if (actual !== expected) throw new Error("Live-data intent mismatch for: " + message + " (expected " + expected + ", got " + actual + ")");
}
if (!liveHelpers.isEgyptGoldPriceRequest("سعر الذهب عيار 21 اليوم")) throw new Error("Egypt gold-price query detection failed.");
const goodGoldResults = {
  results: "آخر تحديث اليوم 03:45 ص: عيار 21 6205 جنيه https://shashetelsagha.com/\nآخر تحديث اليوم 02:53 ص: عيار 21 6205 جنيه https://officialtibr.com/gold/egypt/21/"
};
const oneGoldSource = { results: "آخر تحديث اليوم 03:45 ص: عيار 21 6205 جنيه https://shashetelsagha.com/" };
const redirectedGoldSources = {
  results: "آخر تحديث اليوم 03:45 ص: عيار 21 6205 جنيه https://duckduckgo.com/l/?uddg=https%3A%2F%2Fshashetelsagha.com%2Fgold\nآخر تحديث اليوم 02:53 ص: عيار 21 6205 جنيه https://duckduckgo.com/l/?uddg=https%3A%2F%2Fofficialtibr.com%2Fgold%2Fegypt"
};

const staleResults = { results: "عيار 21 سعره 6205 جنيه https://example.com/" };
if (!liveHelpers.hasVerifiableLiveSources(goodGoldResults, 2)) throw new Error("Two timestamped sources should pass live-price verification.");
if (!liveHelpers.hasVerifiableLiveSources(redirectedGoldSources, 2)) throw new Error("DuckDuckGo redirect links should resolve to independent source domains.");
if (liveHelpers.hasVerifiableLiveSources(oneGoldSource, 2)) throw new Error("Gold price must fail with only one source.");
if (liveHelpers.hasVerifiableLiveSources(staleResults, 1)) throw new Error("Results without a freshness marker must fail.");
console.log("Wens live-data verification tests passed for gold, exchange rates, weather, and stale/missing sources.");

console.log("Wens feature contracts passed: document reading, agent routing, project editing and rollback, reply deduplication, Egyptian voice handling and admin features.");
