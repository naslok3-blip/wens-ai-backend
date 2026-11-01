# Wens AI Android

مشروع Android WebView يفتح تطبيق ونس المستضاف على Cloudflare Worker، ويستخدم صلاحيات الإنترنت والكاميرا والميكروفون عند الحاجة.

## البناء
افتح مجلد android في Android Studio مع JDK 17 وAndroid SDK 35، أو استخدم GitHub Actions من تبويب Actions لبناء APK تجريبي.

لا يحتاج التطبيق مفتاح OpenAI. الدردشة تعمل عبر Cloudflare Workers AI المرتبط بالـWorker، وتستخدم الحصة المجانية اليومية المتاحة للحساب. لا تضع مفاتيح API داخل APK.
