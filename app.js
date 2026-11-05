const $ = id => document.getElementById(id);
// إدارة ونس تفتح من الصورة الشخصية فقط، داخل الصفحة نفسها.
let authMode = "login";
let currentUser = null;
let recognition = null;
let pendingAttachments = [];
let deepThinkEnabled = false;
const appSettings = loadLocalSettings();

function loadLocalSettings() {
  const defaults = {
    appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
    welcomeTitle: "أهلًا بيك، أنا ونس 💜",
    welcomeText: "اتكلم معايا واسألني اللي في بالك.",
    greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
    voiceButton: "اتكلم معايا",
    voiceRate: 0.96, voicePitch: 1.12, theme: "purple",
    enableVoice: true, voiceLocale: "ar-EG", avatarDataUrl: ""
  };
  try {
    const saved = JSON.parse(localStorage.getItem("wensAISettings") || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
    return {
      ...defaults,
      ...Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
        key in defaults && typeof value === typeof defaults[key]
      ))
    };
  } catch { return defaults; }
}

function applyLocalSettings() {
  document.title = appSettings.appName;
  $("brandName").textContent = appSettings.appName;
  $("eyebrowText").textContent = appSettings.eyebrow;
  $("welcomeTitle").textContent = appSettings.welcomeTitle;
  $("welcomeText").textContent = appSettings.welcomeText;
  $("voiceButtonText").textContent = appSettings.voiceButton;
  $("voiceBtn").hidden = !appSettings.enableVoice;
  const avatarSrc = appSettings.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
  const portrait = $("heroPortrait");
  if (portrait) portrait.src = avatarSrc;
  document.querySelectorAll(".mini-avatar").forEach(image => { image.src = avatarSrc; });
  const themes = {
    purple: ["#b49aff", "#ffacd6"],
    blue: ["#83baff", "#8ce8ef"],
    green: ["#8cddb4", "#c5ed9a"],
    rose: ["#ff9fc1", "#ffc4a6"]
  };
  const colors = themes[appSettings.theme] || themes.purple;
  document.documentElement.style.setProperty("--purple", colors[0]);
  document.documentElement.style.setProperty("--pink", colors[1]);
}

async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || "حصل خطأ في الاتصال بالخادم.");
  return data;
}
function setAuthMessage(message, error = false) {
  $("authStatus").textContent = message || "";
  $("authStatus").style.color = error ? "#ff9fba" : "#9be7c1";
}
function showAuth() {
  $("authPanel").hidden = false;
  $("appRoot").hidden = true;
  $("adminInlinePanel").hidden = true;
  $("logoutBtn").hidden = true;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = true;
}
function showApp(user) {
  currentUser = user;
  $("authPanel").hidden = true;
  $("appRoot").hidden = false;
  $("adminInlinePanel").hidden = true;
  $("logoutBtn").hidden = false;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = true;
  $("accountLabel").textContent = user.id === "guest"
    ? "وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات"
    : "مسجّل الدخول: " + user.name;
  updateAdminShortcut();
  loadChatHistory();
}
async function updateAdminShortcut() {
  // الإدارة لا تظهر كزر عام؛ مدخلها المخفي هو الضغط خمس مرات على صورة ونس.
  $("openAdminBtn").hidden = true;
}
function openAdminInsideWens() {
  $("appRoot").hidden = true;
  $("authPanel").hidden = true;
  $("adminInlinePanel").hidden = false;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = false;
  const frame = $("adminFrame");
  if (!frame.dataset.loaded) {
    frame.src = "/admin.html?embed=1&v=single-entry-20261104";
    frame.dataset.loaded = "true";
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function returnToWensChat() {
  $("adminInlinePanel").hidden = true;
  $("appRoot").hidden = false;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$("openAdminBtn").addEventListener("click", openAdminInsideWens);
$("backToAppBtn").addEventListener("click", returnToWensChat);

let adminAvatarTapCount = 0;
let adminAvatarTapTimer = null;
async function handleAdminAvatarTap() {
  if (!currentUser || currentUser.id === "guest") return;
  adminAvatarTapCount += 1;
  if (adminAvatarTapTimer) clearTimeout(adminAvatarTapTimer);
  adminAvatarTapTimer = setTimeout(() => { adminAvatarTapCount = 0; }, 3000);
  if (adminAvatarTapCount < 5) return;
  adminAvatarTapCount = 0;
  clearTimeout(adminAvatarTapTimer);
  adminAvatarTapTimer = null;
  try {
    const session = await api("/api/admin/session", undefined, "GET");
    if (session.owner) openAdminInsideWens();
    else $("voiceStatus").textContent = "هذا المدخل مخصص لمالك التطبيق فقط.";
  } catch {
    $("voiceStatus").textContent = "تعذّر التحقق من صلاحية الإدارة الآن.";
  }
}
const adminPortrait = $("heroPortrait");
if (adminPortrait) {
  adminPortrait.addEventListener("click", handleAdminAvatarTap);
  adminPortrait.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleAdminAvatarTap();
    }
  });
}

