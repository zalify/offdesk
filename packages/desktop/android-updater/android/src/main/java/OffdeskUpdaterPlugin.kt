package dev.offdesk.updater

import android.app.Activity
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray

@TauriPlugin
class OffdeskUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newSingleThreadExecutor()
    private val installing = AtomicBoolean(false)
    private val checking = AtomicBoolean(false)
    @Volatile private var candidate: Release? = null
    private val main = Handler(Looper.getMainLooper())
    private val preferences = activity.getSharedPreferences("offdesk_updates", 0)
    private var foreground = true
    private var pendingPermission: Release? = null
    private var pendingOffer: Release? = null
    private var readyToInstall: (() -> Unit)? = null
    private val automaticCheck = Runnable {
        if (
            foreground &&
                System.currentTimeMillis() >= preferences.getLong("next_check", 0) &&
                !installing.get() &&
                checking.compareAndSet(false, true)
        ) {
            executor.execute {
                try {
                    val release = lookup()
                    if (release != null)
                        main.post {
                            if (foreground) promptInstall(null, release) else pendingOffer = release
                        }
                } catch (_: Exception) {
                    candidate = null
                    deferAutomaticCheck(60_000)
                } finally {
                    checking.set(false)
                }
            }
        }
    }

    // Older Hub pages have no updater JavaScript. Native lifecycle checks keep
    // those Apps upgradeable too. A current UI checks first and defers this fallback.
    override fun load(webView: WebView) {
        scheduleAutomaticCheck()
    }

    override fun onResume() {
        foreground = true
        readyToInstall?.let {
            readyToInstall = null
            it()
            return
        }
        val release = pendingPermission ?: pendingOffer
        pendingPermission = null
        pendingOffer = null
        if (release != null)
            main.post { if (foreground) promptInstall(null, release) else pendingOffer = release }
        else scheduleAutomaticCheck()
    }

    override fun onPause() {
        foreground = false
        main.removeCallbacks(automaticCheck)
    }

    private fun scheduleAutomaticCheck() {
        main.removeCallbacks(automaticCheck)
        main.postDelayed(automaticCheck, 8000)
    }

    private fun deferAutomaticCheck(delay: Long) {
        preferences.edit().putLong("next_check", System.currentTimeMillis() + delay).apply()
    }

    private fun lookup(): Release? {
        val current = installed().versionName ?: error("Could not read installed version")
        val connection =
            connect("https://api.github.com/repos/zalify/offdesk/releases?per_page=100")
        val json =
            try {
                connection.inputStream.use { input ->
                    JSONArray(String(input.readBytesLimited(4 * 1024 * 1024), Charsets.UTF_8))
                }
            } finally {
                connection.disconnect()
            }
        val release = ReleasePolicy.select(json, current, Build.SUPPORTED_ABIS.toList())
        candidate = release
        deferAutomaticCheck(6 * 60 * 60 * 1000L)
        return release
    }

    @Suppress("DEPRECATION")
    private fun installed() =
        activity.packageManager.getPackageInfo(activity.packageName, signatureFlags())

    private fun signatureFlags() =
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo) =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signatures(info: PackageInfo): Set<String> {
        val signatures =
            if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners
            else info.signatures
        return signatures?.map { signature -> hash(signature.toByteArray()) }?.toSet() ?: emptySet()
    }

    private fun hash(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun connect(url: String): HttpURLConnection {
        // Follow GitHub's signed asset redirects, but never downgrade to HTTP.
        var next = URL(url)
        repeat(6) {
            require(next.protocol == "https") { "Update download must use HTTPS" }
            val conn =
                (next.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15000
                    readTimeout = 30000
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", "Offdesk-Android-Updater")
                }
            if (conn.responseCode in listOf(301, 302, 303, 307, 308)) {
                val location = conn.getHeaderField("Location") ?: error("Missing download redirect")
                next = URL(next, location)
                conn.disconnect()
            } else {
                if (conn.responseCode != 200) {
                    val code = conn.responseCode
                    conn.disconnect()
                    error("Update server returned HTTP $code. Try again later.")
                }
                return conn
            }
        }
        error("Too many update redirects")
    }

    @Command
    fun check(invoke: Invoke) {
        if (installing.get() || !checking.compareAndSet(false, true)) {
            invoke.reject("An update operation is already in progress")
            return
        }
        executor.execute {
            try {
                val release = lookup()
                invoke.resolve(
                    JSObject().apply {
                        put("version", release?.version ?: org.json.JSONObject.NULL)
                    }
                )
            } catch (e: Exception) {
                candidate = null
                deferAutomaticCheck(60_000)
                invoke.reject(e.message ?: "Could not check for updates")
            } finally {
                checking.set(false)
            }
        }
    }

    @Command
    fun install(invoke: Invoke) {
        val release =
            candidate
                ?: run {
                    invoke.reject("Check for updates first")
                    return
                }
        promptInstall(invoke, release)
    }

    private fun promptInstall(invoke: Invoke?, release: Release) {
        if (!installing.compareAndSet(false, true)) {
            invoke?.reject("An update is already in progress")
            return
        }
        activity.runOnUiThread {
            // Hub pages may request a check, but cannot silently trigger an APK download/install.
            try {
                AlertDialog.Builder(activity)
                    .setTitle("Update Offdesk to ${release.version}?")
                    .setMessage(
                        "Download the official Android update from GitHub and open the system installer."
                    )
                    .setNegativeButton("Cancel") { _, _ -> finish(invoke, "cancelled") }
                    .setOnCancelListener { finish(invoke, "cancelled") }
                    .setPositiveButton("Update") { _, _ ->
                        if (
                            Build.VERSION.SDK_INT >= 26 &&
                                !activity.packageManager.canRequestPackageInstalls()
                        ) {
                            try {
                                if (invoke == null) pendingPermission = release
                                activity.startActivity(
                                    Intent(
                                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:${activity.packageName}"),
                                    )
                                )
                                finish(invoke, "permission-required")
                            } catch (e: Exception) {
                                fail(invoke, e)
                            }
                        } else
                            try {
                                download(invoke, release)
                            } catch (e: Exception) {
                                fail(invoke, e)
                            }
                    }
                    .show()
            } catch (e: Exception) {
                fail(invoke, e)
            }
        }
    }

    private fun finish(invoke: Invoke?, status: String) {
        installing.set(false)
        invoke?.resolve(JSObject().apply { put("status", status) })
    }

    private fun fail(invoke: Invoke?, error: Exception) {
        installing.set(false)
        pendingPermission = null
        deferAutomaticCheck(60_000)
        if (invoke != null) invoke.reject(error.message ?: "Update failed. Try again.")
        else
            main.post {
                if (foreground && !activity.isFinishing && !activity.isDestroyed)
                    AlertDialog.Builder(activity)
                        .setTitle("Update failed")
                        .setMessage(error.message ?: "Please try again later.")
                        .setPositiveButton("OK", null)
                        .show()
            }
    }

    @Suppress("DEPRECATION")
    private fun download(invoke: Invoke?, release: Release) {
        // Native feedback is essential when an old Hub has no updater UI.
        val cancelled = AtomicBoolean(false)
        val progress =
            ProgressDialog(activity).apply {
                setTitle("Downloading Offdesk ${release.version}")
                setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
                max = 100
                setCancelable(true)
                setOnCancelListener { cancelled.set(true) }
                setButton(ProgressDialog.BUTTON_NEGATIVE, "Cancel") { _, _ -> cancelled.set(true) }
                show()
            }
        executor.execute {
            val directory = File(activity.cacheDir, "offdesk-updates").apply { mkdirs() }
            val apk = File(directory, "${release.digest}.apk")
            val partial = File(directory, "download.part")
            try {
                // Keep an already verified APK intact while Android may still be reading it.
                if (!apk.exists()) {
                    partial.delete()
                    val connection = connect(release.url)
                    try {
                        connection.inputStream.use { input ->
                            partial.outputStream().use { output ->
                                val buffer = ByteArray(65536)
                                var total = 0L
                                var percent = -1
                                while (true) {
                                    if (cancelled.get())
                                        throw java.util.concurrent.CancellationException()
                                    val count = input.read(buffer)
                                    if (count == -1) break
                                    total += count
                                    require(total <= release.size) {
                                        "Update download is larger than expected"
                                    }
                                    output.write(buffer, 0, count)
                                    val nextPercent = (total * 100 / release.size).toInt()
                                    if (nextPercent != percent) {
                                        percent = nextPercent
                                        main.post { progress.progress = nextPercent }
                                    }
                                }
                                require(total == release.size) { "Update download was incomplete" }
                            }
                        }
                    } finally {
                        connection.disconnect()
                    }
                    require(partial.renameTo(apk)) { "Could not save the update" }
                }
                main.post { progress.setTitle("Verifying update") }
                if (cancelled.get()) throw java.util.concurrent.CancellationException()
                val digest = MessageDigest.getInstance("SHA-256")
                apk.inputStream().use { input ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val count = input.read(buffer)
                        if (count == -1) break
                        digest.update(buffer, 0, count)
                    }
                }
                require(digest.digest().joinToString("") { "%02x".format(it) } == release.digest) {
                    "Update checksum did not match"
                }
                @Suppress("DEPRECATION")
                val archive =
                    activity.packageManager.getPackageArchiveInfo(apk.path, signatureFlags())
                        ?: error("Invalid APK")
                val current = installed()
                require(
                    archive.packageName == activity.packageName &&
                        archive.versionName == release.version &&
                        versionCode(archive) > versionCode(current)
                ) {
                    "APK is not a newer Offdesk release"
                }
                require(
                    signatures(current).isNotEmpty() && signatures(archive) == signatures(current)
                ) {
                    "APK signature does not match this installation"
                }
                val openInstaller = openInstaller@{
                    try {
                        progress.dismiss()
                        if (cancelled.get()) {
                            finish(invoke, "cancelled")
                            return@openInstaller
                        }
                        val uri =
                            FileProvider.getUriForFile(
                                activity,
                                "${activity.packageName}.fileprovider",
                                apk,
                            )
                        activity.startActivity(
                            Intent(Intent.ACTION_VIEW)
                                .setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        )
                        finish(invoke, "installer-opened")
                    } catch (e: Exception) {
                        apk.delete()
                        fail(invoke, e)
                    }
                }
                main.post {
                    if (foreground) openInstaller() else readyToInstall = openInstaller
                }
            } catch (e: Exception) {
                partial.delete()
                apk.delete()
                main.post { progress.dismiss() }
                if (e is java.util.concurrent.CancellationException) finish(invoke, "cancelled")
                else fail(invoke, e)
            }
        }
    }
}

private fun java.io.InputStream.readBytesLimited(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer)
        if (count == -1) break
        require(output.size() + count <= limit) { "Update response is too large" }
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}
