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
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromB64url(salt), iterations: 160000, hash: "SHA-256" }, key, 256);
  return b64url(new Uint8Array(bits));
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
async function authRoute(request, env, path) {
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
    const existing = await db.prepare("SELECT id FROM users WHERE email=? LIMIT 1").bind(email).first();
    if (existing) return json({ error: "البريد الإلكتروني مسجل بالفعل. سجّل الدخول." }, 409);
    const id = crypto.randomUUID();
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await passwordHash(password, salt);
    await db.prepare("INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, email, name, hash, salt, Math.floor(Date.now() / 1000)).run();
    return issueSession(db, { id, email, display_name: name });
  }

  const user = await db.prepare("SELECT id,email,display_name,password_hash,password_salt FROM users WHERE email=? LIMIT 1").bind(email).first();
  if (!user) return json({ error: "البريد أو كلمة المرور غير صحيحة." }, 401);
  const candidate = await passwordHash(password, user.password_salt);
  if (!same(candidate, user.password_hash)) return json({ error: "البريد أو كلمة المرور غير صحيحة." }, 401);
  return issueSession(db, user);
}
function base64Json(value) {
  return b64url(enc.encode(JSON.stringify(value)));
}
async function liveKitToken(env, user, room) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Json({ alg: "HS256", typ: "JWT" });
  const payload = base64Json({
    iss: env.LIVEKIT_API_KEY,
    sub: user.id,
    name: user.display_name,
    nbf: now - 5,
    iat: now,
    exp: now + 60 * 60,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true }
  });
  const unsigned = header + "." + payload;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.LIVEKIT_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(unsigned));
  return unsigned + "." + b64url(new Uint8Array(signature));
}

const ADMIN_COOKIE = "wens_admin";
const ADMIN_SESSION_SECONDS = 4 * 60 * 60;
const adminLoginAttempts = new Map();

