const $ = id => document.getElementById(id);
const defaults = {
  appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
  welcomeTitle: "أهلًا بيك، أنا ونس 💜",
  welcomeText: "اتكلم معايا واسألني اللي في بالك.",
  greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
  voiceButton: "اتكلم معايا",
  voiceRate: 0.96, voicePitch: 1.12, theme: "purple",
  enableVoice: true, voiceLocale: "ar-EG", avatarDataUrl: "", voiceEngine: "cloud", voiceName: "coral"
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
      next[key] = value.slice(0, key === "avatarDataUrl" ? 700000 : key === "welcomeText" ? 240 : key === "greeting" ? 350 : 120);
    }
  }
  if (!["purple", "blue", "green", "rose"].includes(next.theme)) next.theme = defaults.theme;
  if (next.voiceLocale !== "ar-EG") next.voiceLocale = "ar-EG";
  if (next.voiceEngine !== "cloud") next.voiceEngine = "cloud";
  if (!["coral", "shimmer", "marin", "cedar", "sage"].includes(next.voiceName)) next.voiceName = defaults.voiceName;
  return next;
}
function fillSettingsForm() {
  for (const key of keys) {
    const element = $(key);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = !!config[key];
    else element.value = config[key];
  }
  updateRanges();
}
async function loadSettings() {
  const data = await request("/api/admin/settings");
  config = normalize(data.settings);
  fillSettingsForm();
  const preview = $("avatarPreview");
  if (preview) preview.src = config.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
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
    setState("databaseState", !f.databaseConfigured ? "غير مربوطة" : !f.databaseConnected ? "فشل الاتصال" : f.databaseSchemaReady ? "جاهزة" : "تحتاج مراجعة", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));
    $("modelName").textContent = "النموذج: " + (data.model || "غير محدد");
    $("databaseDetail").textContent = !f.databaseConfigured ? "لم يتم ربط D1 بعد" : !f.databaseConnected ? "تعذّر الاتصال بقاعدة البيانات" : f.settingsStorageReady ? "الجداول وحفظ الإعدادات جاهزة" : "تخزين الإعدادات يحتاج مراجعة";
    $("checkedAt").textContent = "آخر فحص: " + new Date(data.checkedAt).toLocaleString("ar-EG");
    serviceMessage("تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.");
  } catch (error) {
    serviceMessage(error.message, true);
    if (/سجّل الدخول/.test(error.message)) {
      $("adminApp").hidden = true;
      $("adminGate").hidden = false;
      gateMessage("انتهت الجلسة أو الحساب غير مصرح. سجّل الدخول بحساب المالك.", true);
    }
  } finally { $("refreshStatusBtn").disabled = false; }
}
async function showDashboard() {
  $("adminGate").hidden = true;
  $("adminApp").hidden = false;
  try { await loadSettings(); await refreshStatus(); }
  catch (error) { serviceMessage(error.message, true); }
}
$("adminLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("adminEmail").value.trim(), password = $("adminPassword").value;
  $("adminLoginBtn").disabled = true;
  gateMessage("جاري التحقق من حساب المالك...");
  try {
    await request("/api/admin/login", { email, password }, "POST");
    $("adminPassword").value = "";
    await showDashboard();
  } catch (error) { gateMessage(error.message, true); }
  finally { $("adminLoginBtn").disabled = false; }
});

$("showAdminResetBtn").addEventListener("click", () => {
  $("adminSetupForm").hidden = !$("adminSetupForm").hidden;
  $("adminSetupBtn").textContent = "إنشاء كلمة مرور المدير المستقلة";
  gateMessage($("adminSetupForm").hidden ? "" : "أدخل كلمة مرور حساب ونس الحالية. لا تُرسلها لأي شخص.");
});
$("adminSetupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const ownerPassword = $("ownerPassword").value;
  $("adminSetupBtn").disabled = true;
  gateMessage("جاري التحقق من ملكية الحساب وإعادة إعداد كلمة مرور المدير...");
  try {
    const result = await request("/api/admin/setup", { ownerPassword }, "POST");
    $("ownerPassword").value = "";
    $("adminSetupForm").hidden = true;
    $("adminLoginForm").hidden = true;
    $("showAdminResetBtn").hidden = true;
    if (result.password) {
      $("adminNewPasswordText").textContent = result.password;
      $("adminNewPasswordNotice").hidden = false;
    }
    await showDashboard();
    gateMessage("تم إنشاء كلمة مرور مدير مستقلة وتسجيل دخولك بنجاح.");
  } catch (error) {
    gateMessage(error.message, true);
  } finally {
    $("adminSetupBtn").disabled = false;
  }
});

