package dev.offdesk.native

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import org.json.JSONObject

data class NativeTerminalSummary(
    val id: String,
    val machineId: String,
    val title: String,
    val cwd: String,
    val waiting: Boolean,
    val working: Boolean,
)

/**
 * Full native Android Agent Console shell backed by `liboffdesk_term.so` (120Hz Vulkan GPU).
 * Zero WebView / zero xterm.js: native Jetpack Compose header, sessions sheet, and IME input bar
 * wrapping the shared Rust GPU terminal surface.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NativeConsoleScreen(
    hubUrl: String,
    token: String,
    deviceId: String,
) {
    var surfaceViewRef by remember { mutableStateOf<NativeTerminalSurfaceView?>(null) }
    var terminals by remember { mutableStateOf<List<NativeTerminalSummary>>(emptyList()) }
    var activeId by remember { mutableStateOf<String?>(null) }
    var sheetOpen by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf("all") }
    var composeText by remember { mutableStateOf("") }
    var showKeys by remember { mutableStateOf(false) }

    // Poll inventory JSON from the Rust Hub worker every 1.5s.
    LaunchedEffect(surfaceViewRef) {
        while (true) {
            val view = surfaceViewRef
            if (view != null) {
                val raw = view.getInventoryJson()
                val parsed = parseInventoryJson(raw)
                terminals = parsed
                if (activeId == null && parsed.isNotEmpty()) {
                    val first = parsed.first()
                    activeId = first.id
                    view.selectTerminal(first.machineId, first.id)
                }
            }
            delay(1500)
        }
    }

    val active = terminals.firstOrNull { it.id == activeId }
    val otherWaiting = terminals.firstOrNull { it.waiting && it.id != activeId }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF131415))
            .systemBarsPadding()
    ) {
        // Top bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .background(Color(0xFF17181B))
                .padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Surface(
                modifier = Modifier
                    .weight(1f)
                    .clickable { sheetOpen = true },
                color = Color(0xFF202227),
                shape = RoundedCornerShape(6.dp),
            ) {
                Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp)) {
                    Text(
                        text = active?.title ?: "Connecting…",
                        color = Color(0xFFF2F2F5),
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        text = active?.cwd ?: hubUrl,
                        color = Color(0xFF8E939E),
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            if (otherWaiting != null) {
                Surface(
                    modifier = Modifier.clickable {
                        activeId = otherWaiting.id
                        surfaceViewRef?.selectTerminal(otherWaiting.machineId, otherWaiting.id)
                    },
                    color = Color(0x33EF4444),
                    shape = RoundedCornerShape(999.dp),
                ) {
                    Text(
                        text = "● waiting",
                        color = Color(0xFFEF4444),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
                    )
                }
            }
        }

        // Full-bleed 120Hz Rust wgpu + glyphon terminal surface
        AndroidView(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            factory = { ctx ->
                NativeTerminalSurfaceView(ctx).also { view ->
                    view.connect(hubUrl, token, deviceId)
                    surfaceViewRef = view
                }
            },
        )

        // Native Compose input bar (full Android Chinese IME + voice dictation)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF17181B))
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            OutlinedTextField(
                value = composeText,
                onValueChange = { composeText = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message agent…", color = Color(0xFF777C87), fontSize = 14.sp) },
                maxLines = 4,
                singleLine = false,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    focusedBorderColor = Color(0xFF60A5FA),
                    unfocusedBorderColor = Color(0xFF2D3038),
                ),
            )
            TextButton(onClick = { showKeys = !showKeys }) {
                Text(if (showKeys) "⌄" else "⌨", color = Color(0xFFB4B8C2), fontSize = 16.sp)
            }
            Button(
                enabled = composeText.isNotEmpty(),
                onClick = {
                    surfaceViewRef?.sendText(composeText, appendEnter = true)
                    composeText = ""
                },
                shape = RoundedCornerShape(8.dp),
            ) {
                Text("↑")
            }
        }

        if (showKeys) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF17181B))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                val quickKeys = listOf(
                    "^C" to byteArrayOf(0x03),
                    "esc" to byteArrayOf(0x1B),
                    "tab" to byteArrayOf(0x09),
                    "↑" to "\u001b[A".toByteArray(),
                    "↓" to "\u001b[B".toByteArray(),
                    "enter" to byteArrayOf(0x0D),
                )
                for ((label, bytes) in quickKeys) {
                    TextButton(onClick = { surfaceViewRef?.sendRawBytes(bytes) }) {
                        Text(label, color = Color(0xFFE4E4E7), fontSize = 12.sp)
                    }
                }
            }
        }
    }

    if (sheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { sheetOpen = false },
            containerColor = Color(0xFF17181B),
        ) {
            Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    listOf("all" to "All", "waiting" to "Waiting", "working" to "Working").forEach { (id, label) ->
                        FilterChip(
                            selected = filter == id,
                            onClick = { filter = id },
                            label = { Text(label) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                val filtered = terminals.filter {
                    when (filter) {
                        "waiting" -> it.waiting
                        "working" -> it.working
                        else -> true
                    }
                }
                LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                    items(filtered, key = { it.id }) { item ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    activeId = item.id
                                    surfaceViewRef?.selectTerminal(item.machineId, item.id)
                                    sheetOpen = false
                                }
                                .padding(vertical = 10.dp, horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            item.waiting -> Color(0xFFEF4444)
                                            item.working -> Color(0xFF22C55E)
                                            else -> Color(0xFF52525B)
                                        }
                                    )
                            )
                            Text(
                                text = item.title,
                                color = if (item.id == activeId) Color.White else Color(0xFFD4D4D8),
                                fontWeight = if (item.id == activeId) FontWeight.Bold else FontWeight.Normal,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun parseInventoryJson(raw: String): List<NativeTerminalSummary> {
    val root = runCatching { JSONObject(raw) }.getOrNull() ?: return emptyList()
    val arr = root.optJSONArray("terminals") ?: return emptyList()
    val now = System.currentTimeMillis()
    return (0 until arr.length()).mapNotNull { idx ->
        val obj = arr.optJSONObject(idx) ?: return@mapNotNull null
        val lastMs = obj.optLong("last_activity_ms", 0L)
        NativeTerminalSummary(
            id = obj.optString("id"),
            machineId = obj.optString("machine_id"),
            title = obj.optString("title", "shell"),
            cwd = obj.optString("cwd", ""),
            waiting = obj.optBoolean("waiting", false),
            working = lastMs > 0 && (now - lastMs) < 60_000L,
        )
    }
}
