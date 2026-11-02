import { scrypt } from "node:crypto";

const SYSTEM_PROMPT = "أنتِ ونس، رفيقة افتراضية مصرية ودودة وذكية. تحدثي باللهجة المصرية الطبيعية وبصيغة المؤنث عن نفسك. كوني دافئة ومحترمة وخفيفة الظل دون ادعاء أنك إنسانة حقيقية. أجيبي بوضوح وباختصار مناسب. لا تدّعي أنك ترين أو تسمعين شيئًا لم يتم إرساله فعليًا. لا تطلبي كلمات مرور أو مفاتيح سرية أو بيانات دفع. قدّمي معلومات عامة في المجالات عالية المخاطر ونبّهي للرجوع لمختص.";

const enc = new TextEncoder();
const COOKIE = "wens_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function cookieValue(header, key) {
  const part = (header || "").split(";").map(x => x.trim()).find(x => x.startsWith(key + "="));
  return part ? decodeURIComponent(part.slice(key.length + 1)) : "";
}
function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromB64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
async function digest(value) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
}
async function passwordHash(password, salt) {
  const derivedKey = await new Promise((resolve, reject) => {
    scrypt(password, fromB64url(salt), 32, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return b64url(new Uint8Array(derivedKey));
}
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
function requireDb(env) {
  if (!env.DB) throw new Error("DB_NOT_CONFIGURED");
  return env.DB;
}
async function currentUser(request, env) {
  if (!env.DB) return null;
  const raw = cookieValue(request.headers.get("Cookie"), COOKIE);
  if (!raw) return null;
  const tokenHash = await digest(raw);
  const now = Math.floor(Date.now() / 1000);
  return await env.DB.prepare(
    "SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1"
  ).bind(tokenHash, now).first();
}
function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return COOKIE + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
}
async function issueSession(db, user) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = b64url(bytes);
  const tokenHash = await digest(token);
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  await db.prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)")
    .bind(crypto.randomUUID(), user.id, tokenHash, expires, Math.floor(Date.now() / 1000)).run();
  return json({ ok: true, user: { id: user.id, email: user.email, name: user.display_name } }, 200, { "Set-Cookie": sessionCookie(token) });
}
function authDiagnostic(requestId, phase, error, message = "حصل خطأ أثناء تنفيذ طلب الحساب. جرّب مرة أخرى.") {
  const raw = String(error?.message || error || "unknown");
  const safeDetail = raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, "[email]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .slice(0, 240);
  console.error("[WENS_AUTH_FAILURE]", JSON.stringify({
    requestId,
    phase,
    errorName: String(error?.name || "Error").slice(0, 80),
    detail: safeDetail
  }));
  return json({
    error: message,
    code: "AUTH_" + phase.toUpperCase() + "_FAILED",
    requestId,
    diagnostic: {
      phase,
      errorType: String(error?.name || "Error").slice(0, 80),
      cryptoStage: /^(PBKDF2_IMPORT|PBKDF2_DERIVE)_/.exec(raw)?.[1] || null,
      cryptoErrorType: /^PBKDF2_(?:IMPORT|DERIVE)_([A-Za-z]+)/.exec(raw)?.[1] || null
    }
  }, 500);
}