$("adminLogoutBtn").addEventListener("click", async () => {
  try { await request("/api/admin/logout", {}, "POST"); } catch {}
  $("adminApp").hidden = true;
  $("adminGate").hidden = false;
  $("adminPassword").value = "";
  gateMessage("تم تسجيل خروج المدير.");
});
$("refreshStatusBtn").addEventListener("click", refreshStatus);
$("testWorkersAiBtn").addEventListener("click", async () => {
  $("testWorkersAiBtn").disabled = true;
  serviceMessage("جاري اختبار Cloudflare Workers AI...");
  try {
    const result = await request("/api/admin/test-ai", {}, "POST");
    serviceMessage("اختبار ناجح ✓ رد الخدمة: " + result.reply);
    setState("workersAiState", "يعمل بنجاح", true);
  } catch (error) {
    serviceMessage(error.message, true);
    setState("workersAiState", "فشل الاختبار", false);
  } finally { $("testWorkersAiBtn").disabled = false; }
});
document.querySelectorAll(".nav-btn").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-btn").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll(".tab-page").forEach(page => page.classList.toggle("active", page.id === "tab-" + button.dataset.tab));
}));
["voiceRate", "voicePitch"].forEach(id => $(id).addEventListener("input", updateRanges));
$("saveBtn").addEventListener("click", async () => {
  readForm();
  $("saveBtn").disabled = true;
  try {
    const result = await request("/api/admin/settings", { settings: config }, "PUT");
    config = normalize(result.settings);
    fillSettingsForm();
    $("saveStatus").textContent = "تم حفظ التعديلات على الخادم لكل المستخدمين ✓";
    $("saveStatus").style.color = "#9be7c1";
  } catch (error) {
    $("saveStatus").textContent = error.message;
    $("saveStatus").style.color = "#ff9fba";
  } finally { $("saveBtn").disabled = false; }
});
$("exportBtn").addEventListener("click", () => {
  readForm();
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "wens-ai-settings.json"; link.click();
  URL.revokeObjectURL(url);
  $("backupStatus").textContent = "تم تجهيز نسخة من إعدادات الخادم الحالية.";
});
$("importFile").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = normalize(JSON.parse(await file.text()));
    const result = await request("/api/admin/settings", { settings: imported }, "PUT");
    config = normalize(result.settings); fillSettingsForm();
    $("backupStatus").textContent = "تم استرجاع الإعدادات وحفظها على الخادم.";
  } catch (error) { $("backupStatus").textContent = error.message || "الملف غير صالح؛ اختَر ملف JSON صحيح."; }
  event.target.value = "";
});
$("resetBtn").addEventListener("click", async () => {
  if (!confirm("ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟")) return;
  try {
    const result = await request("/api/admin/settings", { settings: defaults }, "PUT");
    config = normalize(result.settings); fillSettingsForm();
    $("backupStatus").textContent = "تمت استعادة الإعدادات الافتراضية على الخادم.";
  } catch (error) { $("backupStatus").textContent = error.message; }
});


$("voicePreviewBtn").addEventListener("click", async () => {
  $("voicePreviewBtn").disabled = true;
  $("voicePreviewStatus").textContent = "جاري تشغيل عينة صوت ونس...";
  try {
    const play = window.parent && window.parent.WensPlayVoicePreview;
    if (typeof play !== "function") throw new Error("افتح لوحة الإدارة من داخل صفحة ونس لتشغيل العينة.");
    await play("أهلًا بيك، أنا ونس. سعيدة إني أكون معاك النهارده.", $("voiceName").value);
    $("voicePreviewStatus").textContent = "تم إرسال عينة الصوت إلى مشغل ونس.";
  } catch (error) {
    $("voicePreviewStatus").textContent = error.message || "تعذّر اختبار الصوت.";
  } finally {
    $("voicePreviewBtn").disabled = false;
  }
});

