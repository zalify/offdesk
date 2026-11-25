package dev.offdesk.native

import android.content.Context
import android.util.AttributeSet
import android.view.Choreographer
import android.view.MotionEvent
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import kotlin.math.roundToInt

/**
 * JNI bridge to `liboffdesk_term.so` (crates/native-term).
 * Shares the exact same `wgpu + glyphon + alacritty_terminal` GPU engine as the desktop client.
 */
object NativeTerminalBridge {
    init {
        System.loadLibrary("offdesk_term")
    }

    external fun nativeCreate(hubUrl: String, token: String, deviceId: String, fontSize: Float): Long
    external fun nativeAttachSurface(handle: Long, surface: Surface, width: Int, height: Int): Int
    external fun nativeSelectTerminal(handle: Long, machineId: String, terminalId: String)
    external fun nativeResize(handle: Long, width: Int, height: Int)
    external fun nativeSendInput(handle: Long, bytes: ByteArray)
    external fun nativeScroll(handle: Long, deltaLines: Int)
    external fun nativeRender(handle: Long): Int
    external fun nativeGetInventoryJson(handle: Long): String
    external fun nativeDestroy(handle: Long)
}

/**
 * Drop-in 120Hz GPU-accelerated Android `SurfaceView` backed by `liboffdesk_term.so`.
 * Embed inside Jetpack Compose via `AndroidView` alongside native Compose chrome and IME input bar.
 */
class NativeTerminalSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : SurfaceView(context, attrs), SurfaceHolder.Callback, Choreographer.FrameCallback {

    private var handle: Long = 0L
    private var rendering: Boolean = false
    private var lastTouchY: Float = 0f
    private var scrollAccumulatorPx: Float = 0f
    private val lineHeightPx: Float = 44f

    init {
        holder.addCallback(this)
    }

    fun connect(hubUrl: String, token: String, deviceId: String, fontSizeSp: Float = 14f) {
        releaseHandle()
        val fontSizePx = fontSizeSp * resources.displayMetrics.scaledDensity
        handle = NativeTerminalBridge.nativeCreate(hubUrl, token, deviceId, fontSizePx)
        if (handle != 0L && holder.surface?.isValid == true && width > 0 && height > 0) {
            NativeTerminalBridge.nativeAttachSurface(handle, holder.surface, width, height)
            startRenderLoop()
        }
    }

    fun selectTerminal(machineId: String, terminalId: String) {
        if (handle != 0L) {
            NativeTerminalBridge.nativeSelectTerminal(handle, machineId, terminalId)
        }
    }

    fun sendText(text: String, appendEnter: Boolean = false) {
        if (handle == 0L) return
        val payload = if (appendEnter) "$text\r" else text
        NativeTerminalBridge.nativeSendInput(handle, payload.toByteArray(Charsets.UTF_8))
    }

    fun sendRawBytes(bytes: ByteArray) {
        if (handle != 0L) {
            NativeTerminalBridge.nativeSendInput(handle, bytes)
        }
    }

    fun getInventoryJson(): String {
        return if (handle != 0L) NativeTerminalBridge.nativeGetInventoryJson(handle) else "{}"
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        if (handle != 0L && width > 0 && height > 0) {
            NativeTerminalBridge.nativeAttachSurface(handle, holder.surface, width, height)
            startRenderLoop()
        }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (handle != 0L && width > 0 && height > 0) {
            NativeTerminalBridge.nativeResize(handle, width, height)
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        stopRenderLoop()
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!rendering || handle == 0L) return
        NativeTerminalBridge.nativeRender(handle)
        Choreographer.getInstance().postFrameCallback(this)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (handle == 0L) return super.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastTouchY = event.y
                scrollAccumulatorPx = 0f
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                val dy = event.y - lastTouchY
                lastTouchY = event.y
                scrollAccumulatorPx += dy
                val lines = (scrollAccumulatorPx / lineHeightPx).roundToInt()
                if (lines != 0) {
                    scrollAccumulatorPx -= lines * lineHeightPx
                    NativeTerminalBridge.nativeScroll(handle, lines)
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onDetachedFromWindow() {
        stopRenderLoop()
        releaseHandle()
        super.onDetachedFromWindow()
    }

    private fun startRenderLoop() {
        if (rendering) return
        rendering = true
        Choreographer.getInstance().postFrameCallback(this)
    }

    private fun stopRenderLoop() {
        rendering = false
        Choreographer.getInstance().removeFrameCallback(this)
    }

    private fun releaseHandle() {
        if (handle != 0L) {
            NativeTerminalBridge.nativeDestroy(handle)
            handle = 0L
        }
    }
}
