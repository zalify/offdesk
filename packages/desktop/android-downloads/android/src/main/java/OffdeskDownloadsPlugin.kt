package dev.offdesk.downloads

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

private const val FOLDER = "Offdesk"

@TauriPlugin(
    permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "storage")]
)
class OffdeskDownloadsPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun save(invoke: Invoke) {
        // Only API 24-28 needs a runtime grant; MediaStore covers 29+.
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("storage").toString() != "granted") {
            requestPermissionForAlias("storage", invoke, "storageResult")
            return
        }
        write(invoke)
    }

    @PermissionCallback
    fun storageResult(invoke: Invoke) {
        if (getPermissionState("storage").toString() == "granted") write(invoke)
        else invoke.reject("Storage permission was denied")
    }

    private fun write(invoke: Invoke) {
        val args = invoke.getArgs()
        val filename = args.optString("filename")
        val mime = args.optString("mime").takeUnless { it.isBlank() } ?: "application/octet-stream"
        val data = args.optString("dataBase64")
        if (filename.isBlank() || data.isEmpty()) {
            invoke.reject("filename and dataBase64 are required")
            return
        }
        // Decoding and writing can be tens of MiB; keep it off the IPC thread.
        Thread {
            try {
                val bytes = Base64.decode(data, Base64.DEFAULT)
                val result = if (Build.VERSION.SDK_INT >= 29) saveScoped(filename, mime, bytes)
                else saveLegacy(filename, bytes)
                invoke.resolve(result)
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Could not save the file")
            }
        }.start()
    }

    private fun saveScoped(filename: String, mime: String, bytes: ByteArray): JSObject {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values) ?: error("Could not create the download")
        try {
            val out: OutputStream = resolver.openOutputStream(uri) ?: error("Could not open the download")
            out.use { it.write(bytes) }
            val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        // The system may have renamed it to avoid a clash; report the real name.
        val shown = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: filename
        return JSObject().apply {
            put("path", "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER/$shown")
            put("uri", uri.toString())
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(filename: String, bytes: ByteArray): JSObject {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER)
        if (!dir.isDirectory && !dir.mkdirs()) error("Could not create the Download folder")
        val dot = filename.lastIndexOf('.')
        val stem = if (dot > 0) filename.substring(0, dot) else filename
        val ext = if (dot > 0) filename.substring(dot) else ""
        var target = File(dir, filename)
        var n = 1
        while (target.exists()) target = File(dir, "$stem ($n)$ext").also { n += 1 }
        FileOutputStream(target).use { it.write(bytes) }
        return JSObject().apply {
            put("path", "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER/${target.name}")
            // No content uri below API 29; the file path is enough to display.
            put("uri", null)
        }
    }

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.getArgs()
        val uri = args.optString("uri")
        if (uri.isBlank()) {
            invoke.reject("No file to open")
            return
        }
        val mime = args.optString("mime").takeUnless { it.isBlank() } ?: "*/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(uri), mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
            invoke.resolve()
        } catch (_: ActivityNotFoundException) {
            invoke.reject("No app can open this file. Find it in Downloads/Offdesk.")
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not open the file")
        }
    }
}
