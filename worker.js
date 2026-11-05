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
    ["/style.css", { body: ":root{--purple:#a28bff;--pink:#ff9acb;--bg:#101020;--text:#f7f5ff;--muted:#b7b4ce;--line:#34324d}*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:radial-gradient(ellipse at 50% 0%,#a28bff26 0,var(--bg) 55%);color:var(--text);font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif;min-height:100vh}.topbar{display:flex;justify-content:space-between;align-items:center;padding:14px clamp(14px,4vw,34px);border-bottom:1px solid #ffffff12;position:sticky;top:0;background:#101020ef;backdrop-filter:blur(12px);z-index:4}.brand{display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none}.logo{width:42px;height:42px;border-radius:15px;background:linear-gradient(135deg,var(--purple),var(--pink));display:grid;place-items:center;color:#191326;font-size:24px;font-weight:900}.brand b{display:block}.brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px}.admin-shortcut{border:1px solid #ffffff20;border-radius:12px;padding:9px 12px;color:#e9e3ff;text-decoration:none;font-size:13px}.app{width:min(760px,100%);margin:auto;padding:24px 14px 34px}.hero{text-align:center;padding:20px 10px 26px}.orb{width:136px;height:136px;border-radius:50%;margin:0 auto 18px;background:radial-gradient(circle at 35% 25%,#ffe6f6,#bd9dff 46%,#5941a7);box-shadow:0 0 60px #9e82ff30;position:relative;display:grid;place-items:center}.face{width:67px;height:82px;background:linear-gradient(135deg,#f9d2c8,#f2b9bb);border-radius:46% 46% 48% 48%;position:relative;z-index:2;margin-top:12px}.hair{position:absolute;top:17px;width:75px;height:57px;border-radius:48% 48% 30% 25%;background:#382547;z-index:3;clip-path:polygon(0 0,100% 0,100% 78%,80% 53%,73% 100%,58% 57%,43% 100%,30% 58%,10% 84%)}.eye{position:absolute;width:5px;height:7px;border-radius:50%;background:#39243b;top:36px}.eye.left{right:17px}.eye.right{left:17px}.smile{position:absolute;top:53px;left:27px;width:14px;height:7px;border-bottom:2px solid #a34e68;border-radius:0 0 50% 50%}.eyebrow{color:var(--pink);font-size:13px;margin:0 0 8px}.hero h1{font-size:clamp(24px,5vw,34px);margin:0 0 10px}.hero-text{color:var(--muted);max-width:440px;line-height:1.8;margin:0 auto 20px;font-size:14px}.actions{display:flex;justify-content:center;gap:10px;flex-wrap:wrap}.btn{border:0;border-radius:14px;padding:12px 18px;font:inherit;font-weight:700;cursor:pointer;min-height:46px}.primary{background:linear-gradient(120deg,var(--purple),var(--pink));color:#1a1530}.secondary{background:#ffffff0a;border:1px solid #ffffff20;color:var(--text)}.status-line{color:var(--muted);font-size:12px;min-height:18px}.panel{background:#19192ccc;border:1px solid #ffffff12;border-radius:22px;padding:17px;margin:14px 0;box-shadow:0 16px 40px #00000014}.section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.section-head h2{font-size:17px;margin:0}.section-head p{margin:4px 0 0;color:var(--muted);font-size:12px}.text-btn{background:none;border:0;color:#d8ccff;cursor:pointer;font:inherit;font-size:12px}.messages{display:flex;flex-direction:column;gap:12px;padding:17px 0;min-height:100px;max-height:310px;overflow:auto}.message{display:flex;gap:8px;align-items:flex-end}.mini-avatar{width:30px;height:30px;flex:0 0 30px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--purple),var(--pink));color:#201735;font-weight:900}.bubble{max-width:85%;padding:11px 13px;border-radius:15px;background:#ffffff0b;border:1px solid #ffffff0d;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.user{justify-content:flex-start}.user .bubble{background:#8e78d42b;border-color:#aa94ff28}.chat-form{display:flex;gap:8px}.chat-form input,.field input,.field textarea,.field select{min-width:0;width:100%;background:#101020;border:1px solid var(--line);border-radius:12px;padding:13px;color:var(--text);font:inherit;outline:none}.chat-form input:focus,.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--purple)}.send-btn{border:0;border-radius:12px;padding:0 17px;background:var(--purple);color:#18132a;font:inherit;font-weight:800}.disclaimer{color:#9692ae;font-size:11px;line-height:1.7;margin-bottom:0}.panel video,.panel img{width:100%;max-height:350px;object-fit:contain;border-radius:14px;background:#080812;margin-top:12px}.panel[hidden]{display:none}footer{text-align:center;color:#8c88a5;font-size:11px;padding:0 10px 22px}.speaking .orb{animation:pulse 1.1s infinite alternate}@keyframes pulse{to{box-shadow:0 0 0 13px #a28bff12,0 0 70px #a28bff66}}.listening{box-shadow:0 0 0 4px #ff8cc844!important}button:focus-visible,a:focus-visible{outline:2px solid var(--pink);outline-offset:3px}@media(min-width:650px){.app{padding-top:32px}.hero{padding-bottom:32px}.panel{padding:22px}}\n\n/* Wens visual refresh */\n:root{--purple:#b49aff;--pink:#ffacd6;--bg:#0b0b16;--text:#fbf9ff;--muted:#bdb8d2;--line:#39344f}body{background:radial-gradient(ellipse at 50% -12%,#a78bfa35 0,transparent 48%),linear-gradient(180deg,#10101f 0%,#0b0b15 100%)}.topbar{background:#0d0c18eF;border-bottom-color:#ffffff18}.logo{box-shadow:0 8px 24px #a28bff35}.app{max-width:820px}.hero{padding-top:30px}.orb{width:148px;height:148px;box-shadow:0 0 0 10px #a28bff0b,0 18px 65px #a28bff30}.hero h1{letter-spacing:-.6px}.hero-text{font-size:15px}.panel{background:linear-gradient(145deg,#1d1b30f2,#141321f2);border:1px solid #ffffff18;border-radius:24px;box-shadow:0 18px 55px #0005}.section-head h2{letter-spacing:-.2px}.bubble{border-radius:17px;padding:12px 14px}.user .bubble{background:linear-gradient(135deg,#9279e52b,#d78bc51c);border-color:#b49aff35}.chat-form input,.field input,.field textarea,.field select{background:#0d0c18;border-color:#45405f;border-radius:14px;min-height:48px}.send-btn,.primary{background:linear-gradient(120deg,#b49aff,#ffacd6);box-shadow:0 8px 22px #b49aff25}.btn{transition:transform .18s ease,filter .18s ease}.btn:hover,.send-btn:hover{filter:brightness(1.08);transform:translateY(-1px)}.admin-shortcut{background:#ffffff08}.status-line{padding-top:4px}@media(max-width:480px){.app{padding-inline:12px}.hero{padding-top:20px}.panel{padding:15px;border-radius:20px}.chat-form{gap:6px}.send-btn{padding-inline:14px}}\n[hidden]{display:none!important}\n.top-actions{display:flex;align-items:center;gap:8px}\n.auth-panel{max-width:520px;margin:40px auto;padding:clamp(20px,5vw,32px);text-align:center}\n.auth-mark{width:64px;height:64px;margin:0 auto 16px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(135deg,var(--purple),var(--pink));color:#191326;font-size:34px;font-weight:900;box-shadow:0 12px 36px #a28bff35}\n.auth-panel h1{font-size:clamp(24px,5vw,32px);margin:5px 0 9px}\n.auth-form{display:grid;gap:13px;margin-top:20px;text-align:right}\n.auth-form label,.call-controls label{display:grid;gap:7px;color:#e8e3f8;font-size:13px}\n.auth-form input,.call-controls input{min-width:0;width:100%;background:#0d0c18;border:1px solid #45405f;border-radius:13px;padding:14px;color:var(--text);font:inherit}\n.auth-form .btn{width:100%;margin-top:4px}\n.auth-toggle{margin-top:15px;color:#d8ccff;font-size:13px}\n.auth-form button:disabled{opacity:.6;cursor:wait}\n.call-controls{display:grid;gap:13px;margin-top:16px}\n.call-controls .actions{justify-content:flex-start}\n.video-stage{position:relative;margin-top:18px;border:1px solid #ffffff20;border-radius:18px;overflow:hidden;background:#080812;padding:12px}\n.video-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}\n.remote-tile{position:relative;min-height:150px;background:#171527;border-radius:14px;overflow:hidden}\n.remote-video{width:100%;height:100%;min-height:180px;object-fit:cover}\n.remote-label{position:absolute;z-index:2;bottom:8px;right:9px;background:#090817c9;padding:5px 9px;border-radius:9px;font-size:11px}\n.local-video-box{position:relative;margin-top:10px;width:min(190px,45%);min-height:115px;border-radius:14px;overflow:hidden;background:#171527}\n.local-video-box video{display:block;width:100%;height:100%;min-height:115px;object-fit:cover}\n.local-video-box small{position:absolute;bottom:7px;right:8px;background:#090817c9;padding:4px 8px;border-radius:8px}\n.avatar-chip{display:flex;align-items:center;gap:8px;padding:7px 10px;margin:0 auto 12px;width:max-content;border:1px solid #b49aff4b;background:#b49aff13;border-radius:30px}\n.avatar-chip span{width:33px;height:33px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#b49aff,#ffacd6);color:#20152f;font-weight:900;font-size:19px}\n.avatar-chip small{color:#e9e1ff}\n.avatar-chip.speaking span{animation:avatarTalk .45s infinite alternate;box-shadow:0 0 0 7px #b49aff20}\n@keyframes avatarTalk{to{transform:scale(1.12);filter:brightness(1.2)}}\n.btn.danger{background:#9d3452;color:#fff}\n@media(max-width:480px){.top-actions{gap:5px}.top-actions .admin-shortcut{font-size:11px;padding:8px}.auth-panel{margin:22px auto}.video-grid{grid-template-columns:1fr}.local-video-box{width:58%}}\n\n.system-status{margin:14px 0 0;padding:10px 12px;border-radius:12px;background:#ffffff08;border:1px solid #ffffff15;color:#ffcf8f;font-size:11px;line-height:1.8}\n.system-status.all-ready{color:#9be7c1;border-color:#4bba8a55;background:#35a87812}\n\n/* Speech-driven avatar mouth motion (visual approximation, not photoreal lip sync). */\n.face.talking .smile{height:11px;width:13px;top:51px;border:2px solid #a34e68;border-top:0;border-radius:0 0 55% 55%;animation:mouthTalk .16s infinite alternate}.orb.talking{animation:avatarSpeak .55s infinite alternate}.face.talking{animation:faceSpeak .55s infinite alternate}@keyframes mouthTalk{from{transform:scaleY(.45)}to{transform:scaleY(1.25)}}@keyframes avatarSpeak{to{filter:brightness(1.12);box-shadow:0 0 0 9px #a28bff14,0 0 65px #a28bff65}}@keyframes faceSpeak{to{transform:translateY(1px)}}\n\n/* Photoreal Wens profile */\n.hero-portrait{display:block;width:clamp(142px,32vw,192px);height:clamp(142px,32vw,192px);object-fit:cover;object-position:center 34%;border-radius:50%;margin:0 auto 20px;border:3px solid #d4baff;box-shadow:0 0 0 9px #a28bff14,0 16px 55px #a28bff40;background:#20172e}.mini-avatar{overflow:hidden;object-fit:cover;border:1px solid #ffffff28}.avatar-chip img{width:42px;height:42px;object-fit:cover;object-position:center 34%;border-radius:50%;border:2px solid #c9b4ff;box-shadow:0 0 0 4px #b49aff20}.avatar-chip.speaking img{animation:avatarTalk .45s infinite alternate;box-shadow:0 0 0 7px #b49aff20}\n\n/* ChatGPT-style attachment menu and composer */\n[hidden]{display:none!important}\n.chat-composer{position:relative;margin-top:8px}\n.chat-form{align-items:center;gap:8px}\n.chat-form input{flex:1;min-height:48px;font-size:14px}\n.attach-menu-btn{width:46px;height:46px;flex:0 0 46px;border:1px solid #ffffff22;border-radius:50%;background:#29253a;color:#f8f4ff;font-size:30px;line-height:1;display:grid;place-items:center;cursor:pointer;transition:transform .18s,background .18s}\n.attach-menu-btn[aria-expanded=\"true\"]{background:linear-gradient(135deg,var(--purple),var(--pink));color:#21182f;transform:rotate(45deg)}\n.attachment-menu,.plugin-tools{position:absolute;z-index:30;right:0;bottom:calc(100% + 12px);width:min(310px,calc(100vw - 54px));padding:9px;border:1px solid #ffffff22;border-radius:24px;background:rgba(35,32,49,.98);box-shadow:0 18px 48px #0008;backdrop-filter:blur(18px);animation:menuRise .16s ease-out}\n@keyframes menuRise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}\n.attachment-option{width:100%;min-height:65px;padding:9px 10px;display:flex;align-items:center;gap:13px;border:0;border-radius:16px;background:transparent;color:var(--text);text-align:right;font:inherit;cursor:pointer}\n.attachment-option:hover,.attachment-option:focus-visible,.plugin-tools>button:hover{background:#ffffff12}\n.attachment-option>span:nth-child(2){display:grid;gap:2px;flex:1}\n.attachment-option b{font-size:14px;font-weight:700}\n.attachment-option small{color:var(--muted);font-size:11px}\n.attachment-icon{width:42px;height:42px;flex:0 0 42px;display:grid;place-items:center;border-radius:50%;background:#ffffff13;font-size:21px}\n.attachment-chevron{font-size:25px;color:var(--muted)}\n.attachment-check{color:#a8f0c7;font-weight:900;font-size:20px}\n.deep-option[aria-pressed=\"true\"]{background:#b49aff20}\n.plugin-tools{padding:12px}\n.plugin-tools-heading{display:flex;align-items:center;justify-content:space-between;padding:4px 7px 9px;font-size:13px;color:#e8ddff}\n.plugin-tools-heading button{border:0;background:transparent;color:#c9b9ff;font:inherit;font-size:12px}\n.plugin-tools>button{display:block;width:100%;padding:12px 10px;border:0;border-radius:12px;background:transparent;color:var(--text);text-align:right;font:inherit;font-size:13px}\n.deep-think-badge{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;padding:7px 11px;border:1px solid #b49aff50;border-radius:12px;background:#9f87ff17;color:#e5d9ff;font-size:12px}\n.deep-think-badge button{border:0;background:none;color:#ffb6d7;font:inherit;font-size:11px}\n.attachments-preview{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 9px}\n.attachment-chip{max-width:100%;display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid #ffffff20;border-radius:14px;background:#ffffff0c;color:var(--text);font-size:11px}\n.attachment-chip img{width:42px;height:42px;object-fit:cover;border-radius:9px;background:#080812;margin:0}\n.attachment-chip span{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.attachment-chip button{width:25px;height:25px;border:0;border-radius:50%;background:#ffffff15;color:#fff;font-size:16px}\n.attachment-status{min-height:16px;margin:5px 5px 0;color:#ffcadb;font-size:11px}\n.visually-hidden-input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;clip-path:inset(50%)}\n.message-attachments{display:flex;flex-wrap:wrap;gap:7px;margin-top:8px}\n.message-attachments img{display:block;width:auto;max-width:min(220px,58vw);max-height:230px;object-fit:contain;border:1px solid #ffffff24;border-radius:13px;background:#080812;margin:0}\n.message-attachment-name{padding:6px 9px;border-radius:9px;background:#ffffff12;color:#e8dfff;font-size:11px}\n@media(max-width:420px){.attachment-menu,.plugin-tools{width:min(300px,calc(100vw - 42px));right:-2px}.attachment-option{min-height:61px}.chat-form{gap:6px}.attach-menu-btn{width:42px;height:42px;flex-basis:42px}.send-btn{padding:0 13px}}\n", type: "text/css; charset=utf-8" }],
    ["/", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0b0b16\"><link rel=\"manifest\" href=\"manifest.json\"><link rel=\"stylesheet\" href=\"style.css\">\n<title>ونس AI</title>\n<style>.messages{max-height:min(60vh,620px);min-height:150px;overflow:auto}.bubble-text{white-space:pre-wrap;overflow-wrap:anywhere}.bubble-text a{color:#d9c9ff;text-decoration:underline;overflow-wrap:anywhere}.execution-trace{margin-top:10px;padding-top:8px;border-top:1px solid #ffffff18;color:#d9c9ff;font-size:11px}.execution-trace summary{cursor:pointer}.execution-trace ul{margin:7px 0 0;padding-inline-start:20px;color:#b7b0cb;line-height:1.8}.admin-inline-panel{margin-top:14px;padding:14px}.admin-inline-panel iframe{display:block;width:100%;height:82vh;min-height:760px;border:1px solid #ffffff18;border-radius:16px;background:#101020}.admin-inline-panel .section-head{margin-bottom:10px}@media(max-width:480px){.admin-inline-panel{padding:9px}.admin-inline-panel iframe{height:82vh;min-height:720px}}\\n</style></head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b id=\"brandName\">ونس AI</b><small>رفيقة يومك الذكية</small></span></a>\n  <div class=\"top-actions\"><button id=\"openAdminBtn\" class=\"admin-shortcut\" type=\"button\" hidden>الإدارة</button><button id=\"backToAppBtn\" class=\"admin-shortcut\" type=\"button\" hidden>العودة لونس</button><button id=\"logoutBtn\" class=\"admin-shortcut\" hidden>خروج</button></div>\n</header>\n<main class=\"app\">\n<section id=\"authPanel\" class=\"panel auth-panel\">\n  <div class=\"auth-mark\">و</div><p class=\"eyebrow\">مساحتك الخاصة</p><h1 id=\"authTitle\">أهلًا بيك في ونس</h1>\n  <p class=\"hero-text\">سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.</p>\n  <form id=\"authForm\" class=\"auth-form\">\n    <label id=\"nameField\" hidden>الاسم<input id=\"nameInput\" maxlength=\"60\" autocomplete=\"name\" placeholder=\"اسمك\"></label>\n    <label>البريد الإلكتروني<input id=\"emailInput\" type=\"email\" maxlength=\"190\" autocomplete=\"email\" required placeholder=\"name@example.com\"></label>\n    <label>كلمة المرور<input id=\"passwordInput\" type=\"password\" minlength=\"8\" maxlength=\"128\" autocomplete=\"current-password\" required placeholder=\"8 أحرف على الأقل\"></label>\n    <button id=\"authSubmit\" class=\"btn primary\" type=\"submit\">تسجيل الدخول</button>\n  </form>\n  <button id=\"authToggle\" class=\"text-btn auth-toggle\" type=\"button\">إنشاء حساب جديد</button>\n  <p id=\"authStatus\" class=\"status-line\" role=\"status\"></p><p id=\"systemStatus\" class=\"system-status\" role=\"status\">جاري فحص اتصال الخدمات...</p>\n  <p class=\"disclaimer\">كلمة المرور تُخزّن مشفّرة تجزئيًا في قاعدة البيانات، ولا تُعرض داخل التطبيق. لا تستخدم كلمة مرور حسابك في مواقع أخرى.</p>\n</section>\n\n<div id=\"appRoot\" hidden>\n<section class=\"hero\">\n  <img id=\"heroPortrait\" class=\"hero-portrait\" src=\"/avatar.jpg?v=real-jpg-20261105\" alt=\"صورة ونس الشخصية\" width=\"192\" height=\"192\" loading=\"eager\" decoding=\"async\" fetchpriority=\"high\" tabindex=\"0\" role=\"button\" aria-label=\"صورة ونس\">\n  <p class=\"eyebrow\" id=\"eyebrowText\">موجودة علشانك</p><h1 id=\"welcomeTitle\">أهلًا بيك، أنا ونس 💜</h1>\n  <p id=\"welcomeText\" class=\"hero-text\">اتكلم معايا واسألني اللي في بالك.</p>\n  <div class=\"actions\"><button id=\"voiceBtn\" class=\"btn primary\">🎙️ <span id=\"voiceButtonText\">اتكلم معايا</span></button></div>\n  <p id=\"voiceStatus\" class=\"status-line\" aria-live=\"polite\"></p>\n</section>\n\n<section class=\"panel\">\n  <div class=\"section-head\"><div><h2>الدردشة مع ونس</h2><p id=\"accountLabel\">محادثتك محفوظة في حسابك</p></div><button id=\"clearBtn\" class=\"text-btn\">مسح العرض</button></div>\n  <div id=\"messages\" class=\"messages\" aria-live=\"polite\"><div class=\"message assistant\"><img class=\"mini-avatar\" src=\"/avatar.jpg?v=real-jpg-20261104\" alt=\"ونس\" width=\"30\" height=\"30\"><div class=\"bubble\">أهلًا بيك! أنا ونس 💜 اسأليني أو احكيلي اللي في بالك.</div></div></div>\n  <div class=\"chat-composer\">\n    <div id=\"attachmentMenu\" class=\"attachment-menu\" role=\"menu\" aria-label=\"إضافة إلى المحادثة\" hidden>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"camera\">\n        <span class=\"attachment-icon\">📷</span><span><b>الكاميرا</b><small>التقط صورة وأرسلها لونس</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"photos\">\n        <span class=\"attachment-icon\">🖼️</span><span><b>الصور</b><small>اختر صورة من هاتفك</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"files\">\n        <span class=\"attachment-icon\">📎</span><span><b>الملفات</b><small>نصوص ومستندات وملفات أخرى</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"plugins\" aria-expanded=\"false\">\n        <span class=\"attachment-icon\">🧩</span><span><b>المكونات الإضافية</b><small>أدوات ونس المتصلة</small></span>\n        <span class=\"attachment-chevron\">‹</span>\n      </button>\n      <button type=\"button\" class=\"attachment-option deep-option\" data-action=\"deep\" aria-pressed=\"false\">\n        <span class=\"attachment-icon\">🧠</span><span><b>فكّر بعمق أكبر</b><small>استدلال أعمق للمسائل الصعبة</small></span>\n        <span id=\"deepThinkCheck\" class=\"attachment-check\" hidden>✓</span>\n      </button>\n    </div>\n    <div id=\"pluginTools\" class=\"plugin-tools\" hidden>\n      <div class=\"plugin-tools-heading\"><b>أدوات ونس المتاحة</b><button id=\"backToAttachmentMenu\" type=\"button\" aria-label=\"رجوع\">رجوع</button></div>\n      <button type=\"button\" data-plugin-prompt=\"ابحثي في الإنترنت عن: \">🌐 البحث في الإنترنت</button>\n      <button type=\"button\" data-plugin-prompt=\"افتحي هذا الموقع واستخدمي متصفح ونس لقراءته: \">🌍 متصفح المواقع</button>\n      <button type=\"button\" data-plugin-prompt=\"اعرضي مهامي المحفوظة وساعديني في تنظيمها.\">✅ إدارة المهام</button>\n      <button type=\"button\" data-plugin-prompt=\"احسبي لي: \">🧮 الحاسبة</button>\n      <button type=\"button\" data-plugin-prompt=\"ابحثي في سجل محادثاتي عن: \">🗂️ البحث في المحادثات</button>\n    </div>\n    <div id=\"deepThinkBadge\" class=\"deep-think-badge\" hidden>🧠 التفكير العميق مفعّل <button id=\"disableDeepThink\" type=\"button\">إيقاف</button></div>\n    <div id=\"attachmentsPreview\" class=\"attachments-preview\" hidden></div>\n    <form id=\"chatForm\" class=\"chat-form\">\n      <button id=\"attachMenuBtn\" class=\"attach-menu-btn\" type=\"button\" aria-label=\"إضافة مرفق أو أداة\" aria-expanded=\"false\">＋</button>\n      <input id=\"messageInput\" placeholder=\"اكتب رسالتك أو أرفق ملفًا...\" autocomplete=\"off\" aria-label=\"رسالتك\">\n      <button class=\"send-btn\" type=\"submit\">إرسال</button>\n    </form>\n    <input id=\"cameraInput\" class=\"visually-hidden-input\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\" capture=\"environment\">\n    <input id=\"photosInput\" class=\"visually-hidden-input\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\">\n    <input id=\"filesInput\" class=\"visually-hidden-input\" type=\"file\" multiple accept=\".txt,.md,.csv,.json,.xml,.html,.js,.css,.log,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx\">\n    <p id=\"attachmentStatus\" class=\"attachment-status\" role=\"status\" aria-live=\"polite\"></p>\n  </div>\n  <p class=\"disclaimer\">رسائلك ومرفقاتك تُعالج لإعداد الرد. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.</p>\n</section>\n</div>\n<section id=\"adminInlinePanel\" class=\"panel admin-inline-panel\" hidden>\n  <div class=\"section-head\">\n    <div><h2>لوحة إدارة ونس</h2><p>الإدارة داخل حسابك ومن نفس صفحة ونس</p></div>\n    <span class=\"eyebrow\">PRIVATE</span>\n  </div>\n  <iframe id=\"adminFrame\" title=\"لوحة إدارة ونس\" loading=\"lazy\" referrerpolicy=\"same-origin\" src=\"about:blank\"></iframe>\n</section>\n</main>\n<footer>ونس AI • نسخة تطويرية</footer>\n<script src=\"app.js\"></script>\n</body></html>\n", type: "text/html; charset=utf-8" }],
    ["/index.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0b0b16\"><link rel=\"manifest\" href=\"manifest.json\"><link rel=\"stylesheet\" href=\"style.css\">\n<title>ونس AI</title>\n<style>.messages{max-height:min(60vh,620px);min-height:150px;overflow:auto}.bubble-text{white-space:pre-wrap;overflow-wrap:anywhere}.bubble-text a{color:#d9c9ff;text-decoration:underline;overflow-wrap:anywhere}.execution-trace{margin-top:10px;padding-top:8px;border-top:1px solid #ffffff18;color:#d9c9ff;font-size:11px}.execution-trace summary{cursor:pointer}.execution-trace ul{margin:7px 0 0;padding-inline-start:20px;color:#b7b0cb;line-height:1.8}.admin-inline-panel{margin-top:14px;padding:14px}.admin-inline-panel iframe{display:block;width:100%;height:82vh;min-height:760px;border:1px solid #ffffff18;border-radius:16px;background:#101020}.admin-inline-panel .section-head{margin-bottom:10px}@media(max-width:480px){.admin-inline-panel{padding:9px}.admin-inline-panel iframe{height:82vh;min-height:720px}}\\n</style></head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"index.html\"><span class=\"logo\">و</span><span><b id=\"brandName\">ونس AI</b><small>رفيقة يومك الذكية</small></span></a>\n  <div class=\"top-actions\"><button id=\"openAdminBtn\" class=\"admin-shortcut\" type=\"button\" hidden>الإدارة</button><button id=\"backToAppBtn\" class=\"admin-shortcut\" type=\"button\" hidden>العودة لونس</button><button id=\"logoutBtn\" class=\"admin-shortcut\" hidden>خروج</button></div>\n</header>\n<main class=\"app\">\n<section id=\"authPanel\" class=\"panel auth-panel\">\n  <div class=\"auth-mark\">و</div><p class=\"eyebrow\">مساحتك الخاصة</p><h1 id=\"authTitle\">أهلًا بيك في ونس</h1>\n  <p class=\"hero-text\">سجّل دخولك علشان محادثاتك تتحفظ بأمان وتقدر تكمل من أي جهاز.</p>\n  <form id=\"authForm\" class=\"auth-form\">\n    <label id=\"nameField\" hidden>الاسم<input id=\"nameInput\" maxlength=\"60\" autocomplete=\"name\" placeholder=\"اسمك\"></label>\n    <label>البريد الإلكتروني<input id=\"emailInput\" type=\"email\" maxlength=\"190\" autocomplete=\"email\" required placeholder=\"name@example.com\"></label>\n    <label>كلمة المرور<input id=\"passwordInput\" type=\"password\" minlength=\"8\" maxlength=\"128\" autocomplete=\"current-password\" required placeholder=\"8 أحرف على الأقل\"></label>\n    <button id=\"authSubmit\" class=\"btn primary\" type=\"submit\">تسجيل الدخول</button>\n  </form>\n  <button id=\"authToggle\" class=\"text-btn auth-toggle\" type=\"button\">إنشاء حساب جديد</button>\n  <p id=\"authStatus\" class=\"status-line\" role=\"status\"></p><p id=\"systemStatus\" class=\"system-status\" role=\"status\">جاري فحص اتصال الخدمات...</p>\n  <p class=\"disclaimer\">كلمة المرور تُخزّن مشفّرة تجزئيًا في قاعدة البيانات، ولا تُعرض داخل التطبيق. لا تستخدم كلمة مرور حسابك في مواقع أخرى.</p>\n</section>\n\n<div id=\"appRoot\" hidden>\n<section class=\"hero\">\n  <img id=\"heroPortrait\" class=\"hero-portrait\" src=\"/avatar.jpg?v=real-jpg-20261105\" alt=\"صورة ونس الشخصية\" width=\"192\" height=\"192\" loading=\"eager\" decoding=\"async\" fetchpriority=\"high\" tabindex=\"0\" role=\"button\" aria-label=\"صورة ونس\">\n  <p class=\"eyebrow\" id=\"eyebrowText\">موجودة علشانك</p><h1 id=\"welcomeTitle\">أهلًا بيك، أنا ونس 💜</h1>\n  <p id=\"welcomeText\" class=\"hero-text\">اتكلم معايا واسألني اللي في بالك.</p>\n  <div class=\"actions\"><button id=\"voiceBtn\" class=\"btn primary\">🎙️ <span id=\"voiceButtonText\">اتكلم معايا</span></button></div>\n  <p id=\"voiceStatus\" class=\"status-line\" aria-live=\"polite\"></p>\n</section>\n\n<section class=\"panel\">\n  <div class=\"section-head\"><div><h2>الدردشة مع ونس</h2><p id=\"accountLabel\">محادثتك محفوظة في حسابك</p></div><button id=\"clearBtn\" class=\"text-btn\">مسح العرض</button></div>\n  <div id=\"messages\" class=\"messages\" aria-live=\"polite\"><div class=\"message assistant\"><img class=\"mini-avatar\" src=\"/avatar.jpg?v=real-jpg-20261104\" alt=\"ونس\" width=\"30\" height=\"30\"><div class=\"bubble\">أهلًا بيك! أنا ونس 💜 اسأليني أو احكيلي اللي في بالك.</div></div></div>\n  <div class=\"chat-composer\">\n    <div id=\"attachmentMenu\" class=\"attachment-menu\" role=\"menu\" aria-label=\"إضافة إلى المحادثة\" hidden>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"camera\">\n        <span class=\"attachment-icon\">📷</span><span><b>الكاميرا</b><small>التقط صورة وأرسلها لونس</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"photos\">\n        <span class=\"attachment-icon\">🖼️</span><span><b>الصور</b><small>اختر صورة من هاتفك</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"files\">\n        <span class=\"attachment-icon\">📎</span><span><b>الملفات</b><small>نصوص ومستندات وملفات أخرى</small></span>\n      </button>\n      <button type=\"button\" class=\"attachment-option\" data-action=\"plugins\" aria-expanded=\"false\">\n        <span class=\"attachment-icon\">🧩</span><span><b>المكونات الإضافية</b><small>أدوات ونس المتصلة</small></span>\n        <span class=\"attachment-chevron\">‹</span>\n      </button>\n      <button type=\"button\" class=\"attachment-option deep-option\" data-action=\"deep\" aria-pressed=\"false\">\n        <span class=\"attachment-icon\">🧠</span><span><b>فكّر بعمق أكبر</b><small>استدلال أعمق للمسائل الصعبة</small></span>\n        <span id=\"deepThinkCheck\" class=\"attachment-check\" hidden>✓</span>\n      </button>\n    </div>\n    <div id=\"pluginTools\" class=\"plugin-tools\" hidden>\n      <div class=\"plugin-tools-heading\"><b>أدوات ونس المتاحة</b><button id=\"backToAttachmentMenu\" type=\"button\" aria-label=\"رجوع\">رجوع</button></div>\n      <button type=\"button\" data-plugin-prompt=\"ابحثي في الإنترنت عن: \">🌐 البحث في الإنترنت</button>\n      <button type=\"button\" data-plugin-prompt=\"افتحي هذا الموقع واستخدمي متصفح ونس لقراءته: \">🌍 متصفح المواقع</button>\n      <button type=\"button\" data-plugin-prompt=\"اعرضي مهامي المحفوظة وساعديني في تنظيمها.\">✅ إدارة المهام</button>\n      <button type=\"button\" data-plugin-prompt=\"احسبي لي: \">🧮 الحاسبة</button>\n      <button type=\"button\" data-plugin-prompt=\"ابحثي في سجل محادثاتي عن: \">🗂️ البحث في المحادثات</button>\n    </div>\n    <div id=\"deepThinkBadge\" class=\"deep-think-badge\" hidden>🧠 التفكير العميق مفعّل <button id=\"disableDeepThink\" type=\"button\">إيقاف</button></div>\n    <div id=\"attachmentsPreview\" class=\"attachments-preview\" hidden></div>\n    <form id=\"chatForm\" class=\"chat-form\">\n      <button id=\"attachMenuBtn\" class=\"attach-menu-btn\" type=\"button\" aria-label=\"إضافة مرفق أو أداة\" aria-expanded=\"false\">＋</button>\n      <input id=\"messageInput\" placeholder=\"اكتب رسالتك أو أرفق ملفًا...\" autocomplete=\"off\" aria-label=\"رسالتك\">\n      <button class=\"send-btn\" type=\"submit\">إرسال</button>\n    </form>\n    <input id=\"cameraInput\" class=\"visually-hidden-input\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\" capture=\"environment\">\n    <input id=\"photosInput\" class=\"visually-hidden-input\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\">\n    <input id=\"filesInput\" class=\"visually-hidden-input\" type=\"file\" multiple accept=\".txt,.md,.csv,.json,.xml,.html,.js,.css,.log,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx\">\n    <p id=\"attachmentStatus\" class=\"attachment-status\" role=\"status\" aria-live=\"polite\"></p>\n  </div>\n  <p class=\"disclaimer\">رسائلك ومرفقاتك تُعالج لإعداد الرد. لا ترسل كلمات مرور أو بيانات شديدة الخصوصية.</p>\n</section>\n</div>\n<section id=\"adminInlinePanel\" class=\"panel admin-inline-panel\" hidden>\n  <div class=\"section-head\">\n    <div><h2>لوحة إدارة ونس</h2><p>الإدارة داخل حسابك ومن نفس صفحة ونس</p></div>\n    <span class=\"eyebrow\">PRIVATE</span>\n  </div>\n  <iframe id=\"adminFrame\" title=\"لوحة إدارة ونس\" loading=\"lazy\" referrerpolicy=\"same-origin\" src=\"about:blank\"></iframe>\n</section>\n</main>\n<footer>ونس AI • نسخة تطويرية</footer>\n<script src=\"app.js\"></script>\n</body></html>\n", type: "text/html; charset=utf-8" }],
    ["/admin.html", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة؛ وفي أول إعداد أو عند نسيانها، استخدم كلمة مرور حساب ونس الحالية للتحقق من ملكيتك.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"\" placeholder=\"البريد المرتبط بحساب المالك\" required>\n      <label for=\"adminPassword\">كلمة مرور المدير المستقلة</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"20\" maxlength=\"128\" placeholder=\"كلمة مرور المدير\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <button id=\"showAdminResetBtn\" class=\"text-btn auth-toggle\" type=\"button\" hidden>نسيت كلمة مرور المدير؟ إنشاء كلمة مرور جديدة</button>\n    <form id=\"adminSetupForm\" class=\"admin-login-form\" hidden>\n      <p class=\"muted\">لتهيئة أو استعادة كلمة مرور المدير، يجب أن تكون مسجلًا بحساب المالك في ونس. أدخل كلمة مرور حساب ونس الحالية هنا.</p>\n      <label for=\"ownerPassword\">كلمة مرور حساب ونس الحالية</label>\n      <input id=\"ownerPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" required>\n      <button id=\"adminSetupBtn\" class=\"btn primary\" type=\"submit\">إنشاء كلمة مرور المدير المستقلة</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <div id=\"adminNewPasswordNotice\" class=\"notice\" hidden><b>كلمة مرور المدير الجديدة</b><p>انسخها واحفظها الآن؛ لن تظهر مرة أخرى.</p><code id=\"adminNewPasswordText\" dir=\"ltr\" style=\"display:block;overflow-wrap:anywhere;padding:10px 0\"></code><button id=\"copyAdminPasswordBtn\" class=\"btn secondary\" type=\"button\">نسخ كلمة المرور</button><p id=\"copyAdminPasswordStatus\" class=\"muted\"></p></div>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n          <div class=\"field\">\n            <label for=\"avatarUpload\">الصورة الشخصية لونس</label>\n            <img id=\"avatarPreview\" src=\"/avatar.jpg?v=real-jpg-20261105\" alt=\"معاينة صورة ونس\" width=\"132\" height=\"132\" style=\"display:block;width:132px;height:132px;object-fit:cover;border-radius:50%;border:3px solid #c9b4ff;margin:10px auto 14px\">\n            <input id=\"avatarUpload\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\">\n            <p class=\"muted\">اختَر صورة من الهاتف. سيُعاد تحجيمها وضغطها قبل حفظها في إعدادات التطبيق.</p>\n            <div class=\"actions left-actions\">\n              <button id=\"uploadAvatarBtn\" class=\"btn primary\" type=\"button\" disabled>حفظ صورة ونس</button>\n              <button id=\"resetAvatarBtn\" class=\"btn secondary\" type=\"button\">استعادة الصورة الافتراضية</button>\n            </div>\n            <p id=\"avatarStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n          </div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/admin.js", { body: "const $ = id => document.getElementById(id);\nconst defaults = {\n  appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n  welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n  welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n  greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n  voiceButton: \"اتكلم معايا\",\n  voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n  enableVoice: true, voiceLocale: \"ar-EG\", avatarDataUrl: \"\"\n};\nconst keys = Object.keys(defaults);\nlet config = { ...defaults };\nasync function request(path, body, method = \"GET\") {\n  const response = await fetch(path, {\n    method, credentials: \"same-origin\", cache: \"no-store\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"تعذّر تنفيذ الطلب.\");\n  return data;\n}\nfunction gateMessage(message, error = false) {\n  $(\"adminGateStatus\").textContent = message || \"\";\n  $(\"adminGateStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction serviceMessage(message, error = false) {\n  $(\"serviceStatus\").textContent = message || \"\";\n  $(\"serviceStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction normalize(data) {\n  const next = { ...defaults };\n  if (!data || typeof data !== \"object\" || Array.isArray(data)) return next;\n  for (const key of keys) {\n    if (!(key in data)) continue;\n    const value = data[key];\n    if (typeof defaults[key] === \"boolean\") next[key] = value === true;\n    else if (typeof defaults[key] === \"number\") {\n      const max = key === \"voiceRate\" ? 1.35 : 1.5;\n      const min = key === \"voiceRate\" ? 0.65 : 0.7;\n      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];\n    } else if (typeof value === \"string\") {\n      next[key] = value.slice(0, key === \"avatarDataUrl\" ? 700000 : key === \"welcomeText\" ? 240 : key === \"greeting\" ? 350 : 120);\n    }\n  }\n  if (![\"purple\", \"blue\", \"green\", \"rose\"].includes(next.theme)) next.theme = defaults.theme;\n  if (![\"ar-EG\", \"ar-SA\", \"en-US\"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;\n  return next;\n}\nfunction fillSettingsForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (!element) continue;\n    if (element.type === \"checkbox\") element.checked = !!config[key];\n    else element.value = config[key];\n  }\n  updateRanges();\n}\nasync function loadSettings() {\n  const data = await request(\"/api/admin/settings\");\n  config = normalize(data.settings);\n  fillSettingsForm();\n  const preview = $(\"avatarPreview\");\n  if (preview) preview.src = config.avatarDataUrl || \"/avatar.jpg?v=real-jpg-20261105\";\n}\nfunction readForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (element) config[key] = element.type === \"checkbox\" ? element.checked :\n      element.type === \"range\" ? Number(element.value) : element.value;\n  }\n}\nfunction updateRanges() {\n  $(\"rateOut\").value = Number($(\"voiceRate\").value).toFixed(2);\n  $(\"pitchOut\").value = Number($(\"voicePitch\").value).toFixed(2);\n}\nfunction setState(id, label, ready) {\n  const element = $(id);\n  element.textContent = label;\n  element.className = ready ? \"state-ready\" : \"state-off\";\n}\nasync function refreshStatus() {\n  $(\"refreshStatusBtn\").disabled = true;\n  try {\n    const data = await request(\"/api/admin/status\");\n    const f = data.features || {};\n    setState(\"workersAiState\", f.workersAI ? \"متصل ويعمل\" : \"غير مربوط\", !!f.workersAI);\n    setState(\"databaseState\", !f.databaseConfigured ? \"غير مربوطة\" : !f.databaseConnected ? \"فشل الاتصال\" : f.databaseSchemaReady ? \"جاهزة\" : \"تحتاج مراجعة\", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));\n    $(\"modelName\").textContent = \"النموذج: \" + (data.model || \"غير محدد\");\n    $(\"databaseDetail\").textContent = !f.databaseConfigured ? \"لم يتم ربط D1 بعد\" : !f.databaseConnected ? \"تعذّر الاتصال بقاعدة البيانات\" : f.settingsStorageReady ? \"الجداول وحفظ الإعدادات جاهزة\" : \"تخزين الإعدادات يحتاج مراجعة\";\n    $(\"checkedAt\").textContent = \"آخر فحص: \" + new Date(data.checkedAt).toLocaleString(\"ar-EG\");\n    serviceMessage(\"تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.\");\n  } catch (error) {\n    serviceMessage(error.message, true);\n    if (/سجّل الدخول/.test(error.message)) {\n      $(\"adminApp\").hidden = true;\n      $(\"adminGate\").hidden = false;\n      gateMessage(\"انتهت الجلسة أو الحساب غير مصرح. سجّل الدخول بحساب المالك.\", true);\n    }\n  } finally { $(\"refreshStatusBtn\").disabled = false; }\n}\nasync function showDashboard() {\n  $(\"adminGate\").hidden = true;\n  $(\"adminApp\").hidden = false;\n  try { await loadSettings(); await refreshStatus(); }\n  catch (error) { serviceMessage(error.message, true); }\n}\n$(\"adminLoginForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const email = $(\"adminEmail\").value.trim(), password = $(\"adminPassword\").value;\n  $(\"adminLoginBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من حساب المالك...\");\n  try {\n    await request(\"/api/admin/login\", { email, password }, \"POST\");\n    $(\"adminPassword\").value = \"\";\n    await showDashboard();\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminLoginBtn\").disabled = false; }\n});\n$(\"adminLogoutBtn\").addEventListener(\"click\", async () => {\n  try { await request(\"/api/admin/logout\", {}, \"POST\"); } catch {}\n  $(\"adminApp\").hidden = true;\n  $(\"adminGate\").hidden = false;\n  $(\"adminPassword\").value = \"\";\n  gateMessage(\"تم تسجيل خروج المدير.\");\n});\n$(\"refreshStatusBtn\").addEventListener(\"click\", refreshStatus);\n$(\"testWorkersAiBtn\").addEventListener(\"click\", async () => {\n  $(\"testWorkersAiBtn\").disabled = true;\n  serviceMessage(\"جاري اختبار Cloudflare Workers AI...\");\n  try {\n    const result = await request(\"/api/admin/test-ai\", {}, \"POST\");\n    serviceMessage(\"اختبار ناجح ✓ رد الخدمة: \" + result.reply);\n    setState(\"workersAiState\", \"يعمل بنجاح\", true);\n  } catch (error) {\n    serviceMessage(error.message, true);\n    setState(\"workersAiState\", \"فشل الاختبار\", false);\n  } finally { $(\"testWorkersAiBtn\").disabled = false; }\n});\ndocument.querySelectorAll(\".nav-btn\").forEach(button => button.addEventListener(\"click\", () => {\n  document.querySelectorAll(\".nav-btn\").forEach(item => item.classList.toggle(\"active\", item === button));\n  document.querySelectorAll(\".tab-page\").forEach(page => page.classList.toggle(\"active\", page.id === \"tab-\" + button.dataset.tab));\n}));\n[\"voiceRate\", \"voicePitch\"].forEach(id => $(id).addEventListener(\"input\", updateRanges));\n$(\"saveBtn\").addEventListener(\"click\", async () => {\n  readForm();\n  $(\"saveBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: config }, \"PUT\");\n    config = normalize(result.settings);\n    fillSettingsForm();\n    $(\"saveStatus\").textContent = \"تم حفظ التعديلات على الخادم لكل المستخدمين ✓\";\n    $(\"saveStatus\").style.color = \"#9be7c1\";\n  } catch (error) {\n    $(\"saveStatus\").textContent = error.message;\n    $(\"saveStatus\").style.color = \"#ff9fba\";\n  } finally { $(\"saveBtn\").disabled = false; }\n});\n$(\"exportBtn\").addEventListener(\"click\", () => {\n  readForm();\n  const blob = new Blob([JSON.stringify(config, null, 2)], { type: \"application/json\" });\n  const url = URL.createObjectURL(blob), link = document.createElement(\"a\");\n  link.href = url; link.download = \"wens-ai-settings.json\"; link.click();\n  URL.revokeObjectURL(url);\n  $(\"backupStatus\").textContent = \"تم تجهيز نسخة من إعدادات الخادم الحالية.\";\n});\n$(\"importFile\").addEventListener(\"change\", async event => {\n  const file = event.target.files[0];\n  if (!file) return;\n  try {\n    const imported = normalize(JSON.parse(await file.text()));\n    const result = await request(\"/api/admin/settings\", { settings: imported }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تم استرجاع الإعدادات وحفظها على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message || \"الملف غير صالح؛ اختَر ملف JSON صحيح.\"; }\n  event.target.value = \"\";\n});\n$(\"resetBtn\").addEventListener(\"click\", async () => {\n  if (!confirm(\"ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟\")) return;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: defaults }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تمت استعادة الإعدادات الافتراضية على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message; }\n});\n\nfunction compressAvatarFile(file) {\n  return new Promise((resolve, reject) => {\n    const allowed = [\"image/jpeg\", \"image/png\", \"image/webp\"];\n    if (!file || !allowed.includes(file.type)) {\n      reject(new Error(\"اختَر صورة بصيغة JPG أو PNG أو WebP.\"));\n      return;\n    }\n    const objectUrl = URL.createObjectURL(file);\n    const image = new Image();\n    image.onload = () => {\n      try {\n        const maxSide = 512;\n        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));\n        const canvas = document.createElement(\"canvas\");\n        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));\n        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));\n        const context = canvas.getContext(\"2d\", { alpha: false });\n        if (!context) throw new Error(\"تعذّر تجهيز الصورة.\");\n        context.fillStyle = \"#ffffff\";\n        context.fillRect(0, 0, canvas.width, canvas.height);\n        context.drawImage(image, 0, 0, canvas.width, canvas.height);\n        canvas.toBlob(blob => {\n          URL.revokeObjectURL(objectUrl);\n          if (!blob) { reject(new Error(\"تعذّر ضغط الصورة.\")); return; }\n          const reader = new FileReader();\n          reader.onload = () => resolve(String(reader.result || \"\"));\n          reader.onerror = () => reject(new Error(\"تعذّرت قراءة الصورة.\"));\n          reader.readAsDataURL(blob);\n        }, \"image/jpeg\", 0.84);\n      } catch (error) {\n        URL.revokeObjectURL(objectUrl);\n        reject(error);\n      }\n    };\n    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(\"ملف الصورة غير صالح.\")); };\n    image.src = objectUrl;\n  });\n}\n$(\"avatarUpload\").addEventListener(\"change\", () => {\n  $(\"uploadAvatarBtn\").disabled = !$(\"avatarUpload\").files || !$(\"avatarUpload\").files[0];\n  $(\"avatarStatus\").textContent = $(\"avatarUpload\").files && $(\"avatarUpload\").files[0]\n    ? \"الصورة جاهزة. اضغط حفظ صورة ونس لإرسالها.\"\n    : \"\";\n});\n$(\"uploadAvatarBtn\").addEventListener(\"click\", async () => {\n  const file = $(\"avatarUpload\").files && $(\"avatarUpload\").files[0];\n  if (!file) return;\n  $(\"uploadAvatarBtn\").disabled = true;\n  $(\"avatarStatus\").textContent = \"جاري ضغط الصورة وحفظها على الخادم...\";\n  try {\n    const avatarDataUrl = await compressAvatarFile(file);\n    if (avatarDataUrl.length > 700000) throw new Error(\"الصورة كبيرة بعد الضغط. اختَر صورة أصغر.\");\n    const result = await request(\"/api/admin/settings\", { settings: { ...config, avatarDataUrl } }, \"PUT\");\n    config = normalize(result.settings);\n    $(\"avatarPreview\").src = config.avatarDataUrl;\n    $(\"avatarStatus\").textContent = \"تم حفظ صورة ونس على الخادم. ستظهر للمستخدمين بعد تحديث التطبيق.\";\n    $(\"avatarUpload\").value = \"\";\n  } catch (error) {\n    $(\"avatarStatus\").textContent = error.message || \"تعذّر حفظ الصورة.\";\n  } finally {\n    $(\"uploadAvatarBtn\").disabled = false;\n  }\n});\n$(\"resetAvatarBtn\").addEventListener(\"click\", async () => {\n  $(\"resetAvatarBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: { ...config, avatarDataUrl: \"\" } }, \"PUT\");\n    config = normalize(result.settings);\n    $(\"avatarPreview\").src = \"/avatar.jpg?v=real-jpg-20261105\";\n    $(\"avatarUpload\").value = \"\";\n    $(\"uploadAvatarBtn\").disabled = true;\n    $(\"avatarStatus\").textContent = \"تمت استعادة الصورة الافتراضية.\";\n  } catch (error) {\n    $(\"avatarStatus\").textContent = error.message;\n  } finally {\n    $(\"resetAvatarBtn\").disabled = false;\n  }\n});\n\n(async function bootAdmin() {\n  try {\n    const session = await request(\"/api/admin/session\");\n    if (session.authenticated) await showDashboard();\n    else gateMessage(\"أدخل البريد وكلمة مرور حساب مالك التطبيق.\");\n  } catch (error) {\n    gateMessage(error.message === \"تعذّر تنفيذ الطلب.\"\n      ? \"تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت.\"\n      : error.message, true);\n  }\n})();", type: "text/javascript; charset=utf-8" }],
    ["/admin.css", { body: ".admin-wrap{width:min(1050px,100%);margin:auto;padding:24px 14px 45px}.admin-gate{width:min(460px,100%);margin:7vh auto 30px;padding:clamp(22px,5vw,34px);text-align:center}.admin-gate h1{font-size:clamp(25px,5vw,32px);margin:5px 0}.admin-login-form{display:grid;gap:10px;margin:22px 0 8px;text-align:right}.admin-login-form label{font-size:13px;color:#e8e3f8}.admin-login-form input{width:100%;min-height:52px;padding:14px;background:#0d0c18;border:1px solid #45405f;border-radius:13px;color:var(--text);font:inherit;letter-spacing:0;text-align:right;font-size:16px}.admin-login-form button{width:100%}.admin-heading{padding:8px 2px 18px}.admin-heading h1{margin:4px 0 8px;font-size:clamp(25px,5vw,34px)}.admin-heading>p:not(.eyebrow){color:var(--muted);font-size:13px;line-height:1.8}.admin-heading-actions,.service-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.admin-heading-actions{margin-top:15px}.service-panel{background:linear-gradient(145deg,#1d1b30f2,#141321f2);border:1px solid #ffffff18;border-radius:22px;padding:17px;margin:12px 0 16px;box-shadow:0 18px 55px #0005}.service-panel h2{font-size:17px;margin:0}.service-panel .section-head>div>p{color:var(--muted);font-size:11px;margin:4px 0}.service-grid{display:grid;grid-template-columns:1fr;gap:9px;margin:15px 0}.service-card{display:grid;grid-template-columns:34px 1fr auto;align-items:center;gap:5px 9px;background:#ffffff08;border:1px solid #ffffff12;border-radius:14px;padding:13px}.service-icon{grid-row:span 2;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:#b49aff1b;color:#d9ccff;font-size:18px}.service-card b{font-size:13px}.service-card strong{font-size:12px;text-align:left}.service-card small{grid-column:2/4;color:var(--muted);font-size:10px}.state-ready{color:#9be7c1}.state-off{color:#ffb4c7}.state-pending{color:#ffcf8f}.service-actions{align-items:center;margin-top:12px}.service-actions .status-line{flex:1;min-width:170px;margin:0}.admin-grid{display:grid;grid-template-columns:1fr;gap:14px}.admin-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-content:start}.nav-btn{border:1px solid #ffffff12;border-radius:12px;padding:12px 8px;text-align:right;background:#19192c;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.nav-btn.active{background:#a28bff24;color:#fff;border-color:#a28bff88}.admin-content{min-width:0;background:#19192ccc;border:1px solid #ffffff12;border-radius:20px;padding:17px}.tab-page{display:none}.tab-page.active{display:block}.tab-page h2{font-size:19px;margin:3px 0 14px}.stat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:20px 0}.stat{background:#ffffff08;border:1px solid #ffffff10;border-radius:13px;padding:12px 7px;text-align:center}.stat b{display:block;font-size:16px;color:#d6caff}.stat span{font-size:10px;color:var(--muted)}.notice{background:#a28bff12;border:1px solid #a28bff38;border-radius:13px;padding:13px;color:#d8d1f0;font-size:12px;line-height:1.8;margin:16px 0}.field{margin:14px 0}.field label{display:block;font-size:13px;margin-bottom:7px;color:#e4e0f5}.field input[type=range]{padding:0;accent-color:var(--purple)}.field textarea{resize:vertical}.field output{color:var(--pink);font-weight:700}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #ffffff12}.toggle-row b,.toggle-row small{display:block}.toggle-row b{font-size:14px}.toggle-row small{font-size:11px;color:var(--muted);margin-top:4px}.toggle-row input{width:21px;height:21px;accent-color:var(--purple)}.save-bar{display:flex;gap:10px;align-items:center;justify-content:space-between;border-top:1px solid #ffffff15;padding-top:16px;margin-top:20px;flex-wrap:wrap}.save-bar .muted{font-size:11px;flex:1}.link-btn{display:inline-flex;text-decoration:none;align-items:center;justify-content:center}.left-actions{justify-content:flex-start}.file-label{display:inline-flex;align-items:center;justify-content:center}.btn.danger{background:#9d3452;color:#fff}@media(min-width:700px){.admin-grid{grid-template-columns:210px minmax(0,1fr)}.admin-nav{grid-template-columns:1fr}.nav-btn{font-size:13px;padding:13px}.admin-content{padding:25px}.admin-wrap{padding-top:34px}.service-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.service-card{grid-template-columns:34px 1fr}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}}@media(max-width:480px){.admin-wrap{padding-inline:12px}.service-panel{padding:14px}.service-card{grid-template-columns:30px 1fr;gap:5px 8px}.service-card strong{grid-column:2;text-align:right}.service-card small{grid-column:2}.admin-heading-actions .btn{flex:1}.admin-login-form input{font-size:18px}}[hidden]{display:none!important}", type: "text/css; charset=utf-8" }],
    ["/app.js", { body: "const $ = id => document.getElementById(id);\n// إدارة ونس تفتح من الصورة الشخصية فقط، داخل الصفحة نفسها.\nlet authMode = \"login\";\nlet currentUser = null;\nlet recognition = null;\nlet pendingAttachments = [];\nlet deepThinkEnabled = false;\nconst appSettings = loadLocalSettings();\n\nfunction loadLocalSettings() {\n  const defaults = {\n    appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n    welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n    welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n    greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n    voiceButton: \"اتكلم معايا\",\n    voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n    enableVoice: true, voiceLocale: \"ar-EG\", avatarDataUrl: \"\"\n  };\n  try {\n    const saved = JSON.parse(localStorage.getItem(\"wensAISettings\") || \"{}\");\n    if (!saved || typeof saved !== \"object\" || Array.isArray(saved)) return defaults;\n    return {\n      ...defaults,\n      ...Object.fromEntries(Object.entries(saved).filter(([key, value]) =>\n        key in defaults && typeof value === typeof defaults[key]\n      ))\n    };\n  } catch { return defaults; }\n}\n\nfunction applyLocalSettings() {\n  document.title = appSettings.appName;\n  $(\"brandName\").textContent = appSettings.appName;\n  $(\"eyebrowText\").textContent = appSettings.eyebrow;\n  $(\"welcomeTitle\").textContent = appSettings.welcomeTitle;\n  $(\"welcomeText\").textContent = appSettings.welcomeText;\n  $(\"voiceButtonText\").textContent = appSettings.voiceButton;\n  $(\"voiceBtn\").hidden = !appSettings.enableVoice;\n  const avatarSrc = appSettings.avatarDataUrl || \"/avatar.jpg?v=real-jpg-20261105\";\n  const portrait = $(\"heroPortrait\");\n  if (portrait) portrait.src = avatarSrc;\n  document.querySelectorAll(\".mini-avatar\").forEach(image => { image.src = avatarSrc; });\n  const themes = {\n    purple: [\"#b49aff\", \"#ffacd6\"],\n    blue: [\"#83baff\", \"#8ce8ef\"],\n    green: [\"#8cddb4\", \"#c5ed9a\"],\n    rose: [\"#ff9fc1\", \"#ffc4a6\"]\n  };\n  const colors = themes[appSettings.theme] || themes.purple;\n  document.documentElement.style.setProperty(\"--purple\", colors[0]);\n  document.documentElement.style.setProperty(\"--pink\", colors[1]);\n}\n\nasync function api(path, body, method = \"POST\") {\n  const response = await fetch(path, {\n    method,\n    credentials: \"same-origin\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"حصل خطأ في الاتصال بالخادم.\");\n  return data;\n}\nfunction setAuthMessage(message, error = false) {\n  $(\"authStatus\").textContent = message || \"\";\n  $(\"authStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction showAuth() {\n  $(\"authPanel\").hidden = false;\n  $(\"appRoot\").hidden = true;\n  $(\"adminInlinePanel\").hidden = true;\n  $(\"logoutBtn\").hidden = true;\n  $(\"openAdminBtn\").hidden = true;\n  $(\"backToAppBtn\").hidden = true;\n}\nfunction showApp(user) {\n  currentUser = user;\n  $(\"authPanel\").hidden = true;\n  $(\"appRoot\").hidden = false;\n  $(\"adminInlinePanel\").hidden = true;\n  $(\"logoutBtn\").hidden = false;\n  $(\"openAdminBtn\").hidden = true;\n  $(\"backToAppBtn\").hidden = true;\n  $(\"accountLabel\").textContent = user.id === \"guest\"\n    ? \"وضع تجربة مؤقت — المحادثات لن تُحفظ قبل ربط قاعدة البيانات\"\n    : \"مسجّل الدخول: \" + user.name;\n  updateAdminShortcut();\n  loadChatHistory();\n}\nasync function updateAdminShortcut() {\n  // الإدارة لا تظهر كزر عام؛ مدخلها المخفي هو الضغط خمس مرات على صورة ونس.\n  $(\"openAdminBtn\").hidden = true;\n}\nfunction openAdminInsideWens() {\n  $(\"appRoot\").hidden = true;\n  $(\"authPanel\").hidden = true;\n  $(\"adminInlinePanel\").hidden = false;\n  $(\"openAdminBtn\").hidden = true;\n  $(\"backToAppBtn\").hidden = false;\n  const frame = $(\"adminFrame\");\n  if (!frame.dataset.loaded) {\n    frame.src = \"/admin.html?embed=1&v=single-entry-20261104\";\n    frame.dataset.loaded = \"true\";\n  }\n  window.scrollTo({ top: 0, behavior: \"smooth\" });\n}\nfunction returnToWensChat() {\n  $(\"adminInlinePanel\").hidden = true;\n  $(\"appRoot\").hidden = false;\n  $(\"openAdminBtn\").hidden = true;\n  $(\"backToAppBtn\").hidden = true;\n  window.scrollTo({ top: 0, behavior: \"smooth\" });\n}\n$(\"openAdminBtn\").addEventListener(\"click\", openAdminInsideWens);\n$(\"backToAppBtn\").addEventListener(\"click\", returnToWensChat);\n\nlet adminAvatarTapCount = 0;\nlet adminAvatarTapTimer = null;\nasync function handleAdminAvatarTap() {\n  if (!currentUser || currentUser.id === \"guest\") return;\n  adminAvatarTapCount += 1;\n  if (adminAvatarTapTimer) clearTimeout(adminAvatarTapTimer);\n  adminAvatarTapTimer = setTimeout(() => { adminAvatarTapCount = 0; }, 3000);\n  if (adminAvatarTapCount < 5) return;\n  adminAvatarTapCount = 0;\n  clearTimeout(adminAvatarTapTimer);\n  adminAvatarTapTimer = null;\n  try {\n    const session = await api(\"/api/admin/session\", undefined, \"GET\");\n    if (session.owner) openAdminInsideWens();\n    else $(\"voiceStatus\").textContent = \"هذا المدخل مخصص لمالك التطبيق فقط.\";\n  } catch {\n    $(\"voiceStatus\").textContent = \"تعذّر التحقق من صلاحية الإدارة الآن.\";\n  }\n}\nconst adminPortrait = $(\"heroPortrait\");\nif (adminPortrait) {\n  adminPortrait.addEventListener(\"click\", handleAdminAvatarTap);\n  adminPortrait.addEventListener(\"keydown\", event => {\n    if (event.key === \"Enter\" || event.key === \" \") {\n      event.preventDefault();\n      handleAdminAvatarTap();\n    }\n  });\n}\n\nfunction updateAuthMode() {\n  const registering = authMode === \"register\";\n  $(\"nameField\").hidden = !registering;\n  $(\"authTitle\").textContent = registering ? \"إنشاء حساب ونس\" : \"أهلًا بيك في ونس\";\n  $(\"authSubmit\").textContent = registering ? \"إنشاء الحساب\" : \"تسجيل الدخول\";\n  $(\"authToggle\").textContent = registering ? \"عندي حساب بالفعل\" : \"إنشاء حساب جديد\";\n  $(\"passwordInput\").autocomplete = registering ? \"new-password\" : \"current-password\";\n}\n$(\"authToggle\").addEventListener(\"click\", () => {\n  authMode = authMode === \"login\" ? \"register\" : \"login\";\n  updateAuthMode();\n  setAuthMessage(\"\");\n});\n$(\"authForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  $(\"authSubmit\").disabled = true;\n  setAuthMessage(\"جاري التحقق من الحساب...\");\n  const body = {\n    email: $(\"emailInput\").value.trim(),\n    password: $(\"passwordInput\").value,\n    name: $(\"nameInput\").value.trim()\n  };\n  try {\n    const data = await api(authMode === \"register\" ? \"/api/auth/register\" : \"/api/auth/login\", body);\n    $(\"passwordInput\").value = \"\";\n    showApp(data.user);\n  } catch (error) {\n    setAuthMessage(error.message, true);\n  } finally {\n    $(\"authSubmit\").disabled = false;\n  }\n});\n$(\"logoutBtn\").addEventListener(\"click\", async () => {\n  try { await api(\"/api/auth/logout\", {}); } catch {}\n  currentUser = null;\n  $(\"messages\").replaceChildren();\n  showAuth();\n  setAuthMessage(\"تم تسجيل الخروج.\");\n});\nasync function loadChatHistory() {\n  $(\"messages\").replaceChildren();\n  try {\n    const data = await api(\"/api/chat/history\", undefined, \"GET\");\n    for (const item of data.messages || []) addMessage(item.content, item.role);\n    if (!(data.messages || []).length) addMessage(appSettings.greeting);\n  } catch (error) {\n    addMessage(\"تعذّر تحميل المحادثة: \" + error.message);\n  }\n}\nfunction appendMessageText(container, text) {\n  const source = String(text ?? \"\");\n  const pattern = /\\[([^\\]\\n]{1,100})\\]\\((https:\\/\\/[^)\\s]+)\\)|(https:\\/\\/[^\\s<>\"']+)/g;\n  let cursor = 0, match;\n  while ((match = pattern.exec(source))) {\n    if (match.index > cursor) {\n      container.appendChild(document.createTextNode(source.slice(cursor, match.index)));\n    }\n    const label = match[1] || \"\";\n    const rawUrl = match[2] || match[3];\n    const suffix = match[3] ? (rawUrl.match(/[),.!?؟،؛]+$/)?.[0] || \"\") : \"\";\n    const href = suffix ? rawUrl.slice(0, -suffix.length) : rawUrl;\n    try {\n      const parsed = new URL(href);\n      if (parsed.protocol === \"https:\") {\n        const link = document.createElement(\"a\");\n        link.href = parsed.href;\n        link.target = \"_blank\";\n        link.rel = \"noopener noreferrer\";\n        link.textContent = label || href;\n        container.appendChild(link);\n        if (suffix) container.appendChild(document.createTextNode(suffix));\n      } else {\n        container.appendChild(document.createTextNode(match[0]));\n      }\n    } catch {\n      container.appendChild(document.createTextNode(match[0]));\n    }\n    cursor = match.index + match[0].length;\n  }\n  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));\n}\nfunction addMessage(text, who = \"assistant\", steps = [], attachments = [], generatedImages = []) {\n  const row = document.createElement(\"div\");\n  row.className = \"message \" + who;\n  if (who === \"assistant\") {\n    const avatar = document.createElement(\"img\");\n    avatar.className = \"mini-avatar\";\n    avatar.src = appSettings.avatarDataUrl || \"/avatar.jpg?v=real-jpg-20261105\";\n    avatar.alt = \"ونس\";\n    avatar.width = 30;\n    avatar.height = 30;\n    row.appendChild(avatar);\n  }\n  const bubble = document.createElement(\"div\");\n  bubble.className = \"bubble\";\n  const content = document.createElement(\"div\");\n  content.className = \"bubble-text\";\n  appendMessageText(content, text);\n  bubble.appendChild(content);\n  if (Array.isArray(attachments) && attachments.length) {\n    const media = document.createElement(\"div\");\n    media.className = \"message-attachments\";\n    for (const item of attachments.slice(0, 4)) {\n      if (item.kind === \"image\" && item.dataUrl) {\n        const image = document.createElement(\"img\");\n        image.src = item.dataUrl;\n        image.alt = item.name || \"صورة مرفقة\";\n        image.loading = \"lazy\";\n        media.appendChild(image);\n      } else {\n        const name = document.createElement(\"span\");\n        name.className = \"message-attachment-name\";\n        name.textContent = \"📎 \" + String(item.name || \"ملف\").slice(0, 100);\n        media.appendChild(name);\n      }\n    }\n    bubble.appendChild(media);\n  }\n  if (who === \"assistant\" && Array.isArray(generatedImages) && generatedImages.length) {\n    const media = document.createElement(\"div\");\n    media.className = \"message-attachments\";\n    for (const item of generatedImages.slice(0, 1)) {\n      if (!item || typeof item.dataUrl !== \"string\" || !item.dataUrl.startsWith(\"data:image/\")) continue;\n      const image = document.createElement(\"img\");\n      image.src = item.dataUrl;\n      image.alt = item.name || \"صورة من ونس\";\n      image.loading = \"lazy\";\n      media.appendChild(image);\n      const save = document.createElement(\"a\");\n      save.className = \"message-attachment-name\";\n      save.href = item.dataUrl;\n      save.download = String(item.name || \"wens-ai-image\") + \".jpg\";\n      save.textContent = \"حفظ الصورة\";\n      media.appendChild(save);\n    }\n    if (media.childNodes.length) bubble.appendChild(media);\n  }\n  if (who === \"assistant\" && Array.isArray(steps) && steps.length) {\n    const trace = document.createElement(\"details\");\n    trace.className = \"execution-trace\";\n    const summary = document.createElement(\"summary\");\n    summary.textContent = \"خطوات التنفيذ (\" + steps.length + \")\";\n    const list = document.createElement(\"ul\");\n    for (const item of steps.slice(0, 14)) {\n      const li = document.createElement(\"li\");\n      li.textContent = String(item);\n      list.appendChild(li);\n    }\n    trace.append(summary, list);\n    bubble.appendChild(trace);\n  }\n  row.appendChild(bubble);\n  $(\"messages\").appendChild(row);\n  $(\"messages\").scrollTop = $(\"messages\").scrollHeight;\n  return row;\n}\nfunction setBusy(busy) {\n  document.querySelector(\".send-btn\").disabled = busy;\n  $(\"messageInput\").disabled = busy;\n  $(\"attachMenuBtn\").disabled = busy;\n  document.querySelector(\".send-btn\").textContent = busy ? \"ونس بتفكر…\" : \"إرسال\";\n}\nfunction setAttachmentStatus(message, error = false) {\n  $(\"attachmentStatus\").textContent = message || \"\";\n  $(\"attachmentStatus\").style.color = error ? \"#ffb5c9\" : \"#a9efc7\";\n}\nfunction closeAttachmentMenu() {\n  $(\"attachmentMenu\").hidden = true;\n  $(\"pluginTools\").hidden = true;\n  $(\"attachMenuBtn\").setAttribute(\"aria-expanded\", \"false\");\n  $(\"attachMenuBtn\").classList.remove(\"active\");\n  document.querySelector('[data-action=\"plugins\"]')?.setAttribute(\"aria-expanded\", \"false\");\n}\nfunction updateDeepThinkUI() {\n  const option = document.querySelector('[data-action=\"deep\"]');\n  option.setAttribute(\"aria-pressed\", String(deepThinkEnabled));\n  $(\"deepThinkCheck\").hidden = !deepThinkEnabled;\n  $(\"deepThinkBadge\").hidden = !deepThinkEnabled;\n}\nfunction showAttachmentMenu() {\n  $(\"attachmentMenu\").hidden = false;\n  $(\"pluginTools\").hidden = true;\n  $(\"attachMenuBtn\").setAttribute(\"aria-expanded\", \"true\");\n  $(\"attachMenuBtn\").classList.add(\"active\");\n}\nfunction readAsDataUrl(file) {\n  return new Promise((resolve, reject) => {\n    const reader = new FileReader();\n    reader.onload = () => resolve(String(reader.result || \"\"));\n    reader.onerror = () => reject(new Error(\"تعذّرت قراءة الملف من الهاتف.\"));\n    reader.readAsDataURL(file);\n  });\n}\nfunction renderAttachmentPreview() {\n  const preview = $(\"attachmentsPreview\");\n  preview.replaceChildren();\n  preview.hidden = pendingAttachments.length === 0;\n  pendingAttachments.forEach((item, index) => {\n    const chip = document.createElement(\"div\");\n    chip.className = \"attachment-chip\";\n    if (item.kind === \"image\" && item.dataUrl) {\n      const img = document.createElement(\"img\");\n      img.src = item.dataUrl;\n      img.alt = item.name;\n      chip.appendChild(img);\n    } else {\n      const icon = document.createElement(\"b\");\n      icon.textContent = item.kind === \"text\" ? \"TXT\" : \"📎\";\n      chip.appendChild(icon);\n    }\n    const label = document.createElement(\"span\");\n    label.textContent = item.name + (item.kind === \"file\" ? \" (اسم الملف فقط)\" : \"\");\n    chip.appendChild(label);\n    const remove = document.createElement(\"button\");\n    remove.type = \"button\";\n    remove.textContent = \"×\";\n    remove.setAttribute(\"aria-label\", \"إزالة \" + item.name);\n    remove.addEventListener(\"click\", () => {\n      pendingAttachments.splice(index, 1);\n      renderAttachmentPreview();\n      setAttachmentStatus(\"\");\n    });\n    chip.appendChild(remove);\n    preview.appendChild(chip);\n  });\n}\nasync function addSelectedFile(file) {\n  if (!file) return;\n  if (pendingAttachments.length >= 4) {\n    setAttachmentStatus(\"يمكنك إرفاق 4 ملفات كحد أقصى في الرسالة الواحدة.\", true);\n    return;\n  }\n  const isImage = file.type.startsWith(\"image/\");\n  if (isImage) {\n    if (![\"image/jpeg\", \"image/png\", \"image/webp\"].includes(file.type)) {\n      setAttachmentStatus(\"نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP.\", true);\n      return;\n    }\n    if (file.size > 4 * 1024 * 1024) {\n      setAttachmentStatus(\"حجم الصورة أكبر من 4 ميجابايت. اختر صورة أصغر.\", true);\n      return;\n    }\n    if (pendingAttachments.some(item => item.kind === \"image\")) {\n      setAttachmentStatus(\"أرفق صورة واحدة في كل رسالة حاليًا.\", true);\n      return;\n    }\n    try {\n      const bitmap = await createImageBitmap(file);\n      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));\n      const canvas = document.createElement(\"canvas\");\n      canvas.width = Math.max(1, Math.round(bitmap.width * scale));\n      canvas.height = Math.max(1, Math.round(bitmap.height * scale));\n      const context = canvas.getContext(\"2d\");\n      if (!context) throw new Error(\"تعذّر تجهيز الصورة للمعالجة.\");\n      context.fillStyle = \"#ffffff\";\n      context.fillRect(0, 0, canvas.width, canvas.height);\n      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);\n      bitmap.close?.();\n      const optimizedBlob = await new Promise((resolve, reject) => {\n        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(\"تعذّر ضغط الصورة.\")), \"image/jpeg\", 0.88);\n      });\n      const [dataUrl, previewUrl] = await Promise.all([\n        readAsDataUrl(optimizedBlob),\n        readAsDataUrl(file)\n      ]);\n      pendingAttachments.push({\n        kind: \"image\", name: file.name || \"صورة\",\n        type: \"image/jpeg\", size: optimizedBlob.size,\n        data: dataUrl.split(\",\")[1], dataUrl: previewUrl\n      });\n      setAttachmentStatus(\"الصورة جاهزة للتحليل والتعديل بالذكاء الاصطناعي.\");\n    } catch (error) { setAttachmentStatus(error.message, true); }\n  } else {\n    const extension = String(file.name.split(\".\").pop() || \"\").toLowerCase();\n    const textExtensions = [\"txt\",\"md\",\"csv\",\"json\",\"xml\",\"html\",\"js\",\"css\",\"log\"];\n    if (textExtensions.includes(extension)) {\n      if (file.size > 150 * 1024) {\n        setAttachmentStatus(\"الملف النصي أكبر من 150 كيلوبايت.\", true);\n        return;\n      }\n      try {\n        const text = await file.text();\n        pendingAttachments.push({\n          kind: \"text\", name: file.name, type: file.type || \"text/plain\",\n          size: file.size, text\n        });\n        setAttachmentStatus(\"تم إرفاق الملف النصي وقراءته.\");\n      } catch (error) { setAttachmentStatus(\"تعذّرت قراءة الملف النصي.\", true); }\n    } else {\n      pendingAttachments.push({\n        kind: \"file\", name: file.name, type: file.type || \"application/octet-stream\",\n        size: file.size\n      });\n      setAttachmentStatus(\"تم إرفاق اسم الملف. قراءة محتوى PDF وWord وExcel غير مفعّلة بعد.\");\n    }\n  }\n  renderAttachmentPreview();\n}\n$(\"attachMenuBtn\").addEventListener(\"click\", () => {\n  if (!$(\"attachmentMenu\").hidden || !$(\"pluginTools\").hidden) closeAttachmentMenu();\n  else showAttachmentMenu();\n});\n$(\"attachmentMenu\").addEventListener(\"click\", event => {\n  const button = event.target.closest(\"[data-action]\");\n  if (!button) return;\n  const action = button.dataset.action;\n  if (action === \"camera\") { closeAttachmentMenu(); $(\"cameraInput\").click(); }\n  else if (action === \"photos\") { closeAttachmentMenu(); $(\"photosInput\").click(); }\n  else if (action === \"files\") { closeAttachmentMenu(); $(\"filesInput\").click(); }\n  else if (action === \"plugins\") {\n    $(\"attachmentMenu\").hidden = true;\n    $(\"pluginTools\").hidden = false;\n    button.setAttribute(\"aria-expanded\", \"true\");\n  } else if (action === \"deep\") {\n    deepThinkEnabled = !deepThinkEnabled;\n    updateDeepThinkUI();\n    closeAttachmentMenu();\n    setAttachmentStatus(deepThinkEnabled ? \"التفكير العميق مفعّل للرسالة التالية.\" : \"تم إيقاف التفكير العميق.\");\n  }\n});\n$(\"backToAttachmentMenu\").addEventListener(\"click\", () => {\n  $(\"pluginTools\").hidden = true;\n  $(\"attachmentMenu\").hidden = false;\n  document.querySelector('[data-action=\"plugins\"]')?.setAttribute(\"aria-expanded\", \"false\");\n});\n$(\"pluginTools\").addEventListener(\"click\", event => {\n  const button = event.target.closest(\"[data-plugin-prompt]\");\n  if (!button) return;\n  $(\"messageInput\").value = button.dataset.pluginPrompt;\n  closeAttachmentMenu();\n  $(\"messageInput\").focus();\n});\n$(\"disableDeepThink\").addEventListener(\"click\", () => {\n  deepThinkEnabled = false;\n  updateDeepThinkUI();\n  setAttachmentStatus(\"تم إيقاف التفكير العميق.\");\n});\ndocument.addEventListener(\"click\", event => {\n  if (!event.target.closest(\".chat-composer\")) closeAttachmentMenu();\n});\ndocument.addEventListener(\"keydown\", event => {\n  if (event.key === \"Escape\") closeAttachmentMenu();\n});\nfor (const inputId of [\"cameraInput\", \"photosInput\", \"filesInput\"]) {\n  $(inputId).addEventListener(\"change\", async event => {\n    const files = Array.from(event.target.files || []);\n    for (const file of files) await addSelectedFile(file);\n    event.target.value = \"\";\n    closeAttachmentMenu();\n  });\n}\nfunction clearPendingAttachments() {\n  pendingAttachments = [];\n  renderAttachmentPreview();\n  setAttachmentStatus(\"\");\n}\nfunction attachmentPayload() {\n  return pendingAttachments.map(item => {\n    if (item.kind === \"image\") return {\n      kind: item.kind, name: item.name, type: item.type, data: item.data\n    };\n    if (item.kind === \"text\") return {\n      kind: item.kind, name: item.name, type: item.type, text: item.text\n    };\n    return { kind: \"file\", name: item.name, type: item.type, size: item.size };\n  });\n}\n$(\"chatForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const message = $(\"messageInput\").value.trim();\n  if ((!message && !pendingAttachments.length) || !currentUser) return;\n  const selected = pendingAttachments.slice();\n  const text = message || (selected.some(item => item.kind === \"image\")\n    ? \"افحص الصورة المرفقة واشرح لي ما يظهر فيها.\"\n    : \"ساعدني في قراءة المرفقات المرسلة.\");\n  addMessage(text, \"user\", [], selected);\n  const payload = attachmentPayload();\n  const deepThink = deepThinkEnabled;\n  $(\"messageInput\").value = \"\";\n  clearPendingAttachments();\n  closeAttachmentMenu();\n  setBusy(true);\n  try {\n    const data = await api(\"/api/chat\", {\n      message: text, attachments: payload, deepThink\n    });\n    addMessage(data.reply, \"assistant\", data.steps || [], [], data.generatedImages || []);\n    speak(data.reply);\n  } catch (error) {\n    addMessage(\"معلش، مش قادرة أكمل دلوقتي. \" + error.message);\n  } finally {\n    setBusy(false);\n    $(\"messageInput\").focus();\n  }\n});\n$(\"clearBtn\").addEventListener(\"click\", () => {\n  $(\"messages\").replaceChildren();\n  addMessage(\"تم مسح عرض المحادثة من الشاشة. سجل الرسائل المحفوظ في الحساب لم يُحذف.\");\n});\nfunction speak(text) {\n  if (window.WensNative && typeof window.WensNative.speak === \"function\") {\n    window.WensNative.speak(String(text));\n    return;\n  }\n  if (!(\"speechSynthesis\" in window)) return;\n  const utterance = new SpeechSynthesisUtterance(text);\n  utterance.lang = appSettings.voiceLocale;\n  utterance.rate = Math.min(1.35, Math.max(0.65, Number(appSettings.voiceRate) || 0.96));\n  utterance.pitch = Math.min(1.5, Math.max(0.7, Number(appSettings.voicePitch) || 1.12));\n  const voices = speechSynthesis.getVoices();\n  utterance.voice = voices.find(v => v.lang.toLowerCase().startsWith(\"ar-eg\")) || voices.find(v => v.lang.toLowerCase().startsWith(\"ar\")) || null;\n  utterance.onstart = () => { document.querySelector(\".orb\")?.classList.add(\"talking\"); document.querySelector(\".face\")?.classList.add(\"talking\"); };\n  const stopAvatarSpeech = () => { document.querySelector(\".orb\")?.classList.remove(\"talking\"); document.querySelector(\".face\")?.classList.remove(\"talking\"); };\n  utterance.onend = stopAvatarSpeech;\n  utterance.onerror = stopAvatarSpeech;\n  speechSynthesis.cancel();\n  speechSynthesis.speak(utterance);\n}\n$(\"voiceBtn\").addEventListener(\"click\", () => {\n  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;\n  if (!SpeechRecognition) {\n    $(\"voiceStatus\").textContent = \"التعرّف على الكلام مش مدعوم في المتصفح ده؛ استخدم الكتابة.\";\n    return;\n  }\n  if (recognition) { recognition.stop(); return; }\n  recognition = new SpeechRecognition();\n  recognition.lang = appSettings.voiceLocale;\n  recognition.interimResults = false;\n  recognition.onstart = () => { $(\"voiceStatus\").textContent = \"سامعاك... اتكلم دلوقتي 🎙️\"; $(\"voiceBtn\").classList.add(\"listening\"); };\n  recognition.onresult = event => { $(\"messageInput\").value = event.results[0][0].transcript; $(\"chatForm\").requestSubmit(); };\n  recognition.onerror = event => { $(\"voiceStatus\").textContent = event.error === \"not-allowed\" ? \"اسمح باستخدام الميكروفون من إعدادات الجهاز.\" : \"ماقدرتش ألتقط الكلام؛ جرّب تاني.\"; };\n  recognition.onend = () => { recognition = null; $(\"voiceBtn\").classList.remove(\"listening\"); };\n  recognition.start();\n});\n\nasync function loadSystemStatus() {\n  try {\n    const response = await fetch(\"/api/health\", { cache: \"no-store\" });\n    const data = await response.json();\n    const f = data.features || {};\n    const labels = [\n      \"Cloudflare AI \" + (f.workersAI ? \"جاهز\" : \"غير مربوط\"),\n      \"قاعدة البيانات \" + (f.database ? \"جاهزة\" : \"غير مربوطة\")\n    ];\n    $(\"systemStatus\").textContent = labels.concat(f.browser ? \"متصفح المواقع جاهز\" : \"متصفح المواقع غير مربوط\").join(\" · \");\n    $(\"systemStatus\").classList.toggle(\"all-ready\", !!(f.workersAI && f.database));\n    return data;\n  } catch {\n    $(\"systemStatus\").textContent = \"تعذّر فحص حالة الخادم.\";\n    return null;\n  }\n}\nasync function loadServerSettings() {\n  try {\n    const data = await api(\"/api/settings\", undefined, \"GET\");\n    if (data.settings && typeof data.settings === \"object\") Object.assign(appSettings, data.settings);\n  } catch {}\n  applyLocalSettings();\n}\nasync function boot() {\n  applyLocalSettings();\n  await loadServerSettings();\n  updateAuthMode();\n  const health = await loadSystemStatus();\n  if (health && health.ok && health.features && !health.features.database) {\n    showApp({ id: \"guest\", name: \"زائر\" });\n    return;\n  }\n  try {\n    const data = await api(\"/api/auth/me\", undefined, \"GET\");\n    showApp(data.user);\n  } catch {\n    showAuth();\n  }\n}\nboot();\n", type: "text/javascript; charset=utf-8" }],
    ["/owner-panel", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة؛ وفي أول إعداد أو عند نسيانها، استخدم كلمة مرور حساب ونس الحالية للتحقق من ملكيتك.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"\" placeholder=\"البريد المرتبط بحساب المالك\" required>\n      <label for=\"adminPassword\">كلمة مرور المدير المستقلة</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"20\" maxlength=\"128\" placeholder=\"كلمة مرور المدير\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <button id=\"showAdminResetBtn\" class=\"text-btn auth-toggle\" type=\"button\" hidden>نسيت كلمة مرور المدير؟ إنشاء كلمة مرور جديدة</button>\n    <form id=\"adminSetupForm\" class=\"admin-login-form\" hidden>\n      <p class=\"muted\">لتهيئة أو استعادة كلمة مرور المدير، يجب أن تكون مسجلًا بحساب المالك في ونس. أدخل كلمة مرور حساب ونس الحالية هنا.</p>\n      <label for=\"ownerPassword\">كلمة مرور حساب ونس الحالية</label>\n      <input id=\"ownerPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" required>\n      <button id=\"adminSetupBtn\" class=\"btn primary\" type=\"submit\">إنشاء كلمة مرور المدير المستقلة</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <div id=\"adminNewPasswordNotice\" class=\"notice\" hidden><b>كلمة مرور المدير الجديدة</b><p>انسخها واحفظها الآن؛ لن تظهر مرة أخرى.</p><code id=\"adminNewPasswordText\" dir=\"ltr\" style=\"display:block;overflow-wrap:anywhere;padding:10px 0\"></code><button id=\"copyAdminPasswordBtn\" class=\"btn secondary\" type=\"button\">نسخ كلمة المرور</button><p id=\"copyAdminPasswordStatus\" class=\"muted\"></p></div>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n          <div class=\"field\">\n            <label for=\"avatarUpload\">الصورة الشخصية لونس</label>\n            <img id=\"avatarPreview\" src=\"/avatar.jpg?v=real-jpg-20261105\" alt=\"معاينة صورة ونس\" width=\"132\" height=\"132\" style=\"display:block;width:132px;height:132px;object-fit:cover;border-radius:50%;border:3px solid #c9b4ff;margin:10px auto 14px\">\n            <input id=\"avatarUpload\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\">\n            <p class=\"muted\">اختَر صورة من الهاتف. سيُعاد تحجيمها وضغطها قبل حفظها في إعدادات التطبيق.</p>\n            <div class=\"actions left-actions\">\n              <button id=\"uploadAvatarBtn\" class=\"btn primary\" type=\"button\" disabled>حفظ صورة ونس</button>\n              <button id=\"resetAvatarBtn\" class=\"btn secondary\" type=\"button\">استعادة الصورة الافتراضية</button>\n            </div>\n            <p id=\"avatarStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n          </div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/owner-panel/", { body: "<!doctype html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#111124\">\n<meta name=\"robots\" content=\"noindex,nofollow\">\n<link rel=\"stylesheet\" href=\"style.css\">\n<link rel=\"stylesheet\" href=\"/owner-panel.css\">\n<title>مركز إدارة ونس AI</title>\n</head>\n<body>\n<header class=\"topbar\">\n  <a class=\"brand\" href=\"/\"><span class=\"logo\">و</span><span><b>ونس AI</b><small>مركز الإدارة المحمي</small></span></a>\n  <div class=\"top-actions\"><a class=\"admin-shortcut\" href=\"index.html\">العودة للتطبيق</a></div>\n</header>\n<main class=\"admin-wrap\">\n  <section id=\"adminGate\" class=\"panel admin-gate\">\n    <div class=\"auth-mark\">و</div>\n    <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n    <h1>دخول المدير</h1>\n    <p class=\"muted\">لوحة التحكم خاصة بمالك التطبيق. سجّل الدخول بكلمة مرور المدير المستقلة؛ وفي أول إعداد أو عند نسيانها، استخدم كلمة مرور حساب ونس الحالية للتحقق من ملكيتك.</p>\n    <form id=\"adminLoginForm\" class=\"admin-login-form\">\n      <label for=\"adminEmail\">البريد الإلكتروني</label>\n      <input id=\"adminEmail\" type=\"email\" autocomplete=\"username\" maxlength=\"190\" value=\"\" placeholder=\"البريد المرتبط بحساب المالك\" required>\n      <label for=\"adminPassword\">كلمة مرور المدير المستقلة</label>\n      <input id=\"adminPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"20\" maxlength=\"128\" placeholder=\"كلمة مرور المدير\" required>\n      <button id=\"adminLoginBtn\" class=\"btn primary\" type=\"submit\">فتح لوحة التحكم</button>\n    </form>\n    <button id=\"showAdminResetBtn\" class=\"text-btn auth-toggle\" type=\"button\" hidden>نسيت كلمة مرور المدير؟ إنشاء كلمة مرور جديدة</button>\n    <form id=\"adminSetupForm\" class=\"admin-login-form\" hidden>\n      <p class=\"muted\">لتهيئة أو استعادة كلمة مرور المدير، يجب أن تكون مسجلًا بحساب المالك في ونس. أدخل كلمة مرور حساب ونس الحالية هنا.</p>\n      <label for=\"ownerPassword\">كلمة مرور حساب ونس الحالية</label>\n      <input id=\"ownerPassword\" type=\"password\" autocomplete=\"current-password\" minlength=\"8\" maxlength=\"128\" required>\n      <button id=\"adminSetupBtn\" class=\"btn primary\" type=\"submit\">إنشاء كلمة مرور المدير المستقلة</button>\n    </form>\n    <p id=\"adminGateStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n    <p class=\"disclaimer\">الدخول بحساب المالك الموجود في قاعدة البيانات. كلمة المرور لا تُحفظ في لوحة الإدارة.</p>\n  </section>\n\n  <div id=\"adminApp\" hidden>\n    <div id=\"adminNewPasswordNotice\" class=\"notice\" hidden><b>كلمة مرور المدير الجديدة</b><p>انسخها واحفظها الآن؛ لن تظهر مرة أخرى.</p><code id=\"adminNewPasswordText\" dir=\"ltr\" style=\"display:block;overflow-wrap:anywhere;padding:10px 0\"></code><button id=\"copyAdminPasswordBtn\" class=\"btn secondary\" type=\"button\">نسخ كلمة المرور</button><p id=\"copyAdminPasswordStatus\" class=\"muted\"></p></div>\n    <section class=\"admin-heading\">\n      <p class=\"eyebrow\">PRIVATE CONTROL CENTER</p>\n      <h1>لوحة إدارة ونس AI</h1>\n      <p>متابعة الخدمات وتخصيص تجربة التطبيق من مكان واحد.</p>\n      <div class=\"admin-heading-actions\">\n        <button id=\"refreshStatusBtn\" class=\"btn secondary\">تحديث حالة الخدمات</button>\n        <button id=\"adminLogoutBtn\" class=\"btn danger\">تسجيل خروج المدير</button>\n      </div>\n    </section>\n    <section class=\"service-panel\">\n      <div class=\"section-head\"><div><h2>حالة الخادم والخدمات</h2><p id=\"checkedAt\">لم يتم الفحص بعد</p></div></div>\n      <div class=\"service-grid\">\n        <article class=\"service-card\"><span class=\"service-icon\">✧</span><b>الذكاء الاصطناعي</b><strong id=\"workersAiState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"modelName\">النموذج: —</small></article>\n        <article class=\"service-card\"><span class=\"service-icon\">▤</span><b>قاعدة البيانات</b><strong id=\"databaseState\" class=\"state-pending\">جارٍ الفحص</strong><small id=\"databaseDetail\">اتصال D1</small></article>\n      </div>\n      <div class=\"service-actions\">\n        <button id=\"testWorkersAiBtn\" class=\"btn primary\">اختبار Cloudflare AI الآن</button>\n        <p id=\"serviceStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n      </div>\n      <p class=\"disclaimer\">تعرض اللوحة حالة الإعداد فقط ولا تكشف مفاتيح API أو أسرار الخادم. اختبار النموذج يستهلك جزءًا صغيرًا من الحصة المجانية اليومية لـ Workers AI. بعد نفاد الحصة تتوقف الطلبات حتى موعد التجديد اليومي.</p>\n    </section>\n\n    <div class=\"admin-grid\">\n      <nav class=\"admin-nav\" aria-label=\"أقسام لوحة الإدارة\">\n        <button class=\"nav-btn active\" data-tab=\"overview\">▦ نظرة عامة</button>\n        <button class=\"nav-btn\" data-tab=\"identity\">◈ هوية التطبيق</button>\n        <button class=\"nav-btn\" data-tab=\"assistant\">✧ الصوت والمساعدة</button>\n        <button class=\"nav-btn\" data-tab=\"features\">⚙ الميزات</button>\n        <button class=\"nav-btn\" data-tab=\"content\">☷ رسائل البداية</button>\n        <button class=\"nav-btn\" data-tab=\"backup\">⇩ النسخ والاسترجاع</button>\n      </nav>\n      <div class=\"admin-content\">\n        <section class=\"tab-page active\" id=\"tab-overview\">\n          <h2>نظرة عامة</h2>\n          <p class=\"muted\">تظهر إعدادات الخادم الحقيقية في بطاقات الحالة أعلى الصفحة. كل التعديلات تُحفظ مركزيًا على الخادم وتظهر لكل مستخدمي التطبيق.</p>\n          <div class=\"notice\">إعدادات التطبيق تُحفظ في قاعدة بيانات D1. دخول الإدارة مخصص لحساب مالك التطبيق فقط.</div>\n          <div class=\"stat-grid\"><div class=\"stat\"><b>محمية</b><span>حساب المالك فقط</span></div><div class=\"stat\"><b>D1</b><span>حفظ مركزي</span></div><div class=\"stat\"><b>عام</b><span>تطبيق موحد</span></div></div>\n          <a class=\"btn secondary link-btn\" href=\"index.html\">فتح التطبيق</a>\n        </section>\n        <section class=\"tab-page\" id=\"tab-identity\">\n          <h2>هوية التطبيق</h2>\n          <div class=\"field\"><label for=\"appName\">اسم التطبيق</label><input id=\"appName\" maxlength=\"45\" value=\"ونس AI\"></div>\n          <div class=\"field\"><label for=\"assistantName\">اسم الشخصية</label><input id=\"assistantName\" maxlength=\"35\" value=\"ونس\"></div>\n          <div class=\"field\"><label for=\"theme\">لون التصميم</label><select id=\"theme\"><option value=\"purple\">بنفسجي ووردي</option><option value=\"blue\">أزرق وسماوي</option><option value=\"green\">أخضر هادئ</option><option value=\"rose\">وردي دافئ</option></select></div>\n          <div class=\"field\">\n            <label for=\"avatarUpload\">الصورة الشخصية لونس</label>\n            <img id=\"avatarPreview\" src=\"/avatar.jpg?v=real-jpg-20261105\" alt=\"معاينة صورة ونس\" width=\"132\" height=\"132\" style=\"display:block;width:132px;height:132px;object-fit:cover;border-radius:50%;border:3px solid #c9b4ff;margin:10px auto 14px\">\n            <input id=\"avatarUpload\" type=\"file\" accept=\"image/jpeg,image/png,image/webp\">\n            <p class=\"muted\">اختَر صورة من الهاتف. سيُعاد تحجيمها وضغطها قبل حفظها في إعدادات التطبيق.</p>\n            <div class=\"actions left-actions\">\n              <button id=\"uploadAvatarBtn\" class=\"btn primary\" type=\"button\" disabled>حفظ صورة ونس</button>\n              <button id=\"resetAvatarBtn\" class=\"btn secondary\" type=\"button\">استعادة الصورة الافتراضية</button>\n            </div>\n            <p id=\"avatarStatus\" class=\"status-line\" role=\"status\" aria-live=\"polite\"></p>\n          </div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-assistant\">\n          <h2>الصوت والمساعدة</h2>\n          <div class=\"field\"><label for=\"voiceLocale\">لغة الصوت والتعرّف</label><select id=\"voiceLocale\"><option value=\"ar-EG\">العربية - مصر</option><option value=\"ar-SA\">العربية - السعودية</option><option value=\"en-US\">English - US</option></select></div>\n          <div class=\"field\"><label for=\"voiceRate\">سرعة الصوت: <output id=\"rateOut\">0.96</output></label><input id=\"voiceRate\" type=\"range\" min=\"0.65\" max=\"1.35\" step=\"0.05\" value=\"0.96\"></div>\n          <div class=\"field\"><label for=\"voicePitch\">حدة الصوت: <output id=\"pitchOut\">1.12</output></label><input id=\"voicePitch\" type=\"range\" min=\"0.7\" max=\"1.5\" step=\"0.05\" value=\"1.12\"></div>\n          <p class=\"muted\">الصوت المتاح يعتمد على الأصوات المثبتة في الجهاز. هذه الإعدادات تضبط صوت النظام ولا تنشئ صوتًا بشريًا جديدًا.</p>\n        </section>\n        <section class=\"tab-page\" id=\"tab-features\">\n          <h2>الميزات</h2>\n          <label class=\"toggle-row\"><span><b>المحادثة الصوتية</b><small>إظهار زر الميكروفون</small></span><input id=\"enableVoice\" type=\"checkbox\" checked></label>\n          <div class=\"notice\">المحادثة الصوتية تستخدم ميكروفون الجهاز عند الضغط على زر الصوت فقط.</div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-content\">\n          <h2>رسائل البداية</h2>\n          <div class=\"field\"><label for=\"eyebrow\">عبارة قصيرة أعلى الشاشة</label><input id=\"eyebrow\" maxlength=\"80\"></div>\n          <div class=\"field\"><label for=\"welcomeTitle\">عنوان الترحيب</label><input id=\"welcomeTitle\" maxlength=\"100\"></div>\n          <div class=\"field\"><label for=\"welcomeText\">الوصف الرئيسي</label><textarea id=\"welcomeText\" rows=\"3\" maxlength=\"240\"></textarea></div>\n          <div class=\"field\"><label for=\"greeting\">رسالة أول محادثة</label><textarea id=\"greeting\" rows=\"3\" maxlength=\"350\"></textarea></div>\n          <div class=\"field\"><label for=\"voiceButton\">نص زر الصوت</label><input id=\"voiceButton\" maxlength=\"45\"></div>\n        </section>\n        <section class=\"tab-page\" id=\"tab-backup\">\n          <h2>النسخ والاسترجاع</h2>\n          <p class=\"muted\">احفظ نسخة JSON من تخصيص الواجهة أو استرجع نسخة سابقة.</p>\n          <div class=\"actions left-actions\"><button id=\"exportBtn\" class=\"btn primary\">تنزيل نسخة إعدادات</button><label class=\"btn secondary file-label\">استرجاع ملف<input id=\"importFile\" type=\"file\" accept=\"application/json,.json\" hidden></label><button id=\"resetBtn\" class=\"btn secondary\">إرجاع الافتراضي</button></div>\n          <p id=\"backupStatus\" class=\"status-line\"></p>\n        </section>\n        <div class=\"save-bar\"><span id=\"saveStatus\" class=\"muted\">التعديلات غير محفوظة حتى تضغط حفظ.</span><button id=\"saveBtn\" class=\"btn primary\">حفظ التعديلات</button></div>\n      </div>\n    </div>\n  </div>\n</main>\n<script src=\"/owner-panel.js\"></script>\n</body>\n</html>", type: "text/html; charset=utf-8" }],
    ["/owner-panel.js", { body: "const $ = id => document.getElementById(id);\nconst defaults = {\n  appName: \"ونس AI\", assistantName: \"ونس\", eyebrow: \"موجودة علشانك\",\n  welcomeTitle: \"أهلًا بيك، أنا ونس 💜\",\n  welcomeText: \"اتكلم معايا واسألني اللي في بالك.\",\n  greeting: \"أهلًا بيك! أنا ونس 💜 اسألني أو احكيلي اللي في بالك.\",\n  voiceButton: \"اتكلم معايا\",\n  voiceRate: 0.96, voicePitch: 1.12, theme: \"purple\",\n  enableVoice: true, voiceLocale: \"ar-EG\", avatarDataUrl: \"\"\n};\nconst keys = Object.keys(defaults);\nlet config = { ...defaults };\nasync function request(path, body, method = \"GET\") {\n  const response = await fetch(path, {\n    method, credentials: \"same-origin\", cache: \"no-store\",\n    headers: body === undefined ? {} : { \"Content-Type\": \"application/json\" },\n    body: body === undefined ? undefined : JSON.stringify(body)\n  });\n  let data = {};\n  try { data = await response.json(); } catch {}\n  if (!response.ok) throw new Error(data.error || \"تعذّر تنفيذ الطلب.\");\n  return data;\n}\nfunction gateMessage(message, error = false) {\n  $(\"adminGateStatus\").textContent = message || \"\";\n  $(\"adminGateStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction serviceMessage(message, error = false) {\n  $(\"serviceStatus\").textContent = message || \"\";\n  $(\"serviceStatus\").style.color = error ? \"#ff9fba\" : \"#9be7c1\";\n}\nfunction normalize(data) {\n  const next = { ...defaults };\n  if (!data || typeof data !== \"object\" || Array.isArray(data)) return next;\n  for (const key of keys) {\n    if (!(key in data)) continue;\n    const value = data[key];\n    if (typeof defaults[key] === \"boolean\") next[key] = value === true;\n    else if (typeof defaults[key] === \"number\") {\n      const max = key === \"voiceRate\" ? 1.35 : 1.5;\n      const min = key === \"voiceRate\" ? 0.65 : 0.7;\n      next[key] = Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : defaults[key];\n    } else if (typeof value === \"string\") {\n      next[key] = value.slice(0, key === \"avatarDataUrl\" ? 700000 : key === \"welcomeText\" ? 240 : key === \"greeting\" ? 350 : 120);\n    }\n  }\n  if (![\"purple\", \"blue\", \"green\", \"rose\"].includes(next.theme)) next.theme = defaults.theme;\n  if (![\"ar-EG\", \"ar-SA\", \"en-US\"].includes(next.voiceLocale)) next.voiceLocale = defaults.voiceLocale;\n  return next;\n}\nfunction fillSettingsForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (!element) continue;\n    if (element.type === \"checkbox\") element.checked = !!config[key];\n    else element.value = config[key];\n  }\n  updateRanges();\n}\nasync function loadSettings() {\n  const data = await request(\"/api/admin/settings\");\n  config = normalize(data.settings);\n  fillSettingsForm();\n  const preview = $(\"avatarPreview\");\n  if (preview) preview.src = config.avatarDataUrl || \"/avatar.jpg?v=real-jpg-20261105\";\n}\nfunction readForm() {\n  for (const key of keys) {\n    const element = $(key);\n    if (element) config[key] = element.type === \"checkbox\" ? element.checked :\n      element.type === \"range\" ? Number(element.value) : element.value;\n  }\n}\nfunction updateRanges() {\n  $(\"rateOut\").value = Number($(\"voiceRate\").value).toFixed(2);\n  $(\"pitchOut\").value = Number($(\"voicePitch\").value).toFixed(2);\n}\nfunction setState(id, label, ready) {\n  const element = $(id);\n  element.textContent = label;\n  element.className = ready ? \"state-ready\" : \"state-off\";\n}\nasync function refreshStatus() {\n  $(\"refreshStatusBtn\").disabled = true;\n  try {\n    const data = await request(\"/api/admin/status\");\n    const f = data.features || {};\n    setState(\"workersAiState\", f.workersAI ? \"متصل ويعمل\" : \"غير مربوط\", !!f.workersAI);\n    setState(\"databaseState\", !f.databaseConfigured ? \"غير مربوطة\" : !f.databaseConnected ? \"فشل الاتصال\" : f.databaseSchemaReady ? \"جاهزة\" : \"تحتاج مراجعة\", !!(f.databaseConfigured && f.databaseConnected && f.databaseSchemaReady));\n    $(\"modelName\").textContent = \"النموذج: \" + (data.model || \"غير محدد\");\n    $(\"databaseDetail\").textContent = !f.databaseConfigured ? \"لم يتم ربط D1 بعد\" : !f.databaseConnected ? \"تعذّر الاتصال بقاعدة البيانات\" : f.settingsStorageReady ? \"الجداول وحفظ الإعدادات جاهزة\" : \"تخزين الإعدادات يحتاج مراجعة\";\n    $(\"checkedAt\").textContent = \"آخر فحص: \" + new Date(data.checkedAt).toLocaleString(\"ar-EG\");\n    serviceMessage(\"تم فحص الخادم وقاعدة البيانات. لا يتم عرض كلمات مرور أو مفاتيح سرية.\");\n  } catch (error) {\n    serviceMessage(error.message, true);\n    if (/سجّل الدخول/.test(error.message)) {\n      $(\"adminApp\").hidden = true;\n      $(\"adminGate\").hidden = false;\n      gateMessage(\"انتهت الجلسة أو الحساب غير مصرح. سجّل الدخول بحساب المالك.\", true);\n    }\n  } finally { $(\"refreshStatusBtn\").disabled = false; }\n}\nasync function showDashboard() {\n  $(\"adminGate\").hidden = true;\n  $(\"adminApp\").hidden = false;\n  try { await loadSettings(); await refreshStatus(); }\n  catch (error) { serviceMessage(error.message, true); }\n}\n$(\"adminLoginForm\").addEventListener(\"submit\", async event => {\n  event.preventDefault();\n  const email = $(\"adminEmail\").value.trim(), password = $(\"adminPassword\").value;\n  $(\"adminLoginBtn\").disabled = true;\n  gateMessage(\"جاري التحقق من حساب المالك...\");\n  try {\n    await request(\"/api/admin/login\", { email, password }, \"POST\");\n    $(\"adminPassword\").value = \"\";\n    await showDashboard();\n  } catch (error) { gateMessage(error.message, true); }\n  finally { $(\"adminLoginBtn\").disabled = false; }\n});\n$(\"adminLogoutBtn\").addEventListener(\"click\", async () => {\n  try { await request(\"/api/admin/logout\", {}, \"POST\"); } catch {}\n  $(\"adminApp\").hidden = true;\n  $(\"adminGate\").hidden = false;\n  $(\"adminPassword\").value = \"\";\n  gateMessage(\"تم تسجيل خروج المدير.\");\n});\n$(\"refreshStatusBtn\").addEventListener(\"click\", refreshStatus);\n$(\"testWorkersAiBtn\").addEventListener(\"click\", async () => {\n  $(\"testWorkersAiBtn\").disabled = true;\n  serviceMessage(\"جاري اختبار Cloudflare Workers AI...\");\n  try {\n    const result = await request(\"/api/admin/test-ai\", {}, \"POST\");\n    serviceMessage(\"اختبار ناجح ✓ رد الخدمة: \" + result.reply);\n    setState(\"workersAiState\", \"يعمل بنجاح\", true);\n  } catch (error) {\n    serviceMessage(error.message, true);\n    setState(\"workersAiState\", \"فشل الاختبار\", false);\n  } finally { $(\"testWorkersAiBtn\").disabled = false; }\n});\ndocument.querySelectorAll(\".nav-btn\").forEach(button => button.addEventListener(\"click\", () => {\n  document.querySelectorAll(\".nav-btn\").forEach(item => item.classList.toggle(\"active\", item === button));\n  document.querySelectorAll(\".tab-page\").forEach(page => page.classList.toggle(\"active\", page.id === \"tab-\" + button.dataset.tab));\n}));\n[\"voiceRate\", \"voicePitch\"].forEach(id => $(id).addEventListener(\"input\", updateRanges));\n$(\"saveBtn\").addEventListener(\"click\", async () => {\n  readForm();\n  $(\"saveBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: config }, \"PUT\");\n    config = normalize(result.settings);\n    fillSettingsForm();\n    $(\"saveStatus\").textContent = \"تم حفظ التعديلات على الخادم لكل المستخدمين ✓\";\n    $(\"saveStatus\").style.color = \"#9be7c1\";\n  } catch (error) {\n    $(\"saveStatus\").textContent = error.message;\n    $(\"saveStatus\").style.color = \"#ff9fba\";\n  } finally { $(\"saveBtn\").disabled = false; }\n});\n$(\"exportBtn\").addEventListener(\"click\", () => {\n  readForm();\n  const blob = new Blob([JSON.stringify(config, null, 2)], { type: \"application/json\" });\n  const url = URL.createObjectURL(blob), link = document.createElement(\"a\");\n  link.href = url; link.download = \"wens-ai-settings.json\"; link.click();\n  URL.revokeObjectURL(url);\n  $(\"backupStatus\").textContent = \"تم تجهيز نسخة من إعدادات الخادم الحالية.\";\n});\n$(\"importFile\").addEventListener(\"change\", async event => {\n  const file = event.target.files[0];\n  if (!file) return;\n  try {\n    const imported = normalize(JSON.parse(await file.text()));\n    const result = await request(\"/api/admin/settings\", { settings: imported }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تم استرجاع الإعدادات وحفظها على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message || \"الملف غير صالح؛ اختَر ملف JSON صحيح.\"; }\n  event.target.value = \"\";\n});\n$(\"resetBtn\").addEventListener(\"click\", async () => {\n  if (!confirm(\"ترجع كل إعدادات التطبيق للقيم الافتراضية لكل المستخدمين؟\")) return;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: defaults }, \"PUT\");\n    config = normalize(result.settings); fillSettingsForm();\n    $(\"backupStatus\").textContent = \"تمت استعادة الإعدادات الافتراضية على الخادم.\";\n  } catch (error) { $(\"backupStatus\").textContent = error.message; }\n});\n\nfunction compressAvatarFile(file) {\n  return new Promise((resolve, reject) => {\n    const allowed = [\"image/jpeg\", \"image/png\", \"image/webp\"];\n    if (!file || !allowed.includes(file.type)) {\n      reject(new Error(\"اختَر صورة بصيغة JPG أو PNG أو WebP.\"));\n      return;\n    }\n    const objectUrl = URL.createObjectURL(file);\n    const image = new Image();\n    image.onload = () => {\n      try {\n        const maxSide = 512;\n        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));\n        const canvas = document.createElement(\"canvas\");\n        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));\n        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));\n        const context = canvas.getContext(\"2d\", { alpha: false });\n        if (!context) throw new Error(\"تعذّر تجهيز الصورة.\");\n        context.fillStyle = \"#ffffff\";\n        context.fillRect(0, 0, canvas.width, canvas.height);\n        context.drawImage(image, 0, 0, canvas.width, canvas.height);\n        canvas.toBlob(blob => {\n          URL.revokeObjectURL(objectUrl);\n          if (!blob) { reject(new Error(\"تعذّر ضغط الصورة.\")); return; }\n          const reader = new FileReader();\n          reader.onload = () => resolve(String(reader.result || \"\"));\n          reader.onerror = () => reject(new Error(\"تعذّرت قراءة الصورة.\"));\n          reader.readAsDataURL(blob);\n        }, \"image/jpeg\", 0.84);\n      } catch (error) {\n        URL.revokeObjectURL(objectUrl);\n        reject(error);\n      }\n    };\n    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error(\"ملف الصورة غير صالح.\")); };\n    image.src = objectUrl;\n  });\n}\n$(\"avatarUpload\").addEventListener(\"change\", () => {\n  $(\"uploadAvatarBtn\").disabled = !$(\"avatarUpload\").files || !$(\"avatarUpload\").files[0];\n  $(\"avatarStatus\").textContent = $(\"avatarUpload\").files && $(\"avatarUpload\").files[0]\n    ? \"الصورة جاهزة. اضغط حفظ صورة ونس لإرسالها.\"\n    : \"\";\n});\n$(\"uploadAvatarBtn\").addEventListener(\"click\", async () => {\n  const file = $(\"avatarUpload\").files && $(\"avatarUpload\").files[0];\n  if (!file) return;\n  $(\"uploadAvatarBtn\").disabled = true;\n  $(\"avatarStatus\").textContent = \"جاري ضغط الصورة وحفظها على الخادم...\";\n  try {\n    const avatarDataUrl = await compressAvatarFile(file);\n    if (avatarDataUrl.length > 700000) throw new Error(\"الصورة كبيرة بعد الضغط. اختَر صورة أصغر.\");\n    const result = await request(\"/api/admin/settings\", { settings: { ...config, avatarDataUrl } }, \"PUT\");\n    config = normalize(result.settings);\n    $(\"avatarPreview\").src = config.avatarDataUrl;\n    $(\"avatarStatus\").textContent = \"تم حفظ صورة ونس على الخادم. ستظهر للمستخدمين بعد تحديث التطبيق.\";\n    $(\"avatarUpload\").value = \"\";\n  } catch (error) {\n    $(\"avatarStatus\").textContent = error.message || \"تعذّر حفظ الصورة.\";\n  } finally {\n    $(\"uploadAvatarBtn\").disabled = false;\n  }\n});\n$(\"resetAvatarBtn\").addEventListener(\"click\", async () => {\n  $(\"resetAvatarBtn\").disabled = true;\n  try {\n    const result = await request(\"/api/admin/settings\", { settings: { ...config, avatarDataUrl: \"\" } }, \"PUT\");\n    config = normalize(result.settings);\n    $(\"avatarPreview\").src = \"/avatar.jpg?v=real-jpg-20261105\";\n    $(\"avatarUpload\").value = \"\";\n    $(\"uploadAvatarBtn\").disabled = true;\n    $(\"avatarStatus\").textContent = \"تمت استعادة الصورة الافتراضية.\";\n  } catch (error) {\n    $(\"avatarStatus\").textContent = error.message;\n  } finally {\n    $(\"resetAvatarBtn\").disabled = false;\n  }\n});\n\n(async function bootAdmin() {\n  try {\n    const session = await request(\"/api/admin/session\");\n    if (session.authenticated) await showDashboard();\n    else gateMessage(\"أدخل البريد وكلمة مرور حساب مالك التطبيق.\");\n  } catch (error) {\n    gateMessage(error.message === \"تعذّر تنفيذ الطلب.\"\n      ? \"تعذّر الوصول إلى خدمة الإدارة. تأكد من اتصال الإنترنت.\"\n      : error.message, true);\n  }\n})();", type: "text/javascript; charset=utf-8" }],
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
  theme: "purple", enableVoice: true, voiceLocale: "ar-EG", avatarDataUrl: "", voiceEngine: "device", voiceName: "coral"
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
  if (["device", "cloud"].includes(input.voiceEngine)) next.voiceEngine = input.voiceEngine;
  if (["coral", "shimmer", "nova", "marin", "sage"].includes(input.voiceName)) next.voiceName = input.voiceName;
  if (typeof input.avatarDataUrl === "string") {
    const avatar = input.avatarDataUrl.trim();
    if (!avatar) next.avatarDataUrl = "";
    else if (avatar.length <= 700000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) next.avatarDataUrl = avatar;
  }
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
    const accountUser = env.DB ? await currentUser(request, env) : null;
    const credential = env.DB
      ? await env.DB.prepare("SELECT email FROM admin_credentials WHERE email=? LIMIT 1").bind(ADMIN_EMAIL).first()
      : null;
    const owner = Boolean(accountUser && String(accountUser.email || "").trim().toLowerCase() === ADMIN_EMAIL);
    return json({ configured: Boolean(credential), authenticated: Boolean(user), owner });
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
      model: env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash",
      features: {
        workersAI: Boolean(env.AI), databaseConfigured: Boolean(env.DB),
        databaseConnected, databaseSchemaReady, settingsStorageReady
      }
    });
  }
  if (path === "/api/admin/test-ai" && request.method === "POST") {
    if (!env.AI) return json({ error: "ربط Cloudflare Workers AI غير موجود على هذا الخادم." }, 503);
    try {
      const model = env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash";
      const result = await env.AI.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "اكتبي كلمة واحدة فقط: جاهزة" }
        ], temperature: 0, max_tokens: 12
      });
      const assistantMessage = result?.choices?.[0]?.message || result?.result?.choices?.[0]?.message || result;
      const reply = typeof assistantMessage?.content === "string"
        ? assistantMessage.content.trim()
        : typeof result?.response === "string" ? result.response.trim() : "";
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

  // Reuse a session while Browser Run still reports it alive. A user may need
  // time to sign in manually through Live View before returning to the chat.
  const live = saved
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
        const dangerous = /(delete|remove|purchase|buy|cart|checkout|payment|pay|transfer|submit|send|publish|unsubscribe|cancel|logout|log out|sign out|save|confirm|approve|place order|حذف|إزالة|شراء|سلة|الدفع|ادفع|دفع|تحويل|إرسال|نشر|إلغاء|تسجيل خروج|حفظ|تأكيد|اعتماد|تنفيذ الطلب)/i;
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const elements = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')].filter(visible);
        const textOf = el => (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().replace(/\\s+/g," ");
        const el = elements.find(item => textOf(item).toLowerCase() === needle) ||
          elements.find(item => textOf(item).toLowerCase().includes(needle));
        if (!el) return { ok:false, error:"لم أجد زرًا أو رابطًا بهذا الاسم في الصفحة." };
        const text = textOf(el).slice(0,100);
        const isAnchor = el.tagName === "A";
        const isTab = el.getAttribute("role") === "tab";
        const isSafeSearch = /(search|بحث|filter|فلتر|lookup)/i.test(text);
        const href = isAnchor ? String(el.href || "") : "";
        const riskyUrl = /\\/(?:logout|signout|delete|remove|unsubscribe|checkout|payment|purchase|order|transfer|publish)(?:[/?#.-]|$)/i.test(href);
        if (dangerous.test(text) || riskyUrl || (isAnchor && !href.startsWith("https://")) ||
            (!isAnchor && !isTab && !isSafeSearch)) {
          return { ok:false, blocked:true, label:text, error:"لم أضغط هذا العنصر لأنه ليس تنقلًا آمنًا مؤكدًا أو قد يحفظ أو يرسل أو يحذف أو يغيّر شيئًا خارجيًا." };
        }
        el.click();
        return { ok:true, clicked:text, href };
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
        const view = await env.BROWSER.getLiveView(sessionId, { targetId, mode: "tab", expiresInMs: 600000 });
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
function imageDimensions(value) {
  const presets = { square: [1024,1024], landscape: [1024,768], portrait: [768,1024], wide: [1280,720], tall: [720,1280] };
  return presets[String(value || "square").toLowerCase()] || presets.square;
}
function imageMimeFromBase64(value) {
  const head = String(value || "").slice(0,24);
  if (head.startsWith("iVBOR")) return "image/png";
  if (head.startsWith("UklGR")) return "image/webp";
  if (head.startsWith("R0lGOD")) return "image/gif";
  return "image/jpeg";
}
async function runAgentImage(env, action, args, sourceImage) {
  const prompt = String(args?.prompt || "").trim().slice(0,1800);
  if (prompt.length < 5) return { error: "اكتبي وصفًا أوضح للصورة المطلوبة." };
  const [width,height] = imageDimensions(args?.size);
  const model = "@cf/black-forest-labs/flux-2-klein-4b";
  try {
    if (action === "edit_image" && !sourceImage?.data) {
      return { error: "لتعديل صورة، أرفقي الصورة الأصلية مع الرسالة ثم اطلبي التعديل." };
    }
    const form = new FormData();
    form.append("prompt",prompt);
    form.append("width",String(width));
    form.append("height",String(height));
    if (action === "edit_image") {
      const bytes = Uint8Array.from(atob(sourceImage.data), c => c.charCodeAt(0));
      form.append("input_image_0",new Blob([bytes],{type:sourceImage.type || "image/jpeg"}),"wens-reference.jpg");
    }
    const serialized = new Response(form);
    const result = await env.AI.run(model,{
      multipart:{body:serialized.body,contentType:serialized.headers.get("content-type")}
    });
    const image = typeof result?.image === "string" ? result.image : (typeof result?.result?.image === "string" ? result.result.image : "");
    if (!image || image.length < 1000) {
      const resultInfo = "response fields=" + Object.keys(result || {}).join(",") + "; image type=" + typeof result?.image + "; image length=" + (typeof result?.image === "string" ? result.image.length : 0);
      return {error:"خدمة الصور لم تُرجع ملف صورة صالحًا. جرّبي وصفًا آخر.",diagnostic:resultInfo};
    }
    return {imageDataUrl:"data:"+imageMimeFromBase64(image)+";base64,"+image,prompt,width,height,model};
  } catch(error) {
    const detail=String(error?.message || error || "").slice(0,180);
    console.error("[WENS_IMAGE_FAILURE]",detail);
    return {error:/quota|allocation|neurons|billing|payment/i.test(detail)
      ? "خدمة الصور وصلت إلى حد الاستخدام المتاح حاليًا."
      : "تعذّر إنشاء الصورة أو تعديلها الآن. تأكدي من نوع الصورة وحجمها ثم حاولي مرة أخرى.",diagnostic:detail};
  }
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
    fn("generate_image", "Generate an original image from the user's description. Use when the user asks to create, draw, design, or generate a new picture. Return one image in chat.", {
      prompt: { type: "string", description: "Detailed visual description of the requested image." },
      size: { type: "string", description: "Image shape: square, landscape, portrait, wide, or tall." }
    }, ["prompt"]),
    fn("edit_image", "Edit the image attached to the current message according to the user's instructions. Only use when an image is attached. Preserve details the user did not ask to change.", {
      prompt: { type: "string", description: "Exact visual edits to apply to the attached image." },
      size: { type: "string", description: "Image shape: square, landscape, portrait, wide, or tall." }
    }, ["prompt"]),
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
async function extractDocumentAttachments(env, documents, userRequest) {
  if (!env.OPENAI_API_KEY) {
    return { error: "قراءة ملفات PDF وWord وExcel تحتاج تفعيل مفتاح OpenAI على الخادم. لم يُرسل الملف إلى أي خدمة." };
  }
  const content = [];
  for (const file of documents) {
    content.push({
      type: "input_file",
      filename: file.name,
      file_data: "data:" + file.type + ";base64," + file.data,
      ...(file.type === "application/pdf" ? { detail: "low" } : {})
    });
  }
  content.push({
    type: "input_text",
    text: "اقرأ الملفات المرفقة بدقة واستخرج النص والمعلومات والجداول والأرقام والعناوين المهمة. حافظ على أسماء الأعمدة وترتيب الصفوف والقيم كما وردت، ولا تخمّن المحتوى غير الواضح. أعد نصًا منظمًا يستطيع مساعد آخر استخدامه للإجابة عن سؤال المستخدم. سؤال المستخدم: " + String(userRequest || "اقرأ الملفات واشرح محتواها.").slice(0, 4000)
  });
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.WENS_DOCUMENT_MODEL || "gpt-4.1-mini",
        store: false,
        max_output_tokens: 6000,
        input: [{ role: "user", content }]
      }),
      signal: AbortSignal.timeout(90000)
    });
  } catch (error) {
    return { error: "تعذّر الاتصال بخدمة قراءة المستندات: " + String(error?.message || error).slice(0, 120) };
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const apiMessage = String(payload?.error?.message || "").slice(0, 180);
    if (response.status === 401 || response.status === 403) return { error: "مفتاح OpenAI غير صالح أو لا يملك صلاحية قراءة الملفات." };
    if (response.status === 429) return { error: "وصلت خدمة قراءة الملفات إلى حد الاستخدام أو الرصيد المتاح. جرّب لاحقًا." };
    return { error: "فشلت قراءة المستند (" + response.status + "). " + apiMessage };
  }
  let extracted = typeof payload.output_text === "string" ? payload.output_text : "";
  if (!extracted && Array.isArray(payload.output)) {
    extracted = payload.output
      .filter(item => item?.type === "message")
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(item => item?.type === "output_text" && typeof item.text === "string")
      .map(item => item.text)
      .join("\\n");
  }
  extracted = extracted.trim().slice(0, 50000);
  if (!extracted) return { error: "الخدمة استلمت الملفات لكنها لم تُرجع نصًا قابلًا للقراءة. قد يكون الملف محميًا أو تالفًا." };
  return { text: extracted, model: payload.model || env.WENS_DOCUMENT_MODEL || "gpt-4.1-mini" };
}