async function authRoute(request, env, path, requestId) {
  const db = requireDb(env);
  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env);
    return user ? json({ ok: true, user: { id: user.id, email: user.email, name: user.display_name } }) : json({ ok: false }, 401);
  }
  if (path === "/api/auth/logout" && request.method === "POST") {
    const raw = cookieValue(request.headers.get("Cookie"), COOKIE);
    if (raw) await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(raw)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (!["/api/auth/register", "/api/auth/login"].includes(path) || request.method !== "POST") {
    return json({ error: "المسار أو طريقة الطلب غير مدعومة." }, 404);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "البيانات غير صالحة." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return json({ error: "اكتب بريدًا إلكترونيًا صحيحًا." }, 400);
  if (password.length < 8 || password.length > 128) return json({ error: "كلمة المرور يجب أن تكون من 8 إلى 128 حرفًا." }, 400);

  if (path.endsWith("/register")) {
    const name = String(body.name || "").trim().slice(0, 60);
    if (name.length < 2) return json({ error: "اكتب اسمًا من حرفين على الأقل." }, 400);
    let existing;
    try {
      existing = await db.prepare("SELECT id FROM users WHERE email=? LIMIT 1").bind(email).first();
    } catch (error) {
      return authDiagnostic(requestId, "register_lookup", error, "تعذّر التحقق من البريد على قاعدة البيانات. حاول بعد قليل.");
    }
    if (existing) return json({ error: "البريد الإلكتروني مسجل بالفعل. سجّل الدخول." }, 409);
    const id = crypto.randomUUID();
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    let hash;
    try {
      hash = await passwordHash(password, salt);
    } catch (error) {
      return authDiagnostic(requestId, "register_password_hash", error, "تعذّر تجهيز بيانات الحساب بأمان. حاول مرة أخرى.");
    }
    try {
      await db.prepare("INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)")
        .bind(id, email, name, hash, salt, Math.floor(Date.now() / 1000)).run();
    } catch (error) {
      const detail = String(error?.message || error);
      if (/UNIQUE constraint failed:\s*users\.email/i.test(detail)) {
        return json({ error: "البريد الإلكتروني مسجل بالفعل. سجّل الدخول." }, 409);
      }
      return authDiagnostic(requestId, "register_insert", error, "تعذّر حفظ الحساب في قاعدة البيانات. لم يكتمل التسجيل.");
    }
    try {
      return await issueSession(db, { id, email, display_name: name });
    } catch (error) {
      return authDiagnostic(requestId, "register_session", error, "تم إنشاء الحساب، لكن تعذّر إنشاء جلسة الدخول. جرّب تسجيل الدخول الآن.");
    }
  }

  let user;
  try {
    user = await db.prepare("SELECT id,email,display_name,password_hash,password_salt FROM users WHERE email=? LIMIT 1").bind(email).first();
  } catch (error) {
    return authDiagnostic(requestId, "login_lookup", error, "تعذّر التحقق من الحساب على قاعدة البيانات. حاول بعد قليل.");
  }
  if (!user) return json({ error: "البريد أو كلمة المرور غير صحيحة." }, 401);
  let candidate;
  try {
    candidate = await passwordHash(password, user.password_salt);
  } catch (error) {
    return authDiagnostic(requestId, "login_password_check", error, "تعذّر التحقق من كلمة المرور. حاول مرة أخرى.");
  }
  if (!same(candidate, user.password_hash)) return json({ error: "البريد أو كلمة المرور غير صحيحة." }, 401);
  try {
    return await issueSession(db, user);
  } catch (error) {
    return authDiagnostic(requestId, "login_session", error, "كلمة المرور صحيحة، لكن تعذّر إنشاء جلسة الدخول. حاول مرة أخرى.");
  }
}
const INLINE_ASSETS = new Map([
    ["/", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0b0b16\"><link rel=\"manifest\" href=\"manifest.json\"><link rel=\"stylesheet\" href=\"style.css\">\n<title>ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b id=\"brandName\">ونس AI</b><small>رفيقة يومك الذكية</small></span></a>\n  <div class=\"top-actions\"><button id=\"logoutBtn\" class=\"admin-shortcut\" hidden>خروج</button></div>\n</header>\n<main class=\"app\">\n<section id=\"authPanel\" class=\"panel auth-panel\">\n  <div class=\"auth-mark\">و</div><p class=\"eyebrow\">مساحتك الخاصة</p><h1 id=\"authTitle\">أهلًا بيك في ونس</h1>\n  <p class=\"hero-text\">سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.</p>\n  <form id=\"authForm\" class=\"auth-form\">\n    <label id=\"nameField\" hidden>الاسم<input id=\"nameInput\" maxlength=\"60\" autocomplete=\"name\" placeholder=\"اسمك\"></label>\n    <label>البريد الإلكتروني<input id=\"emailInput\" type=\"email\" maxlength=\"190\" autocomplete=\"email\" required placeholder=\"name@example.com\"></label>\n    <label>كلمة المرور<input id=\"passwordInput\" type=\"password\" minlength=\"8\" maxlength=\"128\" autocomplete=\"current-password\" required placeholder=\"8 أحرف على الأقل\"></label>\n    <button id=\"authSubmit\" class=\"btn primary\" type=\"submit\">تسجيل الدخول</button>\n  </form>\n  <button id=\"authToggle\" class=\"text-btn auth-toggle\" type=\"button\">إنشاء حساب جديد</button>\n  <p id=\"authStatus\" class=\"status-line\" role=\"status\"></p><p id=\"systemStatus\" class=\"system-status\" role=\"status\">جاري فحص اتصال الخدمات...</p>\n  <p class=\"disclaimer\">كلمة المرور تُخزّن مشفّرة تجزئيًا في قاعدة البيانات، ولا تُعرض داخل التطبيق. لا تستخدم كلمة مرور حسابك في مواقع أخرى.</p>\n</section>\n\n<div id=\"appRoot\" hidden>\n<section class=\"hero\">\n  <img class=\"hero-portrait\" src=\"avatar.svg\" alt=\"الصورة الشخصية لونس\" width=\"192\" height=\"192\">\n  <p class=\"eyebrow\" id=\"eyebrowText\">موجودة علشانك</p><h1 id=\"welcomeTitle\">أهلًا بيك، أنا ونس 💜</h1>\n  <p id=\"welcomeText\" class=\"hero-text\">اتكلم معايا واسألني اللي في بالك.</p>\n  <div class=\"actions\"><button id=\"voiceBtn\" class=\"btn primary\">🎙️ <span id=\"voiceButtonText\">اتكلم معايا</span></button></div>\n  <p id=\"voiceStatus\" class=\"status-line\" aria-live=\"polite\"></p>\n</section>\n\n<section class=\"panel\">\n  <div class=\"section-head\"><div><h2>الدردشة مع ونس</h2><p id=\"accountLabel\">محادثتك محفوظة في حسابك</p></div><button id=\"clearBtn\" class=\"text-btn\">مسح العرض</button></div>\n  <div id=\"messages\" class=\"messages\" aria-live=\"polite\"><div class=\"message assistant\"><div class=\"mini-avatar\">و</div><div class=\"bubble\">أهلًا بيك! أنا ونس 💜 اسأليني أو احكيلي اللي في بالك.</div></div></div>\n  <form id=\"chatForm\" class=\"chat-form\"><input id=\"messageInput\" placeholder=\"اكتب رسالتك هنا...\" autocomplete=\"off\" aria-label=\"رسالتك\"><button class=\"send-btn\" type=\"submit\">إرسال</button></form>\n  <p class=\"disclaimer\">رسائلك تُعالج عبر Cloudflare Workers AI، وتُحفظ في قاعدة بيانات حسابك. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.</p>\n</section>\n</div>\n</main>\n<footer>ونس AI • نسخة تطويرية</footer>\n<script src=\"app.js\"></script>\n</body></html>\n", type: "text/html; charset=utf-8" }],
    ["/index.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0b0b16\"><link rel=\"manifest\" href=\"manifest.json\"><link rel=\"stylesheet\" href=\"style.css\">\n<title>ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b id=\"brandName\">ونس AI</b><small>رفيقة يومك الذكية</small></span></a>\n  <div class=\"top-actions\"><button id=\"logoutBtn\" class=\"admin-shortcut\" hidden>خروج</button></div>\n</header>\n<main class=\"app\">\n<section id=\"authPanel\" class=\"panel auth-panel\">\n  <div class=\"auth-mark\">و</div><p class=\"eyebrow\">مساحتك الخاصة</p><h1 id=\"authTitle\">أهلًا بيك في ونس</h1>\n  <p class=\"hero-text\">سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.</p>\n  <form id=\"authForm\" class=\"auth-form\">\n    <label id=\"nameField\" hidden>الاسم<input id=\"nameInput\" maxlength=\"60\" autocomplete=\"name\" placeholder=\"اسمك\"></label>\n    <label>البريد الإلكتروني<input id=\"emailInput\" type=\"email\" maxlength=\"190\" autocomplete=\"email\" required placeholder=\"name@example.com\"></label>\n    <label>كلمة المرور<input id=\"passwordInput\" type=\"password\" minlength=\"8\" maxlength=\"128\" autocomplete=\"current-password\" required placeholder=\"8 أحرف على الأقل\"></label>\n    <button id=\"authSubmit\" class=\"btn primary\" type=\"submit\">تسجيل الدخول</button>\n  </form>\n  <button id=\"authToggle\" class=\"text-btn auth-toggle\" type=\"button\">إنشاء حساب جديد</button>\n  <p id=\"authStatus\" class=\"status-line\" role=\"status\"></p><p id=\"systemStatus\" class=\"system-status\" role=\"status\">جاري فحص اتصال الخدمات...</p>\n  <p class=\"disclaimer\">كلمة المرور تُخزّن مشفّرة تجزئيًا في قاعدة البيانات، ولا تُعرض داخل التطبيق. لا تستخدم كلمة مرور حسابك في مواقع أخرى.</p>\n</section>\n\n<div id=\"appRoot\" hidden>\n<section class=\"hero\">\n  <img class=\"hero-portrait\" src=\"avatar.svg\" alt=\"الصورة الشخصية لونس\" width=\"192\" height=\"192\">\n  <p class=\"eyebrow\" id=\"eyebrowText\">موجودة علشانك</p><h1 id=\"welcomeTitle\">أهلًا بيك، أنا ونس 💜</h1>\n  <p id=\"welcomeText\" class=\"hero-text\">اتكلم معايا واسألني اللي في بالك.</p>\n  <div class=\"actions\"><button id=\"voiceBtn\" class=\"btn primary\">🎙️ <span id=\"voiceButtonText\">اتكلم معايا</span></button></div>\n  <p id=\"voiceStatus\" class=\"status-line\" aria-live=\"polite\"></p>\n</section>\n\n<section class=\"panel\">\n  <div class=\"section-head\"><div><h2>الدردشة مع ونس</h2><p id=\"accountLabel\">محادثتك محفوظة في حسابك</p></div><button id=\"clearBtn\" class=\"text-btn\">مسح العرض</button></div>\n  <div id=\"messages\" class=\"messages\" aria-live=\"polite\"><div class=\"message assistant\"><div class=\"mini-avatar\">و</div><div class=\"bubble\">أهلًا بيك! أنا ونس 💜 اسأليني أو احكيلي اللي في بالك.</div></div></div>\n  <form id=\"chatForm\" class=\"chat-form\"><input id=\"messageInput\" placeholder=\"اكتب رسالتك هنا...\" autocomplete=\"off\" aria-label=\"رسالتك\"><button class=\"send-btn\" type=\"submit\">إرسال</button></form>\n  <p class=\"disclaimer\">رسائلك تُعالج عبر Cloudflare Workers AI، وتُحفظ في قاعدة بيانات حسابك. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.</p>\n</section>\n</div>\n</main>\n<footer>ونس AI • نسخة تطويرية</footer>\n<script src=\"app.js\"></script>\n</body></html>\n", type: "text/html; charset=utf-8" }],
    ["/admin.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"admin.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بالبريد وكلمة مرور حسابك المسجّل في ونس.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"naslok3@gmail.com\" required>\n      <label for=\"adminPassword\">كلمة المرور</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" placeholder=\"كلمة مرور حساب ونس\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"admin.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/admin.js", { body: "const $ = id => document.getElementById(id);\nconst defaults = {\n  appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n  welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n  welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n  greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n  voiceButton: \"اتكلم معايا\",\n  voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n  enableVoice: true, voiceLocale: \"ar-EG\"\n};\nconst keys = Object.keys(defaults);\nlet config = { ...defaults };\nasync function request(path, body, method = \"GET\") {\n  const response = await fetch(path, {\n    method, credentials: \"same-origin\", cache: \"no-store\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"تعذّر تنفيذ الطلب.\");\n  return data;\n}\nfunction gateMessage(message, error = false) {\n  $(\"adminGateStatus\").textContent = message || \"\";\n  $(\"adminGateStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction serviceMessage(message, error = false) {\n  $(\"serviceStatus\").textContent = message || \"\";\n  $(\"serviceStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction normalize(data) {\n  const next = { ...defaults };\n  if (!data || typeof data !== \"object\" || Array.isArray(data)) return next;\n  for (const key of keys) {\n    if (!(key in data)) continue;\n    const value = data[key];\n    if (typeof defaults[key] === \"boolean\") next[key] = value === true;\n    else if (typeof defaults[key] === \"number\") {\n      const max = key === \"voiceRate\" ? 1.35 : 1.5;\n      const min = key === \"voiceRate\" ? 0.65 : 0.7;\n      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];\n    } else if (typeof value === \"string\") {\n      next[key] = value.slice(0, key === \"welcomeText\" ? 240 : key === \"greeting\" ? 350 : 120);\n    }\n  }\n  if (![\"purple\", \"blue\", \"green\", \"rose\"].includes(next.theme)) next.theme = defaults.theme;\n  if (![\"ar-EG\", \"ar-SA\", \"en-US\"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;\n  return next;\n}\nfunction fillSettingsForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (!element) continue;\n    if (element.type === \"checkbox\") element.checked = !!config[key];\n    else element.value = config[key];\n  }\n  updateRanges();\n}\nasync function loadSettings() {\n  const data = await request(\"/api/admin/settings\");\n  config = normalize(data.settings);\n  fillSettingsForm();\n}\nfunction readForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (element) config[key] = element.type === \"checkbox\" ? element.checked :\n      element.type === \"range\" ? Number(element.value) : element.value;\n  }\n}\nfunction updateRanges() {\n  $(\"rateOut\").value = Number($(\"voiceRate\").value).toFixed(2);\n  $(\"pitchOut\").value = Number($(\"voicePitch\").value).toFixed(2);\n}\nfunction setState(id, label, ready) {\n  const element = $(id);\n  element.textContent = label;\n  element.className = ready ? \"state-ready\" : \"state-off\";\n}\nasync function refreshStatus() {\n  $(\"refreshStatusBtn\").disabled = true;\n  try {\n    const data = await request(\"/api/admin/status\");\n    const f = data.features || {};\n    setState(\"workersAiState\", f.workersAI ? \"متصل ويعمل\" : \"غير مربوط\", !!f.workersAI);\n    setState(\"databaseState\", !f.databaseConfigured ? \"غير مربوطة\" : !f.databaseConnected ? \"فشل الاتصال\" : f.databaseSchemaReady ? \"جاهزة\" : \"تحتاج مراجعة\", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));\n    $(\"modelName\").textContent = \"النموذج: \" + (data.model || \"غير محدد\");\n    $(\"databaseDetail\").textContent = !f.databaseConfigured ? \"لم يتم ربط D1 بعد\" : !f.databaseConnected ? \"تعذّر الاتصال بقاعدة البيانات\" : f.settingsStorageReady ? \"الجداول وحفظ الإعدادات جاهزة\" : \"تخزين الإعدادات يحتاج مراجعة\";\n    $(\"checkedAt\").textContent = \"آخر فحص: \" + new Date(data.checkedAt).toLocaleString(\"ar-EG\");\n    serviceMessage(\"تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.\");\n  } catch (error) {\n    serviceMessage(error.message, true);\n    if (/سجّل الدخول/.test(error.message)) {\n      $(\"adminApp\").hidden = true;\n      $(\"adminGate\").hidden = false;\n      gateMessage(\"انتهت الجلسة أو الحساب غير مصرح. سجّل الدخول بحساب المالك.\", true);\n    }\n  } finally { $(\"refreshStatusBtn\").disabled = false; }\n}\nasync function showDashboard() {\n  $(\"adminGate\").hidden = true;\n  $(\"adminApp\").hidden = false;\n  try { await loadSettings(); await refreshStatus(); }\n  catch (error) { serviceMessage(error.message, true); }\n}\n$(\"adminLoginForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const email = $(\"adminEmail\").value.trim(), password = $(\"adminPassword\").value;\n  $(\"adminLoginBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من حساب المالك...\");\n  try {\n    await request(\"/api/admin/login\", { email, password }, \"POST\");\n    $(\"adminPassword\").value = \"\";\n    await showDashboard();\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminLoginBtn\").disabled = false; }\n});\n$(\"adminLogoutBtn\").addEventListener(\"click\", async () => {\n  try { await request(\"/api/admin/logout\", {}, \"POST\"); } catch {}\n  $(\"adminApp\").hidden = true;\n  $(\"adminGate\").hidden = false;\n  $(\"adminPassword\").value = \"\";\n  gateMessage(\"تم تسجيل خروج المدير.\");\n});\n$(\"refreshStatusBtn\").addEventListener(\"click\", refreshStatus);\n$(\"testWorkersAiBtn\").addEventListener(\"click\", async () => {\n  $(\"testWorkersAiBtn\").disabled = true;\n  serviceMessage(\"جاري اختبار Cloudflare Workers AI...\");\n  try {\n    const result = await request(\"/api/admin/test-ai\", {}, \"POST\");\n    serviceMessage(\"اختبار ناجح ✓ رد الخدمة: \" + result.reply);\n    setState(\"workersAiState\", \"يعمل بنجاح\", true);\n  } catch (error) {\n    serviceMessage(error.message, true);\n    setState(\"workersAiState\", \"فشل الاختبار\", false);\n  } finally { $(\"testWorkersAiBtn\").disabled = false; }\n});\ndocument.querySelectorAll(\".nav-btn\").forEach(button => button.addEventListener(\"click\", () => {\n  document.querySelectorAll(\".nav-btn\").forEach(item => item.classList.toggle(\"active\", item === button));\n  document.querySelectorAll(\".tab-page\").forEach(page => page.classList.toggle(\"active\", page.id === \"tab-\" + button.dataset.tab));\n}));\n[\"voiceRate\", \"voicePitch\"].forEach(id => $(id).addEventListener(\"input\", updateRanges));\n$(\"saveBtn\").addEventListener(\"click\", async () => {\n  readForm();\n  $(\"saveBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: config }, \"PUT\");\n    config = normalize(result.settings);\n    fillSettingsForm();\n    $(\"saveStatus\").textContent = \"تم حفظ التعديلات على الخادم لكل المستخدمين ✓\";\n    $(\"saveStatus\").style.color = \"#9be7c1\";\n  } catch (error) {\n    $(\"saveStatus\").textContent = error.message;\n    $(\"saveStatus\").style.color = \"#ff9fba\";\n  } finally { $(\"saveBtn\").disabled = false; }\n});\n$(\"exportBtn\").addEventListener(\"click\", () => {\n  readForm();\n  const blob = new Blob([JSON.stringify(config, null, 2)], { type: \"application/json\" });\n  const url = URL.createObjectURL(blob), link = document.createElement(\"a\");\n  link.href = url; link.download = \"wens-ai-settings.json\"; link.click();\n  URL.revokeObjectURL(url);\n  $(\"backupStatus\").textContent = \"تم تجهيز نسخة من إعدادات الخادم الحالية.\";\n});\n$(\"importFile\").addEventListener(\"change\", async event => {\n  const file = event.target.files[0];\n  if (!file) return;\n  try {\n    const imported = normalize(JSON.parse(await file.text()));\n    const result = await request(\"/api/admin/settings\", { settings: imported }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تم استرجاع الإعدادات وحفظها على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message || \"الملف غير صالح؛ اختَر ملف JSON صحيح.\"; }\n  event.target.value = \"\";\n});\n$(\"resetBtn\").addEventListener(\"click\", async () => {\n  if (!confirm(\"ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟\")) return;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: defaults }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تمت استعادة الإعدادات الافتراضية على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message; }\n});\n(async function bootAdmin() {\n  try {\n    const session = await request(\"/api/admin/session\");\n    if (session.authenticated) await showDashboard();\n    else gateMessage(\"أدخل البريد وكلمة مرور حساب مالك التطبيق.\");\n  } catch (error) {\n    gateMessage(error.message === \"تعذّر تنفيذ الطلب.\"\n      ? \"تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت.\"\n      : error.message, true);\n  }\n})();", type: "text/javascript; charset=utf-8" }],
    ["/admin.css", { body: ".admin-wrap{width:min(1050px,100%);margin:auto;padding:24px 14px 45px}.admin-gate{width:min(460px,100%);margin:7vh auto 30px;padding:clamp(22px,5vw,34px);text-align:center}.admin-gate h1{font-size:clamp(25px,5vw,32px);margin:5px 0}.admin-login-form{display:grid;gap:10px;margin:22px 0 8px;text-align:right}.admin-login-form label{font-size:13px;color:#e8e3f8}.admin-login-form input{width:100%;min-height:52px;padding:14px;background:#0d0c18;border:1px solid #45405f;border-radius:13px;color:var(--text);font:inherit;letter-spacing:0;text-align:right;font-size:16px}.admin-login-form button{width:100%}.admin-heading{padding:8px 2px 18px}.admin-heading h1{margin:4px 0 8px;font-size:clamp(25px,5vw,34px)}.admin-heading>p:not(.eyebrow){color:var(--muted);font-size:13px;line-height:1.8}.admin-heading-actions,.service-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.admin-heading-actions{margin-top:15px}.service-panel{background:linear-gradient(145deg,#1d1b30f2,#141321f2);border:1px solid #ffffff18;border-radius:22px;padding:17px;margin:12px 0 16px;box-shadow:0 18px 55px #0005}.service-panel h2{font-size:17px;margin:0}.service-panel .section-head>div>p{color:var(--muted);font-size:11px;margin:4px 0}.service-grid{display:grid;grid-template-columns:1fr;gap:9px;margin:15px 0}.service-card{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:5px 9px;background:#ffffff08;border:1px solid #ffffff12;border-radius:14px;padding:13px}.service-icon{grid-row:span 2;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:#b49aff1b;color:#d9ccff;font-size:18px}.service-card b{font-size:13px}.service-card strong{font-size:12px;text-align:left}.service-card small{grid-column:2/4;color:var(--muted);font-size:10px}.state-ready{color:#9be7c1}.state-off{color:#ffb4c7}.state-pending{color:#ffcf8f}.service-actions{align-items:center;margin-top:12px}.service-actions .status-line{flex:1;min-width:170px;margin:0}.admin-grid{display:grid;grid-template-columns:1fr;gap:14px}.admin-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-content:start}.nav-btn{border:1px solid #ffffff12;border-radius:12px;padding:12px 8px;text-align:right;background:#19192c;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.nav-btn.active{background:#a28bff24;color:#fff;border-color:#a28bff88}.admin-content{min-width:0;background:#19192ccc;border:1px solid #ffffff12;border-radius:20px;padding:17px}.tab-page{display:none}.tab-page.active{display:block}.tab-page h2{font-size:19px;margin:3px 0 14px}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:20px 0}.stat{background:#ffffff08;border:1px solid #ffffff10;border-radius:13px;padding:12px 7px;text-align:center}.stat b{display:block;font-size:16px;color:#d6caff}.stat span{font-size:10px;color:var(--muted)}.notice{background:#a28bff12;border:1px solid #a28bff38;border-radius:13px;padding:13px;color:#d8d1f0;font-size:12px;line-height:1.8;margin:16px 0}.field{margin:14px 0}.field label{display:block;font-size:13px;margin-bottom:7px;color:#e4e0f5}.field input[type=range]{padding:0;accent-color:var(--purple)}.field textarea{resize:vertical}.field output{color:var(--pink);font-weight:700}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #ffffff12}.toggle-row b,.toggle-row small{display:block}.toggle-row b{font-size:14px}.toggle-row small{font-size:11px;color:var(--muted);margin-top:4px}.toggle-row input{width:21px;height:21px;accent-color:var(--purple)}.save-bar{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid #ffffff15;padding-top:16px;margin-top:20px;flex-wrap:wrap}.save-bar .muted{font-size:11px;flex:1}.link-btn{display:inline-flex;text-decoration:none;align-items:center;justify-content:center}.left-actions{justify-content:flex-start}.file-label{display:inline-flex;align-items:center;justify-content:center}.btn.danger{background:#9d3452;color:#fff}@media(min-width:700px){.admin-grid{grid-template-columns:210px minmax(0,1fr)}.admin-nav{grid-template-columns:1fr}.nav-btn{font-size:13px;padding:13px}.admin-content{padding:25px}.admin-wrap{padding-top:34px}.service-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.service-card{grid-template-columns:34px 1fr}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}}@media(max-width:480px){.admin-wrap{padding-inline:12px}.service-panel{padding:14px}.service-card{grid-template-columns:30px 1fr;gap:5px 8px}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}.admin-heading-actions .btn{flex:1}.admin-login-form input{font-size:18px}}[hidden]{display:none!important}", type: "text/css; charset=utf-8" }],
    ["/app.js", { body: "const $ = id => document.getElementById(id);\n// Hidden manager entry: tap the brand five times within three seconds.\n(() => {\n  const brand = document.querySelector(\".brand\");\n  if (!brand) return;\n  let taps = 0;\n  let resetTimer;\n  brand.addEventListener(\"click\", event => {\n    event.preventDefault();\n    taps += 1;\n    clearTimeout(resetTimer);\n    resetTimer = setTimeout(() => { taps = 0; }, 3000);\n    if (taps >= 5) window.location.assign(\"/admin.html\");\n  });\n  window.addEventListener(\"keydown\", event => {\n    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === \"a\") {\n      event.preventDefault();\n      window.location.assign(\"/admin.html\");\n    }\n  });\n})();\nlet authMode = \"login\";\nlet currentUser = null;\nlet recognition = null;\nconst appSettings = loadLocalSettings();\n\nfunction loadLocalSettings() {\n  const defaults = {\n    appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n    welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n    welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n    greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n    voiceButton: \"اتكلم معايا\",\n    voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n    enableVoice: true, voiceLocale: \"ar-EG\"\n  };\n  try {\n    const saved = JSON.parse(localStorage.getItem(\"wensAISettings\") || \"{}\");\n    if (!saved || typeof saved !== \"object\" || Array.isArray(saved)) return defaults;\n    return {\n      ...defaults,\n      ...Object.fromEntries(Object.entries(saved).filter(([key, value]) =>\n        key in defaults && typeof value === typeof defaults[key]\n      ))\n    };\n  } catch { return defaults; }\n}\n\nfunction applyLocalSettings() {\n  document.title = appSettings.appName;\n  $(\"brandName\").textContent = appSettings.appName;\n  $(\"eyebrowText\").textContent = appSettings.eyebrow;\n  $(\"welcomeTitle\").textContent = appSettings.welcomeTitle;\n  $(\"welcomeText\").textContent = appSettings.welcomeText;\n  $(\"voiceButtonText\").textContent = appSettings.voiceButton;\n  $(\"voiceBtn\").hidden = !appSettings.enableVoice;\n  const themes = {\n    purple: [\"#b49aff\", \"#ffacd6\"],\n    blue: [\"#83baff\", \"#8ce8ef\"],\n    green: [\"#8cddb4\", \"#c5ed9a\"],\n    rose: [\"#ff9fc1\", \"#ffc4a6\"]\n  };\n  const colors = themes[appSettings.theme] || themes.purple;\n  document.documentElement.style.setProperty(\"--purple\", colors[0]);\n  document.documentElement.style.setProperty(\"--pink\", colors[1]);\n}\n\nasync function api(path, body, method = \"POST\") {\n  const response = await fetch(path, {\n    method,\n    credentials: \"same-origin\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"حصل خطأ في الاتصال بالخادم.\");\n  return data;\n}\nfunction setAuthMessage(message, error = false) {\n  $(\"authStatus\").textContent = message || \"\";\n  $(\"authStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction showAuth() {\n  $(\"authPanel\").hidden = false;\n  $(\"appRoot\").hidden = true;\n  $(\"logoutBtn\").hidden = true;\n}\nfunction showApp(user) {\n  currentUser = user;\n  $(\"authPanel\").hidden = true;\n  $(\"appRoot\").hidden = false;\n  $(\"logoutBtn\").hidden = false;\n  $(\"accountLabel\").textContent = user.id === \"guest\"\n    ? \"وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات\"\n    : \"مسجّل الدخول: \" + user.name;\n  loadChatHistory();\n}\nfunction updateAuthMode() {\n  const registering = authMode === \"register\";\n  $(\"nameField\").hidden = !registering;\n  $(\"authTitle\").textContent = registering ? \"إنشاء حساب ونس\" : \"أهلًا بيك في ونس\";\n  $(\"authSubmit\").textContent = registering ? \"إنشاء الحساب\" : \"تسجيل الدخول\";\n  $(\"authToggle\").textContent = registering ? \"عندي حساب بالفعل\" : \"إنشاء حساب جديد\";\n  $(\"passwordInput\").autocomplete = registering ? \"new-password\" : \"current-password\";\n}\n$(\"authToggle\").addEventListener(\"click\", () => {\n  authMode = authMode === \"login\" ? \"register\" : \"login\";\n  updateAuthMode();\n  setAuthMessage(\"\");\n});\n$(\"authForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  $(\"authSubmit\").disabled = true;\n  setAuthMessage(\"جاري التحقق من الحساب...\");\n  const body = {\n    email: $(\"emailInput\").value.trim(),\n    password: $(\"passwordInput\").value,\n    name: $(\"nameInput\").value.trim()\n  };\n  try {\n    const data = await api(authMode === \"register\" ? \"/api/auth/register\" : \"/api/auth/login\", body);\n    $(\"passwordInput\").value = \"\";\n    showApp(data.user);\n  } catch (error) {\n    setAuthMessage(error.message, true);\n  } finally {\n    $(\"authSubmit\").disabled = false;\n  }\n});\n$(\"logoutBtn\").addEventListener(\"click\", async () => {\n  try { await api(\"/api/auth/logout\", {}); } catch {}\n  currentUser = null;\n  $(\"messages\").replaceChildren();\n  showAuth();\n  setAuthMessage(\"تم تسجيل الخروج.\");\n});\nasync function loadChatHistory() {\n  $(\"messages\").replaceChildren();\n  try {\n    const data = await api(\"/api/chat/history\", undefined, \"GET\");\n    for (const item of data.messages || []) addMessage(item.content, item.role);\n    if (!(data.messages || []).length) addMessage(appSettings.greeting);\n  } catch (error) {\n    addMessage(\"تعذّر تحميل المحادثة: \" + error.message);\n  }\n}\nfunction addMessage(text, who = \"assistant\") {\n  const row = document.createElement(\"div\");\n  row.className = \"message \" + who;\n  if (who === \"assistant\") {\n    const avatar = document.createElement(\"img\");\n    avatar.className = \"mini-avatar\";\n    avatar.src = \"avatar.svg\";\n    avatar.alt = \"ونس\";\n    avatar.width = 30;\n    avatar.height = 30;\n    row.appendChild(avatar);\n  }\n  const bubble = document.createElement(\"div\");\n  bubble.className = \"bubble\";\n  bubble.textContent = text;\n  row.appendChild(bubble);\n  $(\"messages\").appendChild(row);\n  $(\"messages\").scrollTop = $(\"messages\").scrollHeight;\n}\nfunction setBusy(busy) {\n  document.querySelector(\".send-btn\").disabled = busy;\n  $(\"messageInput\").disabled = busy;\n  document.querySelector(\".send-btn\").textContent = busy ? \"ونس بتفكر…\" : \"إرسال\";\n}\n$(\"chatForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const message = $(\"messageInput\").value.trim();\n  if (!message || !currentUser) return;\n  addMessage(message, \"user\");\n  $(\"messageInput\").value = \"\";\n  setBusy(true);\n  try {\n    const data = await api(\"/api/chat\", { message });\n    addMessage(data.reply);\n    speak(data.reply);\n  } catch (error) {\n    addMessage(\"معلش، مش قادرة أكمل دلوقتي. \" + error.message);\n  } finally {\n    setBusy(false);\n    $(\"messageInput\").focus();\n  }\n});\n$(\"clearBtn\").addEventListener(\"click\", () => {\n  $(\"messages\").replaceChildren();\n  addMessage(\"تم مسح عرض المحادثة من الشاشة. سجل الرسائل المحفوظ في الحساب لم يُحذف.\");\n});\nfunction speak(text) {\n  if (window.WensNative && typeof window.WensNative.speak === \"function\") {\n    window.WensNative.speak(String(text));\n    return;\n  }\n  if (!(\"speechSynthesis\" in window)) return;\n  const utterance = new SpeechSynthesisUtterance(text);\n  utterance.lang = appSettings.voiceLocale;\n  utterance.rate = Math.min(1.35, Math.max(0.65, Number(appSettings.voiceRate) || 0.96));\n  utterance.pitch = Math.min(1.5, Math.max(0.7, Number(appSettings.voicePitch) || 1.12));\n  const voices = speechSynthesis.getVoices();\n  utterance.voice = voices.find(v => v.lang.toLowerCase().startsWith(\"ar-eg\")) || voices.find(v => v.lang.toLowerCase().startsWith(\"ar\")) || null;\n  utterance.onstart = () => { document.querySelector(\".orb\")?.classList.add(\"talking\"); document.querySelector(\".face\")?.classList.add(\"talking\"); };\n  const stopAvatarSpeech = () => { document.querySelector(\".orb\")?.classList.remove(\"talking\"); document.querySelector(\".face\")?.classList.remove(\"talking\"); };\n  utterance.onend = stopAvatarSpeech;\n  utterance.onerror = stopAvatarSpeech;\n  speechSynthesis.cancel();\n  speechSynthesis.speak(utterance);\n}\n$(\"voiceBtn\").addEventListener(\"click\", () => {\n  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;\n  if (!SpeechRecognition) {\n    $(\"voiceStatus\").textContent = \"التعرّف على الكلام مش مدعوم في المتصفح ده؛ استخدم الكتابة.\";\n    return;\n  }\n  if (recognition) { recognition.stop(); return; }\n  recognition = new SpeechRecognition();\n  recognition.lang = appSettings.voiceLocale;\n  recognition.interimResults = false;\n  recognition.onstart = () => { $(\"voiceStatus\").textContent = \"سامعاك... اتكلم دلوقتي 🎙️\"; $(\"voiceBtn\").classList.add(\"listening\"); };\n  recognition.onresult = event => { $(\"messageInput\").value = event.results[0][0].transcript; $(\"chatForm\").requestSubmit(); };\n  recognition.onerror = event => { $(\"voiceStatus\").textContent = event.error === \"not-allowed\" ? \"اسمح باستخدام الميكروفون من إعدادات الجهاز.\" : \"ماقدرتش ألتقط الكلام؛ جرّب تاني.\"; };\n  recognition.onend = () => { recognition = null; $(\"voiceBtn\").classList.remove(\"listening\"); };\n  recognition.start();\n});\n\nasync function loadSystemStatus() {\n  try {\n    const response = await fetch(\"/api/health\", { cache: \"no-store\" });\n    const data = await response.json();\n    const f = data.features || {};\n    const labels = [\n      \"Cloudflare AI \" + (f.workersAI ? \"جاهز\" : \"غير مربوط\"),\n      \"قاعدة البيانات \" + (f.database ? \"جاهزة\" : \"غير مربوطة\")\n    ];\n    $(\"systemStatus\").textContent = labels.join(\" · \");\n    $(\"systemStatus\").classList.toggle(\"all-ready\", !!(f.workersAI && f.database));\n    return data;\n  } catch {\n    $(\"systemStatus\").textContent = \"تعذّر فحص حالة الخادم.\";\n    return null;\n  }\n}\nasync function loadServerSettings() {\n  try {\n    const data = await api(\"/api/settings\", undefined, \"GET\");\n    if (data.settings && typeof data.settings === \"object\") Object.assign(appSettings, data.settings);\n  } catch {}\n  applyLocalSettings();\n}\nasync function boot() {\n  applyLocalSettings();\n  await loadServerSettings();\n  updateAuthMode();\n  const health = await loadSystemStatus();\n  if (health && health.ok && health.features && !health.features.database) {\n    showApp({ id: \"guest\", name: \"زائر\" });\n    return;\n  }\n  try {\n    const data = await api(\"/api/auth/me\", undefined, \"GET\");\n    showApp(data.user);\n  } catch {\n    showAuth();\n  }\n}\nboot();\n", type: "text/javascript; charset=utf-8" }]
]);

