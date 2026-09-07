package dev.offdesk.updater

import android.app.Activity
import android.app.AlertDialog
import android.os.Looper
import android.provider.Settings
import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class UpdaterDialogsTest {
    private lateinit var activity: Activity
    private lateinit var plugin: OffdeskUpdaterPlugin
    private val release =
        Release(
            "0.6.3",
            "https://github.com/zalify/offdesk/releases/download/app-v0.6.3/offdesk-0.6.3-arm64-v8a.apk",
            1024,
            "a".repeat(64),
        )
    private var response: String? = null

    private fun field(name: String, value: Any?) {
        OffdeskUpdaterPlugin::class
            .java
            .getDeclaredField(name)
            .apply { isAccessible = true }
            .set(plugin, value)
    }

    private fun invocation() =
        Invoke(1, "install", 1, 2, { _, json -> response = json }, "{}", ObjectMapper())

    @Before
    fun setup() {
        activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        plugin = OffdeskUpdaterPlugin(activity)
        field("candidate", release)
        response = null
    }

    @Test
    fun cancellationAllowsAnotherAttemptWithoutStartingInstallation() {
        plugin.install(invocation())
        ShadowAlertDialog.getLatestAlertDialog()
            .getButton(AlertDialog.BUTTON_NEGATIVE)
            .performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(response!!.contains("cancelled"))
        assertNull(shadowOf(activity).nextStartedActivity)
        response = null
        plugin.install(invocation())
        assertTrue(ShadowAlertDialog.getLatestAlertDialog().isShowing)
        assertNull(response)
    }

    @Test
    fun missingInstallPermissionOpensSettingsAndReturnsRetryableStatus() {
        plugin.install(invocation())
        ShadowAlertDialog.getLatestAlertDialog()
            .getButton(AlertDialog.BUTTON_POSITIVE)
            .performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            shadowOf(activity).nextStartedActivity.action,
        )
        assertTrue(response!!.contains("permission-required"))
    }

    @Test
    fun legacyHubPermissionReturnOffersNativeRetryWithoutJavascript() {
        field("pendingPermission", release)
        plugin.onResume()
        shadowOf(Looper.getMainLooper()).idle()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.isShowing)
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun readyInstallerWaitsForResumeAndRunsOnlyOnce() {
        var opened = 0
        field(
            "readyToInstall",
            {
                opened++
                Unit
            },
        )
        plugin.onPause()
        assertEquals(0, opened)
        plugin.onResume()
        assertEquals(1, opened)
        plugin.onResume()
        assertEquals(1, opened)
    }
}