function adminCookie(token, maxAge = ADMIN_SESSION_SECONDS) {
  return ADMIN_COOKIE + "=" + encodeURIComponent(token) +
    "; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;
}
function adminAttemptAllowed(ip) {
  const now = Date.now();
  const item = adminLoginAttempts.get(ip);
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
async function makeAdminSession(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = b64url(enc.encode(JSON.stringify({ exp: expiresAt, nonce })));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.WENS_ADMIN_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return payload + "." + b64url(new Uint8Array(signature));
}
async function validAdminSession(request, env) {
  if (!env.WENS_ADMIN_SESSION_SECRET) return false;
  const raw = cookieValue(request.headers.get("Cookie"), ADMIN_COOKIE);
  const parts = raw.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(env.WENS_ADMIN_SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC", key, fromB64url(parts[1]), enc.encode(parts[0])
    );
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000) &&
      typeof payload.nonce === "string" && payload.nonce.length >= 20;
  } catch {
    return false;
  }
}
function adminConfigurationReady(env) {
  return /^\d{6,12}$/.test(String(env.WENS_ADMIN_PIN || "")) &&
    String(env.WENS_ADMIN_SESSION_SECRET || "").length >= 32;
}
async function adminRoute(request, env, path) {
  if (path === "/api/admin/logout" && request.method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": adminCookie("", 0) });
  }
  if (path === "/api/admin/login" && request.method === "POST") {
    if (!adminConfigurationReady(env)) {
      return json({
        error: "حماية لوحة التحكم لم تُضبط بعد. أضف WENS_ADMIN_PIN (من 6 إلى 12 رقمًا) وWENS_ADMIN_SESSION_SECRET (سر عشوائي طويل لا يقل عن 32 حرفًا) إلى Secrets في نفس Worker."
      }, 503);
    }
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!adminAttemptAllowed(ip)) {
      return json({ error: "محاولات كثيرة. انتظر 15 دقيقة ثم جرّب مرة أخرى." }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: "الرقم السري غير صالح." }, 400); }
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!same(pin, String(env.WENS_ADMIN_PIN))) {
      recordAdminAttempt(ip);
      return json({ error: "الرقم السري غير صحيح." }, 401);
    }
    adminLoginAttempts.delete(ip);
    return json({ ok: true }, 200, { "Set-Cookie": adminCookie(await makeAdminSession(env)) });
  }
  if (path === "/api/admin/session" && request.method === "GET") {
    if (!adminConfigurationReady(env)) {
      return json({
        configured: false,
        authenticated: false,
        error: "إعداد حماية المدير ناقص: أضف WENS_ADMIN_PIN (6 إلى 12 رقمًا) وWENS_ADMIN_SESSION_SECRET (سر عشوائي لا يقل عن 32 حرفًا) في Secrets لنفس Worker."
      }, 503);
    }
    const authenticated = await validAdminSession(request, env);
    return json({ configured: true, authenticated });
  }
  if (!adminConfigurationReady(env)) {
    return json({ error: "إعدادات حماية لوحة التحكم غير مكتملة على الخادم." }, 503);
  }
  if (!(await validAdminSession(request, env))) {
    return json({ error: "انتهت جلسة المدير. سجّل الدخول مرة أخرى." }, 401);
  }
  if (path === "/api/admin/status" && request.method === "GET") {
    let databaseConnected = false;
    let databaseSchemaReady = false;
    if (env.DB) {
      try {
        const probe = await env.DB.prepare("SELECT 1 AS ok").first();
        databaseConnected = Number(probe?.ok) === 1;
        if (databaseConnected) {
          const schema = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','messages')"
          ).first();
          databaseSchemaReady = Number(schema?.total) === 3;
        }
      } catch {}
    }
    return json({
      ok: true,
      checkedAt: new Date().toISOString(),
      model: env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct",
      features: {
        workersAI: Boolean(env.AI),
        databaseConfigured: Boolean(env.DB),
        databaseConnected,
        databaseSchemaReady,
        videoAvatar: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)
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
        ],
        temperature: 0,
        max_tokens: 12
      });
      const reply = typeof result?.response === "string" ? result.response.trim() : "";
      return reply
        ? json({ ok: true, model, reply })
        : json({ error: "تم الاتصال بالنموذج لكنه لم يرجع نصًا." }, 502);
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
          videoAvatar: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)
        },
        diagnostics: {
          workersAiBindingPresent,
          model: workersAiBindingPresent ? (env.WENS_AI_MODEL || "@cf/meta/llama-3.2-1b-instruct") : null
        }
      });
    }
    try {
      if (path.startsWith("/api/admin/")) return await adminRoute(request, env, path);
      if (path.startsWith("/api/auth/")) return await authRoute(request, env, path);
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
      if (path === "/api/call/token" && request.method === "POST") {
        const user = await currentUser(request, env);
        if (!user) return json({ error: "سجّل الدخول الأول لبدء مكالمة." }, 401);
        if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
          return json({ error: "مكالمات الفيديو تحتاج إعداد LiveKit على الخادم أولًا." }, 503);
        }
        let body;
        try { body = await request.json(); } catch { return json({ error: "بيانات الغرفة غير صالحة." }, 400); }
        const room = String(body.room || "").trim();
        if (!/^[a-zA-Z0-9_-]{4,64}$/.test(room)) return json({ error: "كود الغرفة يجب أن يكون من 4 إلى 64 حرفًا أو رقمًا." }, 400);
        return json({ url: env.LIVEKIT_URL, token: await liveKitToken(env, user, room), room });
      }
      if (path.startsWith("/api/")) return json({ error: "المسار غير موجود." }, 404);
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "المسار غير موجود." }, 404);
    } catch (error) {
      if (String(error?.message) === "DB_NOT_CONFIGURED") return json({ error: "قاعدة البيانات غير مربوطة بالخادم بعد." }, 503);
      return json({ error: "حصل خطأ داخلي. حاول مرة أخرى." }, 500);
    }
  }
};
