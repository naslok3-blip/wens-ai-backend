const $ = id => document.getElementById(id);
// إدارة ونس تفتح من الصورة الشخصية فقط، داخل الصفحة نفسها.
let authMode = "login";
let currentUser = null;
let recognition = null;
const appSettings = loadLocalSettings();

function loadLocalSettings() {
  const defaults = {
    appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
    welcomeTitle: "أهلًا بيك، أنا ونس 💜",
    welcomeText: "اتكلم معايا واسألني اللي في بالك.",
    greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
    voiceButton: "اتكلم معايا",
    voiceRate: 0.96, voicePitch: 1.12, theme: "purple",
    enableVoice: true, voiceLocale: "ar-EG"
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
  $("logoutBtn").hidden = true;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = true;
}
function showApp(user) {
  currentUser = user;
  $("authPanel").hidden = true;
  $("appRoot").hidden = false;
  $("logoutBtn").hidden = false;
  $("openAdminBtn").hidden = false;
  $("accountLabel").textContent = user.id === "guest"
    ? "وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات"
    : "مسجّل الدخول: " + user.name;
  loadChatHistory();
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
function addMessage(text, who = "assistant", steps = []) {
  const row = document.createElement("div");
  row.className = "message " + who;
  if (who === "assistant") {
    const avatar = document.createElement("img");
    avatar.className = "mini-avatar";
    avatar.src = "avatar.svg";
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
  document.querySelector(".send-btn").textContent = busy ? "ونس بتفكر…" : "إرسال";
}
$("chatForm").addEventListener("submit", async event => {
  event.preventDefault();
  const message = $("messageInput").value.trim();
  if (!message || !currentUser) return;
  addMessage(message, "user");
  $("messageInput").value = "";
  setBusy(true);
  try {
    const data = await api("/api/chat", { message });
    addMessage(data.reply, "assistant", data.steps || []);
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
