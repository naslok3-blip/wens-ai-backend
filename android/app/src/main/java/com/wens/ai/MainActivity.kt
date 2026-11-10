package com.wens.ai

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import java.util.Locale

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingRequest: PermissionRequest? = null
    @Volatile private var textToSpeech: TextToSpeech? = null
    @Volatile private var ttsReady = false
    @Volatile private var nativeVoiceLabel = "صوت Android العربي المحلي"
    private val appHost = "wens-ai-backend-b142.naqashy1.workers.dev"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(13, 12, 24)
        window.navigationBarColor = Color.rgb(13, 12, 24)

        textToSpeech = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val engine = textToSpeech
                val egyptianResult = engine?.setLanguage(Locale("ar", "EG")) ?: TextToSpeech.ERROR
                val supportsEgyptian = egyptianResult != TextToSpeech.LANG_MISSING_DATA &&
                    egyptianResult != TextToSpeech.LANG_NOT_SUPPORTED
                if (!supportsEgyptian) {
                    val arabicResult = engine?.setLanguage(Locale("ar")) ?: TextToSpeech.ERROR
                    nativeVoiceLabel = if (arabicResult == TextToSpeech.LANG_MISSING_DATA ||
                        arabicResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                        "محرك Android متاح لكن حزمة الصوت العربي غير مثبتة"
                    } else {
                        "صوت Android عربي محلي (لهجة الجهاز)"
                    }
                } else {
                    nativeVoiceLabel = "صوت Android للمصرية إذا كانت الحزمة المثبتة تدعمها"
                }

                // Prefer an Egyptian Arabic voice when the device exposes one; otherwise use its Arabic fallback.
                try {
                    val voices = engine?.voices.orEmpty().filter { it.locale.language.equals("ar", true) }
                    val egyptian = voices.filter { it.locale.country.equals("EG", true) }
                    val preferred = (egyptian + voices).distinct().firstOrNull { voice ->
                        Regex("female|woman|salma|hoda|هدى|سلمى|ليلى|فاطمة", RegexOption.IGNORE_CASE)
                            .containsMatchIn(voice.name)
                    } ?: egyptian.firstOrNull()
                    if (preferred != null) {
                        engine?.voice = preferred
                        nativeVoiceLabel = if (preferred.locale.country.equals("EG", true)) {
                            "صوت Android مصري مثبت على الهاتف"
                        } else {
                            "صوت Android عربي مثبت على الهاتف"
                        }
                    }
                } catch (_: Exception) {
                    // Keep the system-selected Arabic voice if voice enumeration is unavailable.
                }
                ttsReady = engine != null && nativeVoiceLabel != "محرك Android متاح لكن حزمة الصوت العربي غير مثبتة"
            }
        }

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
        }
        webView.addJavascriptInterface(object {
            @JavascriptInterface fun speak(message: String, utteranceId: String): Boolean {
                if (!ttsReady) return false
                val safeId = utteranceId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(80)
                if (safeId.isBlank()) return false
                val safeMessage = message.take(4000)
                runOnUiThread {
                    val engine = textToSpeech
                    val result = engine?.speak(
                        safeMessage,
                        TextToSpeech.QUEUE_FLUSH,
                        Bundle(),
                        safeId
                    ) ?: TextToSpeech.ERROR
                    if (result == TextToSpeech.ERROR) dispatchTtsEvent("error", safeId)
                }
                return true
            }

            @JavascriptInterface fun getVoiceLabel(): String = nativeVoiceLabel

            @JavascriptInterface fun stop() {
                runOnUiThread { textToSpeech?.stop() }
            }
        }, "WensNative")

        textToSpeech?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = dispatchTtsEvent("start", utteranceId)
            override fun onDone(utteranceId: String) = dispatchTtsEvent("done", utteranceId)
            @Deprecated("Deprecated in Android")
            override fun onError(utteranceId: String) = dispatchTtsEvent("error", utteranceId)
            override fun onError(utteranceId: String, errorCode: Int) = dispatchTtsEvent("error", utteranceId)
            override fun onStop(utteranceId: String, interrupted: Boolean) = dispatchTtsEvent("stop", utteranceId)
        })

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.scheme == "https" && uri.host == appHost) return false
                if (uri.scheme == "https" || uri.scheme == "http") {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                }
                return true
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.origin.host != appHost) { request.deny(); return }
                val resourcesAllowed = request.resources.all {
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                if (!resourcesAllowed) { request.deny(); return }
                val missing = arrayOf(Manifest.permission.RECORD_AUDIO)
                    .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) {
                    request.grant(request.resources)
                } else {
                    pendingRequest = request
                    requestPermissions(missing.toTypedArray(), 410)
                }
            }
        }
        setContentView(webView)
        if (savedInstanceState == null) {
            webView.loadUrl("https://$appHost/")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    private fun dispatchTtsEvent(event: String, utteranceId: String) {
        val safeId = org.json.JSONObject.quote(utteranceId)
        val safeEvent = org.json.JSONObject.quote(event)
        runOnUiThread {
            if (::webView.isInitialized) {
                webView.evaluateJavascript(
                    "window.onWensNativeTtsEvent && window.onWensNativeTtsEvent($safeEvent,$safeId)",
                    null
                )
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::webView.isInitialized) webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 410) {
            val req = pendingRequest
            pendingRequest = null
            if (results.isNotEmpty() && results.all { it == PackageManager.PERMISSION_GRANTED } && req != null) {
                req.grant(req.resources)
            } else {
                req?.deny()
                Toast.makeText(this, "اسمح بالميكروفون لتشغيل المحادثة الصوتية.", Toast.LENGTH_LONG).show()
            }
        }
    }

    @Deprecated("Deprecated in Android")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onDestroy() {
        pendingRequest?.deny()
        pendingRequest = null
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
        textToSpeech?.stop()
        textToSpeech?.shutdown()
        textToSpeech = null
        ttsReady = false
        super.onDestroy()
    }
}
