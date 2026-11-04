package com.linmengyao.companion

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private val configured = Uri.parse(BuildConfig.COMPANION_URL)
    private var pendingAudio: PermissionRequest? = null
    private val audioPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingAudio.also { pendingAudio = null }
        if (granted) request?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request?.deny()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        require(configured.scheme == "https" && !configured.host.isNullOrBlank()) { "COMPANION_URL 必须是 HTTPS" }
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                return target.scheme != "https" || target.host != configured.host || target.port != configured.port
            }
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) = handler.cancel()
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val origin = request.origin
                    val audioOnly = request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    if (!audioOnly || origin.scheme != "https" || origin.host != configured.host || origin.port != configured.port) {
                        request.deny(); return@runOnUiThread
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) request.grant(request.resources)
                    else { pendingAudio?.deny(); pendingAudio = request; audioPermission.launch(Manifest.permission.RECORD_AUDIO) }
                }
            }
        }
        web.loadUrl(configured.toString())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })
    }

    override fun onDestroy() {
        pendingAudio?.deny()
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }
}
