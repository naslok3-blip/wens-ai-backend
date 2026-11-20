import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function extractFunction(name, nextName) {
  const start = worker.indexOf(`function ${name}(`);
  const candidates = [
    worker.indexOf(`function ${nextName}(`, start),
    worker.indexOf(`async function ${nextName}(`, start)
  ].filter(position => position >= 0);
  const end = candidates.length ? Math.min(...candidates) : -1;
  assert.ok(start >= 0 && end > start, `Could not locate ${name} in worker.js`);
  return worker.slice(start, end);
}

const helpers = [
  extractFunction("normalizeLiveDataText", "isEgyptGoldPriceRequest"),
  extractFunction("buildConversationTitle", "ensureChatSchema"),
  extractFunction("isEgyptGoldPriceRequest", "isLiveDataRequest"),
  extractFunction("isLiveDataRequest", "isEgyptNationalTeamRequest"),
  extractFunction("isEgyptNationalTeamRequest", "isSportsScheduleRequest"),
  extractFunction("isSportsScheduleRequest", "hasVerifiableLiveSources"),
  extractFunction("hasVerifiableLiveSources", "hasVerifiableSportsScheduleSources"),
  extractFunction("isExplicitExternalSearchRequest", "isExternalResearchIntent"),
  extractFunction("isExternalResearchIntent", "extractExternalSources"),
  extractFunction("buildExternalSearchQuery", "extractExternalSources"),
  extractFunction("extractExternalSources", "handleAgent"),
  extractFunction("getCurrentEgyptFootballSeason", "hasVerifiableSportsScheduleSources"),
  extractFunction("hasUpcomingFootballDate", "hasRecentFootballSchedulePublication"),
  extractFunction("hasRecentFootballSchedulePublication", "hasVerifiableSportsScheduleSources"),
  extractFunction("hasVerifiableSportsScheduleSources", "hasVerifiableGoldPriceSources"),
  extractFunction("hasVerifiableGoldPriceSources", "isExplicitExternalSearchRequest")
].join("\n");

const sandbox = { URL, atob, Date, module: { exports: {} } };
vm.runInNewContext(
  helpers + "\nmodule.exports = { isExternalResearchIntent, isLiveDataRequest, isEgyptNationalTeamRequest, isSportsScheduleRequest, getCurrentEgyptFootballSeason, hasUpcomingFootballDate, hasRecentFootballSchedulePublication, hasVerifiableSportsScheduleSources, hasVerifiableGoldPriceSources, extractExternalSources, buildExternalSearchQuery, buildConversationTitle };",
  sandbox
);
const { isExternalResearchIntent, isLiveDataRequest, isEgyptNationalTeamRequest, isSportsScheduleRequest, getCurrentEgyptFootballSeason, hasUpcomingFootballDate, hasRecentFootballSchedulePublication, hasVerifiableSportsScheduleSources, hasVerifiableGoldPriceSources, extractExternalSources, buildExternalSearchQuery, buildConversationTitle } = sandbox.module.exports;

test("does not search for greetings", () => {
  assert.equal(isExternalResearchIntent("ازيك يا ونس"), false);
  assert.equal(isExternalResearchIntent("شكرا يا ونس"), false);
});

test("searches for direct factual questions", () => {
  assert.equal(isExternalResearchIntent("ايه عاصمة اليابان؟"), true);
  assert.equal(isExternalResearchIntent("ممكن تقولي تاريخ حرب أكتوبر"), true);
});

test("searches for natural Egyptian research requests", () => {
  assert.equal(isExternalResearchIntent("عايز اعرف أحدث الموبايلات في مصر"), true);
  assert.equal(isExternalResearchIntent("آخر أخبار الذكاء الاصطناعي"), true);
  assert.equal(isExternalResearchIntent("الفرق بين iPhone وSamsung"), true);
});

test("searches for current prices and explicitly requested web research", () => {
  assert.equal(isExternalResearchIntent("سعر الذهب اليوم في مصر"), true);
  assert.equal(isExternalResearchIntent("ابحث عن أفضل مصادر تعلم البرمجة"), true);
});

test("does not misclassify create, edit, or update requests as research", () => {
  assert.equal(isExternalResearchIntent("اعمللي تطبيق لإدارة المحل"), false);
  assert.equal(isExternalResearchIntent("عدل الصورة وخلي الخلفية بيضاء"), false);
  assert.equal(isExternalResearchIntent("ممكن تحدثي الموقع"), false);
});

