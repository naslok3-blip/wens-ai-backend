import { scrypt } from "node:crypto";

const SYSTEM_PROMPT = "أنتِ ونس، رفيقة افتراضية مصرية ودودة وذكية. تحدثي باللهجة المصرية الطبيعية وبصيغة المؤنث عن نفسك. كوني دافئة ومحترمة وخفيفة الظل دون ادعاء أنك إنسانة حقيقية. أجيبي بوضوح وباختصار مناسب. لا تدّعي أنك ترين أو تسمعين شيئًا لم يتم إرساله فعليًا. لا تطلبي كلمات مرور أو مفاتيح سرية أو بيانات دفع. قدّمي معلومات عامة في المجالات عالية المخاطر ونبّهي للرجوع لمختص.";

const enc = new TextEncoder();
const COOKIE = "wens_session";
const ADMIN_COOKIE = "wens_admin_session";
let adminTablesReady;
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
function adminSessionCookie(token, maxAge = 4 * 60 * 60) {
  return ADMIN_COOKIE + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;
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
    ["/index.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0b0b16\"><link rel=\"manifest\" href=\"manifest.json\"><link rel=\"stylesheet\" href=\"style.css\"><link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b id=\"brandName\">ونس AI</b><small>رفيقة يومك الذكية</small></span></a>\n  <div class=\"top-actions\"><button id=\"openAdminBtn\" class=\"admin-shortcut\" type=\"button\" hidden>الإدارة</button><button id=\"backToAppBtn\" class=\"admin-shortcut\" type=\"button\" hidden>العودة لونس</button><button id=\"logoutBtn\" class=\"admin-shortcut\" hidden>خروج</button></div>\n</header>\n<main class=\"app\">\n<section id=\"authPanel\" class=\"panel auth-panel\">\n  <div class=\"auth-mark\">و</div><p class=\"eyebrow\">مساحتك الخاصة</p><h1 id=\"authTitle\">أهلًا بيك في ونس</h1>\n  <p class=\"hero-text\">سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.</p>\n  <form id=\"authForm\" class=\"auth-form\">\n    <label id=\"nameField\" hidden>الاسم<input id=\"nameInput\" maxlength=\"60\" autocomplete=\"name\" placeholder=\"اسمك\"></label>\n    <label>البريد الإلكتروني<input id=\"emailInput\" type=\"email\" maxlength=\"190\" autocomplete=\"email\" required placeholder=\"name@example.com\"></label>\n    <label>كلمة المرور<input id=\"passwordInput\" type=\"password\" minlength=\"8\" maxlength=\"128\" autocomplete=\"current-password\" required placeholder=\"8 أحرف على الأقل\"></label>\n    <button id=\"authSubmit\" class=\"btn primary\" type=\"submit\">تسجيل الدخول</button>\n  </form>\n  <button id=\"authToggle\" class=\"text-btn auth-toggle\" type=\"button\">إنشاء حساب جديد</button>\n  <p id=\"authStatus\" class=\"status-line\" role=\"status\"></p><p id=\"systemStatus\" class=\"system-status\" role=\"status\">جاري فحص اتصال الخدمات...</p>\n  <p class=\"disclaimer\">كلمة المرور تُخزّن مشفّرة تجزئيًا في قاعدة البيانات، ولا تُعرض داخل التطبيق. لا تستخدم كلمة مرور حسابك في مواقع أخرى.</p>\n</section>\n\n<div id=\"appRoot\" hidden>\n<section class=\"hero\">\n  <img class=\"hero-portrait\" src=\"avatar.svg\" alt=\"الصورة الشخصية لونس\" width=\"192\" height=\"192\">\n  <p class=\"eyebrow\" id=\"eyebrowText\">موجودة علشانك</p><h1 id=\"welcomeTitle\">أهلًا بيك، أنا ونس 💜</h1>\n  <p id=\"welcomeText\" class=\"hero-text\">اتكلم معايا واسألني اللي في بالك.</p>\n  <div class=\"actions\"><button id=\"voiceBtn\" class=\"btn primary\">🎙️ <span id=\"voiceButtonText\">اتكلم معايا</span></button><a class=\"btn secondary\" href=\"/agent.html\" style=\"text-decoration:none;display:inline-flex;align-items:center;justify-content:center\">🤖 وكيل ونس الذكي</a></div>\n  <p id=\"voiceStatus\" class=\"status-line\" aria-live=\"polite\"></p>\n</section>\n\n<section class=\"panel\">\n  <div class=\"section-head\"><div><h2>الدردشة مع ونس</h2><p id=\"accountLabel\">محادثتك محفوظة في حسابك</p></div><button id=\"clearBtn\" class=\"text-btn\">مسح العرض</button></div>\n  <div id=\"messages\" class=\"messages\" aria-live=\"polite\"><div class=\"message assistant\"><div class=\"mini-avatar\">و</div><div class=\"bubble\">أهلًا بيك! أنا ونس 💜 اسأليني أو احكيلي اللي في بالك.</div></div></div>\n  <form id=\"chatForm\" class=\"chat-form\"><input id=\"messageInput\" placeholder=\"اكتب رسالتك هنا...\" autocomplete=\"off\" aria-label=\"رسالتك\"><button class=\"send-btn\" type=\"submit\">إرسال</button></form>\n  <p class=\"disclaimer\">رسائلك تُعالج عبر Cloudflare Workers AI، وتُحفظ في قاعدة بيانات حسابك. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.</p>\n</section>\n</div>\n<section id=\"adminSection\" class=\"admin-wrap\" hidden>\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة. أول مرة؟ هيّئها بأمان أدناه.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"naslok3@gmail.com\" required>\n      <label for=\"adminPassword\">كلمة المرور</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"20\" maxlength=\"128\" placeholder=\"كلمة مرور المدير المستقلة\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <button id=\"showAdminResetBtn\" class=\"text-btn auth-toggle\" type=\"button\" hidden>نسيت كلمة مرور المدير؟ إنشاء كلمة مرور جديدة</button>\n    <form id=\"adminSetupForm\" class=\"admin-login-form\" hidden>\n      <p class=\"muted\">يشترط أن تكون مسجلًا بالفعل بحساب المالك في ونس. أدخل كلمة مرور حساب ونس الحالية؛ سيُنشئ الخادم كلمة مرور مدير مستقلة ويحفظها ثم يعرضها لك مرة واحدة.</p>\n      <label for=\"ownerPassword\">كلمة مرور حساب ونس الحالية</label>\n      <input id=\"ownerPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" required>\n      <button id=\"adminSetupBtn\" class=\"btn primary\" type=\"submit\">إنشاء كلمة مرور مدير مستقلة</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">كلمة مرور المدير مستقلة عن كلمة مرور حساب ونس. احتفظ بها في مكان آمن.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <div id=\"adminNewPasswordNotice\" class=\"notice\" hidden>\n      <b>تم إنشاء كلمة مرور المدير المستقلة.</b>\n      <p>انسخها واحفظها الآن؛ لن يعرضها التطبيق مرة أخرى بعد إغلاق هذه الصفحة.</p>\n      <code id=\"adminNewPasswordText\" dir=\"ltr\" style=\"display:block;overflow-wrap:anywhere;font-size:16px;padding:10px 0\"></code>\n      <button id=\"copyAdminPasswordBtn\" class=\"btn secondary\" type=\"button\">نسخ كلمة المرور</button>\n      <p id=\"copyAdminPasswordStatus\" class=\"muted\"></p>\n    </div>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</section>\n</main>\n<footer>ونس AI • نسخة تطويرية</footer>\n<script src=\"app.js\"></script><script type=\"module\" src=\"/owner-panel.js\"></script>\n</body></html>\n", type: "text/html; charset=utf-8" }],
    ["/admin.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة. أول مرة؟ هيّئها بأمان أدناه.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"naslok3@gmail.com\" required>\n      <label for=\"adminPassword\">كلمة المرور</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"20\" maxlength=\"128\" placeholder=\"كلمة مرور المدير المستقلة\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <button id=\"showAdminResetBtn\" class=\"text-btn auth-toggle\" type=\"button\" hidden>نسيت كلمة مرور المدير؟ إنشاء كلمة مرور جديدة</button>\n    <form id=\"adminSetupForm\" class=\"admin-login-form\" hidden>\n      <p class=\"muted\">يشترط أن تكون مسجلًا بالفعل بحساب المالك في ونس. أدخل كلمة مرور حساب ونس الحالية؛ سيُنشئ الخادم كلمة مرور مدير مستقلة ويحفظها ثم يعرضها لك مرة واحدة.</p>\n      <label for=\"ownerPassword\">كلمة مرور حساب ونس الحالية</label>\n      <input id=\"ownerPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" required>\n      <button id=\"adminSetupBtn\" class=\"btn primary\" type=\"submit\">إنشاء كلمة مرور مدير مستقلة</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">كلمة مرور المدير مستقلة عن كلمة مرور حساب ونس. احتفظ بها في مكان آمن.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <div id=\"adminNewPasswordNotice\" class=\"notice\" hidden>\n      <b>تم إنشاء كلمة مرور المدير المستقلة.</b>\n      <p>انسخها واحفظها الآن؛ لن يعرضها التطبيق مرة أخرى بعد إغلاق هذه الصفحة.</p>\n      <code id=\"adminNewPasswordText\" dir=\"ltr\" style=\"display:block;overflow-wrap:anywhere;font-size:16px;padding:10px 0\"></code>\n      <button id=\"copyAdminPasswordBtn\" class=\"btn secondary\" type=\"button\">نسخ كلمة المرور</button>\n      <p id=\"copyAdminPasswordStatus\" class=\"muted\"></p>\n    </div>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/admin.js", { body: "const $ = id => document.getElementById(id);\nconst defaults = {\n  appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n  welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n  welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n  greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n  voiceButton: \"اتكلم معايا\",\n  voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n  enableVoice: true, voiceLocale: \"ar-EG\"\n};\nconst keys = Object.keys(defaults);\nlet config = { ...defaults };\nasync function request(path, body, method = \"GET\") {\n  const response = await fetch(path, {\n    method, credentials: \"same-origin\", cache: \"no-store\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"تعذّر تنفيذ الطلب.\");\n  return data;\n}\nfunction gateMessage(message, error = false) {\n  $(\"adminGateStatus\").textContent = message || \"\";\n  $(\"adminGateStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction serviceMessage(message, error = false) {\n  $(\"serviceStatus\").textContent = message || \"\";\n  $(\"serviceStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction normalize(data) {\n  const next = { ...defaults };\n  if (!data || typeof data !== \"object\" || Array.isArray(data)) return next;\n  for (const key of keys) {\n    if (!(key in data)) continue;\n    const value = data[key];\n    if (typeof defaults[key] === \"boolean\") next[key] = value === true;\n    else if (typeof defaults[key] === \"number\") {\n      const max = key === \"voiceRate\" ? 1.35 : 1.5;\n      const min = key === \"voiceRate\" ? 0.65 : 0.7;\n      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];\n    } else if (typeof value === \"string\") {\n      next[key] = value.slice(0, key === \"welcomeText\" ? 240 : key === \"greeting\" ? 350 : 120);\n    }\n  }\n  if (![\"purple\", \"blue\", \"green\", \"rose\"].includes(next.theme)) next.theme = defaults.theme;\n  if (![\"ar-EG\", \"ar-SA\", \"en-US\"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;\n  return next;\n}\nfunction fillSettingsForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (!element) continue;\n    if (element.type === \"checkbox\") element.checked = !!config[key];\n    else element.value = config[key];\n  }\n  updateRanges();\n}\nasync function loadSettings() {\n  const data = await request(\"/api/admin/settings\");\n  config = normalize(data.settings);\n  fillSettingsForm();\n}\nfunction readForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (element) config[key] = element.type === \"checkbox\" ? element.checked :\n      element.type === \"range\" ? Number(element.value) : element.value;\n  }\n}\nfunction updateRanges() {\n  $(\"rateOut\").value = Number($(\"voiceRate\").value).toFixed(2);\n  $(\"pitchOut\").value = Number($(\"voicePitch\").value).toFixed(2);\n}\nfunction setState(id, label, ready) {\n  const element = $(id);\n  element.textContent = label;\n  element.className = ready ? \"state-ready\" : \"state-off\";\n}\nasync function refreshStatus() {\n  $(\"refreshStatusBtn\").disabled = true;\n  try {\n    const data = await request(\"/api/admin/status\");\n    const f = data.features || {};\n    setState(\"workersAiState\", f.workersAI ? \"متصل ويعمل\" : \"غير مربوط\", !!f.workersAI);\n    setState(\"databaseState\", !f.databaseConfigured ? \"غير مربوطة\" : !f.databaseConnected ? \"فشل الاتصال\" : f.databaseSchemaReady ? \"جاهزة\" : \"تحتاج مراجعة\", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));\n    $(\"modelName\").textContent = \"النموذج: \" + (data.model || \"غير محدد\");\n    $(\"databaseDetail\").textContent = !f.databaseConfigured ? \"لم يتم ربط D1 بعد\" : !f.databaseConnected ? \"تعذّر الاتصال بقاعدة البيانات\" : f.settingsStorageReady ? \"الجداول وحفظ الإعدادات جاهزة\" : \"تخزين الإعدادات يحتاج مراجعة\";\n    $(\"checkedAt\").textContent = \"آخر فحص: \" + new Date(data.checkedAt).toLocaleString(\"ar-EG\");\n    serviceMessage(\"تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.\");\n  } catch (error) {\n    serviceMessage(error.message, true);\n    if (/سجّل الدخول/.test(error.message)) {\n      $(\"adminApp\").hidden = true;\n      $(\"adminGate\").hidden = false;\n      gateMessage(\"انتهت جلسة المدير. سجّل الدخول بكلمة مرور المدير المستقلة.\", true);\n    }\n  } finally { $(\"refreshStatusBtn\").disabled = false; }\n}\nasync function showDashboard() {\n  $(\"adminGate\").hidden = true;\n  $(\"adminApp\").hidden = false;\n  try { await loadSettings(); await refreshStatus(); }\n  catch (error) { serviceMessage(error.message, true); }\n}\n$(\"adminSetupForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const ownerPassword = $(\"ownerPassword\").value;\n  $(\"adminSetupBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من ملكية الحساب وإنشاء كلمة مرور المدير...\");\n  try {\n    const result = await request(\"/api/admin/setup\", { email: $(\"adminEmail\").value.trim(), ownerPassword }, \"POST\");\n    if (!result.password || result.password.length < 32) throw new Error(\"الخادم لم يُرجع كلمة مرور المدير. أعد المحاولة.\");\n    $(\"ownerPassword\").value = \"\";\n    $(\"adminSetupForm\").hidden = true;\n    $(\"adminLoginForm\").hidden = false;\n    $(\"adminNewPasswordText\").textContent = result.password;\n    $(\"adminNewPasswordNotice\").hidden = false;\n    await showDashboard();\n    $(\"adminNewPasswordNotice\").hidden = false;\n    gateMessage(\"تم إنشاء كلمة مرور المدير. احفظها من الشريط أعلى لوحة الإدارة.\");\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminSetupBtn\").disabled = false; }\n});\n$(\"copyAdminPasswordBtn\").addEventListener(\"click\", async () => {\n  const value = $(\"adminNewPasswordText\").textContent;\n  try {\n    await navigator.clipboard.writeText(value);\n    $(\"copyAdminPasswordStatus\").textContent = \"تم نسخ كلمة المرور.\";\n  } catch {\n    $(\"copyAdminPasswordStatus\").textContent = \"اضغط مطولًا على كلمة المرور لنسخها.\";\n  }\n});\n$(\"adminLoginForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const email = $(\"adminEmail\").value.trim(), password = $(\"adminPassword\").value;\n  $(\"adminLoginBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من كلمة مرور المدير...\");\n  try {\n    await request(\"/api/admin/login\", { email, password }, \"POST\");\n    $(\"adminPassword\").value = \"\";\n    await showDashboard();\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminLoginBtn\").disabled = false; }\n});\n$(\"adminLogoutBtn\").addEventListener(\"click\", async () => {\n  try { await request(\"/api/admin/logout\", {}, \"POST\"); } catch {}\n  $(\"adminApp\").hidden = true;\n  $(\"adminGate\").hidden = false;\n  $(\"adminPassword\").value = \"\";\n  $(\"adminSetupForm\").hidden = true;\n  $(\"adminLoginForm\").hidden = false;\n  $(\"showAdminResetBtn\").hidden = false;\n  $(\"adminNewPasswordNotice\").hidden = true;\n  $(\"adminNewPasswordText\").textContent = \"\";\n  gateMessage(\"تم تسجيل خروج المدير.\");\n});\n$(\"refreshStatusBtn\").addEventListener(\"click\", refreshStatus);\n$(\"testWorkersAiBtn\").addEventListener(\"click\", async () => {\n  $(\"testWorkersAiBtn\").disabled = true;\n  serviceMessage(\"جاري اختبار Cloudflare Workers AI...\");\n  try {\n    const result = await request(\"/api/admin/test-ai\", {}, \"POST\");\n    serviceMessage(\"اختبار ناجح ✓ رد الخدمة: \" + result.reply);\n    setState(\"workersAiState\", \"يعمل بنجاح\", true);\n  } catch (error) {\n    serviceMessage(error.message, true);\n    setState(\"workersAiState\", \"فشل الاختبار\", false);\n  } finally { $(\"testWorkersAiBtn\").disabled = false; }\n});\ndocument.querySelectorAll(\".nav-btn\").forEach(button => button.addEventListener(\"click\", () => {\n  document.querySelectorAll(\".nav-btn\").forEach(item => item.classList.toggle(\"active\", item === button));\n  document.querySelectorAll(\".tab-page\").forEach(page => page.classList.toggle(\"active\", page.id === \"tab-\" + button.dataset.tab));\n}));\n[\"voiceRate\", \"voicePitch\"].forEach(id => $(id).addEventListener(\"input\", updateRanges));\n$(\"saveBtn\").addEventListener(\"click\", async () => {\n  readForm();\n  $(\"saveBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: config }, \"PUT\");\n    config = normalize(result.settings);\n    fillSettingsForm();\n    $(\"saveStatus\").textContent = \"تم حفظ التعديلات على الخادم لكل المستخدمين ✓\";\n    $(\"saveStatus\").style.color = \"#9be7c1\";\n  } catch (error) {\n    $(\"saveStatus\").textContent = error.message;\n    $(\"saveStatus\").style.color = \"#ff9fba\";\n  } finally { $(\"saveBtn\").disabled = false; }\n});\n$(\"exportBtn\").addEventListener(\"click\", () => {\n  readForm();\n  const blob = new Blob([JSON.stringify(config, null, 2)], { type: \"application/json\" });\n  const url = URL.createObjectURL(blob), link = document.createElement(\"a\");\n  link.href = url; link.download = \"wens-ai-settings.json\"; link.click();\n  URL.revokeObjectURL(url);\n  $(\"backupStatus\").textContent = \"تم تجهيز نسخة من إعدادات الخادم الحالية.\";\n});\n$(\"importFile\").addEventListener(\"change\", async event => {\n  const file = event.target.files[0];\n  if (!file) return;\n  try {\n    const imported = normalize(JSON.parse(await file.text()));\n    const result = await request(\"/api/admin/settings\", { settings: imported }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تم استرجاع الإعدادات وحفظها على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message || \"الملف غير صالح؛ اختَر ملف JSON صحيح.\"; }\n  event.target.value = \"\";\n});\n$(\"resetBtn\").addEventListener(\"click\", async () => {\n  if (!confirm(\"ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟\")) return;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: defaults }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تمت استعادة الإعدادات الافتراضية على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message; }\n});\n(async function bootAdmin() {\n  try {\n    const session = await request(\"/api/admin/session\");\n    if (session.authenticated) await showDashboard();\n    else if (!session.configured) {\n      $(\"adminLoginForm\").hidden = true;\n      $(\"adminSetupForm\").hidden = false;\n      $(\"showAdminResetBtn\").hidden = true;\n      gateMessage(\"أنشئ كلمة مرور المدير المستقلة أولًا. لن تتغير كلمة مرور حساب ونس.\");\n    } else {\n      $(\"adminSetupForm\").hidden = true;\n      $(\"adminLoginForm\").hidden = false;\n      $(\"showAdminResetBtn\").hidden = false;\n      gateMessage(\"أدخل البريد وكلمة مرور المدير المستقلة.\");\n    }\n  } catch (error) {\n    gateMessage(error.message === \"تعذّر تنفيذ الطلب.\"\n      ? \"تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت.\"\n      : error.message, true);\n  }\n})();", type: "text/javascript; charset=utf-8" }],
    ["/admin.css", { body: ".admin-wrap{width:min(1050px,100%);margin:auto;padding:24px 14px 45px}.admin-gate{width:min(460px,100%);margin:7vh auto 30px;padding:clamp(22px,5vw,34px);text-align:center}.admin-gate h1{font-size:clamp(25px,5vw,32px);margin:5px 0}.admin-login-form{display:grid;gap:10px;margin:22px 0 8px;text-align:right}.admin-login-form label{font-size:13px;color:#e8e3f8}.admin-login-form input{width:100%;min-height:52px;padding:14px;background:#0d0c18;border:1px solid #45405f;border-radius:13px;color:var(--text);font:inherit;letter-spacing:0;text-align:right;font-size:16px}.admin-login-form button{width:100%}.admin-heading{padding:8px 2px 18px}.admin-heading h1{margin:4px 0 8px;font-size:clamp(25px,5vw,34px)}.admin-heading>p:not(.eyebrow){color:var(--muted);font-size:13px;line-height:1.8}.admin-heading-actions,.service-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.admin-heading-actions{margin-top:15px}.service-panel{background:linear-gradient(145deg,#1d1b30f2,#141321f2);border:1px solid #ffffff18;border-radius:22px;padding:17px;margin:12px 0 16px;box-shadow:0 18px 55px #0005}.service-panel h2{font-size:17px;margin:0}.service-panel .section-head>div>p{color:var(--muted);font-size:11px;margin:4px 0}.service-grid{display:grid;grid-template-columns:1fr;gap:9px;margin:15px 0}.service-card{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:5px 9px;background:#ffffff08;border:1px solid #ffffff12;border-radius:14px;padding:13px}.service-icon{grid-row:span 2;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:#b49aff1b;color:#d9ccff;font-size:18px}.service-card b{font-size:13px}.service-card strong{font-size:12px;text-align:left}.service-card small{grid-column:2/4;color:var(--muted);font-size:10px}.state-ready{color:#9be7c1}.state-off{color:#ffb4c7}.state-pending{color:#ffcf8f}.service-actions{align-items:center;margin-top:12px}.service-actions .status-line{flex:1;min-width:170px;margin:0}.admin-grid{display:grid;grid-template-columns:1fr;gap:14px}.admin-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-content:start}.nav-btn{border:1px solid #ffffff12;border-radius:12px;padding:12px 8px;text-align:right;background:#19192c;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.nav-btn.active{background:#a28bff24;color:#fff;border-color:#a28bff88}.admin-content{min-width:0;background:#19192ccc;border:1px solid #ffffff12;border-radius:20px;padding:17px}.tab-page{display:none}.tab-page.active{display:block}.tab-page h2{font-size:19px;margin:3px 0 14px}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:20px 0}.stat{background:#ffffff08;border:1px solid #ffffff10;border-radius:13px;padding:12px 7px;text-align:center}.stat b{display:block;font-size:16px;color:#d6caff}.stat span{font-size:10px;color:var(--muted)}.notice{background:#a28bff12;border:1px solid #a28bff38;border-radius:13px;padding:13px;color:#d8d1f0;font-size:12px;line-height:1.8;margin:16px 0}.field{margin:14px 0}.field label{display:block;font-size:13px;margin-bottom:7px;color:#e4e0f5}.field input[type=range]{padding:0;accent-color:var(--purple)}.field textarea{resize:vertical}.field output{color:var(--pink);font-weight:700}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #ffffff12}.toggle-row b,.toggle-row small{display:block}.toggle-row b{font-size:14px}.toggle-row small{font-size:11px;color:var(--muted);margin-top:4px}.toggle-row input{width:21px;height:21px;accent-color:var(--purple)}.save-bar{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid #ffffff15;padding-top:16px;margin-top:20px;flex-wrap:wrap}.save-bar .muted{font-size:11px;flex:1}.link-btn{display:inline-flex;text-decoration:none;align-items:center;justify-content:center}.left-actions{justify-content:flex-start}.file-label{display:inline-flex;align-items:center;justify-content:center}.btn.danger{background:#9d3452;color:#fff}@media(min-width:700px){.admin-grid{grid-template-columns:210px minmax(0,1fr)}.admin-nav{grid-template-columns:1fr}.nav-btn{font-size:13px;padding:13px}.admin-content{padding:25px}.admin-wrap{padding-top:34px}.service-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.service-card{grid-template-columns:34px 1fr}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}}@media(max-width:480px){.admin-wrap{padding-inline:12px}.service-panel{padding:14px}.service-card{grid-template-columns:30px 1fr;gap:5px 8px}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}.admin-heading-actions .btn{flex:1}.admin-login-form input{font-size:18px}}[hidden]{display:none!important}", type: "text/css; charset=utf-8" }],
    ["/app.js", { body: "const $ = id => document.getElementById(id);\n// إدارة ونس تفتح من الصورة الشخصية فقط، داخل الصفحة نفسها.\nlet authMode = \"login\";\nlet currentUser = null;\nlet recognition = null;\nconst appSettings = loadLocalSettings();\n\nfunction loadLocalSettings() {\n  const defaults = {\n    appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n    welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n    welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n    greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n    voiceButton: \"اتكلم معايا\",\n    voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n    enableVoice: true, voiceLocale: \"ar-EG\"\n  };\n  try {\n    const saved = JSON.parse(localStorage.getItem(\"wensAISettings\") || \"{}\");\n    if (!saved || typeof saved !== \"object\" || Array.isArray(saved)) return defaults;\n    return {\n      ...defaults,\n      ...Object.fromEntries(Object.entries(saved).filter(([key, value]) =>\n        key in defaults && typeof value === typeof defaults[key]\n      ))\n    };\n  } catch { return defaults; }\n}\n\nfunction applyLocalSettings() {\n  document.title = appSettings.appName;\n  $(\"brandName\").textContent = appSettings.appName;\n  $(\"eyebrowText\").textContent = appSettings.eyebrow;\n  $(\"welcomeTitle\").textContent = appSettings.welcomeTitle;\n  $(\"welcomeText\").textContent = appSettings.welcomeText;\n  $(\"voiceButtonText\").textContent = appSettings.voiceButton;\n  $(\"voiceBtn\").hidden = !appSettings.enableVoice;\n  const themes = {\n    purple: [\"#b49aff\", \"#ffacd6\"],\n    blue: [\"#83baff\", \"#8ce8ef\"],\n    green: [\"#8cddb4\", \"#c5ed9a\"],\n    rose: [\"#ff9fc1\", \"#ffc4a6\"]\n  };\n  const colors = themes[appSettings.theme] || themes.purple;\n  document.documentElement.style.setProperty(\"--purple\", colors[0]);\n  document.documentElement.style.setProperty(\"--pink\", colors[1]);\n}\n\nasync function api(path, body, method = \"POST\") {\n  const response = await fetch(path, {\n    method,\n    credentials: \"same-origin\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"حصل خطأ في الاتصال بالخادم.\");\n  return data;\n}\nfunction setAuthMessage(message, error = false) {\n  $(\"authStatus\").textContent = message || \"\";\n  $(\"authStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction showAuth() {\n  $(\"authPanel\").hidden = false;\n  $(\"appRoot\").hidden = true;\n  $(\"logoutBtn\").hidden = true;\n}\nfunction showApp(user) {\n  currentUser = user;\n  $(\"authPanel\").hidden = true;\n  $(\"appRoot\").hidden = false;\n  $(\"logoutBtn\").hidden = false;\n  $(\"accountLabel\").textContent = user.id === \"guest\"\n    ? \"وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات\"\n    : \"مسجّل الدخول: \" + user.name;\n  loadChatHistory();\n}\nfunction updateAuthMode() {\n  const registering = authMode === \"register\";\n  $(\"nameField\").hidden = !registering;\n  $(\"authTitle\").textContent = registering ? \"إنشاء حساب ونس\" : \"أهلًا بيك في ونس\";\n  $(\"authSubmit\").textContent = registering ? \"إنشاء الحساب\" : \"تسجيل الدخول\";\n  $(\"authToggle\").textContent = registering ? \"عندي حساب بالفعل\" : \"إنشاء حساب جديد\";\n  $(\"passwordInput\").autocomplete = registering ? \"new-password\" : \"current-password\";\n}\n$(\"authToggle\").addEventListener(\"click\", () => {\n  authMode = authMode === \"login\" ? \"register\" : \"login\";\n  updateAuthMode();\n  setAuthMessage(\"\");\n});\n$(\"authForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  $(\"authSubmit\").disabled = true;\n  setAuthMessage(\"جاري التحقق من الحساب...\");\n  const body = {\n    email: $(\"emailInput\").value.trim(),\n    password: $(\"passwordInput\").value,\n    name: $(\"nameInput\").value.trim()\n  };\n  try {\n    const data = await api(authMode === \"register\" ? \"/api/auth/register\" : \"/api/auth/login\", body);\n    $(\"passwordInput\").value = \"\";\n    showApp(data.user);\n  } catch (error) {\n    setAuthMessage(error.message, true);\n  } finally {\n    $(\"authSubmit\").disabled = false;\n  }\n});\n$(\"logoutBtn\").addEventListener(\"click\", async () => {\n  try { await api(\"/api/auth/logout\", {}); } catch {}\n  currentUser = null;\n  $(\"messages\").replaceChildren();\n  showAuth();\n  setAuthMessage(\"تم تسجيل الخروج.\");\n});\nasync function loadChatHistory() {\n  $(\"messages\").replaceChildren();\n  try {\n    const data = await api(\"/api/chat/history\", undefined, \"GET\");\n    for (const item of data.messages || []) addMessage(item.content, item.role);\n    if (!(data.messages || []).length) addMessage(appSettings.greeting);\n  } catch (error) {\n    addMessage(\"تعذّر تحميل المحادثة: \" + error.message);\n  }\n}\nfunction addMessage(text, who = \"assistant\") {\n  const row = document.createElement(\"div\");\n  row.className = \"message \" + who;\n  if (who === \"assistant\") {\n    const avatar = document.createElement(\"img\");\n    avatar.className = \"mini-avatar\";\n    avatar.src = \"avatar.svg\";\n    avatar.alt = \"ونس\";\n    avatar.width = 30;\n    avatar.height = 30;\n    row.appendChild(avatar);\n  }\n  const bubble = document.createElement(\"div\");\n  bubble.className = \"bubble\";\n  bubble.textContent = text;\n  row.appendChild(bubble);\n  $(\"messages\").appendChild(row);\n  $(\"messages\").scrollTop = $(\"messages\").scrollHeight;\n}\nfunction setBusy(busy) {\n  document.querySelector(\".send-btn\").disabled = busy;\n  $(\"messageInput\").disabled = busy;\n  document.querySelector(\".send-btn\").textContent = busy ? \"ونس بتفكر…\" : \"إرسال\";\n}\n$(\"chatForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const message = $(\"messageInput\").value.trim();\n  if (!message || !currentUser) return;\n  addMessage(message, \"user\");\n  $(\"messageInput\").value = \"\";\n  setBusy(true);\n  try {\n    const data = await api(\"/api/chat\", { message });\n    addMessage(data.reply);\n    if (Array.isArray(data.steps) && data.steps.length) {\n      const summary = data.steps.filter(Boolean).join(\" • \");\n      addMessage(\"نفذت ونس الأدوات التالية: \" + summary);\n    }\n    speak(data.reply);\n  } catch (error) {\n    addMessage(\"معلش، مش قادرة أكمل دلوقتي. \" + error.message);\n  } finally {\n    setBusy(false);\n    $(\"messageInput\").focus();\n  }\n});\n$(\"clearBtn\").addEventListener(\"click\", () => {\n  $(\"messages\").replaceChildren();\n  addMessage(\"تم مسح عرض المحادثة من الشاشة. سجل الرسائل المحفوظ في الحساب لم يُحذف.\");\n});\nfunction speak(text) {\n  if (window.WensNative && typeof window.WensNative.speak === \"function\") {\n    window.WensNative.speak(String(text));\n    return;\n  }\n  if (!(\"speechSynthesis\" in window)) return;\n  const utterance = new SpeechSynthesisUtterance(text);\n  utterance.lang = appSettings.voiceLocale;\n  utterance.rate = Math.min(1.35, Math.max(0.65, Number(appSettings.voiceRate) || 0.96));\n  utterance.pitch = Math.min(1.5, Math.max(0.7, Number(appSettings.voicePitch) || 1.12));\n  const voices = speechSynthesis.getVoices();\n  utterance.voice = voices.find(v => v.lang.toLowerCase().startsWith(\"ar-eg\")) || voices.find(v => v.lang.toLowerCase().startsWith(\"ar\")) || null;\n  utterance.onstart = () => { document.querySelector(\".orb\")?.classList.add(\"talking\"); document.querySelector(\".face\")?.classList.add(\"talking\"); };\n  const stopAvatarSpeech = () => { document.querySelector(\".orb\")?.classList.remove(\"talking\"); document.querySelector(\".face\")?.classList.remove(\"talking\"); };\n  utterance.onend = stopAvatarSpeech;\n  utterance.onerror = stopAvatarSpeech;\n  speechSynthesis.cancel();\n  speechSynthesis.speak(utterance);\n}\n$(\"voiceBtn\").addEventListener(\"click\", () => {\n  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;\n  if (!SpeechRecognition) {\n    $(\"voiceStatus\").textContent = \"التعرّف على الكلام مش مدعوم في المتصفح ده؛ استخدم الكتابة.\";\n    return;\n  }\n  if (recognition) { recognition.stop(); return; }\n  recognition = new SpeechRecognition();\n  recognition.lang = appSettings.voiceLocale;\n  recognition.interimResults = false;\n  recognition.onstart = () => { $(\"voiceStatus\").textContent = \"سامعاك... اتكلم دلوقتي 🎙️\"; $(\"voiceBtn\").classList.add(\"listening\"); };\n  recognition.onresult = event => { $(\"messageInput\").value = event.results[0][0].transcript; $(\"chatForm\").requestSubmit(); };\n  recognition.onerror = event => { $(\"voiceStatus\").textContent = event.error === \"not-allowed\" ? \"اسمح باستخدام الميكروفون من إعدادات الجهاز.\" : \"ماقدرتش ألتقط الكلام؛ جرّب تاني.\"; };\n  recognition.onend = () => { recognition = null; $(\"voiceBtn\").classList.remove(\"listening\"); };\n  recognition.start();\n});\n\nasync function loadSystemStatus() {\n  try {\n    const response = await fetch(\"/api/health\", { cache: \"no-store\" });\n    const data = await response.json();\n    const f = data.features || {};\n    const labels = [\n      \"Cloudflare AI \" + (f.workersAI ? \"جاهز\" : \"غير مربوط\"),\n      \"قاعدة البيانات \" + (f.database ? \"جاهزة\" : \"غير مربوطة\")\n    ];\n    $(\"systemStatus\").textContent = labels.join(\" · \");\n    $(\"systemStatus\").classList.toggle(\"all-ready\", !!(f.workersAI && f.database));\n    return data;\n  } catch {\n    $(\"systemStatus\").textContent = \"تعذّر فحص حالة الخادم.\";\n    return null;\n  }\n}\nasync function loadServerSettings() {\n  try {\n    const data = await api(\"/api/settings\", undefined, \"GET\");\n    if (data.settings && typeof data.settings === \"object\") Object.assign(appSettings, data.settings);\n  } catch {}\n  applyLocalSettings();\n}\nasync function boot() {\n  applyLocalSettings();\n  await loadServerSettings();\n  updateAuthMode();\n  const health = await loadSystemStatus();\n  if (health && health.ok && health.features && !health.features.database) {\n    showApp({ id: \"guest\", name: \"زائر\" });\n    return;\n  }\n  try {\n    const data = await api(\"/api/auth/me\", undefined, \"GET\");\n    showApp(data.user);\n  } catch {\n    showAuth();\n  }\n}\nboot();\n\n/* فتح لوحة الإدارة: اضغط على صورة ونس خمس مرات متتالية */\n(() => {\n  const portrait = document.querySelector(\".hero-portrait\");\n  let tapCount = 0;\n  let resetTimer = null;\n\n  if (!portrait) return;\n\n  portrait.addEventListener(\"click\", () => {\n    tapCount += 1;\n    if (resetTimer) clearTimeout(resetTimer);\n    resetTimer = setTimeout(() => { tapCount = 0; }, 3000);\n\n    if (tapCount >= 5) {\n      tapCount = 0;\n      if (resetTimer) clearTimeout(resetTimer);\n      const adminTrigger = $(\"openAdminBtn\");\n      if (adminTrigger) adminTrigger.click();\n    }\n  });\n})();\n", type: "text/javascript; charset=utf-8" }],
    ["/owner-panel", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بالبريد وكلمة مرور حسابك المسجّل في ونس.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"naslok3@gmail.com\" required>\n      <label for=\"adminPassword\">كلمة المرور</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" placeholder=\"كلمة مرور حساب ونس\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/owner-panel/", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بالبريد وكلمة مرور حسابك المسجّل في ونس.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"naslok3@gmail.com\" required>\n      <label for=\"adminPassword\">كلمة المرور</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" placeholder=\"كلمة مرور حساب ونس\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/owner-panel.js", { body: "const $ = id => document.getElementById(id);\nconst defaults = {\n  appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n  welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n  welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n  greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n  voiceButton: \"اتكلم معايا\",\n  voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n  enableVoice: true, voiceLocale: \"ar-EG\"\n};\nconst keys = Object.keys(defaults);\nlet config = { ...defaults };\nasync function request(path, body, method = \"GET\") {\n  const response = await fetch(path, {\n    method, credentials: \"same-origin\", cache: \"no-store\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"تعذّر تنفيذ الطلب.\");\n  return data;\n}\nfunction gateMessage(message, error = false) {\n  $(\"adminGateStatus\").textContent = message || \"\";\n  $(\"adminGateStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction serviceMessage(message, error = false) {\n  $(\"serviceStatus\").textContent = message || \"\";\n  $(\"serviceStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction normalize(data) {\n  const next = { ...defaults };\n  if (!data || typeof data !== \"object\" || Array.isArray(data)) return next;\n  for (const key of keys) {\n    if (!(key in data)) continue;\n    const value = data[key];\n    if (typeof defaults[key] === \"boolean\") next[key] = value === true;\n    else if (typeof defaults[key] === \"number\") {\n      const max = key === \"voiceRate\" ? 1.35 : 1.5;\n      const min = key === \"voiceRate\" ? 0.65 : 0.7;\n      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];\n    } else if (typeof value === \"string\") {\n      next[key] = value.slice(0, key === \"welcomeText\" ? 240 : key === \"greeting\" ? 350 : 120);\n    }\n  }\n  if (![\"purple\", \"blue\", \"green\", \"rose\"].includes(next.theme)) next.theme = defaults.theme;\n  if (![\"ar-EG\", \"ar-SA\", \"en-US\"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;\n  return next;\n}\nfunction fillSettingsForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (!element) continue;\n    if (element.type === \"checkbox\") element.checked = !!config[key];\n    else element.value = config[key];\n  }\n  updateRanges();\n}\nasync function loadSettings() {\n  const data = await request(\"/api/admin/settings\");\n  config = normalize(data.settings);\n  fillSettingsForm();\n}\nfunction readForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (element) config[key] = element.type === \"checkbox\" ? element.checked :\n      element.type === \"range\" ? Number(element.value) : element.value;\n  }\n}\nfunction updateRanges() {\n  $(\"rateOut\").value = Number($(\"voiceRate\").value).toFixed(2);\n  $(\"pitchOut\").value = Number($(\"voicePitch\").value).toFixed(2);\n}\nfunction setState(id, label, ready) {\n  const element = $(id);\n  element.textContent = label;\n  element.className = ready ? \"state-ready\" : \"state-off\";\n}\nasync function refreshStatus() {\n  $(\"refreshStatusBtn\").disabled = true;\n  try {\n    const data = await request(\"/api/admin/status\");\n    const f = data.features || {};\n    setState(\"workersAiState\", f.workersAI ? \"متصل ويعمل\" : \"غير مربوط\", !!f.workersAI);\n    setState(\"databaseState\", !f.databaseConfigured ? \"غير مربوطة\" : !f.databaseConnected ? \"فشل الاتصال\" : f.databaseSchemaReady ? \"جاهزة\" : \"تحتاج مراجعة\", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));\n    $(\"modelName\").textContent = \"النموذج: \" + (data.model || \"غير محدد\");\n    $(\"databaseDetail\").textContent = !f.databaseConfigured ? \"لم يتم ربط D1 بعد\" : !f.databaseConnected ? \"تعذّر الاتصال بقاعدة البيانات\" : f.settingsStorageReady ? \"الجداول وحفظ الإعدادات جاهزة\" : \"تخزين الإعدادات يحتاج مراجعة\";\n    $(\"checkedAt\").textContent = \"آخر فحص: \" + new Date(data.checkedAt).toLocaleString(\"ar-EG\");\n    serviceMessage(\"تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.\");\n  } catch (error) {\n    serviceMessage(error.message, true);\n    if (/سجّل الدخول/.test(error.message)) {\n      $(\"adminApp\").hidden = true;\n      $(\"adminGate\").hidden = false;\n      gateMessage(\"انتهت الجلسة أو الحساب غير مصرح. سجّل الدخول بحساب المالك.\", true);\n    }\n  } finally { $(\"refreshStatusBtn\").disabled = false; }\n}\nasync function showDashboard() {\n  $(\"adminGate\").hidden = true;\n  $(\"adminApp\").hidden = false;\n  try { await loadSettings(); await refreshStatus(); }\n  catch (error) { serviceMessage(error.message, true); }\n}\n$(\"showAdminResetBtn\").addEventListener(\"click\", () => {\n  $(\"adminLoginForm\").hidden = true; $(\"showAdminResetBtn\").hidden = true;\n  $(\"adminSetupForm\").hidden = false; $(\"ownerPassword\").value = \"\";\n  gateMessage(\"أدخل كلمة مرور حساب ونس الحالية لإنشاء كلمة مرور مدير جديدة.\");\n});\n$(\"adminSetupForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault(); $(\"adminSetupBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من جلسة المالك وكلمة مروره، ثم إنشاء كلمة مرور مدير مستقلة...\");\n  try {\n    const result = await request(\"/api/admin/setup\", { ownerPassword: $(\"ownerPassword\").value }, \"POST\");\n    if (!result.password || result.password.length !== 64) throw new Error(\"الخادم لم يُرجع كلمة مرور المدير.\");\n    $(\"ownerPassword\").value = \"\"; $(\"adminSetupForm\").hidden = true; $(\"adminLoginForm\").hidden = false;\n    $(\"adminNewPasswordText\").textContent = result.password; $(\"adminNewPasswordNotice\").hidden = false;\n    await showDashboard(); $(\"adminNewPasswordNotice\").hidden = false;\n    gateMessage(\"تم إنشاء كلمة مرور المدير. احفظها الآن.\");\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminSetupBtn\").disabled = false; }\n});\n$(\"copyAdminPasswordBtn\").addEventListener(\"click\", async () => {\n  try { await navigator.clipboard.writeText($(\"adminNewPasswordText\").textContent); $(\"copyAdminPasswordStatus\").textContent = \"تم نسخ كلمة المرور.\"; }\n  catch { $(\"copyAdminPasswordStatus\").textContent = \"اضغط مطولًا على كلمة المرور لنسخها.\"; }\n});\n$(\"adminLoginForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const email = $(\"adminEmail\").value.trim(), password = $(\"adminPassword\").value;\n  $(\"adminLoginBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من كلمة مرور المدير...\");\n  try {\n    await request(\"/api/admin/login\", { email, password }, \"POST\");\n    $(\"adminPassword\").value = \"\";\n    await showDashboard();\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminLoginBtn\").disabled = false; }\n});\n$(\"adminLogoutBtn\").addEventListener(\"click\", async () => {\n  try { await request(\"/api/admin/logout\", {}, \"POST\"); } catch {}\n  $(\"adminApp\").hidden = true;\n  $(\"adminGate\").hidden = false;\n  $(\"adminPassword\").value = \"\";\n  gateMessage(\"تم تسجيل خروج المدير.\");\n});\n$(\"refreshStatusBtn\").addEventListener(\"click\", refreshStatus);\n$(\"testWorkersAiBtn\").addEventListener(\"click\", async () => {\n  $(\"testWorkersAiBtn\").disabled = true;\n  serviceMessage(\"جاري اختبار Cloudflare Workers AI...\");\n  try {\n    const result = await request(\"/api/admin/test-ai\", {}, \"POST\");\n    serviceMessage(\"اختبار ناجح ✓ رد الخدمة: \" + result.reply);\n    setState(\"workersAiState\", \"يعمل بنجاح\", true);\n  } catch (error) {\n    serviceMessage(error.message, true);\n    setState(\"workersAiState\", \"فشل الاختبار\", false);\n  } finally { $(\"testWorkersAiBtn\").disabled = false; }\n});\ndocument.querySelectorAll(\".nav-btn\").forEach(button => button.addEventListener(\"click\", () => {\n  document.querySelectorAll(\".nav-btn\").forEach(item => item.classList.toggle(\"active\", item === button));\n  document.querySelectorAll(\".tab-page\").forEach(page => page.classList.toggle(\"active\", page.id === \"tab-\" + button.dataset.tab));\n}));\n[\"voiceRate\", \"voicePitch\"].forEach(id => $(id).addEventListener(\"input\", updateRanges));\n$(\"saveBtn\").addEventListener(\"click\", async () => {\n  readForm();\n  $(\"saveBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: config }, \"PUT\");\n    config = normalize(result.settings);\n    fillSettingsForm();\n    $(\"saveStatus\").textContent = \"تم حفظ التعديلات على الخادم لكل المستخدمين ✓\";\n    $(\"saveStatus\").style.color = \"#9be7c1\";\n  } catch (error) {\n    $(\"saveStatus\").textContent = error.message;\n    $(\"saveStatus\").style.color = \"#ff9fba\";\n  } finally { $(\"saveBtn\").disabled = false; }\n});\n$(\"exportBtn\").addEventListener(\"click\", () => {\n  readForm();\n  const blob = new Blob([JSON.stringify(config, null, 2)], { type: \"application/json\" });\n  const url = URL.createObjectURL(blob), link = document.createElement(\"a\");\n  link.href = url; link.download = \"wens-ai-settings.json\"; link.click();\n  URL.revokeObjectURL(url);\n  $(\"backupStatus\").textContent = \"تم تجهيز نسخة من إعدادات الخادم الحالية.\";\n});\n$(\"importFile\").addEventListener(\"change\", async event => {\n  const file = event.target.files[0];\n  if (!file) return;\n  try {\n    const imported = normalize(JSON.parse(await file.text()));\n    const result = await request(\"/api/admin/settings\", { settings: imported }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تم استرجاع الإعدادات وحفظها على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message || \"الملف غير صالح؛ اختَر ملف JSON صحيح.\"; }\n  event.target.value = \"\";\n});\n$(\"resetBtn\").addEventListener(\"click\", async () => {\n  if (!confirm(\"ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟\")) return;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: defaults }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تمت استعادة الإعدادات الافتراضية على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message; }\n});\n(async function bootAdmin() {\n  try {\n    const session = await request(\"/api/admin/session\");\n    if (session.authenticated) await showDashboard();\n    else if (!session.configured) { $(\"adminLoginForm\").hidden = true; $(\"adminSetupForm\").hidden = false; gateMessage(\"أنشئ كلمة مرور المدير أولًا باستخدام كلمة مرور حساب ونس.\"); }\n    else { $(\"adminSetupForm\").hidden = true; $(\"adminLoginForm\").hidden = false; $(\"showAdminResetBtn\").hidden = false; gateMessage(\"أدخل كلمة مرور المدير المستقلة.\"); }\n  } catch (error) {\n    gateMessage(error.message === \"تعذّر تنفيذ الطلب.\"\n      ? \"تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت.\"\n      : error.message, true);\n  }\n})();\n$(\"openAdminBtn\").addEventListener(\"click\", () => {\n  $(\"appRoot\").hidden = true; $(\"authPanel\").hidden = true;\n  $(\"adminSection\").hidden = false; $(\"openAdminBtn\").hidden = true; $(\"backToAppBtn\").hidden = false;\n  window.scrollTo({top:0,behavior:\"smooth\"});\n});\n$(\"backToAppBtn\").addEventListener(\"click\", () => {\n  $(\"adminSection\").hidden = true; $(\"appRoot\").hidden = false;\n  $(\"openAdminBtn\").hidden = false; $(\"backToAppBtn\").hidden = true;\n  window.scrollTo({top:0,behavior:\"smooth\"});\n});\n", type: "text/javascript; charset=utf-8" }],
    ["/owner-panel.css", { body: ".admin-wrap{width:min(1050px,100%);margin:auto;padding:24px 14px 45px}.admin-gate{width:min(460px,100%);margin:7vh auto 30px;padding:clamp(22px,5vw,34px);text-align:center}.admin-gate h1{font-size:clamp(25px,5vw,32px);margin:5px 0}.admin-login-form{display:grid;gap:10px;margin:22px 0 8px;text-align:right}.admin-login-form label{font-size:13px;color:#e8e3f8}.admin-login-form input{width:100%;min-height:52px;padding:14px;background:#0d0c18;border:1px solid #45405f;border-radius:13px;color:var(--text);font:inherit;letter-spacing:0;text-align:right;font-size:16px}.admin-login-form button{width:100%}.admin-heading{padding:8px 2px 18px}.admin-heading h1{margin:4px 0 8px;font-size:clamp(25px,5vw,34px)}.admin-heading>p:not(.eyebrow){color:var(--muted);font-size:13px;line-height:1.8}.admin-heading-actions,.service-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.admin-heading-actions{margin-top:15px}.service-panel{background:linear-gradient(145deg,#1d1b30f2,#141321f2);border:1px solid #ffffff18;border-radius:22px;padding:17px;margin:12px 0 16px;box-shadow:0 18px 55px #0005}.service-panel h2{font-size:17px;margin:0}.service-panel .section-head>div>p{color:var(--muted);font-size:11px;margin:4px 0}.service-grid{display:grid;grid-template-columns:1fr;gap:9px;margin:15px 0}.service-card{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:5px 9px;background:#ffffff08;border:1px solid #ffffff12;border-radius:14px;padding:13px}.service-icon{grid-row:span 2;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:#b49aff1b;color:#d9ccff;font-size:18px}.service-card b{font-size:13px}.service-card strong{font-size:12px;text-align:left}.service-card small{grid-column:2/4;color:var(--muted);font-size:10px}.state-ready{color:#9be7c1}.state-off{color:#ffb4c7}.state-pending{color:#ffcf8f}.service-actions{align-items:center;margin-top:12px}.service-actions .status-line{flex:1;min-width:170px;margin:0}.admin-grid{display:grid;grid-template-columns:1fr;gap:14px}.admin-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-content:start}.nav-btn{border:1px solid #ffffff12;border-radius:12px;padding:12px 8px;text-align:right;background:#19192c;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.nav-btn.active{background:#a28bff24;color:#fff;border-color:#a28bff88}.admin-content{min-width:0;background:#19192ccc;border:1px solid #ffffff12;border-radius:20px;padding:17px}.tab-page{display:none}.tab-page.active{display:block}.tab-page h2{font-size:19px;margin:3px 0 14px}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:20px 0}.stat{background:#ffffff08;border:1px solid #ffffff10;border-radius:13px;padding:12px 7px;text-align:center}.stat b{display:block;font-size:16px;color:#d6caff}.stat span{font-size:10px;color:var(--muted)}.notice{background:#a28bff12;border:1px solid #a28bff38;border-radius:13px;padding:13px;color:#d8d1f0;font-size:12px;line-height:1.8;margin:16px 0}.field{margin:14px 0}.field label{display:block;font-size:13px;margin-bottom:7px;color:#e4e0f5}.field input[type=range]{padding:0;accent-color:var(--purple)}.field textarea{resize:vertical}.field output{color:var(--pink);font-weight:700}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #ffffff12}.toggle-row b,.toggle-row small{display:block}.toggle-row b{font-size:14px}.toggle-row small{font-size:11px;color:var(--muted);margin-top:4px}.toggle-row input{width:21px;height:21px;accent-color:var(--purple)}.save-bar{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid #ffffff15;padding-top:16px;margin-top:20px;flex-wrap:wrap}.save-bar .muted{font-size:11px;flex:1}.link-btn{display:inline-flex;text-decoration:none;align-items:center;justify-content:center}.left-actions{justify-content:flex-start}.file-label{display:inline-flex;align-items:center;justify-content:center}.btn.danger{background:#9d3452;color:#fff}@media(min-width:700px){.admin-grid{grid-template-columns:210px minmax(0,1fr)}.admin-nav{grid-template-columns:1fr}.nav-btn{font-size:13px;padding:13px}.admin-content{padding:25px}.admin-wrap{padding-top:34px}.service-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.service-card{grid-template-columns:34px 1fr}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}}@media(max-width:480px){.admin-wrap{padding-inline:12px}.service-panel{padding:14px}.service-card{grid-template-columns:30px 1fr;gap:5px 8px}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}.admin-heading-actions .btn{flex:1}.admin-login-form input{font-size:18px}}[hidden]{display:none!important}", type: "text/css; charset=utf-8" }]
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
async function ensureAdminSecurityTables(db) {
  if (!adminTablesReady) {
    adminTablesReady = (async () => {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS admin_credentials (email TEXT PRIMARY KEY NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, updated_at INTEGER NOT NULL)"
      ).run();
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"
      ).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash)").run();
    })().catch(error => { adminTablesReady = null; throw error; });
  }
  await adminTablesReady;
}
async function adminUser(request, env) {
  if (!env.DB) return null;
  await ensureAdminSecurityTables(env.DB);
  const raw = cookieValue(request.headers.get("Cookie"), ADMIN_COOKIE);
  if (!raw) return null;
  const tokenHash = await digest(raw);
  const now = Math.floor(Date.now() / 1000);
  return await env.DB.prepare(
    "SELECT u.id,u.email,u.display_name FROM admin_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND lower(u.email)=? LIMIT 1"
  ).bind(tokenHash, now, ADMIN_EMAIL).first();
}
async function issueAdminSession(db, user, extra = {}) {
  await ensureAdminSecurityTables(db);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000), tokenHash = await digest(token);
  await db.prepare(
    "INSERT INTO admin_sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)"
  ).bind(crypto.randomUUID(), user.id, tokenHash, now + ADMIN_SESSION_SECONDS, now).run();
  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.display_name }, ...extra },
    200, { "Set-Cookie": adminSessionCookie(token, ADMIN_SESSION_SECONDS) }
  );
}
async function adminRoute(request, env, path) {
  if (path === "/api/admin/logout" && request.method === "POST") {
    const raw = cookieValue(request.headers.get("Cookie"), ADMIN_COOKIE);
    if (raw && env.DB) {
      await ensureAdminSecurityTables(env.DB);
      await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await digest(raw)).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": adminSessionCookie("", 0) });
  }
  if (path === "/api/admin/setup" && request.method === "POST") {
    if (!env.DB) return json({ error: "قاعدة بيانات الحسابات غير متاحة حاليًا." }, 503);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!adminAttemptAllowed(ip)) return json({ error: "محاولات كثيرة. انتظر 15 دقيقة ثم جرّب مرة أخرى." }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات التهيئة غير صالحة." }, 400); }
    const ownerPassword = String(body.ownerPassword || "");
    if (ownerPassword.length < 8 || ownerPassword.length > 128) {
      recordAdminAttempt(ip);
      return json({ error: "أدخل كلمة مرور حساب ونس الحالية." }, 400);
    }
    let stage = "owner_session";
    try {
      // Require an active normal WENS owner session as well as the current account password.
      const signedInUser = await currentUser(request, env);
      if (!signedInUser || String(signedInUser.email || "").trim().toLowerCase() !== ADMIN_EMAIL) {
        recordAdminAttempt(ip);
        return json({ error: "سجّل الدخول أولًا إلى حساب المالك في ونس، ثم افتح الإدارة مرة أخرى." }, 401);
      }
      stage = "owner_lookup";
      await ensureAdminSecurityTables(env.DB);
      const user = await env.DB.prepare(
        "SELECT id,email,display_name,password_hash,password_salt FROM users WHERE id=? AND lower(email)=? LIMIT 1"
      ).bind(signedInUser.id, ADMIN_EMAIL).first();
      if (!user) {
        recordAdminAttempt(ip);
        return json({ error: "حساب المالك غير موجود في قاعدة البيانات." }, 403);
      }
      stage = "password_check";
      const ownerCandidate = await passwordHash(ownerPassword, user.password_salt);
      if (!same(ownerCandidate, user.password_hash)) {
        recordAdminAttempt(ip);
        return json({ error: "كلمة مرور حساب ونس الحالية غير صحيحة. لم يتم إنشاء كلمة مرور المدير." }, 401);
      }
      stage = "credential_save";
      const passwordBytes = crypto.getRandomValues(new Uint8Array(32));
      const newPassword = Array.from(passwordBytes, byte => byte.toString(16).padStart(2, "0")).join("");
      const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await passwordHash(newPassword, salt);
      await env.DB.prepare(
        "INSERT INTO admin_credentials (email,password_hash,password_salt,updated_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,updated_at=excluded.updated_at"
      ).bind(ADMIN_EMAIL, hash, salt, Math.floor(Date.now() / 1000)).run();
      await env.DB.prepare("DELETE FROM admin_sessions WHERE user_id=?").bind(user.id).run();
      adminLoginAttempts.delete(ip);
      stage = "admin_session";
      return await issueAdminSession(env.DB, user, { password: newPassword });
    } catch (error) {
      console.error("[WENS_ADMIN_SETUP_FAILURE]", JSON.stringify({
        stage,
        errorName: String(error?.name || "Error").slice(0, 80),
        detail: String(error?.message || error).replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 160)
      }));
      return json({
        error: "تعذّر إنشاء كلمة مرور المدير. لم تتغير كلمة مرور حساب ونس.",
        code: "ADMIN_SETUP_FAILED",
        stage
      }, 500);
    }
  }
  if (path === "/api/admin/login" && request.method === "POST") {
    if (!env.DB) return json({ error: "قاعدة بيانات الحسابات غير متاحة حاليًا." }, 503);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!adminAttemptAllowed(ip)) return json({ error: "محاولات كثيرة. انتظر 15 دقيقة ثم جرّب مرة أخرى." }, 429);
    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات الدخول غير صالحة." }, 400); }
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email !== ADMIN_EMAIL || password.length < 20 || password.length > 128) {
      recordAdminAttempt(ip);
      return json({ error: "البريد أو كلمة مرور المدير غير صحيحة." }, 401);
    }
    try {
      await ensureAdminSecurityTables(env.DB);
      const credential = await env.DB.prepare(
        "SELECT password_hash,password_salt FROM admin_credentials WHERE email=? LIMIT 1"
      ).bind(ADMIN_EMAIL).first();
      if (!credential) return json({ error: "لم يتم إعداد كلمة مرور المدير بعد." }, 409);
      const user = await env.DB.prepare(
        "SELECT id,email,display_name FROM users WHERE email=? LIMIT 1"
      ).bind(ADMIN_EMAIL).first();
      if (!user) { recordAdminAttempt(ip); return json({ error: "حساب المدير غير موجود في قاعدة البيانات." }, 403); }
      const candidate = await passwordHash(password, credential.password_salt);
      if (!same(candidate, credential.password_hash)) {
        recordAdminAttempt(ip);
        return json({ error: "البريد أو كلمة مرور المدير غير صحيحة." }, 401);
      }
      adminLoginAttempts.delete(ip);
      return await issueAdminSession(env.DB, user);
    } catch (error) {
      console.error("[WENS_ADMIN_LOGIN_FAILURE]", String(error?.message || error).slice(0, 180));
      return json({ error: "تعذّر إكمال تسجيل دخول المدير. حاول مرة أخرى." }, 500);
    }
  }
  if (path === "/api/admin/session" && request.method === "GET") {
    if (env.DB) await ensureAdminSecurityTables(env.DB);
    const user = await adminUser(request, env);
    const credential = env.DB
      ? await env.DB.prepare("SELECT email FROM admin_credentials WHERE email=? LIMIT 1").bind(ADMIN_EMAIL).first()
      : null;
    return json({ configured: Boolean(credential), authenticated: Boolean(user) });
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


let agentBrowserTableReady;
let nextCdpCommandId = 0;

async function ensureAgentBrowserSessions(db) {
  if (!agentBrowserTableReady) {
    agentBrowserTableReady = db.prepare(
      "CREATE TABLE IF NOT EXISTS agent_browser_sessions (user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT NOT NULL, target_id TEXT NOT NULL, last_url TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)"
    ).run().catch(error => { agentBrowserTableReady = null; throw error; });
  }
  await agentBrowserTableReady;
}

function validatePublicWebUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("اكتب رابط موقع صحيح يبدأ بـ https://"); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("المتصفح الخارجي يقبل روابط HTTPS العامة فقط، ولا يقبل بيانات دخول مضمّنة في الرابط.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host === "metadata.google.internal" || host === "metadata") {
    throw new Error("هذا العنوان داخلي أو غير مسموح به.");
  }
  // Disallow IP literals to avoid browser access to private and link-local networks.
  if (host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host.startsWith("127.") || host.startsWith("10.") ||
      host.startsWith("192.168.") || host.startsWith("169.254.") ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("العناوين المباشرة للشبكات الداخلية أو عناوين IP غير مسموح بها.");
  }
  url.hash = url.hash.slice(0, 512);
  return url.toString();
}

