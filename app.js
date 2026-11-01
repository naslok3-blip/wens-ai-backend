const $ = id => document.getElementById(id);
// Hidden manager entry: tap the brand five times within three seconds.
(() => {
  const brand = document.querySelector(".brand");
  if (!brand) return;
  let taps = 0;
  let resetTimer;
  brand.addEventListener("click", event => {
    event.preventDefault();
    taps += 1;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { taps = 0; }, 3000);
    if (taps >= 5) window.location.assign("/admin.html");
  });
  window.addEventListener("keydown", event => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      window.location.assign("/admin.html");
    }
  });
})();
let authMode = "login";
let currentUser = null;
let recognition = null;
let activeRoom = null;
let localTracks = [];
let liveKitModule = null;
let micEnabled = true;
let cameraEnabled = true;
const appSettings = loadLocalSettings();

function loadLocalSettings() {
  const defaults = {
    appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
    welcomeTitle: "أهلًا بيك، أنا ونس 💜",
    welcomeText: "اتكلم معايا أو افتح مكالمة فيديو مع شخص تحبه.",
    greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
    voiceButton: "اتكلم معايا", cameraButton: "📹 مكالمة فيديو",
    voiceRate: 0.96, voicePitch: 1.12, theme: "purple",
    enableVoice: true, enableCamera: true, voiceLocale: "ar-EG"
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
  $("cameraBtn").textContent = appSettings.cameraButton;
  $("voiceBtn").hidden = !appSettings.enableVoice;
  $("cameraBtn").hidden = !appSettings.enableCamera;
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
function setCallMessage(message, error = false) {
  $("callStatus").textContent = message || "";
  $("callStatus").style.color = error ? "#ff9fba" : "#9be7c1";
}
function showAuth() {
  $("authPanel").hidden = false;
  $("appRoot").hidden = true;
  $("logoutBtn").hidden = true;
}
function showApp(user) {
  currentUser = user;
  $("authPanel").hidden = true;
  $("appRoot").hidden = false;
  $("logoutBtn").hidden = false;
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
  await endCall(false);
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
function addMessage(text, who = "assistant") {
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
  bubble.textContent = text;
  row.appendChild(bubble);
  $("messages").appendChild(row);
  $("messages").scrollTop = $("messages").scrollHeight;
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
    addMessage(data.reply);
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

$("cameraBtn").addEventListener("click", () => {
  $("callPanel").hidden = false;
  $("callPanel").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("closeCallBtn").addEventListener("click", async () => {
  await endCall(false);
  $("callPanel").hidden = true;
});
function makeRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return "wens-" + Array.from(bytes, b => (b % 36).toString(36)).join("");
}
$("createCallBtn").addEventListener("click", async () => {
  const room = makeRoomCode();
  $("roomInput").value = room;
  await connectCall(room);
});
$("joinCallBtn").addEventListener("click", async () => {
  await connectCall($("roomInput").value.trim());
});
$("copyRoomBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("roomInput").value.trim());
    setCallMessage("تم نسخ كود الغرفة. ابعته للطرف الآخر علشان ينضم.");
  } catch { setCallMessage("انسخ كود الغرفة يدويًا: " + $("roomInput").value, true); }
});
async function connectCall(roomName) {
  if (!roomName) { setCallMessage("اكتب كود الغرفة أولًا.", true); return; }
  $("createCallBtn").disabled = $("joinCallBtn").disabled = true;
  setCallMessage("جاري تجهيز غرفة الاتصال...");
  try {
    const tokenData = await api("/api/call/token", { room: roomName });
    if (!liveKitModule) liveKitModule = await import("https://cdn.jsdelivr.net/npm/livekit-client@2/+esm");
    const { Room, RoomEvent, createLocalTracks } = liveKitModule;
    activeRoom = new Room({ adaptiveStream: true, dynacast: true });
    activeRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => attachRemoteTrack(track, participant));
    activeRoom.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => detachRemoteTrack(track, participant));
    activeRoom.on(RoomEvent.ParticipantDisconnected, participant => removeParticipant(participant));
    activeRoom.on(RoomEvent.ActiveSpeakersChanged, speakers => {
      $("avatarChip").classList.toggle("speaking", speakers.some(p => p.identity !== activeRoom.localParticipant.identity));
    });
    activeRoom.on(RoomEvent.Disconnected, () => setCallMessage("انتهت المكالمة."));
    await activeRoom.connect(tokenData.url, tokenData.token);
    localTracks = await createLocalTracks({ audio: true, video: { facingMode: "user" } });
    for (const track of localTracks) {
      await activeRoom.localParticipant.publishTrack(track);
      if (track.kind === "video") {
        $("localVideo").srcObject = new MediaStream([track.mediaStreamTrack]);
      }
    }
    $("videoStage").hidden = false;
    $("copyRoomBtn").disabled = false;
    setCallMessage("أنت داخل الغرفة " + roomName + ". شارك الكود مع الشخص الآخر.");
  } catch (error) {
    await endCall(false);
    setCallMessage(error.message || "تعذّر بدء المكالمة. راجع إعدادات خدمة الفيديو.", true);
  } finally {
    $("createCallBtn").disabled = $("joinCallBtn").disabled = false;
  }
}
function attachRemoteTrack(track, participant) {
  const id = "participant-" + participant.identity.replace(/[^a-zA-Z0-9_-]/g, "");
  let tile = document.getElementById(id);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "remote-tile";
    tile.id = id;
    const label = document.createElement("span");
    label.className = "remote-label";
    label.textContent = participant.name || "مشارك";
    tile.appendChild(label);
    $("remoteVideos").appendChild(tile);
  }
  const element = track.attach();
  element.autoplay = true;
  element.playsInline = true;
  if (track.kind === "video") element.className = "remote-video";
  tile.appendChild(element);
}
function detachRemoteTrack(track, participant) {
  track.detach().forEach(element => element.remove());
  if (participant) {
    const id = "participant-" + participant.identity.replace(/[^a-zA-Z0-9_-]/g, "");
    const tile = document.getElementById(id);
    if (tile && tile.querySelectorAll("video,audio").length === 0) tile.remove();
  }
}
function removeParticipant(participant) {
  const id = "participant-" + participant.identity.replace(/[^a-zA-Z0-9_-]/g, "");
  document.getElementById(id)?.remove();
}
$("muteBtn").addEventListener("click", async () => {
  if (!activeRoom) return;
  micEnabled = !micEnabled;
  await activeRoom.localParticipant.setMicrophoneEnabled(micEnabled);
  $("muteBtn").textContent = micEnabled ? "كتم الميكروفون" : "تشغيل الميكروفون";
});
$("cameraToggleBtn").addEventListener("click", async () => {
  if (!activeRoom) return;
  cameraEnabled = !cameraEnabled;
  await activeRoom.localParticipant.setCameraEnabled(cameraEnabled);
  $("cameraToggleBtn").textContent = cameraEnabled ? "إيقاف الكاميرا" : "تشغيل الكاميرا";
});
$("endCallBtn").addEventListener("click", () => endCall(true));
async function endCall(showMessage = true) {
  try {
    if (activeRoom) await activeRoom.disconnect();
  } catch {}
  activeRoom = null;
  for (const track of localTracks) {
    try { track.stop(); track.detach(); } catch {}
  }
  localTracks = [];
  $("localVideo").srcObject = null;
  $("remoteVideos").replaceChildren();
  $("videoStage").hidden = true;
  $("copyRoomBtn").disabled = true;
  micEnabled = true;
  cameraEnabled = true;
  $("muteBtn").textContent = "كتم الميكروفون";
  $("cameraToggleBtn").textContent = "إيقاف الكاميرا";
  $("avatarChip").classList.remove("speaking");
  if (showMessage) setCallMessage("تم إنهاء المكالمة.");
}
async function loadSystemStatus() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    const f = data.features || {};
    const labels = [
      "Cloudflare AI " + (f.workersAI ? "جاهز" : "غير مربوط"),
      "قاعدة البيانات " + (f.database ? "جاهزة" : "غير مربوطة"),
      "الفيديو " + (f.videoAvatar ? "جاهز" : "بانتظار LiveKit")
    ];
    $("systemStatus").textContent = labels.join(" · ");
    $("systemStatus").classList.toggle("all-ready", !!(f.workersAI && f.database));
    return data;
  } catch {
    $("systemStatus").textContent = "تعذّر فحص حالة الخادم.";
    return null;
  }
}
async function boot() {
  applyLocalSettings();
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
