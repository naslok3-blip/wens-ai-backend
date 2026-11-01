package com.wens.ai

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingRequest: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(13, 12, 24)
        window.navigationBarColor = Color.rgb(13, 12, 24)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = true
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return request.url.scheme !in listOf("https", "http")
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val allowed = request.resources.all {
                    it == PermissionRequest.RESOURCE_VIDEO_CAPTURE ||
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                if (!allowed) { request.deny(); return }
                val missing = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
                    .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) request.grant(request.resources)
                else {
                    pendingRequest = request
                    if (Build.VERSION.SDK_INT >= 23) requestPermissions(missing.toTypedArray(), 410)
                    else request.deny()
                }
            }
        }
        setContentView(webView)
        webView.loadUrl("https://wens-ai-backend-b142.naqashy1.workers.dev/")
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
                Toast.makeText(this, "اسمح بالكاميرا والميكروفون لتشغيل ميزات الصوت والصورة.", Toast.LENGTH_LONG).show()
            }
        }
    }

    @Deprecated("Deprecated in Android")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