async function browserQuickAction(env, action, options) {
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
    return { error: "متصفح المواقع الخارجي غير مربوط على الخادم حتى الآن." };
  }
  const response = await env.BROWSER.quickAction(action, options);
  let data = response;
  if (response && typeof response.json === "function") {
    if (response.ok === false) return { error: "تعذر فتح الموقع (HTTP " + response.status + ")." };
    data = await response.json();
  }
  if (data && data.success === false) return { error: String(data.errors?.[0]?.message || "تعذر قراءة الموقع.") };
  return data;
}

async function getAgentBrowserConnection(env, user, db, create = true) {
  if (!env.BROWSER || !db || !user) throw new Error("متصفح المواقع يحتاج ربط Browser Run وتسجيل الدخول إلى ونس.");
  await ensureAgentBrowserSessions(db);
  const now = Math.floor(Date.now() / 1000);
  let saved = await db.prepare(
    "SELECT session_id,target_id,last_url,updated_at FROM agent_browser_sessions WHERE user_id=? LIMIT 1"
  ).bind(user.id).first();

  let live = saved && now - Number(saved.updated_at || 0) < 900
    ? await env.BROWSER.getSession(saved.session_id).catch(() => null)
    : null;

  if (!saved || !live) {
    if (!create) throw new Error("لا توجد جلسة متصفح مفتوحة. اطلبي من ونس فتح موقع أولًا.");
    const launched = await env.BROWSER.launch({ keepAlive: 1200000, targets: true });
    const sessionId = launched.sessionId;
    if (!sessionId) throw new Error("لم يرجع Browser Run معرّف جلسة.");
    let targets = Array.isArray(launched.targets) ? launched.targets : [];
    if (!targets.length && env.BROWSER.devtools?.listTargets) {
      targets = await env.BROWSER.devtools.listTargets(sessionId);
    }
    let target = targets.find(item => item.type === "page");
    if (!target && env.BROWSER.devtools?.newTarget) {
      target = await env.BROWSER.devtools.newTarget(sessionId, "about:blank");
    }
    const targetId = String(target?.id || target?.targetId || "");
    if (!targetId) {
      await env.BROWSER.closeSession(sessionId).catch(() => {});
      throw new Error("تم فتح جلسة المتصفح لكن لم يتم العثور على تبويب.");
    }
    await db.prepare(
      "INSERT INTO agent_browser_sessions (user_id,session_id,target_id,last_url,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET session_id=excluded.session_id,target_id=excluded.target_id,last_url=excluded.last_url,updated_at=excluded.updated_at"
    ).bind(user.id, sessionId, targetId, "about:blank", now).run();
    saved = { session_id: sessionId, target_id: targetId, last_url: "about:blank", updated_at: now };
  }

  const connection = await env.BROWSER.connectSession(saved.session_id, { targetId: saved.target_id });
  const response = await connection.webSocket.fetch(
    "https://browser-binding.invalid",
    { headers: { Upgrade: "websocket" } }
  );
  if (!response.webSocket) throw new Error("Browser Run لم ينشئ اتصال تحكم صالحًا.");
  const socket = response.webSocket;
  socket.accept();
  return { socket, sessionId: saved.session_id, targetId: saved.target_id, lastUrl: saved.last_url };
}

