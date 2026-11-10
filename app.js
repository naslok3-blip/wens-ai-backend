const $ = id => document.getElementById(id);
const setVoiceStatus = message => { const status = $("voiceStatus"); if (status) status.textContent = message || ""; };
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
    voiceRate: 0.96, theme: "purple",
    enableVoice: true, autoSpeak: true, voiceLocale: "ar-EG", avatarDataUrl: "", voiceEngine: "device", voiceName: "device"
  };
  try {
    const saved = JSON.parse(localStorage.getItem("wensAISettings") || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return defaults;
    return {
      ...defaults,
      ...Object.fromEntries(Object.entries(saved).filter(([key, value]) =>
        key in defaults && typeof value === typeof defaults[key] && ((key !== "voiceEngine" || value === "device") && (key !== "voiceLocale" || value === "ar-EG") && (key !== "voiceName" || value === "device"))
      ))
    };
  } catch { return defaults; }
}

function applyLocalSettings() {
  document.title = appSettings.appName;
  const brandName = $("brandName");
  if (brandName) brandName.textContent = appSettings.appName;
  const voiceButtonText = $("voiceButtonText");
  if (voiceButtonText) voiceButtonText.textContent = appSettings.voiceButton;
  const voiceButton = $("voiceBtn");
  if (voiceButton) voiceButton.hidden = !appSettings.enableVoice;
  const avatarSrc = appSettings.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
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

let notificationItems = [];
async function refreshNotifications() {
  const button = $("notificationsBtn");
  if (!currentUser || currentUser.id === "guest" || !button) return;
  try {
    const data = await api("/api/notifications", undefined, "GET");
    notificationItems = Array.isArray(data.notifications) ? data.notifications : [];
    const unread = Number(data.unread || 0);
    $("notificationCount").textContent = unread > 99 ? "99+" : String(unread);
    button.classList.toggle("has-unread", unread > 0);
    const list = $("notificationList");
    if (!list) return;
    list.replaceChildren();
    if (!notificationItems.length) {
      const empty = document.createElement("p");
      empty.className = "notification-empty";
      empty.textContent = "لا توجد إشعارات بعد.";
      list.append(empty);
      return;
    }
    for (const item of notificationItems) {
      const card = document.createElement("article");
      card.className = "notification-item" + (item.read_at ? "" : " unread");
      const title = document.createElement("strong");
      title.textContent = String(item.title || "إشعار ونس");
      const body = document.createElement("p");
      body.textContent = String(item.body || "");
      const time = document.createElement("small");
      time.textContent = item.created_at
        ? new Date(Number(item.created_at) * 1000).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
        : "";
      card.append(title, body, time);
      if (!item.read_at) {
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = "notification-read-btn";
        mark.textContent = "تحديد كمقروء";
        mark.addEventListener("click", async () => {
          mark.disabled = true;
          try {
            await api("/api/notifications", { id: item.id }, "PATCH");
            await refreshNotifications();
          } catch (error) {
            mark.disabled = false;
            $("voiceStatus").textContent = error.message;
          }
        });
        card.append(mark);
      }
      list.append(card);
    }
  } catch (error) {
    const list = $("notificationList");
    if (list) list.textContent = "تعذّر تحميل الإشعارات: " + error.message;
  }
}
function setAuthMessage(message, error = false) {
  $("authStatus").textContent = message || "";
  $("authStatus").style.color = error ? "#ff9fba" : "#9be7c1";
}
let presenceHeartbeatTimer = null;
function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) clearInterval(presenceHeartbeatTimer);
  presenceHeartbeatTimer = null;
}
function startPresenceHeartbeat() {
  stopPresenceHeartbeat();
  if (!currentUser || currentUser.id === "guest") return;
  const ping = () => {
    if (document.visibilityState === "visible") api("/api/auth/presence", {}, "POST").catch(() => {});
  };
  ping();
  presenceHeartbeatTimer = setInterval(ping, 45000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser && currentUser.id !== "guest") {
    api("/api/auth/presence", {}, "POST").catch(() => {});
  }
});
function showAuth() {
  stopPresenceHeartbeat();
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
  $("notificationsBtn").hidden = user.id === "guest";
  $("notificationsPanel").hidden = true;
  startPresenceHeartbeat();
  loadChatHistory();
  if (user.id !== "guest") refreshNotifications();
}
async function updateAdminShortcut() {
  // الإدارة لا تظهر كزر عام؛ مدخلها المخفي هو الضغط خمس مرات على شعار ونس.
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
async function returnToWensChat() {
  $("adminInlinePanel").hidden = true;
  $("appRoot").hidden = false;
  $("openAdminBtn").hidden = true;
  $("backToAppBtn").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
  await loadServerSettings();
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
const adminBrandEntry = $("brandAdminEntry");
if (adminBrandEntry) {
  adminBrandEntry.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    handleAdminAvatarTap();
  });
  adminBrandEntry.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
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
  $("notificationsBtn").hidden = true;
  $("notificationsPanel").hidden = true;
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
function stripInternalToolMarkup(value) {
  return String(value ?? "")
    .replace(/(?:<\s*tool_call\b[^>]*>|tool_call\s*>|<\|tool_call\|>)[\s\S]*?(?:<\s*\/\s*tool_call\s*>|<<\s*\/\s*tool_call\s*>?|<\|tool_call_end\|>|$)/gi, " ")
    .replace(/<\s*\/?\s*arg_key\b[^>]*>/gi, " ")
    .replace(/<\s*\/?\s*arg_value\b[^>]*>/gi, " ")
    .replace(/<\s*\/?\s*arg\b[^>]*>/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function cleanRepeatedReplyText(value) {
  const source = stripInternalToolMarkup(value).replace(/\r\n?/g, "\n").trim();
  if (!source) return "";
  const seen = new Set();
  const output = [];
  let previousBlank = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/[ \t]+$/g, "");
    const trimmed = line.trim();
    if (!trimmed) {
      if (output.length && !previousBlank) output.push("");
      previousBlank = true;
      continue;
    }
    previousBlank = false;
    const key = trimmed
      .replace(/^(?:[-*•▪‣]\s+|\d+[.)]\s+)/u, "")
      .replace(/\s+/g, " ")
      .replace(/[.!؟،,;:؛]+$/u, "")
      .toLocaleLowerCase("ar");
    if (key.length >= 16) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    output.push(line);
  }
  return output.join("\n").trim();
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
function hideExternalLinksFromDisplay(value) {
  let text = String(value ?? "");
  // Keep readable Markdown labels, but never expose external destinations.
  text = text.replace(/\[([^\]]{1,240})\]\(\s*https?:\/\/[^)\s]+(?:\s+"[^"]*")?\s*\)/gi, "$1");
  text = text.replace(/<https?:\/\/[^>\s]+>/gi, "");
  text = text.replace(/https?:\/\/[^\s<>{}\[\]"']+/gi, "");
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/[ \t]+([،؛,.!?؟])/g, "$1");
  text = text.replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function addMessage(text, who = "assistant", steps = [], attachments = [], generatedImages = [], generatedProjects = [], activity = [], sources = []) {
  const displayText = who === "assistant" ? hideExternalLinksFromDisplay(cleanRepeatedReplyText(text)) : String(text ?? "");
  const replyKey = displayText.replace(/\s+/g, " ").trim();
  const messageContainer = $("messages");
  const previousRow = messageContainer.lastElementChild;
  const hasExtras = (steps?.length || attachments?.length || generatedImages?.length || generatedProjects?.length || activity?.length || sources?.length);
  if (who === "assistant" && replyKey && !hasExtras &&
      previousRow?.classList.contains("assistant") && previousRow.dataset.replyKey === replyKey) {
    return previousRow;
  }
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
  appendMessageText(content, displayText);
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
  if (who === "assistant" && Array.isArray(generatedProjects) && generatedProjects.length) {
    for (const project of generatedProjects.slice(0, 2)) {
      if (!project || !/^\/api\/projects\/[0-9a-f-]{36}\/preview$/i.test(String(project.previewPath || "")) || !/^\/api\/projects\/[0-9a-f-]{36}\/download$/i.test(String(project.downloadPath || ""))) continue;
      const card=document.createElement("section"); card.className="generated-project-card";
      const heading=document.createElement("div"); heading.className="generated-project-heading";
      const title=document.createElement("strong"); title.textContent=String(project.title||"مشروع ونس");
      const type=document.createElement("span"); type.textContent=project.kind==="game"?"لعبة":"تطبيق ويب"; heading.append(title,type);
      const preview=document.createElement("iframe"); preview.className="generated-project-preview"; preview.title="معاينة "+String(project.title||"مشروع ونس");
      preview.loading="lazy"; preview.referrerPolicy="no-referrer"; preview.setAttribute("sandbox","allow-scripts"); preview.src=project.previewPath;
      const actions=document.createElement("div"); actions.className="generated-project-actions";
      const open=document.createElement("a"); open.href=project.previewPath; open.target="_blank"; open.rel="noopener noreferrer"; open.textContent="فتح المعاينة";
      const download=document.createElement("a"); download.href=project.downloadPath; download.download=""; download.textContent="تنزيل ملف HTML";
      actions.append(open,download); card.append(heading,preview,actions); bubble.append(card);
    }
  }
  if (who === "assistant" && Array.isArray(activity) && activity.length) {
    const trace = document.createElement("details");
    trace.className = "execution-trace research-trace";
    trace.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "بحث وتنفيذ ونس (" + activity.length + ")";
    const list = document.createElement("ul");
    for (const item of activity.slice(0, 16)) {
      const li = document.createElement("li");
      const status = item?.status === "completed" ? "✓ " : item?.status === "failed" ? "تعذّر " : "• ";
      const label = String(item?.label || "خطوة تنفيذ").slice(0, 120);
      const detail = hideExternalLinksFromDisplay(item?.detail || "").slice(0, 240);
      li.textContent = status + label + (detail ? " — " + detail : "");
      li.className = "trace-" + (item?.status === "failed" ? "failed" : item?.status === "completed" ? "completed" : "pending");
      list.appendChild(li);
    }
    trace.append(summary, list);
    bubble.appendChild(trace);
  } else if (who === "assistant" && Array.isArray(steps) && steps.length) {
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
  if (who === "assistant" && Array.isArray(sources) && sources.length) {
    const sourceTrace = document.createElement("details");
    sourceTrace.className = "execution-trace source-trace";
    sourceTrace.open = false;
    const summary = document.createElement("summary");
    summary.textContent = "مصادر تم التحقق منها (" + sources.length + ")";
    const list = document.createElement("ul");
    const seenSources = new Set();
    for (const item of sources.slice(0, 8)) {
      const label = hideExternalLinksFromDisplay(item?.title || item?.domain || "مصدر موثوق")
        .replace(/[?#].*$/, "").slice(0, 160);
      const key = label.toLocaleLowerCase();
      if (!label || seenSources.has(key)) continue;
      seenSources.add(key);
      const li = document.createElement("li");
      li.textContent = label;
      list.appendChild(li);
    }
    if (list.childNodes.length) {
      sourceTrace.append(summary, list);
      bubble.appendChild(sourceTrace);
    }
  }
  if (who === "assistant" && currentUser && currentUser.id !== "guest" && displayText.trim().length > 1) {
    const feedback = document.createElement("div");
    feedback.className = "reply-feedback";
    feedback.setAttribute("aria-label", "تقييم رد ونس");
    const label = document.createElement("span");
    label.textContent = "هل كان الرد مفيدًا؟";
    const helpful = document.createElement("button");
    helpful.type = "button";
    helpful.textContent = "👍 مفيد";
    helpful.setAttribute("aria-label", "الرد مفيد");
    const notHelpful = document.createElement("button");
    notHelpful.type = "button";
    notHelpful.textContent = "👎 مش مفيد";
    notHelpful.setAttribute("aria-label", "الرد غير مفيد");
    const sendRating = async (rating, chosen, other) => {
      helpful.disabled = true;
      notHelpful.disabled = true;
      try {
        await api("/api/feedback", { reply: displayText, rating });
        chosen.classList.add("selected");
        chosen.textContent = rating === "helpful" ? "✓ شكرًا لتقييمك" : "✓ تم تسجيل ملاحظتك";
        other.hidden = true;
        label.textContent = "تم حفظ تقييمك";
      } catch (error) {
        helpful.disabled = false;
        notHelpful.disabled = false;
        label.textContent = error.message || "تعذّر حفظ التقييم";
      }
    };
    helpful.addEventListener("click", () => sendRating("helpful", helpful, notHelpful));
    notHelpful.addEventListener("click", () => sendRating("not_helpful", notHelpful, helpful));
    feedback.append(label, helpful, notHelpful);
    bubble.appendChild(feedback);
  }
  if (who === "assistant") {
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "voice-replay-btn";
    replay.textContent = "🔊 اسمع رد ونس";
    replay.setAttribute("aria-label", "تشغيل رد ونس صوتيًا");
    replay.addEventListener("click", async () => {
      replay.disabled = true;
      replay.textContent = "جاري تجهيز الصوت…";
      await speak(displayText, null, bubble);
      replay.disabled = false;
      replay.textContent = "🔊 اسمع رد ونس";
    });
    bubble.appendChild(replay);
  }
  row.appendChild(bubble);
  if (who === "assistant") row.dataset.replyKey = replyKey;
  messageContainer.appendChild(row);
  messageContainer.scrollTop = messageContainer.scrollHeight;
  return row;
}
function setBusy(busy) {
  document.querySelector(".send-btn").disabled = busy;
  $("messageInput").disabled = busy;
  $("attachMenuBtn").disabled = busy;
  document.querySelector(".send-btn").textContent = busy ? "ونس بتفكر…" : "إرسال";
}
function pendingActivityLabel(message, attachments = []) {
  const value = String(message || "").trim();
  const normalized = value.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").toLowerCase();
  const explicitSearch = /(?:ابحث|ابحثي|بحث|دور|دوري|المواقع الخارجية|مواقع خارجية|على الانترنت|الانترنت|الويب|search the web|browse the web|look up)/i.test(normalized);
  const question = /[؟?]/.test(value) || /^(?:ما|ماذا|من|مين|متى|امتى|فين|اين|كيف|ازاي|ليه|لماذا|هل|ايه|اشرح|شرح|قارن|افضل|احدث|اخر|اخر\s+اخبار|اخر\s+تحديث|what|who|when|where|why|how|which|is|are|can|should)(?:\s|[؟?!]|$)/i.test(normalized);
  const action = /^(?:انشئ|انشئي|اعمل|اعملي|صمم|صممي|نفذ|نفذي|عدل|عدلي|تعديل|طور|طوري|ابني|اصنع|اصنعي|احفظ|استعيد|ارشف|جهز|جهزي|create|build|edit|update|modify|deploy)(?:لي|لنا)?(?:\s|[؟?!]|$)/i.test(normalized) ||
    /^(?:عايزك|عاوزك|عايزة|عاوزة|عايز|عاوز|محتاج|محتاجة|ممكن)\s+(?:انشئ|انشئي|اعمل|اعملي|صمم|صممي|نفذ|نفذي|عدل|عدلي|طور|طوري|ابني|اصنع|اصنعي|احفظ|استعيد|ارشف|جهز|جهزي|create|build|edit|update|modify|deploy)(?:لي|لنا)?(?:\s|[؟?!]|$)/i.test(normalized) ||
    /(?:عدل|تعديل|حدث|تحدث|تحديث|طور|ارفع|انشر|شغل|تعدل|تحدث|تطور)(?:ي|وا|ت|نا)?\s+(?:ونس|التطبيق|الموقع|الملف|الكود|الخادم|الواجهة|الصورة|الصوره)/i.test(normalized);
  const researchLead = /^(?:ممكن\s+(?:تقولي|تقول|تعرفني|تعرف|تشرحي|تشرح|تدور|تدوري)|عايز(?:ة)?\s+(?:اعرف|اعرفي|معلومات|تفاصيل)|عاوز(?:ة)?\s+(?:اعرف|اعرفي|معلومات|تفاصيل)|محتاج(?:ة)?\s+(?:اعرف|اعرفي|معلومات|تفاصيل)|قولي\s+(?:لي|لنا)?|احكيلي\s+عن|اعرفني\s+على|اتكلم(?:ي)?\s+عن|الفرق\s+بين|مقارنة\s+بين|رشح(?:ي)?\s+لي|رشح(?:ي)?\s+لنا|ما\s+افضل|افضل\s+اختيار|تاريخ\s+تأسيس|تأسس\s+امتى|اخر\s+اخبار|احدث\s+اخبار|اخر\s+تحديث|احدث\s+تحديث|tell me about|can you tell me|find out|compare|recommend|review|difference between)(?:\s|[؟?!]|$)/i.test(normalized);
  if (explicitSearch || ((question || researchLead) && !action)) return "ونس بتبحث في المواقع الخارجية قبل الرد…";
  if (attachments.some(item => item.kind === "image")) return "ونس بتفحص الصورة وبتجهز النتيجة…";
  if (action) return "ونس بتراجع طلبك وبتنفّذ الخطوات المتاحة…";
  return "ونس بتجهّز الرد…";
}
function addPendingActivityMessage(message, attachments = []) {
  const row = document.createElement("div");
  row.className = "message assistant activity-message";
  const avatar = document.createElement("img");
  avatar.className = "mini-avatar";
  avatar.src = appSettings.avatarDataUrl || "/avatar.jpg?v=real-jpg-20261105";
  avatar.alt = "ونس";
  avatar.width = 30;
  avatar.height = 30;
  const bubble = document.createElement("div");
  bubble.className = "bubble activity-bubble";
  const spinner = document.createElement("span");
  spinner.className = "activity-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "activity-label";
  label.textContent = pendingActivityLabel(message, attachments);
  bubble.append(spinner, label);
  row.append(avatar, bubble);
  $("messages").appendChild(row);
  $("messages").scrollTop = $("messages").scrollHeight;
  return row;
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
      icon.textContent = item.kind === "text" ? "TXT" : item.kind === "document" ? "DOC" : "📎";
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.textContent = item.name + (item.kind === "file" ? " (اسم الملف فقط)" : item.kind === "document" ? " (جاهز للقراءة)" : "");
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
      const documentTypes = {
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      };
      if (Object.prototype.hasOwnProperty.call(documentTypes, extension)) {
        if (file.size > 8 * 1024 * 1024) {
          setAttachmentStatus("حجم الملف يتجاوز 8 ميجابايت. اختَر نسخة أصغر.", true);
          return;
        }
        try {
          const dataUrl = await readAsDataUrl(file);
          pendingAttachments.push({
            kind: "document", name: file.name, type: documentTypes[extension],
            size: file.size, data: dataUrl.split(",")[1]
          });
          setAttachmentStatus("تم تجهيز الملف. سيُقرأ محتواه عند الإرسال باستخدام خدمة المستندات.");
        } catch {
          setAttachmentStatus("تعذّرت قراءة الملف من الهاتف.", true);
        }
      } else {
        pendingAttachments.push({
          kind: "file", name: file.name, type: file.type || "application/octet-stream",
          size: file.size
        });
        setAttachmentStatus("هذا النوع غير مدعوم للقراءة حتى الآن؛ أُرفق اسم الملف فقط.", true);
      }
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
    if (item.kind === "document") return {
      kind: item.kind, name: item.name, type: item.type, size: item.size, data: item.data
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
  const progressRow = addPendingActivityMessage(text, selected);
  try {
    const data = await api("/api/chat", {
      message: text, attachments: payload, deepThink
    });
    progressRow.remove();
    const assistantRow = addMessage(
      data.reply, "assistant", data.steps || [], [],
      data.generatedImages || [], data.generatedProjects || [],
      data.activity || [], data.sources || []
    );
    refreshNotifications();
    if (appSettings.autoSpeak) assistantRow.querySelector(".voice-replay-btn")?.click();
  } catch (error) {
    progressRow.remove();
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
$("notificationsBtn").addEventListener("click", async () => {
  const panel = $("notificationsPanel");
  panel.hidden = !panel.hidden;
  $("notificationsBtn").setAttribute("aria-expanded", panel.hidden ? "false" : "true");
  if (!panel.hidden) await refreshNotifications();
});
$("markNotificationsReadBtn").addEventListener("click", async () => {
  const button = $("markNotificationsReadBtn");
  button.disabled = true;
  try {
    await api("/api/notifications", { allRead: true }, "PATCH");
    await refreshNotifications();
  } catch (error) {
    $("voiceStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

let activeVoicePeer = null;
let activeVoiceDataChannel = null;
let activeVoiceAudio = null;
let voiceFinishTimer = null;

function setAvatarSpeaking(active) {
  document.querySelectorAll(".mini-avatar").forEach(image => image.classList.toggle("talking", active));
}

function stopRealtimeVoice() {
  if (voiceFinishTimer) clearTimeout(voiceFinishTimer);
  voiceFinishTimer = null;
  try { activeVoiceDataChannel?.close(); } catch {}
  try { activeVoicePeer?.close(); } catch {}
  try { activeVoiceAudio?.pause(); } catch {}
  if (activeVoiceAudio) {
    activeVoiceAudio.srcObject = null;
    activeVoiceAudio.closest(".voice-player-shell")?.remove();
  }
  activeVoicePeer = null;
  activeVoiceDataChannel = null;
  activeVoiceAudio = null;
  setAvatarSpeaking(false);
}

function waitForIce(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("انتهت مهلة تجهيز الصوت.")); }, 12000);
    const onChange = () => {
      if (peer.iceGatheringState === "complete") { cleanup(); resolve(); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
    };
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

async function speakRealtime(text, voiceName, playerTarget, waitForPlayback = false) {
  if (!("RTCPeerConnection" in window)) throw new Error("متصفح الهاتف لا يدعم تشغيل الصوت الحديث.");
  stopRealtimeVoice();

  const host = playerTarget && typeof playerTarget.appendChild === "function"
    ? playerTarget
    : $("voicePlayerDock");
  const shell = document.createElement("div");
  shell.className = "voice-player-shell";
  const label = document.createElement("span");
  label.className = "voice-player-label";
  label.textContent = "صوت ونس — استخدم زر التشغيل لو ما بدأش تلقائيًا";
  const player = document.createElement("audio");
  player.className = "voice-audio-player";
  player.controls = true;
  player.autoplay = true;
  player.playsInline = true;
  player.preload = "none";
  player.setAttribute("aria-label", "مشغل صوت رد ونس");
  shell.append(label, player);
  host.querySelector(".voice-player-shell")?.remove();
  host.appendChild(shell);
  activeVoiceAudio = player;
  let resolvePlaybackStarted = null;
  let rejectPlaybackStarted = null;
  const playbackStarted = waitForPlayback
    ? new Promise((resolve, reject) => {
        resolvePlaybackStarted = resolve;
        rejectPlaybackStarted = reject;
      })
    : null;

  player.addEventListener("playing", () => {
    setAvatarSpeaking(true);
    $("voiceStatus").textContent = "ونس بتتكلم دلوقتي 💜";
    resolvePlaybackStarted?.(true);
  });
  player.addEventListener("pause", () => setAvatarSpeaking(false));
  player.addEventListener("error", () => {
    $("voiceStatus").textContent = "تعذّر تشغيل ملف الصوت. جرّب زر التشغيل مرة تانية.";
    rejectPlaybackStarted?.(new Error("اتصل الصوت لكن تعذّر تشغيل المقطع في مشغل الهاتف."));
  });

  const peer = new RTCPeerConnection();
  activeVoicePeer = peer;
  peer.addTransceiver("audio", { direction: "recvonly" });
  const channel = peer.createDataChannel("oai-events");
  activeVoiceDataChannel = channel;
  const scheduleStop = (delay = 120000) => {
    if (voiceFinishTimer) clearTimeout(voiceFinishTimer);
    voiceFinishTimer = setTimeout(() => {
      if (activeVoicePeer === peer) stopRealtimeVoice();
    }, delay);
  };

  peer.ontrack = event => {
    const stream = event.streams?.[0] || new MediaStream([event.track]);
    player.srcObject = stream;
    player.play().then(() => {
      $("voiceStatus").textContent = "تم تشغيل صوت ونس 💜";
    }).catch(() => {
      $("voiceStatus").textContent = "الصوت اتجهز. اضغط ▶ في مشغل الصوت الظاهر تحت الرد.";
      player.controls = true;
    });
  };

  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
      $("voiceStatus").textContent = "اتصال الصوت انقطع. اضغط اسمع رد ونس للمحاولة مرة أخرى.";
      scheduleStop(3000);
    }
  });

  channel.addEventListener("message", event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "response.output_audio.delta") setAvatarSpeaking(true);
    if (data.type === "response.done") {
      const failed = data.response?.status && data.response.status !== "completed";
      if (failed) {
        const detail = data.response?.status_details?.error?.message || "خدمة الصوت لم تكمل الرد.";
        $("voiceStatus").textContent = String(detail).slice(0, 180);
        scheduleStop(3000);
      } else {
        $("voiceStatus").textContent = "تم تجهيز الرد الصوتي. استخدم مشغل الصوت لسماعه مرة أخرى.";
        scheduleStop(120000);
      }
    }
    if (data.type === "error") {
      const detail = data.error?.message || data.message || "حدث خطأ أثناء توليد الصوت.";
      $("voiceStatus").textContent = String(detail).slice(0, 180);
      scheduleStop(3000);
    }
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIce(peer);
  const response = await fetch("/api/voice/connect", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sdp: peer.localDescription.sdp, voice: voiceName || "coral" })
  });
  if (!response.ok) {
    let data = {};
    try { data = await response.json(); } catch {}
    throw new Error(data.error || "تعذّر فتح قناة الصوت.");
  }
  const answer = await response.text();
  if (!answer.startsWith("v=0")) throw new Error("رد اتصال الصوت غير صالح.");
  await peer.setRemoteDescription({ type: "answer", sdp: answer });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("لم تفتح قناة الصوت في الهاتف.")), 15000);
    channel.addEventListener("open", () => {
      clearTimeout(timer);
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: String(text).slice(0, 2000) }] }
      }));
      channel.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
      $("voiceStatus").textContent = "جاري تجهيز صوت ونس…";
      resolve();
    }, { once: true });
    channel.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("فشل فتح قناة الصوت."));
    }, { once: true });
  });
  if (waitForPlayback) {
    let playbackTimer;
    try {
      await Promise.race([
        playbackStarted,
        new Promise((_, reject) => {
          playbackTimer = setTimeout(() => reject(new Error(
            "اتصلت قناة الصوت لكن لم يبدأ تشغيل المقطع خلال 45 ثانية. شغّل المقطع من المشغل الظاهر ثم أعد الاختبار."
          )), 45000);
        })
      ]);
    } finally {
      clearTimeout(playbackTimer);
    }
  }
  scheduleStop(120000);
}

