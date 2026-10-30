# ونس AI

مشروع Cloudflare Worker مع واجهة الويب كـ Workers Assets.

## النشر
- اربط هذا المستودع بـ Cloudflare Workers Builds.
- أمر النشر: `npx wrangler deploy`
- لا تضع مفتاح OpenAI داخل الملفات أو GitHub.
- أضف `OPENAI_API_KEY` من إعدادات Worker > Settings > Variables and Secrets كـ Secret.
- المتغير الاختياري `OPENAI_MODEL` افتراضيًا `gpt-4o-mini`.

## فحص الخدمة
- `GET /api/health`
- `POST /api/chat` مع JSON يحتوي `message` و`history` اختيارية.
