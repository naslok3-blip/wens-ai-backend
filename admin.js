const $ = id => document.getElementById(id);
const defaults = {
  appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
  welcomeTitle: "أهلًا بيك، أنا ونس 💜",
  welcomeText: "اتكلم معايا أو افتح مكالمة فيديو مع شخص تحبه.",
  greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
  voiceButton: "اتكلم معايا", cameraButton: "📹 مكالمة فيديو",
  voiceRate: 0.96, voicePitch: 1.12, theme: "purple",
  enableVoice: true, enableCamera: true, voiceLocale: "ar-EG"
};
const keys = Object.keys(defaults);
let config = { ...defaults };

async function request(path, body, method = "GET") {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || "تعذّر تنفيذ الطلب.");
  return data;
}
function gateMessage(message, error = false) {
  $("adminGateStatus").textContent = message || "";
  $("adminGateStatus").style.color = error ? "#ff9fba" : "#9be7c1";
}
function serviceMessage(message, error = false) {
  $("serviceStatus").textContent = message || "";
  $("serviceStatus").style.color = error ? "#ff9fba" : "#9be7c1";
}
function normalize(data) {
  const next = { ...defaults };
  if (!data || typeof data !== "object" || Array.isArray(data)) return next;
  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (typeof defaults[key] === "boolean") next[key] = value === true;
    else if (typeof defaults[key] === "number") {
      const max = key === "voiceRate" ? 1.35 : 1.5;
      const min = key === "voiceRate" ? 0.65 : 0.7;
      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];
    } else if (typeof value === "string") {
      next[key] = value.slice(0, key === "welcomeText" || key === "greeting" ? 350 : 120);
    }
  }
  if (!["purple", "blue", "green", "rose"].includes(next.theme)) next.theme = defaults.theme;
  if (!["ar-EG", "ar-SA", "en-US"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;
  return next;
}
function loadSettings() {
  try { config = normalize(JSON.parse(localStorage.getItem("wensAISettings") || "{}")); }
  catch { config = { ...defaults }; }
  for (const key of keys) {
    const element = $(key);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = !!config[key];
    else element.value = config[key];
  }
  updateRanges();
}
function readForm() {
  for (const key of keys) {
    const element = $(key);
    if (element) config[key] = element.type === "checkbox" ? element.checked :
      element.type === "range" ? Number(element.value) : element.value;
  }
}
function updateRanges() {
  $("rateOut").value = Number($("voiceRate").value).toFixed(2);
  $("pitchOut").value = Number($("voicePitch").value).toFixed(2);
}
function setState(id, label, ready) {
  const element = $(id);
  element.textContent = label;
  element.className = ready ? "state-ready" : "state-off";
}
async function refreshStatus() {
  $("refreshStatusBtn").disabled = true;
  try {
    const data = await request("/api/admin/status");
    const f = data.features || {};
    setState("workersAiState", f.workersAI ? "متصل ويعمل" : "غير مربوط", !!f.workersAI);
    setState("databaseState", !f.databaseConfigured ? "غير مربوطة" : !f.databaseConnected ? "فشل الاتصال" : f.databaseSchemaReady ? "جاهزة" : "تحتاج تطبيق الجداول", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));
    setState("videoState", f.videoAvatar ? "الإعداد مكتمل" : "بانتظار الإعداد", !!f.videoAvatar);
    $("modelName").textContent = "النموذج: " + (data.model || "غير محدد");
    $("databaseDetail").textContent = !f.databaseConfigured ? "لم يتم ربط D1 بعد" : !f.databaseConnected ? "تعذّر الاتصال بقاعدة البيانات" : f.databaseSchemaReady ? "الجداول الأساسية الثلاثة موجودة" : "طبّق migration 0001_initial.sql";
    $("checkedAt").textContent = "آخر فحص: " + new Date(data.checkedAt).toLocaleString("ar-EG");
    serviceMessage("تم فحص إعدادات الخدمات على الخادم. لا يتم عرض أي مفاتيح سرية.");
  } catch (error) {
    serviceMessage(error.message, true);
    if (/جلسة المدير/.test(error.message)) {
      $("adminApp").hidden = true;
      $("adminGate").hidden = false;
      gateMessage("انتهت الجلسة. أدخل الرقم السري مرة أخرى.", true);
    }
  } finally {
    $("refreshStatusBtn").disabled = false;
  }
}
function showDashboard() {
  $("adminGate").hidden = true;
  $("adminApp").hidden = false;
  loadSettings();
  refreshStatus();
}
$("adminLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const pin = $("adminPin").value;
  $("adminLoginBtn").disabled = true;
  gateMessage("جاري التحقق من الرقم السري...");
  try {
    await request("/api/admin/login", { pin }, "POST");
    $("adminPin").value = "";
    showDashboard();
  } catch (error) {
    gateMessage(error.message, true);
  } finally {
    $("adminLoginBtn").disabled = false;
  }
});
$("adminLogoutBtn").addEventListener("click", async () => {
  try { await request("/api/admin/logout", {}, "POST"); } catch {}
  $("adminApp").hidden = true;
  $("adminGate").hidden = false;
  $("adminPin").value = "";
  gateMessage("تم تسجيل خروج المدير.");
});
$("refreshStatusBtn").addEventListener("click", refreshStatus);
$("testWorkersAiBtn").addEventListener("click", async () => {
  $("testOpenAiBtn").disabled = true;
  serviceMessage("جاري اختبار Cloudflare Workers AI...");
  try {
    const result = await request("/api/admin/test-ai", {}, "POST");
    serviceMessage("اختبار ناجح ✓ رد الخدمة: " + result.reply);
    setState("workersAiState", "يعمل بنجاح", true);
  } catch (error) {
    serviceMessage(error.message, true);
    setState("workersAiState", "فشل الاختبار", false);
  } finally {
    $("testOpenAiBtn").disabled = false;
  }
});
document.querySelectorAll(".nav-btn").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-btn").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll(".tab-page").forEach(page => page.classList.toggle("active", page.id === "tab-" + button.dataset.tab));
}));
["voiceRate", "voicePitch"].forEach(id => $(id).addEventListener("input", updateRanges));
$("saveBtn").addEventListener("click", () => {
  readForm();
  localStorage.setItem("wensAISettings", JSON.stringify(config));
  $("saveStatus").textContent = "تم حفظ التعديلات على هذا الجهاز ✓";
  $("saveStatus").style.color = "#9be7c1";
});
$("exportBtn").addEventListener("click", () => {
  readForm();
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "wens-ai-settings.json";
  link.click();
  URL.revokeObjectURL(url);
  $("backupStatus").textContent = "تم تجهيز ملف الإعدادات للتنزيل.";
});
$("importFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    config = normalize(JSON.parse(await file.text()));
    localStorage.setItem("wensAISettings", JSON.stringify(config));
    loadSettings();
    $("backupStatus").textContent = "تم استرجاع الإعدادات بنجاح.";
  } catch {
    $("backupStatus").textContent = "الملف غير صالح؛ اختَر ملف JSON صحيح.";
  }
  event.target.value = "";
});
$("resetBtn").addEventListener("click", () => {
  if (!confirm("ترجع كل إعدادات الواجهة للقيم الافتراضية؟")) return;
  config = { ...defaults };
  localStorage.setItem("wensAISettings", JSON.stringify(config));
  loadSettings();
  $("backupStatus").textContent = "تمت استعادة الإعدادات الافتراضية.";
});
(async function bootAdmin() {
  try {
    const session = await request("/api/admin/session");
    if (session.authenticated) showDashboard();
    else gateMessage("أدخل الرقم السري للمتابعة.");
  } catch (error) {
    gateMessage(error.message === "تعذّر تنفيذ الطلب."
      ? "لوحة المدير غير مهيأة. أضف WENS_ADMIN_PIN وWENS_ADMIN_SESSION_SECRET إلى Secrets في Worker."
      : error.message.includes("Failed to fetch")
        ? "تعذّر الاتصال بالخادم. تأكد من اتصال الإنترنت."
        : error.message, true);
  }
})();