const nativeSpeechWaiters = new Map();
window.onWensNativeTtsEvent = (event, utteranceId) => {
  const waiter = nativeSpeechWaiters.get(String(utteranceId || ""));
  if (waiter) waiter.handle(String(event || ""));
};

function speakWithAndroidNative(message, playerTarget, waitForPlayback = false) {
  const bridge = window.WensNative;
  if (!bridge || typeof bridge.speak !== "function") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = "wens-tts-" + (globalThis.crypto?.randomUUID?.() || (Date.now() + "-" + Math.random().toString(36).slice(2)));
    let settled = false;
    let started = false;
    const finish = () => {
      clearTimeout(timer);
      nativeSpeechWaiters.delete(id);
      setAvatarSpeaking(false);
    };
    const timer = setTimeout(() => {
      finish();
      try { bridge.stop?.(); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error("محرك الصوت في تطبيق Android لم يُكمل التشغيل. راجع خدمة تحويل النص إلى كلام في الهاتف."));
      }
    }, Math.max(30000, Math.min(180000, message.length * 110)));
    nativeSpeechWaiters.set(id, {
      handle(event) {
        if (event === "start") {
          started = true;
          setAvatarSpeaking(true);
          setVoiceStatus("ونس بتتكلم من محرك Android المحلي 💜");
          if (waitForPlayback && !settled) {
            settled = true;
            resolve(true);
          }
        } else if (event === "done") {
          finish();
          if (!settled) {
            settled = true;
            resolve(true);
          }
        } else if (event === "error" || event === "stop") {
          finish();
          const error = new Error(event === "stop"
            ? "تم إيقاف تشغيل الصوت."
            : "محرك الصوت المحلي في Android تعذّر عليه نطق الرد.");
          if (!settled) {
            settled = true;
            reject(error);
          } else {
            setVoiceStatus(error.message);
          }
        }
      }
    });
    let accepted = false;
    try { accepted = bridge.speak(message.slice(0, 4000), id) === true; } catch {}
    if (!accepted) {
      finish();
      resolve(null);
      return;
    }
    const bubble = playerTarget && typeof playerTarget.querySelector === "function" ? playerTarget : null;
    let note = bubble?.querySelector(".voice-device-note");
    if (bubble && !note) {
      note = document.createElement("p");
      note.className = "voice-device-note";
      bubble.appendChild(note);
    }
    let description = "صوت Android المحلي";
    try {
      if (typeof bridge.getVoiceLabel === "function") description = String(bridge.getVoiceLabel() || description);
    } catch {}
    if (note) note.textContent = "🔊 " + description;
    setVoiceStatus("جاري تشغيل صوت ونس من الهاتف…");
  });
}