test("Egypt gold verification rejects one source and non-EGP prices", () => {
  assert.equal(
    hasVerifiableGoldPriceSources({ results: "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم" }),
    false
  );
  assert.equal(
    hasVerifiableGoldPriceSources({ results:
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 USD اليوم\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 USD اليوم"
    }),
    false
  );
});

test("Egypt gold verification accepts two independent, current EGP sources", () => {
  assert.equal(
    hasVerifiableGoldPriceSources({ results:
      "[سعر الذهب](https://one.example/gold) عيار 21: 2,200 جنيه اليوم آخر تحديث 10:30\n" +
      "[سعر الذهب](https://two.example/gold) عيار 21: 2,210 EGP اليوم آخر تحديث 10:35"
    }),
    true
  );
});

test("recognizes the exact explicit search request from chat", () => {
  assert.equal(
    isExternalResearchIntent("ايه عاصمة اليابان؟ ابحث في المواقع الخارجية واعرض المصادر داخل الشات."),
    true
  );
});

test("extracts original links from DuckDuckGo and Google redirects", () => {
  const sources = extractExternalSources({
    results:
      "[Example](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle)\n" +
      "[Reference](https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fguide)"
  });
  assert.equal(
    sources.map(item => item.url).join("|"),
    "https://example.com/article|https://example.org/guide"
  );
});

test("extracts source links from HTML and structured search responses", () => {
  const htmlSources = extractExternalSources({
    results: '<a href="https://example.net/page">Example Net</a>'
  });
  assert.equal(htmlSources[0]?.domain, "example.net");
  const structured = extractExternalSources({
    sources: [{ title: "Example Source", url: "https://example.edu/reference" }]
  });
  assert.equal(structured[0]?.url, "https://example.edu/reference");
});

test("removes search-interface instructions before querying engines", () => {
  assert.equal(
    buildExternalSearchQuery("ايه عاصمة اليابان؟ ابحث في المواقع الخارجية واعرض المصادر داخل الشات."),
    "ايه عاصمة اليابان"
  );
  assert.equal(
    buildExternalSearchQuery("ابحث عن أفضل مصادر تعلم البرمجة"),
    "أفضل مصادر تعلم البرمجة"
  );
});

test("recognizes Egyptian football fixture and league schedule requests", () => {
  assert.equal(isSportsScheduleRequest("مواعيد مباريات الأهلي في الدوري المصري الممتاز"), true);
  assert.equal(isSportsScheduleRequest("جدول مباريات الدوري المصري"), true);
  assert.equal(isSportsScheduleRequest("ما هي كرة القدم؟"), false);
});

test("recognizes natural Egyptian national-team fixture wording and misspellings", () => {
  for (const message of [
    "ابحث عن موعد منتخب مصر",
    "ميعاد منتخب مصر الجاي",
    "متى ماتش منتخب مصر القادم",
    "موعد مبارة منتخب مصر القادمة",
    "موعد مبارة الاهلي الجاية"
  ]) {
    assert.equal(isSportsScheduleRequest(message), true, message);
    assert.equal(isExternalResearchIntent(message), true, message);
  }
  assert.equal(isEgyptNationalTeamRequest("ابحث عن موعد منتخب مصر"), true);
  assert.equal(isEgyptNationalTeamRequest("ميعاد منتخب مصر الجاي"), true);
});

test("Egyptian Arabic normalization recognises taa marbuta and diacritic variants", () => {
  assert.equal(isSportsScheduleRequest("موعد مباراة منتخب مصر القادمة"), true);
  assert.equal(isSportsScheduleRequest("موعد مباراه منتخب مصر القادمه"), true);
  assert.equal(isExternalResearchIntent("مواعيد ماتشات الاهلى الجاية"), true);
});

test("builds a bilingual corrected query for Egypt national-team fixtures", () => {
  const query = buildExternalSearchQuery("ابحث عن موعد منتخيب مصر الجاي");
  assert.match(query, /منتخب مصر/);
  assert.match(query, /Egypt national football team upcoming fixtures/);
});

test("upcoming fixture date parser rejects past dates and accepts future CAF dates", () => {
  const now = new Date("2026-11-11T10:00:00+02:00");
  assert.equal(hasUpcomingFootballDate("Egypt v Malawi (23/11, 19h00)", now), true);
  assert.equal(hasUpcomingFootballDate("Egypt v Malawi (17 Nov 2026)", now), true);
  assert.equal(hasUpcomingFootballDate("Egypt v Malawi (13/10/2026)", now), false);
});

