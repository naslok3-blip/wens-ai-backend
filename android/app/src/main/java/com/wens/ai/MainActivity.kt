package com.wens.ai

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var pendingRequest: PermissionRequest? = null
    private val appHost = "wens-aii.naqashy1.workers.dev"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(13, 12, 24)
        window.navigationBarColor = Color.rgb(13, 12, 24)

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
                    it == PermissionRequest.RESOURCE_VIDEO_CAPTURE ||
                    it == PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                if (!resourcesAllowed) { request.deny(); return }
                val missing = arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
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
                Toast.makeText(this, "اسمح بالكاميرا والميكروفون لتشغيل مكالمات الفيديو.", Toast.LENGTH_LONG).show()
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
        super.onDestroy()
    }
}