async function speakOnDevice(text, playerTarget, waitForPlayback = false) {
  const nativePlayback = await speakWithAndroidNative(String(text || "").trim().slice(0, 4000), playerTarget, waitForPlayback);
  if (nativePlayback !== null) return nativePlayback;
  const synth = window.speechSynthesis;
  const Utterance = window.SpeechSynthesisUtterance;
  if (!synth || typeof Utterance !== "function") {
    throw new Error("المتصفح مش بيدعم تشغيل الصوت المحلي.");
  }
  synth.cancel();
  const message = String(text || "").trim().slice(0, 2000);
  if (!message) return false;

  let voices = typeof synth.getVoices === "function" ? synth.getVoices() : [];
  if (!voices.length) {
    await Promise.race([
      new Promise(resolve => {
        if (typeof synth.addEventListener === "function") {
          synth.addEventListener("voiceschanged", resolve, { once: true });
        } else {
          resolve();
        }
      }),
      new Promise(resolve => setTimeout(resolve, 1500))
    ]);
    voices = typeof synth.getVoices === "function" ? synth.getVoices() : [];
  }

  const egyptianVoices = voices.filter(voice =>
    /^ar-EG(?:[-_]|$)/i.test(String(voice.lang || "")) ||
    /egyptian|egypt|مصري|مصر/i.test(String(voice.name || ""))
  );
  const arabicVoices = voices.filter(voice =>
    /^ar(?:[-_]|$)/i.test(String(voice.lang || "")) ||
    /arabic|العربية|عربي/i.test(String(voice.name || ""))
  );
  const femaleVoice = list => list.find(voice =>
    /female|woman|hoda|salma|هدى|سلمى|فاطمة|ليلى/i.test(String(voice.name || ""))
  );
  const preferredVoice =
    femaleVoice(egyptianVoices) ||
    egyptianVoices[0] ||
    femaleVoice(arabicVoices) ||
    arabicVoices[0] ||
    null;
  const hasEgyptianVoice = Boolean(preferredVoice && egyptianVoices.includes(preferredVoice));
  const voiceDescription = hasEgyptianVoice
    ? "صوت مصري مثبت على الهاتف"
    : preferredVoice
      ? "صوت عربي متاح على الهاتف"
      : "صوت الهاتف الافتراضي للغة العربية";

  const utterance = new Utterance(message);
  utterance.lang = preferredVoice?.lang || "ar-EG";
  utterance.rate = Math.min(1.15, Math.max(0.85, Number(appSettings.voiceRate) || 0.98));
  utterance.pitch = 1.06;
  if (preferredVoice) utterance.voice = preferredVoice;

  const bubble = playerTarget && typeof playerTarget.querySelector === "function" ? playerTarget : null;
  let note = bubble?.querySelector(".voice-device-note");
  if (bubble && !note) {
    note = document.createElement("p");
    note.className = "voice-device-note";
    bubble.appendChild(note);
  }
  if (note) note.textContent = "🔊 " + voiceDescription;
  setVoiceStatus("بجهز صوت ونس من الهاتف…");
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    let playbackTimer = null;
    const startTimer = setTimeout(() => {
      if (!started && !settled) {
        settled = true;
        reject(new Error("محرك الصوت في الهاتف ما بدأش التشغيل. جرّب زر اسمع رد ونس أو راجع إعدادات تحويل النص لصوت."));
      }
    }, 12000);
    utterance.onstart = () => {
      started = true;
      clearTimeout(startTimer);
      if (!waitForPlayback) {
        const playbackLimit = Math.max(25000, Math.min(120000, message.length * 75));
        playbackTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          setAvatarSpeaking(false);
          try { synth.cancel(); } catch {}
          setVoiceStatus("محرك الصوت ما أنهـاش تشغيل الرد في الوقت المتوقع. تقدر تعيد المحاولة.");
          reject(new Error("انتهى وقت تشغيل الصوت؛ جرّب تشغيل الرد مرة أخرى."));
        }, playbackLimit);
      }
      setAvatarSpeaking(true);
      setVoiceStatus(hasEgyptianVoice
        ? "ونس بتتكلم دلوقتي بصوت مصري 💜"
        : "ونس بتتكلم دلوقتي بصوت عربي من الهاتف 💜");
      if (waitForPlayback && !settled) { settled = true; resolve(true); }
    };
    utterance.onend = () => {
      clearTimeout(startTimer);
      if (playbackTimer) clearTimeout(playbackTimer);
      setAvatarSpeaking(false);
      if (!settled) { settled = true; resolve(true); }
    };
    utterance.onerror = event => {
      clearTimeout(startTimer);
      if (playbackTimer) clearTimeout(playbackTimer);
      setAvatarSpeaking(false);
      const reason = event?.error === "not-allowed"
        ? "اسمح للمتصفح بتشغيل الصوت من إعدادات الهاتف."
        : "محرك الصوت في الهاتف رفض تشغيل الرد. اضغط اسمع رد ونس للمحاولة مرة أخرى.";
      if (!settled) { settled = true; reject(new Error(reason)); }
    };
    try {
      synth.speak(utterance);
      synth.resume?.();
    } catch (error) {
      clearTimeout(startTimer);
      if (playbackTimer) clearTimeout(playbackTimer);
      reject(error);
    }
  });
}
async function speak(text, voiceOverride, playerTarget, waitForPlayback = false) {
  const message = String(text || "").trim().slice(0, 2000);
  if (!message) return false;
  setVoiceStatus("بدور على صوت مصري مثبت على الموبايل…");
  try {
    await speakOnDevice(message, playerTarget, waitForPlayback);
    return true;
  } catch (error) {
    stopRealtimeVoice();
    setVoiceStatus(String(error?.message || error).slice(0, 220));
    return false;
  }
}

