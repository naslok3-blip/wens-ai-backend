const $ = id => document.getElementById(id);
const defaults = {
  appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
  welcomeTitle: "أهلًا بيك، أنا ونس 💜",
  welcomeText: "اتكلم معايا واسألني اللي في بالك.",
  greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
  voiceButton: "اتكلم معايا",
  voiceRate: 0.96, theme: "purple",
  enableVoice: true, autoSpeak: true, voiceLocale: "ar-EG", avatarDataUrl: "", voiceEngine: "device", voiceName: "device",
  uiCopy: {
    "brandTagline": "رفيقة يومك الذكية",
    "authEyebrow": "مساحتك الخاصة",
    "authTitle": "أهلًا بيك في ونس",
    "registerTitle": "إنشاء حساب ونس",
    "backToLogin": "عندي حساب بالفعل",
    "authDescription": "سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.",
    "nameLabel": "الاسم",
    "emailLabel": "البريد الإلكتروني",
    "passwordLabel": "كلمة المرور",
    "loginButton": "تسجيل الدخول",
    "registerButton": "إنشاء حساب جديد",
    "chatSidebarTitle": "محادثاتك",
    "newConversation": "＋ محادثة جديدة",
    "conversationSearch": "ابحث في المحادثات...",
    "archivedConversations": "المحادثات المؤرشفة",
    "activeChatTitle": "الدردشة مع ونس",
    "accountLabel": "محادثتك محفوظة في حسابك",
    "newChatButton": "＋ جديد",
    "notificationTitle": "مركز الإشعارات",
    "markAllRead": "تحديد الكل كمقروء",
    "noNotifications": "لا توجد إشعارات بعد.",
    "attachmentMenu": "إضافة إلى المحادثة",
    "cameraTitle": "الكاميرا",
    "cameraDescription": "التقط صورة وأرسلها لونس",
    "photosTitle": "الصور",
    "photosDescription": "اختر صورة من هاتفك",
    "filesTitle": "الملفات",
    "filesDescription": "نصوص ومستندات وملفات أخرى",
    "pluginsTitle": "المكونات الإضافية",
    "pluginsDescription": "أدوات ونس المتصلة",
    "deepThinkTitle": "فكّر بعمق أكبر",
    "deepThinkDescription": "استدلال أعمق للمسائل الصعبة",
    "pluginToolsTitle": "أدوات ونس المتاحة",
    "searchWeb": "🌐 البحث في الإنترنت",
    "browseWeb": "🌍 متصفح المواقع",
    "manageTasks": "✅ إدارة المهام",
    "calculator": "🧮 الحاسبة",
    "searchConversations": "🗂️ البحث في المحادثات",
    "saveMemory": "🧠 حفظ تفضيل في الذاكرة",
    "viewMemory": "📚 عرض ذاكرتي",
    "deleteMemory": "🧹 حذف معلومة من الذاكرة",
    "createApp": "🧩 إنشاء تطبيق أو لعبة",
    "backButton": "رجوع",
    "deepThinkEnabled": "🧠 التفكير العميق مفعّل",
    "stopButton": "إيقاف",
    "correctionButton": "استخدم التصحيح",
    "composerPlaceholder": "اكتب رسالتك أو أرفق ملفًا...",
    "composerAria": "رسالتك",
    "sendButton": "إرسال",
    "privacyDisclaimer": "رسائلك ومرفقاتك تُعالج لإعداد الرد. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.",
    "adminTitle": "لوحة إدارة ونس",
    "adminDescription": "الإدارة داخل حسابك ومن نفس صفحة ونس",
    "footerText": "ونس AI • نسخة تطويرية",
    "genericError": "حصل خطأ في الاتصال بالخادم.",
    "notificationFallbackTitle": "إشعار ونس",
    "notificationLoadError": "تعذّر تحميل الإشعارات: ",
    "guestAccountLabel": "وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات",
    "loggedInPrefix": "مسجّل الدخول: ",
    "conversationsLoadError": "تعذّر تحميل المحادثات: ",
    "logoutSuccess": "تم تسجيل الخروج.",
    "noArchivedConversations": "لا توجد محادثات مؤرشفة.",
    "noConversations": "لسه مفيش محادثات. ابدأ محادثة جديدة.",
    "restoreAction": "استعادة",
    "restoreConversationAria": "استعادة المحادثة",
    "restoreConversationError": "تعذّرت استعادة المحادثة: ",
    "renameAction": "تسمية",
    "renameConversationAria": "إعادة تسمية المحادثة",
    "renamePrompt": "اسم المحادثة",
    "renameConversationError": "تعذّرت إعادة التسمية: ",
    "archiveAction": "أرشفة",
    "archiveConversationAria": "أرشفة المحادثة",
    "archiveConversationError": "تعذّرت أرشفة المحادثة: ",
    "deleteAction": "حذف",
    "deleteConversationAria": "حذف المحادثة نهائيًا",
    "deleteConversationConfirm": "حذف هذه المحادثة ورسائلها نهائيًا؟ لا يمكن التراجع عن الحذف.",
    "deleteConversationError": "تعذّر حذف المحادثة: ",
    "loadingConversation": "جاري تحميل المحادثة...",
    "loadConversationError": "تعذّر تحميل المحادثة: ",
    "createConversationError": "تعذّر إنشاء محادثة جديدة: ",
    "searchConversationsError": "تعذّر البحث في المحادثات: ",
    "copiedText": "تم نسخ النص.",
    "copyTextError": "تعذّر النسخ تلقائيًا على الجهاز ده.",
    "feedbackTitle": "تقييم رد ونس",
    "feedbackQuestion": "هل كان الرد مفيدًا؟",
    "feedbackHelpful": "👍 مفيد",
    "feedbackHelpfulAria": "الرد مفيد",
    "feedbackNotHelpful": "👎 مش مفيد",
    "feedbackNotHelpfulAria": "الرد غير مفيد",
    "feedbackThanks": "✓ شكرًا لتقييمك",
    "feedbackSaved": "تم حفظ تقييمك",
    "feedbackSaveError": "تعذّر حفظ التقييم",
    "replayReply": "🔊 اسمع رد ونس",
    "replayAria": "تشغيل رد ونس صوتيًا",
    "voicePreparing": "جاري تجهيز الصوت…",
    "voicePlaying": "🔊 الصوت يعمل",
    "voiceUnavailable": "تعذّر تشغيل الصوت",
    "assistantThinking": "ونس بتفكر…",
    "ownerBrandTagline": "مركز الإدارة المحمي",
    "ownerGateEyebrow": "PRIVATE CONTROL CENTER",
    "ownerGateTitle": "دخول المدير",
    "ownerGateIntro": "لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة.",
    "ownerEmailLabel": "البريد الإلكتروني",
    "ownerPasswordLabel": "كلمة مرور المدير المستقلة",
    "ownerLoginButton": "فتح لوحة التحكم",
    "ownerReturnApp": "العودة للتطبيق",
    "ownerLogoutButton": "تسجيل خروج المدير",
    "ownerOverviewTab": "▦ نظرة عامة",
    "ownerSystemTab": "⌁ مركز التشغيل",
    "ownerAgentTab": "✧ الوكيل والأدوات",
    "ownerFilesTab": "▤ اختبار الملفات",
    "ownerIdentityTab": "◈ هوية التطبيق",
    "ownerVoiceTab": "🔊 الصوت والمساعدة",
    "ownerFeaturesTab": "⚙ الميزات",
    "ownerWelcomeTab": "☷ رسائل البداية",
    "ownerCopyTab": "✎ محرر نصوص التطبيق",
    "ownerBackupTab": "⇩ النسخ والاسترجاع",
    "ownerSaveButton": "حفظ التعديلات",
    "ownerSavePending": "التعديلات غير محفوظة حتى تضغط حفظ.",
    "ownerCopyTitle": "محرر نصوص التطبيق",
    "ownerCopyDescription": "عدّل النصوص الظاهرة في واجهة ونس. التغييرات مسودة حتى تضغط حفظ التعديلات. المعاينة داخل التطبيق لا تحفظها للمستخدمين.",
    "ownerCopySearchLabel": "ابحث عن نص",
    "ownerCopySearchPlaceholder": "ابحث بالاسم أو النص...",
    "ownerCopyPreview": "معاينة المسودة في ونس",
    "ownerCopyResetDraft": "إرجاع نصوص المسودة للأصل",
    "ownerCopyStatus": "كتالوج النصوص الأساسية جاهز. الرسائل الديناميكية ورسائل الخادم ليست كلها ضمن هذا الإصدار."
  }
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
  const incomingCopy = data.uiCopy && typeof data.uiCopy === "object" && !Array.isArray(data.uiCopy) ? data.uiCopy : {};
  next.uiCopy = { ...defaults.uiCopy, ...Object.fromEntries(Object.entries(incomingCopy).filter(([key, value]) => key in defaults.uiCopy && typeof value === "string" && value.length <= 240)) };
  if (!["purple", "blue", "green", "rose"].includes(next.theme)) next.theme = defaults.theme;
  if (next.voiceLocale !== "ar-EG") next.voiceLocale = "ar-EG";
  if (next.voiceEngine !== "device") next.voiceEngine = "device";
  if (next.voiceName !== "device") next.voiceName = "device";
  return next;
}
function applyOwnerCopy() {
  document.querySelectorAll("[data-wens-admin-copy]").forEach(element => {
    const value = config.uiCopy?.[element.dataset.wensAdminCopy];
    if (typeof value === "string") element.textContent = value;
  });
  document.querySelectorAll("[data-wens-admin-placeholder]").forEach(element => {
    const value = config.uiCopy?.[element.dataset.wensAdminPlaceholder];
    if (typeof value === "string") element.placeholder = value;
  });
}
function fillSettingsForm() {
  applyOwnerCopy();
  for (const key of keys) {
    const element = $(key);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = !!config[key];
    else element.value = config[key];
  }
  renderCopyEditor();
  updateRanges();
}
function renderCopyEditor(filter = "") {
  const host = $("copyEditorList");
  if (!host) return;
  const labels = {"brandTagline":"وصف العلامة أعلى الصفحة","authEyebrow":"عبارة شاشة الدخول","authTitle":"عنوان شاشة الدخول","registerTitle":"عنوان إنشاء الحساب","backToLogin":"العودة لتسجيل الدخول","authDescription":"وصف شاشة الدخول","nameLabel":"حقل الاسم","emailLabel":"حقل البريد الإلكتروني","passwordLabel":"حقل كلمة المرور","loginButton":"زر تسجيل الدخول","registerButton":"زر إنشاء الحساب","chatSidebarTitle":"عنوان قائمة المحادثات","newConversation":"زر محادثة جديدة","conversationSearch":"تلميح البحث في المحادثات","archivedConversations":"زر المحادثات المؤرشفة","activeChatTitle":"عنوان المحادثة","accountLabel":"وصف الحساب","newChatButton":"زر محادثة جديدة السريع","notificationTitle":"عنوان الإشعارات","markAllRead":"زر تحديد الكل كمقروء","noNotifications":"حالة عدم وجود إشعارات","attachmentMenu":"اسم قائمة المرفقات","cameraTitle":"عنوان الكاميرا","cameraDescription":"وصف الكاميرا","photosTitle":"عنوان الصور","photosDescription":"وصف الصور","filesTitle":"عنوان الملفات","filesDescription":"وصف الملفات","pluginsTitle":"عنوان المكونات الإضافية","pluginsDescription":"وصف المكونات الإضافية","deepThinkTitle":"عنوان التفكير العميق","deepThinkDescription":"وصف التفكير العميق","pluginToolsTitle":"عنوان أدوات ونس","searchWeb":"أداة البحث في الإنترنت","browseWeb":"أداة متصفح المواقع","manageTasks":"أداة إدارة المهام","calculator":"أداة الحاسبة","searchConversations":"أداة البحث في المحادثات","saveMemory":"أداة حفظ الذاكرة","viewMemory":"أداة عرض الذاكرة","deleteMemory":"أداة حذف الذاكرة","createApp":"أداة إنشاء تطبيق","backButton":"زر الرجوع","deepThinkEnabled":"شارة التفكير العميق","stopButton":"زر الإيقاف","correctionButton":"زر التصحيح","composerPlaceholder":"تلميح مربع الكتابة","composerAria":"وصف مربع الكتابة لقارئ الشاشة","sendButton":"زر الإرسال","privacyDisclaimer":"تنبيه الخصوصية","adminTitle":"عنوان قسم الإدارة","adminDescription":"وصف قسم الإدارة","footerText":"نص أسفل الصفحة","genericError":"رسالة خطأ الاتصال","notificationFallbackTitle":"عنوان الإشعار الافتراضي","notificationLoadError":"بادئة خطأ تحميل الإشعارات","guestAccountLabel":"وصف وضع التجربة","loggedInPrefix":"بادئة الحساب المسجل","conversationsLoadError":"بادئة خطأ تحميل المحادثات","logoutSuccess":"رسالة تسجيل الخروج","noArchivedConversations":"حالة الأرشيف الفارغ","noConversations":"حالة المحادثات الفارغة","restoreAction":"زر استعادة المحادثة","restoreConversationAria":"وصف زر الاستعادة","restoreConversationError":"بادئة خطأ الاستعادة","renameAction":"زر تسمية المحادثة","renameConversationAria":"وصف زر التسمية","renamePrompt":"عنوان نافذة التسمية","renameConversationError":"بادئة خطأ التسمية","archiveAction":"زر أرشفة المحادثة","archiveConversationAria":"وصف زر الأرشفة","archiveConversationError":"بادئة خطأ الأرشفة","deleteAction":"زر حذف المحادثة","deleteConversationAria":"وصف زر الحذف","deleteConversationConfirm":"رسالة تأكيد الحذف","deleteConversationError":"بادئة خطأ الحذف","loadingConversation":"حالة تحميل المحادثة","loadConversationError":"بادئة خطأ تحميل المحادثة","createConversationError":"بادئة خطأ إنشاء محادثة","searchConversationsError":"بادئة خطأ البحث","copiedText":"رسالة نجاح النسخ","copyTextError":"رسالة فشل النسخ","feedbackTitle":"وصف تقييم الرد","feedbackQuestion":"سؤال تقييم الرد","feedbackHelpful":"زر التقييم الإيجابي","feedbackHelpfulAria":"وصف التقييم الإيجابي","feedbackNotHelpful":"زر التقييم السلبي","feedbackNotHelpfulAria":"وصف التقييم السلبي","feedbackThanks":"شكر التقييم الإيجابي","feedbackSaved":"رسالة حفظ التقييم","feedbackSaveError":"رسالة خطأ حفظ التقييم","replayReply":"زر تشغيل الرد صوتيًا","replayAria":"وصف زر تشغيل الرد","voicePreparing":"حالة تجهيز الصوت","voicePlaying":"حالة تشغيل الصوت","voiceUnavailable":"حالة تعذر تشغيل الصوت","assistantThinking":"حالة تفكير ونس","ownerBrandTagline":"وصف أعلى لوحة المالك","ownerGateEyebrow":"عبارة بوابة المالك","ownerGateTitle":"عنوان دخول المالك","ownerGateIntro":"وصف دخول المالك","ownerEmailLabel":"تسمية بريد المالك","ownerPasswordLabel":"تسمية كلمة مرور المالك","ownerLoginButton":"زر دخول المالك","ownerReturnApp":"زر العودة للتطبيق","ownerLogoutButton":"زر خروج المالك","ownerOverviewTab":"تبويب النظرة العامة","ownerSystemTab":"تبويب مركز التشغيل","ownerAgentTab":"تبويب الوكيل","ownerFilesTab":"تبويب اختبار الملفات","ownerIdentityTab":"تبويب الهوية","ownerVoiceTab":"تبويب الصوت","ownerFeaturesTab":"تبويب الميزات","ownerWelcomeTab":"تبويب رسائل البداية","ownerCopyTab":"تبويب محرر النصوص","ownerBackupTab":"تبويب النسخ والاسترجاع","ownerSaveButton":"زر حفظ الإعدادات","ownerSavePending":"حالة التعديلات غير المحفوظة","ownerCopyTitle":"عنوان محرر النصوص","ownerCopyDescription":"وصف محرر النصوص","ownerCopySearchLabel":"عنوان البحث في النصوص","ownerCopySearchPlaceholder":"تلميح البحث في النصوص","ownerCopyPreview":"زر معاينة المسودة","ownerCopyResetDraft":"زر إعادة النصوص للأصل","ownerCopyStatus":"حالة محرر النصوص"};
  const query = String(filter || "").trim().toLocaleLowerCase("ar");
  host.replaceChildren();
  for (const [key, label] of Object.entries(labels)) {
    const value = String(config.uiCopy?.[key] ?? defaults.uiCopy[key] ?? "");
    if (query && !(label + " " + value + " " + key).toLocaleLowerCase("ar").includes(query)) continue;
    const field = document.createElement("div");
    field.className = "field copy-editor-field";
    const title = document.createElement("label");
    title.htmlFor = "copy-" + key;
    title.textContent = label;
    const area = document.createElement("textarea");
    area.id = "copy-" + key;
    area.rows = value.length > 85 ? 3 : 2;
    area.maxLength = 240;
    area.value = value;
    area.dataset.copyKey = key;
    area.addEventListener("input", () => {
      config.uiCopy[key] = area.value;
      $("copyEditorStatus").textContent = "مسودة غير محفوظة — يمكنك معاينتها داخل التطبيق أو حفظها من زر الحفظ العام.";
    });
    field.append(title, area);
    host.append(field);
  }
  if (!host.childElementCount) host.textContent = "لا توجد نصوص مطابقة للبحث.";
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
  document.querySelectorAll("[data-copy-key]").forEach(element => {
    config.uiCopy[element.dataset.copyKey] = element.value.slice(0, 240);
  });
}
function updateRanges() {
  $("rateOut").value = Number($("voiceRate").value).toFixed(2);
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
    setState("voiceState", "صوت الجهاز المجاني — يحتاج صوت ar-EG مثبت", false);
    setState("browserState", f.browserConfigured ? "الربط موجود" : "غير مربوط", !!f.browserConfigured);
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
function setDiagnostic(id, text, ready) {
  const element = $(id);
  if (!element) return;
  element.textContent = text;
  element.className = ready ? "state-ready" : "state-off";
}
function setMetric(id, value) {
  const element = $(id);
  if (element) element.textContent = Number.isFinite(Number(value)) ? Number(value).toLocaleString("ar-EG") : "غير متاح";
}
let registeredUsersOffset = 0;
const registeredUsersPageSize = 25;
let registeredUsersTotal = 0;
function renderRegisteredUsers(users) {
  const list = $("registeredUsersList");
  if (!list) return;
  list.replaceChildren();
  const items = Array.isArray(users) ? users : [];
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "لا توجد حسابات تطابق البحث.";
    list.append(empty);
    return;
  }
  for (const user of items) {
    const card = document.createElement("article");
    card.className = "registered-user-card";
    const identity = document.createElement("div");
    identity.className = "registered-user-identity";
    const name = document.createElement("strong");
    name.textContent = user.name || "مستخدم ونس";
    const email = document.createElement("span");
    email.textContent = user.email || "";
    identity.append(name, email);
    const details = document.createElement("div");
    details.className = "registered-user-details";
    const fields = [
      ["تاريخ التسجيل", formatPresenceTime(user.registeredAt)],
      ["آخر دخول مسجل", formatPresenceTime(user.lastLoginAt)],
      ["مرات الدخول المسجلة", Number(user.loginCount || 0).toLocaleString("ar-EG")],
      ["الجلسات النشطة", Number(user.activeSessions || 0).toLocaleString("ar-EG")],
      ["آخر نشاط", formatPresenceTime(user.lastSeenAt)],
      ["الرسائل المحفوظة", Number(user.messageCount || 0).toLocaleString("ar-EG")]
    ];
    for (const [label, value] of fields) {
      const item = document.createElement("span");
      item.textContent = label + ": " + value;
      details.append(item);
    }
    card.append(identity, details);
    list.append(card);
  }
}
async function refreshRegisteredUsers(reset = false) {
  const list = $("registeredUsersList");
  const search = $("usersSearchInput");
  const previous = $("usersPrevBtn");
  const next = $("usersNextBtn");
  const searchButton = $("usersSearchBtn");
  if (reset) registeredUsersOffset = 0;
  if (searchButton) searchButton.disabled = true;
  try {
    const query = String(search?.value || "").trim().slice(0, 100);
    const url = "/api/admin/users?limit=" + registeredUsersPageSize +
      "&offset=" + registeredUsersOffset + "&q=" + encodeURIComponent(query);
    const data = await request(url);
    registeredUsersTotal = Number(data.total || 0);
    renderRegisteredUsers(data.users);
    const count = $("registeredUsersCount");
    if (count) count.textContent = registeredUsersTotal.toLocaleString("ar-EG") + " حساب";
    const first = registeredUsersTotal ? registeredUsersOffset + 1 : 0;
    const last = Math.min(registeredUsersOffset + registeredUsersPageSize, registeredUsersTotal);
    $("usersPageStatus").textContent = first.toLocaleString("ar-EG") + "–" + last.toLocaleString("ar-EG") +
      " من " + registeredUsersTotal.toLocaleString("ar-EG");
    if (previous) previous.disabled = registeredUsersOffset <= 0;
    if (next) next.disabled = registeredUsersOffset + registeredUsersPageSize >= registeredUsersTotal;
  } catch (error) {
    if (list) list.textContent = error.message || "تعذّر تحميل بيانات الحسابات.";
    if (previous) previous.disabled = true;
    if (next) next.disabled = true;
    const count = $("registeredUsersCount");
    if (count) count.textContent = "تعذّر التحميل";
    $("usersPageStatus").textContent = "تحقق من جلسة المدير واتصال قاعدة البيانات.";
  } finally {
    if (searchButton) searchButton.disabled = false;
  }
}
function formatPresenceTime(seconds) {
  if (!seconds) return "غير متاح";
  return new Date(seconds * 1000).toLocaleString("ar-EG");
}
function renderOnlineUsers(users) {
  const list = $("onlineUsersList"), count = $("onlineUsersCount");
  const items = Array.isArray(users) ? users : [];
  if (count) count.textContent = items.length.toLocaleString("ar-EG") + " متصل";
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "لا يوجد مستخدمون نشطون خلال آخر دقيقتين.";
    list.append(empty);
    return;
  }
  for (const user of items) {
    const card = document.createElement("article"); card.className = "online-user-card";
    const identity = document.createElement("div"); identity.className = "online-user-identity";
    const name = document.createElement("strong"); name.textContent = user.name || "مستخدم ونس";
    const email = document.createElement("span"); email.textContent = user.email || "";
    identity.append(name, email);
    const status = document.createElement("span"); status.className = "online-status"; status.textContent = "متصل الآن";
    const details = document.createElement("div"); details.className = "online-user-details";
    for (const [label, value] of [
      ["آخر نشاط", formatPresenceTime(user.lastSeenAt)],
      ["تاريخ التسجيل", formatPresenceTime(user.accountCreatedAt)],
      ["الجلسات", Number(user.activeSessions || 0).toLocaleString("ar-EG")],
      ["الرسائل المحفوظة", Number(user.messageCount || 0).toLocaleString("ar-EG")]
    ]) {
      const item = document.createElement("span"); item.textContent = label + ": " + value; details.append(item);
    }
    card.append(identity, status, details); list.append(card);
  }
}
async function refreshDiagnostics() {
  const button = $("refreshDiagnosticsBtn");
  if (button) button.disabled = true;
  try {
    const data = await request("/api/admin/diagnostics");
    const counts = data.counts || {};
    renderOnlineUsers(data.onlineUsers);
    const features = data.features || {};
    const tables = data.tables || {};
    setMetric("metricUsers", counts.users);
    setMetric("metricAccountsEntered", counts.accountsEntered);
    setMetric("metricSuccessfulLogins", counts.successfulLogins);
    setMetric("metricSessions", counts.activeSessions);
    setMetric("metricMessages", counts.messages);
    setMetric("metricTasks", counts.activeAgentTasks);
    setMetric("metricTools", data.agent?.toolCount);
    setDiagnostic("diagWorkersAI", features.workersAI ? "مربوط" : "غير مربوط", !!features.workersAI);
    setDiagnostic("diagDatabase", features.databaseConnected ? "متصلة" : "غير متصلة", !!features.databaseConnected);
    setDiagnostic("diagVoice", features.deviceVoiceFallback ? "صوت الهاتف — يلزم اختبار فعلي" : "غير مهيأ", !!features.deviceVoiceFallback);
    setDiagnostic("diagDocuments", features.freeDocumentParsing ? "استخراج محلي مجاني — اختبر ملفًا" : "غير متاح", !!features.freeDocumentParsing);
    setDiagnostic("diagBrowser", features.browserConfigured ? "الربط موجود — لم يُختبر التصفح" : "غير مربوط", !!features.browserConfigured);
    setDiagnostic("diagTables", tables.missing?.length ? "جداول ناقصة: " + tables.missing.join("، ") : "الجداول الأساسية موجودة", !(tables.missing?.length));
    const when = data.checkedAt ? new Date(data.checkedAt).toLocaleString("ar-EG") : "";
    $("diagnosticsStatus").textContent = "اكتمل فحص الأرقام والإعدادات الإجمالية " + when + ". لا يتضمن الفحص محتوى محادثات أو أسرارًا.";
    await refreshRegisteredUsers(false);
  } catch (error) {
    $("diagnosticsStatus").textContent = error.message || "تعذّر جلب تشخيص الخادم.";
  } finally {
    if (button) button.disabled = false;
  }
}
async function showDashboard() {
  $("adminGate").hidden = true;
  $("adminApp").hidden = false;
  try {
    await loadSettings();
    await Promise.all([refreshStatus(), refreshDiagnostics()]);
  } catch (error) { serviceMessage(error.message, true); }
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
$("refreshDiagnosticsBtn").addEventListener("click", refreshDiagnostics);
$("refreshOnlineUsersBtn")?.addEventListener("click", refreshDiagnostics);
$("usersSearchBtn")?.addEventListener("click", () => refreshRegisteredUsers(true));
$("usersSearchInput")?.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); refreshRegisteredUsers(true); }
});
$("usersPrevBtn")?.addEventListener("click", () => {
  registeredUsersOffset = Math.max(0, registeredUsersOffset - registeredUsersPageSize);
  refreshRegisteredUsers(false);
});
$("usersNextBtn")?.addEventListener("click", () => {
  if (registeredUsersOffset + registeredUsersPageSize < registeredUsersTotal) {
    registeredUsersOffset += registeredUsersPageSize;
    refreshRegisteredUsers(false);
  }
});
setInterval(() => { if (!$("adminApp")?.hidden) refreshDiagnostics(); }, 30000);
$("testAgentBtn").addEventListener("click", async () => {
  const button = $("testAgentBtn");
  button.disabled = true;
  $("agentTestStatus").textContent = "جاري اختبار استجابة الوكيل وأداة الحساب...";
  $("agentTestSteps").textContent = "";
  $("agentTestReply").textContent = "";
  try {
    const result = await request("/api/admin/test-agent", {}, "POST");
    const steps = Array.isArray(result.steps) ? result.steps : [];
    $("agentTestSteps").textContent = steps.join("\n");
    $("agentTestReply").textContent = result.reply || "";
    if (result.calculatorToolUsed) {
      $("agentTestStatus").textContent = "نجح الاختبار: الوكيل رد ونفّذ أداة الحساب ✓";
      $("agentTestStatus").style.color = "#9be7c1";
    } else {
      $("agentTestStatus").textContent = "وصل رد من النموذج، لكن لم يثبت استخدام أداة الحساب. لا نعتبر اختبار الوكيل كاملًا.";
      $("agentTestStatus").style.color = "#ffcf8f";
    }
  } catch (error) {
    $("agentTestStatus").textContent = error.message || "فشل اختبار الوكيل.";
    $("agentTestStatus").style.color = "#ff9fba";
  } finally { button.disabled = false; }
});
function updateDocumentTestButton() {
  $("testDocumentBtn").disabled = !(
    $("documentTestFile").files?.[0] && $("documentTestConsent").checked
  );
}
$("documentTestFile").addEventListener("change", updateDocumentTestButton);
$("documentTestConsent").addEventListener("change", updateDocumentTestButton);
$("testDocumentBtn").addEventListener("click", async () => {
  const file = $("documentTestFile").files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    $("documentTestStatus").textContent = "الحد الأقصى لحجم الملف في هذا الاختبار 8 ميجابايت.";
    $("documentTestStatus").style.color = "#ff9fba";
    return;
  }
  const extension = String(file.name.split(".").pop() || "").toLowerCase();
  const types = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  if (!types[extension]) {
    $("documentTestStatus").textContent = "اختَر PDF أو DOCX أو XLSX أو PPTX.";
    $("documentTestStatus").style.color = "#ff9fba";
    return;
  }
  const button = $("testDocumentBtn");
  button.disabled = true;
  $("documentTestResult").textContent = "";
  $("documentTestStatus").textContent = "جاري استخراج الملف محليًا على خادم ونس دون إرساله إلى خدمة مدفوعة...";
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("تعذّرت قراءة الملف من الهاتف."));
      reader.readAsDataURL(file);
    });
    const data = dataUrl.split(",")[1] || "";
    if (!data) throw new Error("الملف المرفق لا يحتوي على بيانات قابلة للقراءة.");
    const result = await request("/api/admin/test-document", {
      name: file.name, type: types[extension], data
    }, "POST");
    $("documentTestResult").textContent =
      "الملف: " + result.name + "\nمحرك الاستخراج: " + (result.source || result.model) +
      "\nعدد الحروف المستخرجة: " + result.extractedCharacters +
      "\n\nمقتطف من المحتوى:\n" + result.preview;
    $("documentTestStatus").textContent = "نجح الاستخراج المحلي المجاني. راجع المقتطف مقابل الملف الأصلي.";
    $("documentTestStatus").style.color = "#9be7c1";
  } catch (error) {
    $("documentTestStatus").textContent = error.message || "فشل اختبار قراءة الملف.";
    $("documentTestStatus").style.color = "#ff9fba";
  } finally {
    updateDocumentTestButton();
  }
});
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
["voiceRate"].forEach(id => $(id).addEventListener("input", updateRanges));
$("copySearch").addEventListener("input", () => renderCopyEditor($("copySearch").value));
$("copyPreviewBtn").addEventListener("click", () => {
  readForm();
  applyOwnerCopy();
  const parentPreviewReady = window.parent && window.parent !== window &&
    typeof window.parent.WensApplyCopyPreview === "function";
  if (parentPreviewReady) window.parent.WensApplyCopyPreview(config.uiCopy);
  $("copyEditorStatus").textContent = parentPreviewReady
    ? "تمت معاينة المسودة في واجهة ونس ولوحة المالك الحالية فقط. لم يتم الحفظ على الخادم."
    : "تمت معاينة نصوص لوحة المالك الحالية. افتح اللوحة من داخل ونس لمعاينة الواجهة الرئيسية أيضًا.";
});
$("copyResetDraftBtn").addEventListener("click", () => {
  if (!confirm("إرجاع جميع نصوص المحرر إلى القيم الأصلية في المسودة؟")) return;
  config.uiCopy = { ...defaults.uiCopy };
  renderCopyEditor($("copySearch").value);
  $("copyEditorStatus").textContent = "تم إرجاع المسودة للقيم الأصلية. اضغط حفظ التعديلات لاعتمادها.";
});
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
async function refreshSettingsHistory() {
  const list = $("settingsHistoryList");
  const button = $("refreshSettingsHistoryBtn");
  button.disabled = true;
  list.textContent = "جاري تحميل سجل التعديلات...";
  try {
    const data = await request("/api/admin/settings/history");
    list.replaceChildren();
    const revisions = Array.isArray(data.revisions) ? data.revisions : [];
    if (!revisions.length) {
      list.textContent = "لا توجد نسخ سابقة محفوظة حتى الآن.";
      return;
    }
    for (const revision of revisions) {
      const row = document.createElement("div");
      row.className = "actions left-actions";
      row.style.cssText = "justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#ddd)";
      const label = document.createElement("span");
      label.textContent = new Date(revision.createdAt * 1000).toLocaleString("ar-EG") + " · " + (revision.actor || "مالك التطبيق");
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn secondary";
      restore.textContent = "استرجاع هذه النسخة";
      restore.addEventListener("click", async () => {
        if (!confirm("استرجاع هذه النسخة سيستبدل الإعدادات الحالية لكل مستخدمي ونس. هل تريد المتابعة؟")) return;
        restore.disabled = true;
        try {
          const result = await request("/api/admin/settings/restore", { revisionId: revision.id }, "POST");
          config = normalize(result.settings);
          fillSettingsForm();
          const preview = $("avatarPreview");
          if (preview) preview.src = config.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
          $("backupStatus").textContent = "تم استرجاع النسخة المحددة، وحُفظت الحالة السابقة في السجل.";
          await refreshSettingsHistory();
        } catch (error) {
          $("backupStatus").textContent = error.message || "تعذّر استرجاع النسخة.";
          restore.disabled = false;
        }
      });
      row.append(label, restore);
      list.append(row);
    }
  } catch (error) {
    list.textContent = error.message || "تعذّر تحميل سجل التعديلات.";
  } finally {
    button.disabled = false;
  }
}
$("refreshSettingsHistoryBtn").addEventListener("click", refreshSettingsHistory);