function updateAuthMode() {
  const registering = authMode === "register";
  $("nameField").hidden = !registering;
  $("authTitle").textContent = registering ? "إنشاء حساب ونس" : "أهلًا بيك في ونس";
  $("authSubmit").textContent = registering ? "إنشاء الحساب" : "تسجيل الدخول";
  $("authToggle").textContent = registering ? "عندي حساب بالفعل" : "إنشاء حساب جديد";
  $("passwordInput").autocomplete = registering ? "new-password" : "current-password";
}
$("authToggle").addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  updateAuthMode();
  setAuthMessage("");
});
$("authForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("authSubmit").disabled = true;
  setAuthMessage("جاري التحقق من الحساب...");
  const body = {
    email: $("emailInput").value.trim(),
    password: $("passwordInput").value,
    name: $("nameInput").value.trim()
  };
  try {
    const data = await api(authMode === "register" ? "/api/auth/register" : "/api/auth/login", body);
    $("passwordInput").value = "";
    showApp(data.user);
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    $("authSubmit").disabled = false;
  }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout", {}); } catch {}
  currentUser = null;
  $("messages").replaceChildren();
  showAuth();
  setAuthMessage("تم تسجيل الخروج.");
});
async function loadChatHistory() {
  $("messages").replaceChildren();
  try {
    const data = await api("/api/chat/history", undefined, "GET");
    for (const item of data.messages || []) addMessage(item.content, item.role);
    if (!(data.messages || []).length) addMessage(appSettings.greeting);
  } catch (error) {
    addMessage("تعذّر تحميل المحادثة: " + error.message);
  }
}
function appendMessageText(container, text) {
  const source = String(text ?? "");
  const pattern = /\[([^\]\n]{1,100})\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s<>"']+)/g;
  let cursor = 0, match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    }
    const label = match[1] || "";
    const rawUrl = match[2] || match[3];
    const suffix = match[3] ? (rawUrl.match(/[),.!?؟،؛]+$/)?.[0] || "") : "";
    const href = suffix ? rawUrl.slice(0, -suffix.length) : rawUrl;
    try {
      const parsed = new URL(href);
      if (parsed.protocol === "https:") {
        const link = document.createElement("a");
        link.href = parsed.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = label || href;
        container.appendChild(link);
        if (suffix) container.appendChild(document.createTextNode(suffix));
      } else {
        container.appendChild(document.createTextNode(match[0]));
      }
    } catch {
      container.appendChild(document.createTextNode(match[0]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}
function addMessage(text, who = "assistant", steps = [], attachments = [], generatedImages = []) {
  const row = document.createElement("div");
  row.className = "message " + who;
  if (who === "assistant") {
    const avatar = document.createElement("img");
    avatar.className = "mini-avatar";
    avatar.src = appSettings.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
    avatar.alt = "ونس";
    avatar.width = 30;
    avatar.height = 30;
    row.appendChild(avatar);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const content = document.createElement("div");
  content.className = "bubble-text";
  appendMessageText(content, text);
  bubble.appendChild(content);
  if (Array.isArray(attachments) && attachments.length) {
    const media = document.createElement("div");
    media.className = "message-attachments";
    for (const item of attachments.slice(0, 4)) {
      if (item.kind === "image" && item.dataUrl) {
        const image = document.createElement("img");
        image.src = item.dataUrl;
        image.alt = item.name || "صورة مرفقة";
        image.loading = "lazy";
        media.appendChild(image);
      } else {
        const name = document.createElement("span");
        name.className = "message-attachment-name";
        name.textContent = "📎 " + String(item.name || "ملف").slice(0, 100);
        media.appendChild(name);
      }
    }
    bubble.appendChild(media);
  }
  if (who === "assistant" && Array.isArray(generatedImages) && generatedImages.length) {
    const media = document.createElement("div");
    media.className = "message-attachments";
    for (const item of generatedImages.slice(0, 1)) {
      if (!item || typeof item.dataUrl !== "string" || !item.dataUrl.startsWith("data:image/")) continue;
      const image = document.createElement("img");
      image.src = item.dataUrl;
      image.alt = item.name || "صورة من ونس";
      image.loading = "lazy";
      media.appendChild(image);
      const save = document.createElement("a");
      save.className = "message-attachment-name";
      save.href = item.dataUrl;
      save.download = String(item.name || "wens-ai-image") + ".jpg";
      save.textContent = "حفظ الصورة";
      media.appendChild(save);
    }
    if (media.childNodes.length) bubble.appendChild(media);
  }
  if (who === "assistant" && Array.isArray(steps) && steps.length) {
    const trace = document.createElement("details");
    trace.className = "execution-trace";
    const summary = document.createElement("summary");
    summary.textContent = "خطوات التنفيذ (" + steps.length + ")";
    const list = document.createElement("ul");
    for (const item of steps.slice(0, 14)) {
      const li = document.createElement("li");
      li.textContent = String(item);
      list.appendChild(li);
    }
    trace.append(summary, list);
    bubble.appendChild(trace);
  }
  row.appendChild(bubble);
  $("messages").appendChild(row);
  $("messages").scrollTop = $("messages").scrollHeight;
  return row;
}
function setBusy(busy) {
  document.querySelector(".send-btn").disabled = busy;
  $("messageInput").disabled = busy;
  $("attachMenuBtn").disabled = busy;
  document.querySelector(".send-btn").textContent = busy ? "ونس بتفكر…" : "إرسال";
}
function setAttachmentStatus(message, error = false) {
  $("attachmentStatus").textContent = message || "";
  $("attachmentStatus").style.color = error ? "#ffb5c9" : "#a9efc7";
}
function closeAttachmentMenu() {
  $("attachmentMenu").hidden = true;
  $("pluginTools").hidden = true;
  $("attachMenuBtn").setAttribute("aria-expanded", "false");
  $("attachMenuBtn").classList.remove("active");
  document.querySelector('[data-action="plugins"]')?.setAttribute("aria-expanded", "false");
}
function updateDeepThinkUI() {
  const option = document.querySelector('[data-action="deep"]');
  option.setAttribute("aria-pressed", String(deepThinkEnabled));
  $("deepThinkCheck").hidden = !deepThinkEnabled;
  $("deepThinkBadge").hidden = !deepThinkEnabled;
}
function showAttachmentMenu() {
  $("attachmentMenu").hidden = false;
  $("pluginTools").hidden = true;
  $("attachMenuBtn").setAttribute("aria-expanded", "true");
  $("attachMenuBtn").classList.add("active");
}
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("تعذّرت قراءة الملف من الهاتف."));
    reader.readAsDataURL(file);
  });
}
function renderAttachmentPreview() {
  const preview = $("attachmentsPreview");
  preview.replaceChildren();
  preview.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((item, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (item.kind === "image" && item.dataUrl) {
      const img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = item.name;
      chip.appendChild(img);
    } else {
      const icon = document.createElement("b");
      icon.textContent = item.kind === "text" ? "TXT" : "📎";
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.textContent = item.name + (item.kind === "file" ? " (اسم الملف فقط)" : "");
    chip.appendChild(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "إزالة " + item.name);
    remove.addEventListener("click", () => {
      pendingAttachments.splice(index, 1);
      renderAttachmentPreview();
      setAttachmentStatus("");
    });
    chip.appendChild(remove);
    preview.appendChild(chip);
  });
}
async function addSelectedFile(file) {
  if (!file) return;
  if (pendingAttachments.length >= 4) {
    setAttachmentStatus("يمكنك إرفاق 4 ملفات كحد أقصى في الرسالة الواحدة.", true);
    return;
  }
  const isImage = file.type.startsWith("image/");
  if (isImage) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setAttachmentStatus("نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP.", true);
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setAttachmentStatus("حجم الصورة أكبر من 4 ميجابايت. اختر صورة أصغر.", true);
      return;
    }
    if (pendingAttachments.some(item => item.kind === "image")) {
      setAttachmentStatus("أرفق صورة واحدة في كل رسالة حاليًا.", true);
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("تعذّر تجهيز الصورة للمعالجة.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const optimizedBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("تعذّر ضغط الصورة.")), "image/jpeg", 0.88);
      });
      const [dataUrl, previewUrl] = await Promise.all([
        readAsDataUrl(optimizedBlob),
        readAsDataUrl(file)
      ]);
      pendingAttachments.push({
        kind: "image", name: file.name || "صورة",
        type: "image/jpeg", size: optimizedBlob.size,
        data: dataUrl.split(",")[1], dataUrl: previewUrl
      });
      setAttachmentStatus("الصورة جاهزة للتحليل والتعديل بالذكاء الاصطناعي.");
    } catch (error) { setAttachmentStatus(error.message, true); }
  } else {
    const extension = String(file.name.split(".").pop() || "").toLowerCase();
    const textExtensions = ["txt","md","csv","json","xml","html","js","css","log"];
    if (textExtensions.includes(extension)) {
      if (file.size > 150 * 1024) {
        setAttachmentStatus("الملف النصي أكبر من 150 كيلوبايت.", true);
        return;
      }
      try {
        const text = await file.text();
        pendingAttachments.push({
          kind: "text", name: file.name, type: file.type || "text/plain",
          size: file.size, text
        });
        setAttachmentStatus("تم إرفاق الملف النصي وقراءته.");
      } catch (error) { setAttachmentStatus("تعذّرت قراءة الملف النصي.", true); }
    } else {
      pendingAttachments.push({
        kind: "file", name: file.name, type: file.type || "application/octet-stream",
        size: file.size
      });
      setAttachmentStatus("تم إرفاق اسم الملف. قراءة محتوى PDF وWord وExcel غير مفعّلة بعد.");
    }
  }
  renderAttachmentPreview();
}
$("attachMenuBtn").addEventListener("click", () => {
  if (!$("attachmentMenu").hidden || !$("pluginTools").hidden) closeAttachmentMenu();
  else showAttachmentMenu();
});
$("attachmentMenu").addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "camera") { closeAttachmentMenu(); $("cameraInput").click(); }
  else if (action === "photos") { closeAttachmentMenu(); $("photosInput").click(); }
  else if (action === "files") { closeAttachmentMenu(); $("filesInput").click(); }
  else if (action === "plugins") {
    $("attachmentMenu").hidden = true;
    $("pluginTools").hidden = false;
    button.setAttribute("aria-expanded", "true");
  } else if (action === "deep") {
    deepThinkEnabled = !deepThinkEnabled;
    updateDeepThinkUI();
    closeAttachmentMenu();
    setAttachmentStatus(deepThinkEnabled ? "التفكير العميق مفعّل للرسالة التالية." : "تم إيقاف التفكير العميق.");
  }
});
$("backToAttachmentMenu").addEventListener("click", () => {
  $("pluginTools").hidden = true;
  $("attachmentMenu").hidden = false;
  document.querySelector('[data-action="plugins"]')?.setAttribute("aria-expanded", "false");
});
$("pluginTools").addEventListener("click", event => {
  const button = event.target.closest("[data-plugin-prompt]");
  if (!button) return;
  $("messageInput").value = button.dataset.pluginPrompt;
  closeAttachmentMenu();
  $("messageInput").focus();
});
$("disableDeepThink").addEventListener("click", () => {
  deepThinkEnabled = false;
  updateDeepThinkUI();
  setAttachmentStatus("تم إيقاف التفكير العميق.");
});
document.addEventListener("click", event => {
  if (!event.target.closest(".chat-composer")) closeAttachmentMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeAttachmentMenu();
});
for (const inputId of ["cameraInput", "photosInput", "filesInput"]) {
  $(inputId).addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);
    for (const file of files) await addSelectedFile(file);
    event.target.value = "";
    closeAttachmentMenu();
  });
}
function clearPendingAttachments() {
  pendingAttachments = [];
  renderAttachmentPreview();
  setAttachmentStatus("");
}
function attachmentPayload() {
  return pendingAttachments.map(item => {
    if (item.kind === "image") return {
      kind: item.kind, name: item.name, type: item.type, data: item.data
    };
    if (item.kind === "text") return {
      kind: item.kind, name: item.name, type: item.type, text: item.text
    };
    return { kind: "file", name: item.name, type: item.type, size: item.size };
  });
}
$("chatForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = $("messageInput").value.trim();
  if ((!message && !pendingAttachments.length) || !currentUser) return;
  const selected = pendingAttachments.slice();
  const text = message || (selected.some(item => item.kind === "image")
    ? "افحص الصورة المرفقة واشرح لي ما يظهر فيها."
    : "ساعدني في قراءة المرفقات المرسلة.");
  addMessage(text, "user", [], selected);
  const payload = attachmentPayload();
  const deepThink = deepThinkEnabled;
  $("messageInput").value = "";
  clearPendingAttachments();
  closeAttachmentMenu();
  setBusy(true);
  try {
    const data = await api("/api/chat", {
      message: text, attachments: payload, deepThink
    });
    addMessage(data.reply, "assistant", data.steps || [], [], data.generatedImages || []);
    speak(data.reply);
  } catch (error) {
    addMessage("معلش، مش قادرة أكمل دلوقتي. " + error.message);
  } finally {
    setBusy(false);
    $("messageInput").focus();
  }
});
$("clearBtn").addEventListener("click", () => {
  $("messages").replaceChildren();
  addMessage("تم مسح عرض المحادثة من الشاشة. سجل الرسائل المحفوظ في الحساب لم يُحذف.");
});
function speak(text) {
  if (window.WensNative && typeof window.WensNative.speak === "function") {
    window.WensNative.speak(String(text));
    return;
  }
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = appSettings.voiceLocale;
  utterance.rate = Math.min(1.35, Math.max(0.65, Number(appSettings.voiceRate) || 0.96));
  utterance.pitch = Math.min(1.5, Math.max(0.7, Number(appSettings.voicePitch) || 1.12));
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(v => v.lang.toLowerCase().startsWith("ar-eg")) || voices.find(v => v.lang.toLowerCase().startsWith("ar")) || null;
  utterance.onstart = () => { document.querySelector(".orb")?.classList.add("talking"); document.querySelector(".face")?.classList.add("talking"); };
  const stopAvatarSpeech = () => { document.querySelector(".orb")?.classList.remove("talking"); document.querySelector(".face")?.classList.remove("talking"); };
  utterance.onend = stopAvatarSpeech;
  utterance.onerror = stopAvatarSpeech;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}