const ADMIN_EMAIL = "naslok3@gmail.com";
const ADMIN_SESSION_SECONDS = 4 * 60 * 60;
const adminLoginAttempts = new Map();
const DEFAULT_APP_SETTINGS = {
  appName: "ونس AI", assistantName: "ونس", eyebrow: "موجودة علشانك",
  welcomeTitle: "أهلًا بيك، أنا ونس 💜",
  welcomeText: "اتكلم معايا واسألني اللي في بالك.",
  greeting: "أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.",
  voiceButton: "اتكلم معايا", voiceRate: 0.96, voicePitch: 1.12,
  theme: "purple", enableVoice: true, voiceLocale: "ar-EG"
};
const APP_SETTING_LIMITS = {
  appName: 45, assistantName: 35, eyebrow: 80, welcomeTitle: 100,
  welcomeText: 240, greeting: 350, voiceButton: 45
};
let settingsTableReady;

function normalizeAppSettings(input) {
  const next = { ...DEFAULT_APP_SETTINGS };
  if (!input || typeof input !== "object" || Array.isArray(input)) return next;
  for (const [key, limit] of Object.entries(APP_SETTING_LIMITS)) {
    if (typeof input[key] === "string") next[key] = input[key].trim().slice(0, limit);
  }
  if (typeof input.enableVoice === "boolean") next.enableVoice = input.enableVoice;
  if (Number.isFinite(Number(input.voiceRate))) next.voiceRate = Math.min(1.35, Math.max(0.65, Number(input.voiceRate)));
  if (Number.isFinite(Number(input.voicePitch))) next.voicePitch = Math.min(1.5, Math.max(0.7, Number(input.voicePitch)));
  if (["purple", "blue", "green", "rose"].includes(input.theme)) next.theme = input.theme;
  if (["ar-EG", "ar-SA", "en-US"].includes(input.voiceLocale)) next.voiceLocale = input.voiceLocale;
  return next;
}
async function ensureSettingsTable(db) {
  if (!settingsTableReady) {
    settingsTableReady = db.prepare(
      "CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run().catch(error => { settingsTableReady = null; throw error; });
  }
  await settingsTableReady;
}
async function readAppSettings(env) {
  if (!env.DB) return { ...DEFAULT_APP_SETTINGS };
  await ensureSettingsTable(env.DB);
  const row = await env.DB.prepare("SELECT setting_value FROM app_settings WHERE setting_key='global' LIMIT 1").first();
  if (!row?.setting_value) return { ...DEFAULT_APP_SETTINGS };
  try { return normalizeAppSettings(JSON.parse(row.setting_value)); }
  catch { return { ...DEFAULT_APP_SETTINGS }; }
}
async function writeAppSettings(env, input) {
  if (!env.DB) throw new Error("DB_NOT_CONFIGURED");
  const settings = normalizeAppSettings(input);
  await ensureSettingsTable(env.DB);
  await env.DB.prepare(
    "INSERT INTO app_settings (setting_key,setting_value,updated_at) VALUES ('global',?,?) " +
    "ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at"
  ).bind(JSON.stringify(settings), Math.floor(Date.now() / 1000)).run();
  return settings;
}
function adminAttemptAllowed(ip) {
  const now = Date.now(), item = adminLoginAttempts.get(ip);
  if (!item || now - item.startedAt > 15 * 60 * 1000) {
    adminLoginAttempts.set(ip, { startedAt: now, count: 0 });
    return true;
  }
  return item.count < 5;
}
function recordAdminAttempt(ip) {
  const item = adminLoginAttempts.get(ip) || { startedAt: Date.now(), count: 0 };
  item.count += 1;
  adminLoginAttempts.set(ip, item);
}
async function adminUser(request, env) {
  const user = await currentUser(request, env);
  return user && String(user.email || "").toLowerCase() === ADMIN_EMAIL ? user : null;
}
async function issueAdminSession(db, user) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000), tokenHash = await digest(token);
  await db.prepare(
    "INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)"
  ).bind(crypto.randomUUID(), user.id, tokenHash, now + ADMIN_SESSION_SECONDS, now).run();
  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.display_name } },
    200, { "Set-Cookie": sessionCookie(token, ADMIN_SESSION_SECONDS) }
  );
}
async function adminRoute(request, env, path) {
  if (path === "/api/admin/logout" && request.method === "POST") {
    const raw = cookieValue(request.headers.get("Cookie"), COOKIE);
    if (raw && env.DB) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(raw)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (path === "/api/admin/login" && request.method === "POST") {
    if (!env.DB) return json({ error: "قاعدة بيانات الحسابات غير متاحة حاليًا." }, 503);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!adminAttemptAllowed(ip)) return json({ error: "محاولات كثيرة. انتظر 15 دقيقة ثم جرّب مرة أخرى." }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات الدخول غير صالحة." }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email !== ADMIN_EMAIL || password.length < 8 || password.length > 128) {
      recordAdminAttempt(ip);
      return json({ error: "هذا الحساب غير مصرح له بإدارة التطبيق أو بيانات الدخول غير صحيحة." }, 401);
    }
    try {
      const user = await env.DB.prepare(
        "SELECT id,email,display_name,password_hash,password_salt FROM users WHERE email=? LIMIT 1"
      ).bind(ADMIN_EMAIL).first();
      if (!user) { recordAdminAttempt(ip); return json({ error: "حساب المدير غير موجود في قاعدة البيانات." }, 403); }
      const candidate = await passwordHash(password, user.password_salt);
      if (!same(candidate, user.password_hash)) {
        recordAdminAttempt(ip);
        return json({ error: "كلمة المرور غير صحيحة." }, 401);
      }
      adminLoginAttempts.delete(ip);
      return await issueAdminSession(env.DB, user);
    } catch (error) {
      console.error("[WENS_ADMIN_LOGIN_FAILURE]", String(error?.message || error).slice(0, 180));
      return json({ error: "تعذّر إكمال تسجيل دخول المدير. حاول مرة أخرى." }, 500);
    }
  }
  if (path === "/api/admin/session" && request.method === "GET") {
    const user = await adminUser(request, env);
    return json({ configured: Boolean(env.DB), authenticated: Boolean(user) });
  }
  if (!(await adminUser(request, env))) return json({ error: "سجّل الدخول بحساب مالك التطبيق أولًا." }, 401);
  if (path === "/api/admin/settings" && request.method === "GET") {
    return json({ settings: await readAppSettings(env) });
  }
  if (path === "/api/admin/settings" && request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "الإعدادات المرسلة غير صالحة." }, 400); }
    const settings = await writeAppSettings(env, body.settings || body);
    return json({ ok: true, settings });
  }
  if (path === "/api/admin/status" && request.method === "GET") {
    let databaseConnected = false, databaseSchemaReady = false, settingsStorageReady = false;
    if (env.DB) {
      try {
        const probe = await env.DB.prepare("SELECT 1 AS ok").first();
        databaseConnected = Number(probe?.ok) === 1;
        if (databaseConnected) {
          const schema = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','messages')"
          ).first();
          databaseSchemaReady = Number(schema?.total) === 3;
          await ensureSettingsTable(env.DB);
          settingsStorageReady = true;
        }
      } catch {}
    }
    return json({
      ok: true, checkedAt: new Date().toISOString(),
      model: env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct",
      features: {
        workersAI: Boolean(env.AI), databaseConfigured: Boolean(env.DB),
        databaseConnected, databaseSchemaReady, settingsStorageReady
      }
    });
  }
  if (path === "/api/admin/test-ai" && request.method === "POST") {
    if (!env.AI) return json({ error: "ربط Cloudflare Workers AI غير موجود على هذا الخادم." }, 503);
    try {
      const model = env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct";
      const result = await env.AI.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "اكتبي كلمة واحدة فقط: جاهزة" }
        ], temperature: 0, max_tokens: 12
      });
      const reply = typeof result?.response === "string" ? result.response.trim() : "";
      return reply ? json({ ok: true, model, reply }) : json({ error: "تم الاتصال بالنموذج لكنه لم يرجع نصًا." }, 502);
    } catch {
      return json({ error: "تعذّر تشغيل نموذج Cloudflare Workers AI. راجع الحصة اليومية وحالة النموذج." }, 502);
    }
  }
  return json({ error: "مسار إدارة غير موجود." }, 404);
}

