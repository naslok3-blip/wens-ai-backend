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
async function handleChat(request, env, user) {
  if (!env.OPENAI_API_KEY) return json({ error: "خدمة الذكاء الاصطناعي غير مفعّلة على الخادم." }, 503);
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
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.OPENAI_MODEL || "gpt-4o-mini", messages, temperature: 0.7, max_tokens: 800 })
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      if (upstream.status === 429) return json({ error: "طلبات كتير دلوقتي؛ استنى شوية وجرب تاني." }, 429);
      if (upstream.status === 401 || upstream.status === 403) return json({ error: "مفتاح OpenAI مرفوض أو غير مربوط بالمشروع الصحيح." }, 502);
      return json({ error: "خدمة الذكاء الاصطناعي رجّعت خطأ. راجع إعدادات OpenAI." }, 502);
    }
    const reply = result?.choices?.[0]?.message?.content?.trim();
    if (!reply) return json({ error: "لم يصل رد نصي من خدمة الذكاء الاصطناعي." }, 502);
    if (db && user) {
      await db.prepare("INSERT INTO messages (id,user_id,role,content,created_at) VALUES (?,?,?,?,?)")
        .bind(crypto.randomUUID(), user.id, "assistant", reply, Math.floor(Date.now() / 1000)).run();
    }
    return json({ reply });
  } catch {
    return json({ error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. حاول مرة أخرى." }, 502);
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/api/health") {
      return json({
        ok: true,
        service: "wens-ai",
        configured: Boolean(env.OPENAI_API_KEY),
        features: {
          openai: Boolean(env.OPENAI_API_KEY),
          database: Boolean(env.DB),
          videoAvatar: Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)
        }
      });
    }
    try {
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
