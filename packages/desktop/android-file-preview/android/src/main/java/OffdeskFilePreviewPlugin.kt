package dev.offdesk.filepreview

import android.app.Activity
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.text.TextUtils
import android.util.Base64
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

// Never resolved: every request to it is answered here, from the machine.
private const val HOST = "file-preview.offdesk.invalid"
private const val TIMEOUT_SECONDS = 60L
private const val BAR_COLOR = 0xff1e1b2b.toInt()

private class Reply(val status: Int, val mime: String, val body: ByteArray)

private fun textReply(status: Int, message: String) =
    Reply(status, "text/plain; charset=utf-8", message.toByteArray(Charsets.UTF_8))

@InvokeArg
class OpenArgs {
    lateinit var title: String
    lateinit var path: String
    lateinit var requests: Channel
}

/**
 * Shows an HTML file of a remote machine in a WebView of its own, in a
 * full-screen dialog over the app. This WebView has no Tauri bridge: the
 * page cannot call the app. Each request of the page is sent to the app's
 * page over `requests`, which reads the file from the machine and answers
 * with `respond`.
 */
@TauriPlugin
class OffdeskFilePreviewPlugin(private val activity: Activity) : Plugin(activity) {
    private val nextId = AtomicLong()

    // Set on the UI thread; `respond` reads it from the IPC thread.
    @Volatile
    private var current: Session? = null

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        if (!args.path.startsWith("/")) {
            invoke.reject("bad preview path")
            return
        }
        activity.runOnUiThread {
            try {
                current?.dialog?.dismiss()
                current = Session(args.requests).also { it.show(args.title, "https://$HOST${args.path}") }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Could not open the preview")
            }
        }
    }

    @Command
    fun respond(invoke: Invoke) {
        val args = invoke.getArgs()
        val future = current?.pending?.remove(args.getLong("id"))
        if (future != null) {
            val reply = try {
                Reply(args.getInt("status"), args.getString("mime"), Base64.decode(args.getString("dataBase64"), Base64.DEFAULT))
            } catch (e: IllegalArgumentException) {
                textReply(502, "Bad response")
            }
            future.complete(reply)
        }
        invoke.resolve()
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()

    private inner class Session(private val requests: Channel) {
        val pending = ConcurrentHashMap<Long, CompletableFuture<Reply>>()
        var dialog: Dialog? = null

        @Volatile
        private var closed = false

        fun show(title: String, url: String) {
            val webView = WebView(activity)
            webView.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                builtInZoomControls = true
                displayZoomControls = false
                useWideViewPort = true
                loadWithOverviewMode = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            }
            webView.webChromeClient = WebChromeClient()
            webView.webViewClient = Client()

            val close = barButton("✕", "关闭") { dialog?.dismiss() }
            val reload = barButton("↻", "刷新") { webView.reload() }
            val name = TextView(activity).apply {
                text = title
                textSize = 16f
                setTextColor(Color.WHITE)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.MIDDLE
                gravity = Gravity.CENTER_VERTICAL
            }
            val bar = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                setBackgroundColor(BAR_COLOR)
                addView(close, LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.MATCH_PARENT))
                addView(name, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
                addView(reload, LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.MATCH_PARENT))
            }
            val root = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(BAR_COLOR)
                addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
                addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
                // Keep the bar below the status bar, the page above the
                // navigation bar, on edge-to-edge Android versions too.
                @Suppress("DEPRECATION")
                setOnApplyWindowInsetsListener { view, insets ->
                    view.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
                    insets
                }
            }

            val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
            dialog.setContentView(root)
            dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            dialog.setOnKeyListener { _, keyCode, event ->
                if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
                    if (event.action == KeyEvent.ACTION_UP) webView.goBack()
                    true
                } else {
                    false
                }
            }
            dialog.setOnDismissListener {
                if (current === this) current = null
                closed = true
                requests.send(JSObject().apply { put("type", "closed") })
                for (future in pending.values) future.complete(textReply(410, "Preview closed"))
                pending.clear()
                webView.stopLoading()
                webView.destroy()
            }
            this.dialog = dialog
            dialog.show()
            dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            webView.loadUrl(url)
        }

        private fun barButton(label: String, description: String, onClick: () -> Unit) =
            TextView(activity).apply {
                text = label
                textSize = 20f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                contentDescription = description
                setOnClickListener { onClick() }
            }

        // Runs on a WebView loader thread; waits for the app's answer.
        fun fetch(path: String): Reply {
            if (closed) return textReply(410, "Preview closed")
            val id = nextId.incrementAndGet()
            val future = CompletableFuture<Reply>()
            pending[id] = future
            return try {
                requests.send(JSObject().apply {
                    put("type", "request")
                    put("id", id)
                    put("path", path)
                })
                future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            } catch (e: Exception) {
                textReply(504, "The machine did not answer")
            } finally {
                pending.remove(id)
            }
        }

        private inner class Client : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host != HOST) return null
                val reply = fetch(request.url.path ?: "/")
                val parts = reply.mime.split(";").map { it.trim() }
                val charset = parts.drop(1).firstOrNull { it.startsWith("charset=", ignoreCase = true) }
                    ?.substringAfter("=")
                // WebResourceResponse refuses redirects and empty reasons.
                val status = if (reply.status in 200..299 || reply.status in 400..599) reply.status else 502
                return WebResourceResponse(
                    parts[0],
                    charset,
                    status,
                    if (status < 300) "OK" else "Error",
                    mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream(reply.body),
                )
            }

            // Links out of the previewed files open in the person's browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == HOST || !request.isForMainFrame) return false
                if (url.scheme in setOf("http", "https", "mailto", "tel")) {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (e: ActivityNotFoundException) {
                        // Nothing can open it; stay on the page.
                    }
                }
                return true
            }
        }
    }
}