async function handleChat(request, env, user) {
  if (!env.AI) {
    return json({ error: "خدمة الذكاء الاصطناعي المجانية غير مربوطة على الخادم." }, 503);
  }
  const db = env.DB || null;
  let body;
  try { body = await request.json(); } catch { return json({ error: "بيانات الرسالة غير صالحة." }, 400); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return json({ error: "اكتب رسالتك الأول." }, 400);
  if (message.length > 6000) return json({ error: "الرسالة طويلة جدًا؛ اختصرها قليلًا." }, 400);
  const now = Math.floor(Date.now() / 1000);
  if (db && user) {
    await db.prepare("INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), user.id, "user", message, now).run();
  }
  const recent = db && user
    ? await db.prepare("SELECT role,content FROM messages WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 16")
        .bind(user.id).all()
    : { results: [] };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(recent.results || []).reverse().map(x => ({ role: x.role, content: x.content }))
  ];
  if (!db || !user) messages.push({ role: "user", content: message });
  try {
    const model = env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct";
    const result = await env.AI.run(model, {
      messages,
      temperature: 0.7,
      max_tokens: 500
    });
    const reply = typeof result?.response === "string" ? result.response.trim() : "";
    if (!reply) return json({ error: "لم يصل رد نصي من نموذج الذكاء الاصطناعي." }, 502);
    if (db && user) {
      await db.prepare("INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), user.id, "assistant", reply, Math.floor(Date.now() / 1000)).run();
    }
    return json({ reply, model });
  } catch (error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (/daily free allocation|neurons|quota|account limited/.test(message)) {
      return json({ error: "وصلنا للحد المجاني اليومي للذكاء الاصطناعي على Cloudflare. الحصة تتجدد يوميًا؛ جرّب بعد منتصف الليل UTC." }, 429);
    }
    if (/out of capacity|capacity temporarily|rejectifbusy/.test(message)) {
      return json({ error: "نموذج Cloudflare مشغول حاليًا. جرّب تاني بعد قليل." }, 503);
    }
    return json({ error: "تعذّر تشغيل نموذج Cloudflare AI حاليًا. حاول مرة أخرى بعد قليل." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") {
      const workersAiBindingPresent = Boolean(env.AI);
      return json({
        ok: true,
        service: "wens-ai",
        configured: workersAiBindingPresent,
        features: {
          workersAI: workersAiBindingPresent,
          database: Boolean(env.DB),
          adminProtectionConfigured: Boolean(env.DB)
        },
        diagnostics: {
          workersAiBindingPresent,
          model: workersAiBindingPresent ? (env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct") : null
        }
      });
    }
    try {
      if (path === "/api/settings" && request.method === "GET") return json({ settings: await readAppSettings(env) });
      if (path.startsWith("/api/admin/")) return await adminRoute(request, env, path);
      if (path.startsWith("/api/auth/")) return await authRoute(request, env, path, requestId);
      if (path === "/api/chat/history" && request.method === "GET") {
        if (!env.DB) return json({ messages: [], persistence: false });
        const user = await currentUser(request, env);
        if (!user) return json({ error: "سجّل الدخول الأول." }, 401);
        const rows = await requireDb(env).prepare("SELECT role,content,created_at FROM messages WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 60").bind(user.id).all();
        return json({ messages: (rows.results || []).reverse(), persistence: true });
      }
      if (path === "/api/chat" && request.method === "POST") {
        const user = env.DB ? await currentUser(request, env) : null;
        if (env.DB && !user) return json({ error: "سجّل الدخول الأول لاستخدام ونس." }, 401);
        return await handleChat(request, env, user);
      }
      if (path.startsWith("/api/")) return json({ error: "المسار غير موجود." }, 404);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "المسار غير موجود." }, 404);
    } catch (error) {
      const detail = String(error?.message || error || "unknown")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, "[email]")
        .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
        .slice(0, 240);
      console.error("[WENS_REQUEST_FAILURE]", JSON.stringify({
        requestId,
        path,
        errorName: String(error?.name || "Error").slice(0, 80),
        detail
      }));
      if (String(error?.message) === "DB_NOT_CONFIGURED") {
        return json({ error: "قاعدة البيانات غير مربوطة بالخادم بعد.", code: "DB_NOT_CONFIGURED", requestId }, 503);
      }
      return json({ error: "حصل خطأ داخلي. حاول مرة أخرى.", code: "INTERNAL_ERROR", requestId }, 500);
    }
  }
};
