package dev.offdesk.updater

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ReleasePolicyTest {
    private fun release(version: String, vararg abis: String): JSONObject {
        val tag = "app-v$version"
        return JSONObject()
            .put("tag_name", tag)
            .put("draft", false)
            .put("prerelease", false)
            .put(
                "assets",
                JSONArray(
                    abis.map { abi ->
                        val name = "offdesk-$version-$abi.apk"
                        JSONObject()
                            .put("name", name)
                            .put("size", 1024)
                            .put("digest", "sha256:" + "a".repeat(64))
                            .put(
                                "browser_download_url",
                                "https://github.com/zalify/offdesk/releases/download/$tag/$name",
                            )
                    }
                ),
            )
    }

    private fun select(
        vararg releases: JSONObject,
        current: String = "0.6.2",
        abis: List<String> = listOf("arm64-v8a"),
    ) = ReleasePolicy.select(JSONArray(releases.toList()), current, abis)

    @Test
    fun selectsNumericNewestAndroidReleaseRegardlessOfFeedOrder() {
        val unrelated = release("0.99.0", "arm64-v8a").put("tag_name", "desktop-v0.99.0")
        assertEquals(
            "0.10.0",
            select(release("0.9.0", "arm64-v8a"), unrelated, release("0.10.0", "arm64-v8a"))
                ?.version,
        )
    }

    @Test
    fun skipsDraftPrereleaseCurrentAndDowngrade() {
        assertNull(
            select(
                release("0.7.0", "arm64-v8a").put("draft", true),
                release("0.8.0", "arm64-v8a").put("prerelease", true),
                release("0.6.2", "arm64-v8a"),
                release("0.6.1", "arm64-v8a"),
            )
        )
    }

    @Test
    fun choosesMatchingAbiAndFallsBackToUniversal() {
        val mixed = release("0.6.3", "x86_64", "universal", "arm64-v8a")
        assertTrue(select(mixed)!!.url.endsWith("arm64-v8a.apk"))
        assertTrue(select(mixed, abis = listOf("x86_64"))!!.url.endsWith("x86_64.apk"))
        assertTrue(select(release("0.6.3", "universal"))!!.url.endsWith("universal.apk"))
        assertNull(select(release("0.6.3", "x86_64")))
    }

    @Test
    fun rejectsForeignDownloadsMissingDigestAndInvalidSize() {
        for ((field, value) in
            listOf(
                "browser_download_url" to "https://evil.example/update.apk",
                "digest" to "",
                "size" to 0,
            )) {
            val bad = release("0.6.3", "arm64-v8a")
            bad.getJSONArray("assets").getJSONObject(0).put(field, value)
            assertNull(select(bad))
        }
    }

    @Test
    fun rejectsMalformedAndPrereleaseVersionTags() {
        assertNull(
            select(release("0.7.0-rc.1", "arm64-v8a"), release("999999999999.0.0", "arm64-v8a"))
        )
        assertTrue(ReleasePolicy.compare("1.0.0", "0.99.99") > 0)
    }
}
