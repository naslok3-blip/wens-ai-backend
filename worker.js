/**
 * Wens AI - Cloudflare Worker API
 * Required secret: OPENAI_API_KEY
 * Optional vars: OPENAI_MODEL (defaults to gpt-4o-mini)
 */
const SYSTEM_PROMPT = `أنتِ ونس، رفيقة افتراضية مصرية ودودة وذكية. تحدثي باللهجة المصرية الطبيعية وبصيغة المؤنث عن نفسك. كوني دافئة ومحترمة وخفيفة الظل دون مبالغة أو ادعاء أنك إنسانة حقيقية. افهمي سياق المحادثة، واسألي سؤال متابعة واحدًا عند الحاجة. أجيبي بوضوح وباختصار مناسب، واشرحي الأمور الصعبة ببساطة. لا تدّعي أنك ترين صورة أو تسمعين صوتًا ما لم يتم إرسالها فعليًا. لا تطلبي كلمات مرور أو مفاتيح سرية أو بيانات دفع. إذا كان السؤال طبيًا أو قانونيًا أو ماليًا عالي المخاطر، قدّمي معلومات عامة ونبّهي إلى ضرورة الرجوع لمختص.`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "wens-ai", configured: Boolean(env.OPENAI_API_KEY) });
    }
    if (url.pathname !== "/api/chat") {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "المسار غير موجود." }, 404);
    }
    if (request.method !== "POST") return json({ error: "طريقة الطلب غير مدعومة." }, 405);
    if (!env.OPENAI_API_KEY) return json({ error: "الخادم لم يتم إعداد مفتاح الذكاء الاصطناعي عليه بعد." }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "بيانات الطلب غير صالحة." }, 400); }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json({ error: "اكتب رسالتك الأول." }, 400);
    if (message.length > 6000) return json({ error: "الرسالة طويلة جدًا؛ اختصرها قليلًا." }, 400);

    const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
    const messages = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const item of history) {
      if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") continue;
      messages.push({ role: item.role, content: item.content.slice(0, 6000) });
    }
    // The current message is already included in client history; avoid duplicating it.
    if (!history.length || history[history.length - 1]?.role !== "user" || history[history.length - 1]?.content !== message) {
      messages.push({ role: "user", content: message });
    }

    try {
      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-4o-mini",
          messages,
          temperature: 0.7,
          max_tokens: 700
        })
      });
      const result = await upstream.json();
      if (!upstream.ok) {
        const message = result?.error?.message || "حدث خطأ من مزود الذكاء الاصطناعي.";
        return json({ error: `خدمة الذكاء الاصطناعي رفضت الطلب: ${message}` }, upstream.status === 429 ? 429 : 502);
      }
      const reply = result?.choices?.[0]?.message?.content?.trim();
      if (!reply) return json({ error: "لم يصل رد نصي من خدمة الذكاء الاصطناعي." }, 502);
      return json({ reply });
    } catch {
      return json({ error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي. حاول مرة أخرى." }, 502);
    }
  }
};