function getAdminVoicePreviewDock() {
  const panel = $("adminInlinePanel");
  if (!panel) return $("voicePlayerDock");
  let dock = $("adminVoicePreviewDock");
  if (!dock) {
    dock = document.createElement("section");
    dock.id = "adminVoicePreviewDock";
    dock.dir = "rtl";
    dock.style.cssText = "margin:12px 10px;padding:12px;border:1px solid rgba(180,154,255,.5);border-radius:16px;background:rgba(20,18,40,.97);color:#fff;position:relative;z-index:5";
    const title = document.createElement("p");
    title.textContent = "معاينة صوت ونس — اضغط ▶ إذا لم يبدأ التشغيل تلقائيًا";
    title.style.cssText = "margin:0 0 8px;font-weight:700";
    dock.appendChild(title);
    panel.prepend(dock);
  }
  dock.hidden = false;
  dock.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return dock;
}
window.WensPlayVoicePreview = text =>
  speak(text, null, getAdminVoicePreviewDock(), true);
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
  recognition.onstart = () => { setVoiceStatus("سامعاك... اتكلم دلوقتي 🎙️"); $("voiceBtn").classList.add("listening"); };
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
async function registerWensServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // Keep the app usable when the browser blocks service-worker installation.
  }
}
registerWensServiceWorker();
boot();