function compressAvatarFile(file) {
  return new Promise((resolve, reject) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!file || !allowed.includes(file.type)) {
      reject(new Error("اختَر صورة بصيغة JPG أو PNG أو WebP."));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const maxSide = 512;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("تعذّر تجهيز الصورة.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          URL.revokeObjectURL(objectUrl);
          if (!blob) { reject(new Error("تعذّر ضغط الصورة.")); return; }
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("تعذّرت قراءة الصورة."));
          reader.readAsDataURL(blob);
        }, "image/jpeg", 0.84);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("ملف الصورة غير صالح.")); };
    image.src = objectUrl;
  });
}
$("avatarUpload").addEventListener("change", () => {
  $("uploadAvatarBtn").disabled = !$("avatarUpload").files || !$("avatarUpload").files[0];
  $("avatarStatus").textContent = $("avatarUpload").files && $("avatarUpload").files[0]
    ? "الصورة جاهزة. اضغط حفظ صورة ونس لإرسالها."
    : "";
});
$("uploadAvatarBtn").addEventListener("click", async () => {
  const file = $("avatarUpload").files && $("avatarUpload").files[0];
  if (!file) return;
  $("uploadAvatarBtn").disabled = true;
  $("avatarStatus").textContent = "جاري ضغط الصورة وحفظها على الخادم...";
  try {
    const avatarDataUrl = await compressAvatarFile(file);
    if (avatarDataUrl.length > 700000) throw new Error("الصورة كبيرة بعد الضغط. اختَر صورة أصغر.");
    const result = await request("/api/admin/settings", { settings: { ...config, avatarDataUrl } }, "PUT");
    config = normalize(result.settings);
    $("avatarPreview").src = config.avatarDataUrl;
    $("avatarStatus").textContent = "تم حفظ صورة ونس على الخادم. ستظهر للمستخدمين بعد تحديث التطبيق.";
    $("avatarUpload").value = "";
  } catch (error) {
    $("avatarStatus").textContent = error.message || "تعذّر حفظ الصورة.";
  } finally {
    $("uploadAvatarBtn").disabled = false;
  }
});
$("resetAvatarBtn").addEventListener("click", async () => {
  $("resetAvatarBtn").disabled = true;
  try {
    const result = await request("/api/admin/settings", { settings: { ...config, avatarDataUrl: "" } }, "PUT");
    config = normalize(result.settings);
    $("avatarPreview").src = "/avatar.jpg?v=real-jpg-20261105";
    $("avatarUpload").value = "";
    $("uploadAvatarBtn").disabled = true;
    $("avatarStatus").textContent = "تمت استعادة الصورة الافتراضية.";
  } catch (error) {
    $("avatarStatus").textContent = error.message;
  } finally {
    $("resetAvatarBtn").disabled = false;
  }
});

$("avatarTestBtn").addEventListener("click", async () => {
  $("avatarTestBtn").disabled = true;
  $("avatarTestStatus").textContent = "جاري اختبار الحفظ والاسترجاع...";
  const original = config.avatarDataUrl || "";
  let saved = false;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("تعذّر إنشاء صورة الاختبار.");
    context.fillStyle = "#a28bff";
    context.fillRect(0, 0, 2, 2);
    const sample = canvas.toDataURL("image/jpeg", 0.6);
    await request("/api/admin/settings", {settings: {...config, avatarDataUrl: sample}}, "PUT");
    saved = true;
    const check = await request("/api/admin/settings");
    if (check.settings?.avatarDataUrl !== sample) throw new Error("لم تُحفظ الصورة التجريبية بصورة مطابقة.");
    await request("/api/admin/settings", {settings: {...config, avatarDataUrl: original}}, "PUT");
    saved = false;
    config.avatarDataUrl = original;
    $("avatarPreview").src = original || "/avatar.jpg?v=real-jpg-20261105";
    $("avatarTestStatus").textContent = "نجح الاختبار: تم الحفظ والقراءة واستعادة الصورة الأصلية.";
  } catch (error) {
    if (saved) {
      try {
        await request("/api/admin/settings", {settings: {...config, avatarDataUrl: original}}, "PUT");
        config.avatarDataUrl = original;
        $("avatarPreview").src = original || "/avatar.jpg?v=real-jpg-20261105";
      } catch {}
    }
    $("avatarTestStatus").textContent = error.message || "فشل اختبار الصورة.";
  } finally {
    $("avatarTestBtn").disabled = false;
  }
});

(async function bootAdmin() {
  try {
    const session = await request("/api/admin/session");
    if (session.authenticated) await showDashboard();
    else if (session.owner) {
      $("showAdminResetBtn").hidden = false;
      gateMessage(session.configured
        ? "حساب المالك الحالي موثّق. يمكنك تسجيل الدخول بكلمة مرور المدير أو إنشاء كلمة مرور جديدة بعد التحقق من كلمة مرور حساب ونس."
        : "تم التعرف على حساب المالك. أنشئ كلمة مرور المدير المستقلة.");
      if (!session.configured) $("adminSetupForm").hidden = false;
    } else {
      gateMessage("أدخل البريد وكلمة مرور المدير. يجب فتح لوحة الإدارة من حساب المالك داخل ونس.");
    }
  } catch (error) {
    gateMessage(error.message === "تعذّر تنفيذ الطلب."
      ? "تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت."
      : error.message, true);
  }
})();