$("voiceBtn").addEventListener("click", () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("voiceStatus").textContent = "التعرّف على الكلام مش مدعوم في المتصفح ده؛ استخدم الكتابة.";
    return;
  }
  if (recognition) { recognition.stop(); return; }
  recognition = new SpeechRecognition();
  recognition.lang = appSettings.voiceLocale;
  recognition.interimResults = false;
  recognition.onstart = () => { $("voiceStatus").textContent = "سامعاك... اتكلم دلوقتي 🎙️"; $("voiceBtn").classList.add("listening"); };
  recognition.onresult = event => { $("messageInput").value = event.results[0][0].transcript; $("chatForm").requestSubmit(); };
  recognition.onerror = event => { $("voiceStatus").textContent = event.error === "not-allowed" ? "اسمح باستخدام الميكروفون من إعدادات الجهاز." : "ماقدرتش ألتقط الكلام؛ جرّب تاني."; };
  recognition.onend = () => { recognition = null; $("voiceBtn").classList.remove("listening"); };
  recognition.start();
});

async function loadSystemStatus() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    const f = data.features || {};
    const labels = [
      "Cloudflare AI " + (f.workersAI ? "جاهز" : "غير مربوط"),
      "قاعدة البيانات " + (f.database ? "جاهزة" : "غير مربوطة")
    ];
    $("systemStatus").textContent = labels.concat(f.browser ? "متصفح المواقع جاهز" : "متصفح المواقع غير مربوط").join(" · ");
    $("systemStatus").classList.toggle("all-ready", !!(f.workersAI && f.database));
    return data;
  } catch {
    $("systemStatus").textContent = "تعذّر فحص حالة الخادم.";
    return null;
  }
}
async function loadServerSettings() {
  try {
    const data = await api("/api/settings", undefined, "GET");
    if (data.settings && typeof data.settings === "object") Object.assign(appSettings, data.settings);
  } catch {}
  applyLocalSettings();
}
async function boot() {
  applyLocalSettings();
  await loadServerSettings();
  updateAuthMode();
  const health = await loadSystemStatus();
  if (health && health.ok && health.features && !health.features.database) {
    showApp({ id: "guest", name: "زائر" });
    return;
  }
  try {
    const data = await api("/api/auth/me", undefined, "GET");
    showApp(data.user);
  } catch {
    showAuth();
  }
}
boot();
