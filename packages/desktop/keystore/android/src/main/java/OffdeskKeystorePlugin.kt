package dev.offdesk.keystore

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class StoreArgs { lateinit var slot: String; var value: String? = null }

// No JavaScript commands are registered by this plugin. Only the Rust bridge
// calls these methods. The AES key never leaves Android KeyStore.
@TauriPlugin
class OffdeskKeystorePlugin(private val activity: Activity): Plugin(activity) {
    private val alias = "offdesk.secure.v1"
    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create) { "Missing device key; pair again" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }
    private fun preferences() = activity.getSharedPreferences("offdesk_secure", Context.MODE_PRIVATE)
    private fun validate(slot: String) { require(slot == "connection" || slot == "candidate") }
    @Command
    fun read(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StoreArgs::class.java); validate(args.slot)
            val stored = preferences().getString(args.slot, null)
            val result = JSObject()
            if (stored != null) {
                val bytes = Base64.decode(stored, Base64.NO_WRAP)
                require(bytes.size >= 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
                cipher.updateAAD(args.slot.toByteArray(Charsets.UTF_8))
                result.put("value", String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
            }
            invoke.resolve(result)
        } catch (_: Exception) { invoke.reject("Could not unlock Android KeyStore. Pair again from your Hub.") }
    }
    @Command
    fun write(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StoreArgs::class.java); validate(args.slot)
            val editor = preferences().edit()
            val value = args.value
            if (value == null) { editor.remove(args.slot) } else {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, key(true))
                cipher.updateAAD(args.slot.toByteArray(Charsets.UTF_8))
                val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                editor.putString(args.slot, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            }
            check(editor.commit())
            invoke.resolve(JSObject())
        } catch (_: Exception) { invoke.reject("Could not save to Android KeyStore") }
    }
}