async function handleAgent(request, env, user, options = {}) {
  if (!env.AI) return json({ error: "خدمة الذكاء الاصطناعي غير متاحة حاليًا." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "بيانات المهمة غير صالحة." }, 400); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4) : [];
  const deepThink = body.deepThink === true;
  if ((!message && !attachments.length) || message.length > 4000) {
    return json({ error: "اكتب رسالة أو أرفق ملفًا، وبحد أقصى 4000 حرف." }, 400);
  }
  let imageBase64 = "";
  let imageMimeType = "";
  let textAttachmentContext = "";
  const attachmentNames = [];
  const documentFiles = [];
  let documentBytesTotal = 0;
  let textAttachmentLength = 0;
  for (const item of attachments) {
    const name = String(item?.name || "ملف مرفق").replace(/[\\r\\n]/g, " ").slice(0, 120);
    const kind = String(item?.kind || "");
    const type = String(item?.type || "").toLowerCase();
    attachmentNames.push(name);
    if (kind === "image") {
      if (imageBase64) return json({ error: "يمكن إرفاق صورة واحدة في الرسالة حاليًا." }, 400);
      if (!["image/jpeg", "image/png", "image/webp"].includes(type)) {
        return json({ error: "نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP." }, 415);
      }
      const data = String(item?.data || "");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > 6 * 1024 * 1024) {
        return json({ error: "بيانات الصورة غير صالحة أو حجمها كبير جدًا." }, 413);
      }
      imageBase64 = data;
      imageMimeType = type;
    } else if (kind === "text") {
      const content = String(item?.text || "");
      if (content.length > 100000 || textAttachmentLength + content.length > 100000) {
        return json({ error: "إجمالي نصوص الملفات المرفقة يجب ألا يتجاوز 100 ألف حرف." }, 413);
      }
      textAttachmentLength += content.length;
      textAttachmentContext += "\\n\\n--- ملف: " + name + " ---\\n" + content;
    } else if (kind === "document") {
      const extension = String(name.split(".").pop() || "").toLowerCase();
      const documentMimes = {
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      };
      const expectedType = documentMimes[extension];
      const data = String(item?.data || "");
      if (!expectedType || type !== expectedType || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        return json({ error: "نوع المستند أو بياناته غير صالحة: " + name }, 415);
      }
      if (data.length > 11 * 1024 * 1024 || documentBytesTotal + data.length > 14 * 1024 * 1024) {
        return json({ error: "حجم ملفات المستندات كبير جدًا. الحد 8 ميجابايت للملف و10 ميجابايت إجماليًا تقريبًا." }, 413);
      }
      documentBytesTotal += data.length;
      documentFiles.push({ name, type: expectedType, data });
    } else {
      textAttachmentContext += "\\n\\n[مرفق ملف باسم " + name + " ونوع " + (type || "غير معروف") + ". محتوى هذا النوع لم يتم استخراجه؛ لا تدّعي قراءته.]";
    }
  }
  let documentsWereRead = false;
  if (documentFiles.length) {
    const extraction = await extractDocumentAttachments(env, documentFiles, message);
    if (extraction.error) return json({ error: extraction.error }, 502);
    textAttachmentContext += "\\n\\n--- محتوى المستندات المستخرج ---\\n" + extraction.text;
    documentsWereRead = true;
  }
  const imageName = attachmentNames.find((name, index) => attachments[index]?.kind === "image") || "صورة";
  const promptMessage = [
    message,
    imageBase64 ? "[تم إرفاق صورة باسم " + imageName + ". افحص الصورة وأجب عنها.]" : "",
    textAttachmentContext
  ].filter(Boolean).join("\\n\\n") || "افحص المرفقات المرسلة ووضّح ما يمكن قراءته منها.";
  const storedMessage = (documentFiles.length ? message : promptMessage) +
    (attachmentNames.length ? "\\n\\n[أسماء المرفقات: " + attachmentNames.join("، ") + "]" : "");
  const steps = [];
  if (documentsWereRead) steps.push("قراءة محتوى PDF / Word / Excel");
  const generatedImages = [];
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
    ).bind(crypto.randomUUID(), user.id, "user", storedMessage, Math.floor(Date.now() / 1000)).run();
  }

  const imageWords = /(?:صورة|صوره|صور|الصورة|الصوره|رسم|رسمة|رسمة|لوحة|image|picture|photo|illustration|artwork)/i;
  const imageCreateWords = /(?:أنشئ|انشئ|أنشئي|انشئي|اعمل|اعملي|صمم|صممي|ارسم|ارسمي|اصنع|اصنعي|ولّد|ولد|ابتكر|عايز|عاوزه|عاوز|اريد|أريد|محتاج|محتاجة|create|generate|draw|design|make)/i;
  const imageEditWords = /(?:عدل|عدّل|تعديل|غير|غيّر|بدل|استبدل|احذف|أزل|شيل|قص|حوّل|حول|خلي|اجعل|ضيف|أضف|اضف|remove|edit|change|replace|erase|crop|transform|modify)/i;
  const requestedImageTool = imageBase64 && imageEditWords.test(message)
    ? "edit_image"
    : (!imageBase64 && imageWords.test(message) && imageCreateWords.test(message) ? "generate_image" : "");
  if (requestedImageTool) {
    const result = await runAgentImage(
      env,
      requestedImageTool,
      { prompt: message, size: body.imageSize || "square" },
      imageBase64 ? { data: imageBase64, type: imageMimeType || "image/jpeg" } : null
    );
    if (!result.imageDataUrl) {
      steps.push(requestedImageTool === "edit_image" ? "تعذّر تعديل الصورة" : "تعذّر إنشاء الصورة");
      const payload = { ok: false, error: result.error || "تعذّر تنفيذ مهمة الصور." };
      if (request.headers.get("x-wens-diagnostics") === "image-agent-e2e" && result.diagnostic) payload.diagnostic = result.diagnostic;
      return json(payload, 502);
    }
    const reply = requestedImageTool === "edit_image"
      ? "تم تعديل الصورة حسب طلبك. تقدر تحفظ النسخة الجديدة من هنا."
      : "أنشأت لك الصورة المطلوبة. تقدر تحفظها من هنا.";
    steps.push(requestedImageTool === "edit_image" ? "تعديل الصورة المرفقة — تم" : "إنشاء صورة بالذكاء الاصطناعي — تم");
    const generatedImages = [{
      dataUrl: result.imageDataUrl,
      name: requestedImageTool === "edit_image" ? "wens-edited-image" : "wens-generated-image",
      width: result.width,
      height: result.height
    }];
    if (options.persist && env.DB && user) {
      await env.DB.prepare(
        "INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)"
      ).bind(crypto.randomUUID(), user.id, "assistant", reply, Math.floor(Date.now() / 1000)).run();
    }
    return json({ ok: true, model: result.model, steps, reply, generatedImages });
  }
  const systemPrompt = options.persist
    ? SYSTEM_PROMPT + "\\n\\n" + AGENT_SYSTEM_PROMPT + "\\nفي المحادثة الرئيسية، كوني رفيقة طبيعية: جاوبي مباشرة وباختصار مناسب، ولا تحولي كل سؤال بسيط إلى خطة. استخدمي الأدوات عند الحاجة الفعلية فقط. إذا طلب المستخدم تنفيذ شيء، خططي ونفذي ما تسمح به الأدوات ثم اشرحي النتيجة بصدق."
    : AGENT_SYSTEM_PROMPT;
  const effectiveSystemPrompt = deepThink
    ? systemPrompt + "\\nفي وضع التفكير العميق، تحققي من الخطوات والافتراضات، وراجعي النتائج قبل الإجابة. قدّمي الخلاصة المفيدة ولا تعرضي التفكير الداخلي."
    : systemPrompt;
  const imageInstructions = imageBase64
    ? "\\nالمستخدم أرفق صورة. إذا طلب تعديلها أو تغيير خلفيتها أو أسلوبها، استخدمي أداة edit_image لتنفيذ التعديل على الصورة نفسها، وليس مجرد وصف التعديل."
    : "\\nإذا طلب المستخدم إنشاء صورة جديدة، استخدمي أداة generate_image. إذا طلب تعديل صورة ولم يرفق صورة، اطلبي منه إرفاقها أولًا.";
  const finalSystemPrompt = effectiveSystemPrompt + imageInstructions;
  const messages = [
    { role: "system", content: finalSystemPrompt },
    ...conversationHistory,
    {
      role: "user",
      content: imageBase64
        ? [
            { type: "text", text: promptMessage },
            {
              type: "image_url",
              image_url: { url: "data:" + (imageMimeType || "image/jpeg") + ";base64," + imageBase64 }
            }
          ]
        : promptMessage
    }
  ];
  const useReasoningModel = deepThink || Boolean(imageBase64);
  const model = useReasoningModel ? "@cf/qwen/qwen3.8-27b" : (env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash");
  try {
    let finalText = "";
    const maxTurns = deepThink ? 8 : 6;
    for (let turn = 0; turn < maxTurns; turn++) {
      const runOptions = {
        messages,
        tools: agentTools(),
        temperature: 0.2,
        max_tokens: deepThink ? 1500 : 1100
      };
      if (model === "@cf/qwen/qwen3.8-27b") {
        runOptions.reasoning_effort = deepThink ? "xhigh" : "medium";
      }
      if (imageBase64 && turn === 0) {
        steps.push("تحليل الصورة المرفقة باستخدام نموذج الرؤية");
      }
      const result = await env.AI.run(model, runOptions);
      const assistantMessage = result?.choices?.[0]?.message || result?.result?.choices?.[0]?.message || result;
      const calls = Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : (Array.isArray(result?.tool_calls) ? result.tool_calls : []);
      if (!calls.length) { finalText = typeof assistantMessage?.content === "string" ? assistantMessage.content.trim() : (typeof result?.response === "string" ? result.response.trim() : ""); break; }
      const nativeToolResponse = Array.isArray(result?.tool_calls) && !Array.isArray(assistantMessage?.tool_calls);
      if (!nativeToolResponse) {
        messages.push({ role: "assistant", content: assistantMessage.content || "", tool_calls: calls });
      }
      for (const call of calls.slice(0, 6)) {
        const name = String(call.name || call.function?.name || "");
        let args = call.arguments ?? call.function?.arguments ?? {};
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
        const allowed = ["get_current_time","calculate","search_web","open_webpage","browser_open","browser_inspect","browser_click","browser_fill","browser_close","save_task","list_tasks","update_task","set_task_status","archive_task","restore_task","search_my_messages","generate_image","edit_image"];
        if (!allowed.includes(name)) { steps.push("تم رفض أداة غير مسموح بها."); continue; }
        let output;
        if (name === "generate_image" || name === "edit_image") {
          if (generatedImages.length >= 1) {
            output = { error: "يمكن إنشاء صورة واحدة فقط في كل رسالة حاليًا." };
          } else {
            const imageResult = await runAgentImage(env,name,args || {},imageBase64 ? {data:imageBase64,type:imageMimeType || "image/jpeg"} : null);
            if (imageResult.imageDataUrl) {
              generatedImages.push({dataUrl:imageResult.imageDataUrl,name:name === "edit_image" ? "wens-edited-image" : "wens-generated-image",width:imageResult.width,height:imageResult.height});
              output = {created:true,edited:name === "edit_image",previewReady:true,width:imageResult.width,height:imageResult.height};
            } else output = imageResult;
          }
        } else {
          output = await executeAgentTool(name,args || {},env,user);
        }
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
          generate_image: "إنشاء صورة بالذكاء الاصطناعي",
          edit_image: "تعديل الصورة المرفقة",
          search_web: "البحث في المواقع العامة",
          open_webpage: "قراءة صفحة ويب",
          browser_open: "فتح موقع في المتصفح",
          browser_inspect: "قراءة الصفحة المفتوحة",
          browser_click: "التنقل داخل الموقع",
          browser_fill: "ملء حقل غير حساس",
          browser_close: "إغلاق جلسة المتصفح"
        };
        steps.push(labels[name] + (output.error ? " — " + output.error : " — تم"));
        if (nativeToolResponse) {
          messages.push({ role: "assistant", content: JSON.stringify({ name, arguments: args || {} }) });
          messages.push({ role: "tool", content: JSON.stringify(output) });
        } else {
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(output) });
        }
      }
    }
    if (!finalText) {
      const lastOptions = {
        messages: messages.concat([{ role: "user", content: "قدمي النتيجة النهائية الآن اعتمادًا على نتائج الأدوات السابقة، ولا تدّعي أي تنفيذ غير موجود." }]),
        temperature: 0.2,
        max_tokens: deepThink ? 1500 : 1100
      };
      if (model === "@cf/qwen/qwen3.8-27b") lastOptions.reasoning_effort = deepThink ? "xhigh" : "medium";
      const last = await env.AI.run(model, lastOptions);
      const lastMessage = last?.choices?.[0]?.message || last?.result?.choices?.[0]?.message || last;
      finalText = typeof lastMessage?.content === "string" ? lastMessage.content.trim() : (typeof last?.response === "string" ? last.response.trim() : "");
    }
    if (!finalText) return json({ error: "نفذت الوكيلة الأدوات لكن النموذج لم يرجع ملخصًا نهائيًا." }, 502);
    if (options.persist && env.DB && user) {
      const safeStoredReply = finalText.replace(/https:\/\/live\.browser\.run\/[^\s)]+/g, "[رابط متصفح مؤقت]");
      await env.DB.prepare(
        "INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)"
      ).bind(crypto.randomUUID(), user.id, "assistant", safeStoredReply, Math.floor(Date.now() / 1000)).run();
    }
    return json({ ok: true, model, steps, reply: finalText, generatedImages });
  } catch (error) {
    const diagnostic = String(error?.message || error || "Unknown AI error")
      .replace(/Bearer\\s+[^\\s]+/gi, "Bearer [redacted]")
      .replace(/(?:sk|cf)_[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .slice(0, 220);
    console.error("[WENS_AGENT_FAILURE]", diagnostic);
    const payload = { error: "تعذّر تشغيل وكيل ونس الآن. قد لا يكون نموذج الوكلاء متاحًا في حساب Workers AI أو قد تكون الحصة انتهت." };
    if (request.headers.get("x-wens-diagnostics") === "image-agent-e2e") payload.diagnostic = diagnostic;
    return json(payload, 502);
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
    const model = env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash";
    const result = await env.AI.run(model, {
      messages,
      temperature: 0.7,
      max_tokens: 500
    });
    const assistantMessage = result?.choices?.[0]?.message || result?.result?.choices?.[0]?.message || result;
      const reply = typeof assistantMessage?.content === "string"
        ? assistantMessage.content.trim()
        : typeof result?.response === "string" ? result.response.trim() : "";
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

async function handleVoiceSpeech(request, env) {
  if (!env.OPENAI_API_KEY) return json({ error: "خدمة الصوت الطبيعي غير مفعّلة على الخادم." }, 503);
  if (env.DB) {
    const user = await currentUser(request, env) || await adminUser(request, env);
    if (!user) return json({ error: "سجّل الدخول إلى ونس أو لوحة المدير لاستخدام الصوت." }, 401);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "طلب الصوت غير صالح." }, 400); }
  const input = typeof body.text === "string" ? body.text.trim().slice(0, 2000) : "";
  if (!input) return json({ error: "لا يوجد نص لتحويله إلى صوت." }, 400);
  const allowedVoices = ["coral", "shimmer", "nova", "marin", "sage"];
  const voice = allowedVoices.includes(body.voice) ? body.voice : "coral";
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.WENS_TTS_MODEL || "gpt-4o-mini-tts",
        voice,
        input,
        instructions: "Speak clearly in natural Egyptian Arabic (Masri), with a warm, gentle, feminine-sounding delivery. Use Egyptian pronunciation and natural conversational rhythm. Keep the tone friendly and calm. Do not translate or add words.",
        response_format: "mp3"
      }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    return json({ error: "تعذّر الاتصال بخدمة الصوت الطبيعي: " + String(error?.message || error).slice(0, 120) }, 502);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) return json({ error: "مفتاح OpenAI غير صالح أو لا يملك صلاحية تحويل النص إلى صوت." }, 502);
    if (response.status === 429) return json({ error: "رصيد أو حد استخدام خدمة الصوت الطبيعي غير كافٍ حاليًا." }, 429);
    return json({ error: "فشل إنشاء الصوت الطبيعي (" + response.status + "). " + detail.slice(0, 140) }, 502);
  }
  const audio = await response.arrayBuffer();
  if (!audio.byteLength) return json({ error: "خدمة الصوت لم تُرجع ملفًا صالحًا." }, 502);
  return new Response(audio, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
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
          browser: Boolean(env.BROWSER),
          naturalVoiceConfigured: Boolean(env.OPENAI_API_KEY),
          documentReadingConfigured: Boolean(env.OPENAI_API_KEY),
          adminProtectionConfigured: Boolean(env.DB)
        },
        diagnostics: {
          workersAiBindingPresent,
          browserBindingPresent: Boolean(env.BROWSER),
          model: workersAiBindingPresent ? (env.WENS_AGENT_MODEL || "@cf/zai-org/glm-4.7-flash") : null
        }
      });
    }
    try {
      if (path === "/api/settings" && request.method === "GET") return json({ settings: await readAppSettings(env) });
      if (path === "/api/voice/speech" && request.method === "POST") return await handleVoiceSpeech(request, env);
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