function sendCdpCommand(socket, method, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const id = ++nextCdpCommandId;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("انتهت مهلة التحكم في صفحة الموقع."));
    }, timeoutMs);
    const onClose = () => { cleanup(); reject(new Error("انقطع اتصال المتصفح.")); };
    const onError = () => { cleanup(); reject(new Error("حدث خطأ في اتصال المتصفح.")); };
    const onMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== id) return;
      cleanup();
      if (message.error) reject(new Error(String(message.error.message || "فشل أمر المتصفح.")));
      else resolve(message.result || {});
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { cleanup(); reject(error); }
  });
}

async function browserEvaluate(socket, expression) {
  const result = await sendCdpCommand(socket, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text || "تعذر قراءة الصفحة.";
    throw new Error(String(message).slice(0, 240));
  }
  return result.result?.value ?? null;
}

async function browserPageSummary(socket) {
  return await browserEvaluate(socket, `(() => ({
    title: document.title || "",
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 10000),
    links: [...document.querySelectorAll("a")].filter(a => {
      const r = a.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && a.href.startsWith("https://");
    }).slice(0, 25).map(a => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 100), url: a.href }))
  }))()`);
}

async function runAgentBrowser(env, user, db, task, options = {}) {
  const connection = await getAgentBrowserConnection(env, user, db, options.create !== false);
  const { socket, sessionId, targetId } = connection;
  try {
    await sendCdpCommand(socket, "Page.enable");
    await sendCdpCommand(socket, "Runtime.enable");

    if (task.action === "open") {
      const url = validatePublicWebUrl(task.url);
      await sendCdpCommand(socket, "Page.navigate", { url });
      await new Promise(resolve => setTimeout(resolve, 1800));
    } else if (task.action === "click") {
      const label = String(task.label || "").trim().slice(0, 100);
      if (!label) return { error: "اكتبي اسم الزر أو الرابط الذي تريدين فتحه." };
      const result = await browserEvaluate(socket, `(() => {
        const needle = ${JSON.stringify(label.toLowerCase())};
        const dangerous = /(delete|remove|purchase|buy now|checkout|payment|pay now|transfer|submit|send|publish|unsubscribe|cancel order|حذف|إزالة|شراء|ادفع|دفع|تحويل|إرسال|نشر|إلغاء|تأكيد الطلب)/i;
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const elements = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')].filter(visible);
        const textOf = el => (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\\s+/g," ");
        const el = elements.find(item => textOf(item).toLowerCase() === needle) ||
          elements.find(item => textOf(item).toLowerCase().includes(needle));
        if (!el) return { ok:false, error:"لم أجد زرًا أو رابطًا بهذا الاسم في الصفحة." };
        const text = textOf(el).slice(0,100);
        if (dangerous.test(text)) return { ok:false, blocked:true, label:text, error:"لم أضغط هذا الزر لأنه قد يرسل أو يحذف أو يشتري أو يغيّر شيئًا خارجيًا." };
        el.click();
        return { ok:true, clicked:text, href:el.href || "" };
      })()`);
      if (!result?.ok) return result || { error: "تعذر تنفيذ الضغط." };
      await new Promise(resolve => setTimeout(resolve, 900));
    } else if (task.action === "fill") {
      const field = String(task.field || "").trim().slice(0, 100);
      const value = String(task.value ?? "").slice(0, 2000);
      if (!field || !value) return { error: "اسم الحقل والقيمة غير مكتملين." };
      const sensitive = /(password|passcode|otp|one.?time|verification code|security code|token|secret|cvv|cvc|credit card|debit card|card number|bank account|iban|كلمة المرور|رمز التحقق|رمز الأمان|الرقم السري|بطاقة|رقم الحساب|رمز الدخول)/i;
      const result = await browserEvaluate(socket, `(() => {
        const needle = ${JSON.stringify(field.toLowerCase())};
        const value = ${JSON.stringify(value)};
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const fields = [...document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable="true"],select')].filter(visible);
        const labelFor = el => {
          const labels = [...(el.labels || [])].map(x => x.innerText || "").join(" ");
          const parent = el.closest("label");
          return [labels,parent?.innerText || "",el.getAttribute("aria-label") || "",el.placeholder || "",el.name || "",el.id || ""].join(" ").toLowerCase();
        };
        const el = fields.find(item => labelFor(item) === needle) || fields.find(item => labelFor(item).includes(needle));
        if (!el) return {ok:false,error:"لم أجد هذا الحقل في الصفحة."};
        const hint = labelFor(el);
        if (el.type === "password" || /(password|passcode|otp|verification|security code|token|secret|cvv|cvc|card number|bank account|iban|كلمة المرور|رمز التحقق|رقم الحساب|بطاقة)/i.test(hint)) {
          return {ok:false,blocked:true,error:"لا تضع كلمات المرور أو رموز التحقق أو بيانات الدفع داخل الشات. أدخلها بنفسك في نافذة المتصفح الآمنة."};
        }
        if (el.tagName === "SELECT") {
          const option = [...el.options].find(o => o.text.trim().toLowerCase() === value.toLowerCase() || o.value.toLowerCase() === value.toLowerCase());
          if (!option) return {ok:false,error:"القيمة غير موجودة ضمن اختيارات القائمة."};
          el.value = option.value;
        } else if (el.isContentEditable) {
          el.textContent = value;
        } else {
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto,"value")?.set;
          if (setter) setter.call(el,value); else el.value = value;
        }
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        return {ok:true,field:hint.slice(0,100),filled:true};
      })()`);
      return result || { error: "تعذر ملء الحقل." };
    }

    const summary = await browserPageSummary(socket);
    await db.prepare(
      "UPDATE agent_browser_sessions SET last_url=?,updated_at=? WHERE user_id=? AND session_id=?"
    ).bind(String(summary?.url || ""), Math.floor(Date.now() / 1000), user.id, sessionId).run();

    let liveViewUrl = "";
    if (task.action === "open" && env.BROWSER.getLiveView) {
      try {
        const view = await env.BROWSER.getLiveView(sessionId, { targetId, mode: "devtools" });
        liveViewUrl = String(view?.devtoolsFrontendUrl || view?.url || "");
      } catch {}
    }
    return {
      ok: true,
      action: task.action,
      title: summary?.title || "",
      url: summary?.url || "",
      text: String(summary?.text || "").slice(0, 8500),
      links: task.action === "open" ? (summary?.links || []).slice(0, 15) : [],
      liveViewUrl
    };
  } finally {
    socket.close();
  }
}

