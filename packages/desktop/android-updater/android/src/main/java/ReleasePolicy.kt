package dev.offdesk.updater

import org.json.JSONArray

internal data class Release(
    val version: String,
    val url: String,
    val size: Long,
    val digest: String,
    /** GitHub's copy, when [url] is offdesk.dev's: tried if the mirror fails. */
    val fallbackUrl: String? = null,
)

/** Where release listings are read, in order: offdesk.dev's copy of GitHub's
 * listing first (github.com is unreliable from mainland China), then GitHub. */
internal val RELEASE_FEEDS =
    listOf(
        "https://offdesk.dev/updates/releases.json",
        "https://api.github.com/repos/zalify/offdesk/releases?per_page=100",
    )

/**
 * Releases are `vX.Y.Z` (every component, from 0.23.0) or, before that and as a
 * transitional copy, `app-vX.Y.Z`. The feed also holds older desktop-v/ios-v
 * releases and Web UI channels. Never use /latest.
 */
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
            val version =
                when {
                    tag.startsWith("app-v") -> tag.removePrefix("app-v")
                    tag.startsWith("v") -> tag.removePrefix("v")
                    else -> continue
                }
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
            // The file of this very release, from GitHub or from offdesk.dev's
            // copy of it; nothing else. The digest pins the bytes either way.
            val name = asset.getString("name")
            val github = "https://github.com/zalify/offdesk/releases/download/$tag/$name"
            val mirror = "https://offdesk.dev/download/$tag/$name"
            val size = asset.optLong("size")
            val digest = asset.optString("digest")
            if (
                (url != github && url != mirror) ||
                    size !in 1..268435456 ||
                    !Regex("sha256:[0-9a-f]{64}").matches(digest)
            )
                continue
            if (best == null || compare(version, best.version) > 0)
                best =
                    Release(
                        version,
                        url,
                        size,
                        digest.removePrefix("sha256:"),
                        if (url == mirror) github else null,
                    )
        }
        return best
    }
}
