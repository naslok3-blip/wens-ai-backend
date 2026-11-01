# Wens AI Android

مشروع Android WebView يفتح تطبيق ونس المستضاف على Cloudflare Worker، ويستخدم صلاحيات الإنترنت والكاميرا والميكروفون عند الحاجة.

## البناء
افتح مجلد android في Android Studio مع JDK 17 وAndroid SDK 35، أو استخدم GitHub Actions من تبويب Actions لبناء APK تجريبي.

مفتاح OpenAI لا يوضع في التطبيق. يلزم إعداد OPENAI_API_KEY كـ Secret داخل Cloudflare Worker حتى تعمل الدردشة.