const AGENT_SYSTEM_PROMPT = `أنتِ WENS AI Agent، وكيلة شخصية باللغة العربية المصرية. افهمي الطلب، ثم استخدمي أدوات ونس الفعلية عندما تفيد: الحساب، إنشاء المهام وتعديلها وتحديد مواعيدها وأولوياتها، إنجازها، أرشفتها واستعادتها، والبحث في سجل محادثات المستخدم نفسه. لا تنفذي إلا ما تسمح به الأدوات. يمكنك الآن البحث في الويب وقراءة المواقع العامة، وفتح جلسة متصفح خاصة بالمستخدم للتنقل وقراءة الصفحات والضغط على الروابط والأزرار العادية وملء الحقول غير الحساسة. لا تطلبي كلمة مرور أو رمز تحقق أو رقم بطاقة في الشات؛ أرسلي رابط Live View المؤقت ليُدخل المستخدم بيانات تسجيل الدخول بنفسه داخل المتصفح. لا تضغطي أزرار الدفع والشراء والتحويل والحذف والإرسال والنشر أو اعتماد التغييرات النهائية، ولا تنفذي معاملات مالية أو إجراءات لا يمكن التراجع عنها. لا تطلبي تأكيدًا على البحث أو القراءة أو التنقل أو ملء الحقول غير الحساسة؛ نفذيها مباشرة. الأرشفة قابلة للاسترجاع وليست حذفًا نهائيًا. كوني طبيعية في الحوار ولا تحولي كل سؤال إلى خطة، واذكري بدقة ما تم وما لم يتم.`;
let agentTasksReady;
async function ensureAgentTasks(db) {
  if (!agentTasksReady) {
    agentTasksReady = (async () => {
      await db.prepare("CREATE TABLE IF NOT EXISTS agent_tasks (id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, due_at INTEGER, priority TEXT NOT NULL DEFAULT 'normal', archived INTEGER NOT NULL DEFAULT 0)").run();
      const info = await db.prepare("PRAGMA table_info(agent_tasks)").all();
      const columns = new Set((info.results || []).map(column => column.name));
      if (!columns.has("due_at")) await db.prepare("ALTER TABLE agent_tasks ADD COLUMN due_at INTEGER").run();
      if (!columns.has("priority")) await db.prepare("ALTER TABLE agent_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'").run();
      if (!columns.has("archived")) await db.prepare("ALTER TABLE agent_tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0").run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_created ON agent_tasks(user_id, created_at DESC)").run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status ON agent_tasks(user_id, done, archived)").run();
    })().catch(error => { agentTasksReady = null; throw error; });
  }
  await agentTasksReady;
}
function parseTaskDueAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const millis = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(millis)) return NaN;
  const seconds = Math.floor(millis > 100000000000 ? millis / 1000 : millis);
  const now = Math.floor(Date.now() / 1000);
  if (seconds < now - 86400 * 365 || seconds > now + 86400 * 3650) return NaN;
  return seconds;
}
function taskPriority(value, fallback = "normal") {
  return ["low", "normal", "high"].includes(value) ? value : fallback;
}
function agentTools() {
  const fn = (name, description, properties = {}, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } }
  });
  const taskId = { type: "string", description: "Exact task id returned by list_tasks." };
  const webUrl = { type: "string", description: "A public HTTPS page URL. Do not use private network or localhost URLs." };
  return [
    fn("get_current_time", "Get the current date and time in ISO format."),
    fn("calculate", "Calculate a simple arithmetic expression using numbers, parentheses, decimals, +, -, *, /, and remainder.", {
      expression: { type: "string", description: "Arithmetic expression, for example (1250 * 3.5) + 80." }
    }, ["expression"]),
    fn("search_web", "Search the public web for current information. Return search results and source links.", {
      query: { type: "string", description: "A focused web search query." }
    }, ["query"]),
    fn("open_webpage", "Open and read a public HTTPS webpage, including JavaScript-rendered content, as Markdown.", {
      url: webUrl
    }, ["url"]),
    fn("browser_open", "Open a website in this user's private browser session. Returns page text and a temporary Live View link so the user can sign in directly without sharing passwords in chat.", {
      url: webUrl
    }, ["url"]),
    fn("browser_inspect", "Read the currently open browser page, its visible text, title, URL, and visible links.", {}),
    fn("browser_click", "Click a visible navigation link or ordinary non-destructive button by its visible text. Do not use for purchases, payments, sending, deleting, publishing, or account changes.", {
      label: { type: "string", description: "Exact or distinctive visible text of a safe link or button." }
    }, ["label"]),
    fn("browser_fill", "Fill a non-sensitive visible form field on the current browser page. Never fill passwords, verification codes, payment information, API keys, or secrets.", {
      field: { type: "string", description: "Label, placeholder, name, or ID of the visible field." },
      value: { type: "string", description: "Text to place in the non-sensitive field." }
    }, ["field", "value"]),
    fn("browser_close", "Close this user's current external browser session and clear its saved session reference.", {}),
    fn("save_task", "Create a task in this user's private WENS task list. Priority can be low, normal, or high; due_at is optional ISO-8601 date/time.", {
      title: { type: "string", description: "Short task title." },
      details: { type: "string", description: "Optional task notes or details." },
      due_at: { type: "string", description: "Optional ISO-8601 due date or date-time." },
      priority: { type: "string", description: "Optional priority: low, normal, or high." }
    }, ["title"]),
    fn("list_tasks", "List this user's tasks by status. Scope can be active, completed, archived, or all.", {
      scope: { type: "string", description: "Task scope: active, completed, archived, or all." },
      limit: { type: "integer", description: "Maximum number of tasks to return, from 1 to 30." }
    }),
    fn("update_task", "Update the title, details, due date, or priority of one active task owned by this user. Use the exact id from list_tasks. Set due_at to an empty string to clear it.", {
      id: taskId,
      title: { type: "string", description: "New task title." },
      details: { type: "string", description: "New task details." },
      due_at: { type: "string", description: "New ISO-8601 due date/time, or an empty string to clear." },
      priority: { type: "string", description: "New priority: low, normal, or high." }
    }, ["id"]),
    fn("set_task_status", "Mark one of this user's active tasks complete or active again.", {
      id: taskId,
      done: { type: "boolean", description: "True to mark complete; false to reopen." }
    }, ["id", "done"]),
    fn("archive_task", "Move a task to the archive without permanently deleting it. Only use when the user clearly asks to archive or remove that task.", {
      id: taskId
    }, ["id"]),
    fn("restore_task", "Restore one of this user's archived tasks to the active list.", { id: taskId }, ["id"]),
    fn("search_my_messages", "Search only this signed-in user's own WENS conversation history for a phrase or topic. Return short relevant excerpts.", {
      query: { type: "string", description: "A distinctive phrase or at least two characters to search for." }
    }, ["query"])
  ];
}
async function executeAgentTool(name, args, env, user) {
  if (name === "get_current_time") return { now: new Date().toISOString() };
  if (name === "calculate") {
    const expression = String(args.expression || "").trim();
    if (!expression || expression.length > 160 || !/^[\d\s.+*/()%-]+$/.test(expression)) {
      return { error: "اكتبي عملية حسابية صحيحة بالأرقام والعمليات المسموحة فقط." };
    }
    try {
      const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/%-]/g) || [];
      if (tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, "")) return { error: "صيغة العملية الحسابية غير صحيحة." };
      let index = 0;
      function parsePrimary() {
        const token = tokens[index++];
        if (token === "(") {
          const value = parseExpression();
          if (tokens[index++] !== ")") throw new Error("parenthesis");
          return value;
        }
        if (token === "-") return -parsePrimary();
        if (token === "+") return parsePrimary();
        if (!token || !/^\d+(?:\.\d+)?$/.test(token)) throw new Error("number");
        return Number(token);
      }
      function parseTerm() {
        let value = parsePrimary();
        while (["*", "/", "%"].includes(tokens[index])) {
          const op = tokens[index++], right = parsePrimary();
          if ((op === "/" || op === "%") && right === 0) throw new Error("zero");
          value = op === "*" ? value * right : op === "/" ? value / right : value % right;
        }
        return value;
      }
      function parseExpression() {
        let value = parseTerm();
        while (["+", "-"].includes(tokens[index])) {
          const op = tokens[index++], right = parseTerm();
          value = op === "+" ? value + right : value - right;
        }
        return value;
      }
      const value = parseExpression();
      if (index !== tokens.length || !Number.isFinite(value)) return { error: "صيغة العملية الحسابية غير مكتملة أو نتيجتها غير صالحة." };
      return { expression, result: Number(value.toFixed(8)) };
    } catch (error) {
      return { error: error.message === "zero" ? "لا يمكن القسمة أو أخذ باقي القسمة على صفر." : "صيغة العملية الحسابية غير صحيحة." };
    }
  }
  if (name === "search_web") {
    if (!env.BROWSER) return { error: "خاصية البحث الخارجي غير مربوطة بعد." };
    const query = String(args.query || "").trim().slice(0, 300);
    if (query.length < 2) return { error: "اكتبي موضوع بحث أو سؤالًا واضحًا." };
    const searchUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
    try {
      const data = await browserQuickAction(env, "markdown", {
        url: searchUrl,
        gotoOptions: { waitUntil: "domcontentloaded", timeout: 25000 }
      });
      return { query, source: searchUrl, results: String(data?.result || data?.markdown || data?.content || JSON.stringify(data)).slice(0, 12000) };
    } catch (error) {
      return { error: "تعذر البحث في الويب: " + String(error?.message || error).slice(0, 180) };
    }
  }
  if (name === "open_webpage") {
    if (!env.BROWSER) return { error: "خاصية قراءة المواقع غير مربوطة بعد." };
    let url;
    try { url = validatePublicWebUrl(args.url); }
    catch (error) { return { error: error.message }; }
    try {
      const data = await browserQuickAction(env, "markdown", {
        url,
        gotoOptions: { waitUntil: "networkidle2", timeout: 30000 }
      });
      return { url, content: String(data?.result || data?.markdown || data?.content || JSON.stringify(data)).slice(0, 14000) };
    } catch (error) {
      return { error: "تعذر قراءة الموقع: " + String(error?.message || error).slice(0, 180) };
    }
  }
  if (!env.DB || !user) return { error: "يلزم تسجيل الدخول إلى حساب ونس للوصول إلى بياناتك الخاصة." };
  await ensureAgentTasks(env.DB);
  if (name === "browser_open" || name === "browser_inspect" || name === "browser_click" || name === "browser_fill") {
    if (!env.BROWSER) return { error: "خدمة المتصفح الخارجي غير مربوطة على الخادم." };
    const task = {
      action: name === "browser_open" ? "open" : name === "browser_inspect" ? "inspect" : name === "browser_click" ? "click" : "fill",
      url: args.url, label: args.label, field: args.field, value: args.value
    };
    try {
      return await runAgentBrowser(env, user, env.DB, task, { create: name === "browser_open" });
    } catch (error) {
      return { error: "تعذر تنفيذ خطوة المتصفح: " + String(error?.message || error).slice(0, 200) };
    }
  }
  if (name === "browser_close") {
    if (!env.BROWSER) return { error: "خدمة المتصفح الخارجي غير مربوطة على الخادم." };
    await ensureAgentBrowserSessions(env.DB);
    const saved = await env.DB.prepare("SELECT session_id FROM agent_browser_sessions WHERE user_id=? LIMIT 1").bind(user.id).first();
    if (!saved) return { closed: true, message: "لا توجد جلسة متصفح مفتوحة." };
    await env.BROWSER.closeSession(saved.session_id).catch(() => {});
    await env.DB.prepare("DELETE FROM agent_browser_sessions WHERE user_id=?").bind(user.id).run();
    return { closed: true };
  }


  if (name === "save_task") {
    const title = String(args.title || "").trim().slice(0, 180);
    const details = String(args.details || "").trim().slice(0, 1000);
    const dueAt = parseTaskDueAt(args.due_at);
    const priority = taskPriority(args.priority);
    if (!title) return { error: "عنوان المهمة مطلوب." };
    if (Number.isNaN(dueAt)) return { error: "موعد المهمة غير صالح. استخدمي تاريخًا واضحًا." };
    const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO agent_tasks (id,user_id,title,details,done,created_at,due_at,priority,archived) VALUES (?,?,?,?,0,?,?,?,0)"
    ).bind(id, user.id, title, details, now, dueAt, priority).run();
    return { saved: true, id, title, due_at: dueAt ? new Date(dueAt * 1000).toISOString() : null, priority };
  }

  if (name === "list_tasks") {
    const scope = ["active", "completed", "archived", "all"].includes(args.scope) ? args.scope : "active";
    const limit = Math.min(30, Math.max(1, Number(args.limit) || 20));
    const filters = {
      active: "archived=0 AND done=0",
      completed: "archived=0 AND done=1",
      archived: "archived=1",
      all: "1=1"
    };
    const rows = await env.DB.prepare(
      "SELECT id,title,details,done,created_at,due_at,priority,archived FROM agent_tasks WHERE user_id=? AND " + filters[scope] + " ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT ?"
    ).bind(user.id, limit).all();
    return { scope, tasks: (rows.results || []).map(task => ({
      ...task,
      due_at: task.due_at ? new Date(task.due_at * 1000).toISOString() : null,
      done: Boolean(task.done), archived: Boolean(task.archived)
    })) };
  }

  if (name === "update_task") {
    const id = String(args.id || "").trim();
    if (!id) return { error: "معرّف المهمة مطلوب." };
    const fields = [], values = [];
    if (Object.hasOwn(args, "title")) {
      const title = String(args.title || "").trim().slice(0, 180);
      if (!title) return { error: "عنوان المهمة لا يمكن أن يكون فارغًا." };
      fields.push("title=?"); values.push(title);
    }
    if (Object.hasOwn(args, "details")) {
      fields.push("details=?"); values.push(String(args.details || "").trim().slice(0, 1000));
    }
    if (Object.hasOwn(args, "due_at")) {
      const dueAt = parseTaskDueAt(args.due_at);
      if (Number.isNaN(dueAt)) return { error: "موعد المهمة غير صالح." };
      fields.push("due_at=?"); values.push(dueAt);
    }
    if (Object.hasOwn(args, "priority")) {
      if (!["low", "normal", "high"].includes(args.priority)) return { error: "الأولوية يجب أن تكون منخفضة أو عادية أو عالية." };
      fields.push("priority=?"); values.push(args.priority);
    }
    if (!fields.length) return { error: "لم تحددي أي تعديل للمهمة." };
    values.push(id, user.id);
    const result = await env.DB.prepare(
      "UPDATE agent_tasks SET " + fields.join(", ") + " WHERE id=? AND user_id=? AND archived=0"
    ).bind(...values).run();
    if (!(result.meta?.changes > 0)) return { error: "لم أجد المهمة المطلوبة في قائمتك النشطة." };
    return { updated: true, id };
  }

  if (name === "set_task_status") {
    const id = String(args.id || "").trim();
    if (!id || typeof args.done !== "boolean") return { error: "بيانات تحديث حالة المهمة غير مكتملة." };
    const result = await env.DB.prepare(
      "UPDATE agent_tasks SET done=? WHERE id=? AND user_id=? AND archived=0"
    ).bind(args.done ? 1 : 0, id, user.id).run();
    return result.meta?.changes > 0 ? { updated: true, id, done: args.done } : { error: "لم أجد المهمة المطلوبة." };
  }

  if (name === "archive_task" || name === "restore_task") {
    const id = String(args.id || "").trim();
    if (!id) return { error: "معرّف المهمة مطلوب." };
    const archived = name === "archive_task" ? 1 : 0;
    const result = await env.DB.prepare(
      "UPDATE agent_tasks SET archived=? WHERE id=? AND user_id=?"
    ).bind(archived, id, user.id).run();
    return result.meta?.changes > 0
      ? { updated: true, id, archived: Boolean(archived), reversible: true }
      : { error: "لم أجد المهمة المطلوبة." };
  }

  if (name === "search_my_messages") {
    const query = String(args.query || "").trim().slice(0, 100);
    if (query.length < 2) return { error: "اكتبي كلمة بحث من حرفين على الأقل." };
    const rows = await env.DB.prepare(
      "SELECT role,content,created_at FROM messages WHERE user_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 6"
    ).bind(user.id, "%" + query + "%").all();
    return {
      query,
      matches: (rows.results || []).map(row => ({
        role: row.role,
        excerpt: String(row.content || "").slice(0, 420),
        date: new Date(row.created_at * 1000).toISOString()
      }))
    };
  }

  return { error: "الأداة غير مسموح بها." };
}
async function handleAgent(request, env, user, options = {}) {
  if (!env.AI) return json({ error: "خدمة الذكاء الاصطناعي غير متاحة حاليًا." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "بيانات المهمة غير صالحة." }, 400); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 4000) return json({ error: "اكتب مهمة من 1 إلى 4000 حرف." }, 400);
  const steps = [];
  let conversationHistory = [];
  if (options.persist && env.DB && user) {
    const prior = await env.DB.prepare(
      "SELECT role,content FROM messages WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 16"
    ).bind(user.id).all();
    conversationHistory = (prior.results || []).reverse().map(item => ({
      role: item.role,
      content: item.content
    }));
    await env.DB.prepare(
      "INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)"
    ).bind(crypto.randomUUID(), user.id, "user", message, Math.floor(Date.now() / 1000)).run();
  }
  const systemPrompt = options.persist
    ? SYSTEM_PROMPT + "\n\n" + AGENT_SYSTEM_PROMPT + "\nفي المحادثة الرئيسية، كوني رفيقة طبيعية: جاوبي مباشرة وباختصار مناسب، ولا تحولي كل سؤال بسيط إلى خطة. استخدمي الأدوات عند الحاجة الفعلية فقط. إذا طلب المستخدم تنفيذ شيء، خططي ونفذي ما تسمح به الأدوات ثم اشرحي النتيجة بصدق."
    : AGENT_SYSTEM_PROMPT;
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: message }
  ];
  const model = env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash";
  try {
    let finalText = "";
    for (let turn = 0; turn < 6; turn++) {
      const result = await env.AI.run(model, { messages, tools: agentTools(), temperature: 0.2, max_tokens: 900 });
      const assistantMessage = result?.choices?.[0]?.message || result?.result?.choices?.[0]?.message || result;
      const calls = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : (Array.isArray(result?.tool_calls) ? result.tool_calls : []);
      if (!calls.length) { finalText = typeof assistantMessage?.content === "string" ? assistantMessage.content.trim() : (typeof result?.response === "string" ? result.response.trim() : ""); break; }
      messages.push({ role: "assistant", content: assistantMessage.content || "", tool_calls: calls });
      for (const call of calls.slice(0, 6)) {
        const name = String(call.name || call.function?.name || "");
        let args = call.arguments ?? call.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const allowed = ["get_current_time","calculate","search_web","open_webpage","browser_open","browser_inspect","browser_click","browser_fill","browser_close","save_task","list_tasks","update_task","set_task_status","archive_task","restore_task","search_my_messages"];
        if (!allowed.includes(name)) { steps.push("تم رفض أداة غير مسموح بها."); continue; }
        const output = await executeAgentTool(name, args || {}, env, user);
        const labels = {
          get_current_time: "قراءة التاريخ والوقت",
          calculate: "إجراء حساب",
          save_task: "إنشاء مهمة",
          list_tasks: "عرض المهام",
          update_task: "تعديل مهمة",
          set_task_status: "تحديث حالة مهمة",
          archive_task: "أرشفة مهمة",
          restore_task: "استعادة مهمة",
          search_my_messages: "البحث في سجل المحادثات",
          search_web: "البحث في المواقع العامة",
          open_webpage: "قراءة صفحة ويب",
          browser_open: "فتح موقع في المتصفح",
          browser_inspect: "قراءة الصفحة المفتوحة",
          browser_click: "التنقل داخل الموقع",
          browser_fill: "ملء حقل غير حساس",
          browser_close: "إغلاق جلسة المتصفح"
        };
        steps.push(labels[name] + (output.error ? " — " + output.error : " — تم"));
        messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(output) });
      }
    }
    if (!finalText) {
      const last = await env.AI.run(model, { messages: messages.concat([{ role: "user", content: "قدمي النتيجة النهائية الآن اعتمادًا على نتائج الأدوات السابقة، ولا تدّعي أي تنفيذ غير موجود." }]), temperature: 0.2, max_tokens: 900 });
      const lastMessage = last?.choices?.[0]?.message || last?.result?.choices?.[0]?.message || last;
      finalText = typeof lastMessage?.content === "string" ? lastMessage.content.trim() : (typeof last?.response === "string" ? last.response.trim() : "");
    }
    if (!finalText) return json({ error: "نفذت الوكيلة الأدوات لكن النموذج لم يرجع ملخصًا نهائيًا." }, 502);
    if (options.persist && env.DB && user) {
      await env.DB.prepare(
        "INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)"
      ).bind(crypto.randomUUID(), user.id, "assistant", finalText, Math.floor(Date.now() / 1000)).run();
    }
    return json({ ok: true, model, steps, reply: finalText });
  } catch (error) {
    console.error("[WENS_AGENT_FAILURE]", String(error?.message || error).slice(0,180));
    return json({ error: "تعذّر تشغيل وكيل ونس الآن. قد لا يكون نموذج الوكلاء متاحًا في حساب Workers AI أو قد تكون الحصة انتهت." }, 502);
  }
}
async function agentTasksRoute(request, env, user) {
  if (!env.DB || !user) return json({ error: "سجّل الدخول أولًا لاستخدام المهام المحفوظة." }, 401);
  await ensureAgentTasks(env.DB);
  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id,title,details,done,created_at,due_at,priority,archived FROM agent_tasks WHERE user_id=? AND archived=0 ORDER BY done ASC, CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, created_at DESC LIMIT 50"
    ).bind(user.id).all();
    return json({ tasks: rows.results || [] });
  }
  if (request.method === "PATCH") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "الطلب غير صالح." }, 400); }
    const id = String(body.id || "");
    if (!id) return json({ error: "معرّف المهمة مطلوب." }, 400);
    if (typeof body.done === "boolean") {
      const result = await env.DB.prepare("UPDATE agent_tasks SET done=? WHERE id=? AND user_id=? AND archived=0")
        .bind(body.done ? 1 : 0, id, user.id).run();
      return json({ ok: true, changes: result.meta?.changes || 0 });
    }
    return json({ error: "التعديل غير مدعوم من هذا الطلب." }, 400);
  }
  return json({ error: "طريقة الطلب غير مدعومة." }, 405);
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
      if (path === "/api/agent" && request.method === "POST") {
        const user = env.DB ? await currentUser(request, env) : null;
        if (env.DB && !user) return json({ error: "سجّل الدخول الأول لاستخدام وكيل ونس." }, 401);
        return await handleAgent(request, env, user);
      }
      if (path === "/api/agent/tasks" && (request.method === "GET" || request.method === "PATCH")) {
        const user = env.DB ? await currentUser(request, env) : null;
        return await agentTasksRoute(request, env, user);
      }
      if (path === "/api/chat" && request.method === "POST") {
        const user = env.DB ? await currentUser(request, env) : null;
        if (env.DB && !user) return json({ error: "سجّل الدخول الأول لاستخدام ونس." }, 401);
        return await handleAgent(request, env, user, { persist: true });
      }
      if (request.method === "GET") {
        const asset = INLINE_ASSETS.get(path);
        if (asset) return new Response(asset.body, {
          headers: {
            "Content-Type": asset.type,
            "Cache-Control": "no-store"
          }
        });
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