$("voicePreviewBtn").addEventListener("click", async () => {
  $("voicePreviewBtn").disabled = true;
  $("voiceConfirmBtn").hidden = true;
  $("voicePreviewStatus").textContent = "جاري البحث عن صوت مصري مثبت على الهاتف...";
  try {
    const play = window.parent && window.parent.WensPlayVoicePreview;
    if (typeof play !== "function") throw new Error("افتح لوحة الإدارة من داخل صفحة ونس لتشغيل العينة.");
    const started = await play("أهلًا بيك، أنا ونس. سعيدة إني أكون معاك النهارده.");
    if (!started) throw new Error("صوت مصري ar-EG مش مثبت على الهاتف أو تعذّر تشغيله.");
    $("voiceConfirmBtn").hidden = false;
    $("voicePreviewStatus").textContent = "تم تشغيل عينة صوت الهاتف. اسمعها فعلًا ثم أكّد السماع هنا.";
    $("voicePreviewStatus").style.color = "#ffcf8f";
  } catch (error) {
    $("voicePreviewStatus").textContent = error.message || "تعذّر اختبار الصوت.";
    $("voicePreviewStatus").style.color = "#ff9fba";
  } finally {
    $("voicePreviewBtn").disabled = false;
  }
});
$("voiceConfirmBtn").addEventListener("click", () => {
  $("voicePreviewStatus").textContent = "أكّدت سماع صوت ونس المصري من الهاتف فعليًا.";
  $("voicePreviewStatus").style.color = "#9be7c1";
  $("voiceConfirmBtn").hidden = true;
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