test("Egypt national-team fixtures require two recent independent sources with future dates", () => {
  const result = {
    results:
      "جدول منتخب مصر — CAF\\nPublished: 2026-11-10\\nEgypt v Malawi (23/11, 19h00) — AFCON qualification\\nالرابط: https://caf.example/fixtures\\n\\n" +
      "جدول منتخب مصر — EFA\\nتاريخ النشر: 2026-11-10\\nEgypt v Malawi (23 Nov 2026, 21:00 Cairo) — AFCON qualification\\nالرابط: https://efa.example/fixtures"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
  const oneSource = { results: result.results.split("\\n\\n")[0] };
  assert.equal(hasVerifiableSportsScheduleSources(oneSource), false);
  const stale = {
    results:
      "جدول منتخب مصر — CAF\\nPublished: 2024-11-10\\nEgypt v Malawi (23/11/2024) — AFCON qualification\\nالرابط: https://caf.example/fixtures\\n\\n" +
      "جدول منتخب مصر — EFA\\nتاريخ النشر: 2024-11-10\\nEgypt v Malawi (23 Nov 2024) — AFCON qualification\\nالرابط: https://efa.example/fixtures"
  };
  assert.equal(hasVerifiableSportsScheduleSources(stale), false);
});

test("routes singular upcoming match-date phrases through external live search", () => {
  for (const message of [
    "مواعيد مباراة الاهلي القادمة",
    "ميعاد مباراة الاهلي القادمة",
    "ميعاد مباراة الأهلي القادمة",
    "موعد مباراة الأهلي الجاية",
    "مباراة الأهلي القادمة",
    "ميعاد مباريات الأهلي القادم"
  ]) {
    assert.equal(isSportsScheduleRequest(message), true, message);
    assert.equal(isLiveDataRequest(message), true, message);
    assert.equal(isExternalResearchIntent(message), true, message);
  }
});

test("rejects old-season league schedules even when they contain dates and links", () => {
  const result = {
    results:
      "[مواعيد الأهلي 2024-25](https://one.example/fixtures) جدول مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\n" +
      "[جدول الدوري 2024-25](https://two.example/league) مباريات الدوري المصري 2024-25 اليوم منشور"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("requires two independent fresh sources mentioning the current season for sports fixtures", () => {
  const year = new Date().getUTCFullYear();
  const next = year + 1;
  const season = year + "-" + next;
  const result = {
    results:
      "[جدول الدوري المصري " + season + "](https://one.example/fixtures) مواعيد مباريات الأهلي موسم " + season + " يوم 13 Nov " + next + " اليوم آخر تحديث 10:30\n\n" +
      "[مباريات الأهلي " + season + "](https://two.example/alahly) جدول الدوري موسم " + season + " يوم 13 Nov " + next + " منشور اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});

test("rejects a one-source current-season fixture even if the page is fresh", () => {
  const year = new Date().getUTCFullYear();
  const result = {
    results:
      "[جدول الدوري " + year + "](https://one.example/fixtures) مباريات الأهلي 13 Nov " + year + " Updated " + year + "-11-10"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});


test("rejects an old-season schedule even when an unrelated current year appears in the result", () => {
  const result = {
    results:
      "[جدول 2024-25](https://one.example/fixtures) مواعيد مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\n" +
      "[خبر موسم 2026](https://two.example/news) خبر منشور في 2026 اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("rejects old fixtures when a separate article merely mentions the current season", () => {
  const season = getCurrentEgyptFootballSeason();
  const result = {
    results:
      "[جدول الأهلي 2024-25](https://one.example/fixtures) مواعيد مباريات الأهلي موسم 2024-25 اليوم آخر تحديث 10:30\nالرابط: https://one.example/fixtures\n\n" +
      "خبر عام عن موسم " + season.short + " فقط، بلا تفاصيل\nالرابط: https://two.example/news"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("current-season validator accepts the short season notation only with schedule evidence", () => {
  const season = getCurrentEgyptFootballSeason();
  const result = {
    results:
      "[جدول الدوري " + season.short + "](https://one.example/fixtures) مواعيد مباريات الأهلي موسم " + season.short + " يوم 13 Nov " + season.endYear + " اليوم آخر تحديث 10:30\n\n" +
      "[مباريات الأهلي " + season.short + "](https://two.example/alahly) جدول الدوري موسم " + season.short + " يوم 13 Nov " + season.endYear + " منشور اليوم"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});


test("accepts Al Ahly club fixtures without requiring an Egypt national-team fixture or season label", () => {
  const result = {
    results:
      "[Al Ahly fixtures](https://one.example/alahly) جدول مباريات الأهلي القادمة: 23 Nov 2026 الساعة 19:00. آخر تحديث: 2026-11-18 10:30\n\n" +
      "[Al Ahly schedule](https://two.example/club) مواعيد مباراة الأهلي القادمة: 25 Nov 2026 الساعة 21:00. Published: 2026-11-18"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});

test("keeps the two-independent-sources requirement for club fixtures", () => {
  const result = {
    results:
      "[Al Ahly fixtures](https://one.example/alahly) جدول مباريات الأهلي القادمة: 23 Nov 2026 الساعة 19:00. آخر تحديث: 2026-11-18 10:30"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});

test("rejects stale club fixtures even when the source mentions a current publication date", () => {
  const result = {
    results:
      "[Al Ahly fixtures](https://one.example/alahly) جدول مباريات الأهلي: 23 Nov 2024 الساعة 19:00. آخر تحديث: 2026-11-18 10:30\n\n" +
      "[Al Ahly schedule](https://two.example/club) مواعيد مباراة الأهلي: 25 Nov 2024 الساعة 21:00. Published: 2026-11-18"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});


test("football schedule publication freshness checks the actual publication date", () => {
  const now = new Date("2026-11-19T10:00:00+02:00");
  assert.equal(hasRecentFootballSchedulePublication("Updated: 2026-11-18", now), true);
  assert.equal(hasRecentFootballSchedulePublication("Published: 2026-08-01", now), false);
  assert.equal(hasRecentFootballSchedulePublication("Updated: 2026-10-01", now), false);
  assert.equal(hasRecentFootballSchedulePublication("Last updated: 18/11/2026", now), true);
  assert.equal(hasRecentFootballSchedulePublication("تاريخ النشر: 19 نوفمبر 2026", now), true);
  assert.equal(hasRecentFootballSchedulePublication("آخر تحديث: yesterday", now), true);
});

test("accepts Al Ahly 2027 fixtures without a current-season or national-team allowlist", () => {
  const result = {
    results:
      "[Al Ahly fixtures](https://one.example/alahly) جدول مباريات الأهلي القادمة: 23 Nov 2027 الساعة 19:00. آخر تحديث: 2026-11-18\n\n" +
      "[Al Ahly schedule](https://two.example/club) مواعيد مباراة الأهلي القادمة: 25 Nov 2027 الساعة 21:00. Published: 2026-11-18"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), true);
});

test("rejects future club fixtures copied from stale publication pages", () => {
  const result = {
    results:
      "[Al Ahly fixtures](https://one.example/alahly) جدول مباريات الأهلي القادمة: 23 Nov 2027 الساعة 19:00. Published: 2026-08-01\n\n" +
      "[Al Ahly schedule](https://two.example/club) مواعيد مباراة الأهلي القادمة: 25 Nov 2027 الساعة 21:00. Updated: 2026-08-01"
  };
  assert.equal(hasVerifiableSportsScheduleSources(result), false);
});


test("conversation titles are safe, concise, and normalized for the sidebar", () => {
  assert.equal(buildConversationTitle("  مباراة الأهلي القادمة  "), "مباراة الأهلي القادمة");
  assert.equal(buildConversationTitle("سؤال أول\nسؤال ثاني"), "سؤال أول سؤال ثاني");
  assert.equal(buildConversationTitle(""), "محادثة جديدة");
  assert.equal(Array.from(buildConversationTitle("أ".repeat(80))).length, 52);
  assert.equal(buildConversationTitle(" أ ".repeat(4)), "أ أ أ أ");
});

test("chat persistence is scoped to a conversation and legacy messages are preserved", () => {
  assert.match(worker, /CREATE TABLE IF NOT EXISTS conversations/);
  assert.match(worker, /ALTER TABLE messages ADD COLUMN conversation_id TEXT/);
  assert.match(worker, /INSERT OR IGNORE INTO conversations[\s\S]*SELECT 'legacy-' \|\| user_id/);
  assert.match(worker, /UPDATE messages SET conversation_id='legacy-' \|\| user_id WHERE conversation_id IS NULL/);
  assert.match(worker, /SELECT role,content FROM messages WHERE user_id=\? AND conversation_id=\?/);
  assert.match(worker, /INSERT INTO messages \(id,user_id,conversation_id,role,content,created_at\)/);
  assert.match(worker, /SELECT id,title,archived_at FROM conversations WHERE id=\? AND user_id=\?/);
});

test("conversation APIs exist and are protected by the owning account", () => {
  assert.match(worker, /async function conversationsRoute\(request, env, user, path\)/);
  assert.match(worker, /path === "\/api\/conversations"/);
  assert.match(worker, /path\.startsWith\("\/api\/conversations\/"\)/);
  assert.match(worker, /DELETE FROM messages WHERE user_id=\? AND conversation_id=\?/);
  assert.match(worker, /DELETE FROM conversations WHERE id=\? AND user_id=\?/);
});


test("chat retry is owner-scoped, context-safe, and only replaces a successful latest turn", () => {
  const routeStart = worker.indexOf('path === "/api/chat/retry"');
  const routeEnd = worker.indexOf('path === "/api/chat" && request.method === "POST"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = worker.slice(routeStart, routeEnd);
  assert.match(route, /currentUser\(request, env\)/);
  assert.match(route, /WHERE id=\? AND user_id=\? AND archived_at IS NULL/);
  assert.match(route, /rows\[0\]\.role !== "assistant" \|\| rows\[1\]\.role !== "user"/);
  assert.match(route, /historyBeforeRowid: Number\(originalUser\.seq\)/);
  assert.match(route, /if \(!response\.ok\) return response/);
  assert.ok(route.indexOf("if (!response.ok) return response") < route.indexOf("DELETE FROM messages"));
  assert.match(route, /أسماء المرفقات/);
});

test("chat UI streams edits and regenerates any identified text-only turn in a preserved fork", () => {
  assert.ok(client.includes('requestStreamedReply("/api/chat/edit"'));
  assert.ok(client.includes("messageId: userRow.dataset.messageId"));
  assert.ok(client.includes("function rebuildChatMessageEditActions"));
  assert.ok(client.includes('userRow.dataset.hasAttachments === "true"'));
  assert.ok(client.includes("إعادة توليد الرد"));
  assert.ok(client.includes("تعديل سؤالي"));
  assert.ok(client.includes("attachChatMessageEditActions(assistantRow, userRow)"));
  assert.ok(client.includes("await openConversation(currentConversationId)"));
});


test("stream metadata preserves saved message IDs and recovers an edited fork after a stream error", () => {
  assert.ok(client.includes('event === "meta"'));
  assert.ok(client.includes("streamError.meta = currentStreamMeta"));
  assert.ok(client.includes("meta => {"));
  assert.ok(client.includes("meta.userMessageId"));
  assert.ok(client.includes('path === "/api/chat/edit" && error?.meta?.forked'));
  assert.ok(client.includes("await openConversation(currentConversationId)"));
});

test("historical edit removes an incomplete fork when context cloning fails", () => {
  const routeStart = worker.indexOf('path === "/api/chat/edit"');
  const routeEnd = worker.indexOf('const projectRouteMatch', routeStart);
  const route = worker.slice(routeStart, routeEnd);
  assert.ok(route.includes("const discardIncompleteFork = async () =>"));
  assert.ok(route.includes("catch (cloneError)"));
  assert.ok(route.includes("await discardIncompleteFork()"));
  assert.ok(route.includes("if (cloned !== totalPriorMessages)"));
  assert.ok(route.indexOf("if (cloned !== totalPriorMessages)") < route.indexOf("const response = await handleAgent"));
});

test("chat history uses stable rowid cursor pagination beyond the initial 100 messages", () => {
  assert.match(worker, /url\.searchParams\.get\("before"\)/);
  assert.match(worker, /rowid AS seq/);
  assert.match(worker, /ORDER BY rowid DESC LIMIT 101/);
  assert.match(worker, /nextBefore/);
  assert.match(client, /renderOlderMessagesControl/);
  assert.match(client, /loadOlderMessages/);
  assert.match(client, /&before=/);
  assert.match(client, /messages\.scrollTop = previousTop \+ \(messages\.scrollHeight - previousHeight\)/);
});

test("scanned PDF extraction uses on-device Arabic OCR with bounded workload", () => {
  assert.match(client, /pdfjs-dist@6\.5\.438/);
  assert.match(client, /tesseract\.js@5\.1\.1/);
  assert.match(client, /createWorker\("ara\+eng"/);
  assert.match(client, /pdf\.numPages > 100/);
  assert.match(client, /ocrPages >= 8/);
  assert.match(client, /ocrWorker\.recognize\(canvas\)/);
  assert.match(client, /kind: "text", name: file\.name, type: "application\/pdf"/);
});

test("legacy XLS extraction runs locally and preserves worksheet structure and formulas", () => {
  assert.match(client, /xlsx-0\.20\.3\/package\/xlsx\.mjs/);
  assert.match(client, /cpexcel\.full\.mjs/);
  assert.match(client, /extractLegacyXlsOnDevice/);
  assert.match(client, /XLSX\.utils\.decode_range/);
  assert.match(client, /XLSX\.utils\.encode_cell/);
  assert.ok(client.includes("[صيغة:"));
  assert.match(client, /totalCells > 250000/);
  assert.match(client, /extension === "xls"/);
});


test("legacy DOC parsing runs locally and preserves Word tables without rendering embedded HTML", () => {
  assert.match(client, /@file-viewer\/doc@3\.3\.0/);
  assert.match(client, /parser\.parseMsDoc\(bytes, \{ maxPictureBytes: 0 \}\)/);
  assert.match(client, /legacyDocInlineText/);
  assert.match(client, /block\?\.type === "table"/);
  assert.match(client, /cellsCount > 100000/);
  assert.match(client, /rowsCount > 10000/);
  assert.match(client, /extension === "doc"/);
  assert.ok(client.includes('kind: "text", name: file.name, type: "application/msword"'));
});


test("live voice calls use browser microphone tracks and receive spoken assistant audio", () => {
  assert.ok(client.includes("navigator.mediaDevices.getUserMedia"));
  assert.ok(client.includes("peer.addTrack(track, stream)"));
  assert.ok(client.includes('mode: "conversation"'));
  assert.ok(client.includes('id === "guest"'));
  assert.ok(client.includes('data.type === "input_audio_buffer.speech_started"'));
  assert.ok(client.includes('data.type === "conversation.item.input_audio_transcription.completed"'));
  assert.ok(client.includes('data.type === "response.output_audio_transcript.delta"'));
  assert.ok(client.includes("activeVoiceMicStream?.getTracks?.().forEach(track => track.stop())"));
  assert.ok(client.includes('window.addEventListener("pagehide"'));
});

test("live voice session enables Egyptian Arabic transcription and server VAD", () => {
  const start = worker.indexOf("async function handleRealtimeVoice(");
  const end = worker.indexOf("async function ", start + 20);
  const route = worker.slice(start, end);
  assert.ok(route.includes('body.mode === "conversation"'));
  assert.ok(route.includes('model: "gpt-4o-mini-transcribe"'));
  assert.ok(route.includes('language: "ar"'));
  assert.ok(route.includes('type: "server_vad"'));
  assert.ok(route.includes("create_response: true"));
  assert.ok(route.includes("interrupt_response: true"));
});

test("voice transcripts are saved only to the authenticated owner's active conversation", () => {
  assert.ok(worker.includes('path === "/api/voice/transcript"'));
  assert.ok(worker.includes("const voiceUser = env.DB ? await currentUser(request, env) : null"));
  assert.ok(worker.includes("saveVoiceTranscriptRoute(request, env, voiceUser)"));
  assert.ok(worker.includes('SELECT id FROM conversations WHERE id=? AND user_id=? AND archived_at IS NULL LIMIT 1'));
  assert.ok(worker.includes("INSERT OR IGNORE INTO messages"));
  assert.ok(worker.includes('body.role === "assistant" ? "assistant" : body.role === "user" ? "user" : ""'));
});


test("live call control is hidden unless the Realtime API key is configured", () => {
  assert.ok(client.includes("naturalVoiceConfigured = Boolean(f.naturalVoiceConfigured)"));
  assert.ok(client.includes('user.id === "guest" || !naturalVoiceConfigured'));
  assert.ok(worker.includes("naturalVoiceConfigured: Boolean(env.OPENAI_API_KEY)"));
  assert.ok(worker.includes('المحادثة الصوتية المباشرة غير مفعّلة بدون OpenAI API.'));
});
