package dev.offdesk.updater

import org.json.JSONArray

internal data class Release(
    val version: String,
    val url: String,
    val size: Long,
    val digest: String,
)

/** This feed also contains desktop, iOS and Hub releases. Never use /latest. */
internal object ReleasePolicy {
    private fun parts(version: String): List<Int>? {
        if (!Regex("[0-9]+\\.[0-9]+\\.[0-9]+").matches(version)) return null
        return version.split('.').map { it.toIntOrNull() ?: return null }
    }

    fun compare(left: String, right: String): Int {
        val a = parts(left) ?: error("Invalid release version")
        val b = parts(right) ?: error("Invalid installed version")
        for (i in 0..2) if (a[i] != b[i]) return a[i].compareTo(b[i])
        return 0
    }

    fun select(releases: JSONArray, current: String, abis: List<String>): Release? {
        var best: Release? = null
        for (i in 0 until releases.length()) {
            val release = releases.getJSONObject(i)
            if (release.optBoolean("draft") || release.optBoolean("prerelease")) continue
            val tag = release.optString("tag_name")
            if (!tag.startsWith("app-v")) continue
            val version = tag.removePrefix("app-v")
            if (parts(version) == null || compare(version, current) <= 0) continue
            val assets = release.optJSONArray("assets") ?: continue
            val names =
                abis
                    .filter { it == "arm64-v8a" || it == "x86_64" }
                    .map { "offdesk-$version-$it.apk" } + "offdesk-$version-universal.apk"
            val asset =
                names.firstNotNullOfOrNull { name ->
                    (0 until assets.length())
                        .map { assets.getJSONObject(it) }
                        .firstOrNull { it.optString("name") == name }
                } ?: continue
            val url = asset.optString("browser_download_url")
            val expected =
                "https://github.com/zalify/offdesk/releases/download/$tag/${asset.getString("name")}"
            val size = asset.optLong("size")
            val digest = asset.optString("digest")
            if (
                url != expected ||
                    size !in 1..268435456 ||
                    !Regex("sha256:[0-9a-f]{64}").matches(digest)
            )
                continue
            if (best == null || compare(version, best.version) > 0)
                best = Release(version, url, size, digest.removePrefix("sha256:"))
        }
        return best
    }
}
