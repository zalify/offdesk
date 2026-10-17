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
    fun readsTheOneReleasePerVersionAndItsTransitionalCopy() {
        val unified = { version: String ->
            val tag = "v$version"
            release(version, "arm64-v8a").also { json ->
                json.put("tag_name", tag)
                val asset = json.getJSONArray("assets").getJSONObject(0)
                asset.put(
                    "browser_download_url",
                    "https://github.com/zalify/offdesk/releases/download/$tag/${asset.getString("name")}",
                )
            }
        }
        val picked = select(release("0.23.0", "arm64-v8a"), unified("0.23.0"), unified("0.24.0"))
        assertEquals("0.24.0", picked?.version)
        assertEquals(
            "https://github.com/zalify/offdesk/releases/download/v0.24.0/offdesk-0.24.0-arm64-v8a.apk",
            picked?.url,
        )
        // Web UI channels and older platform tags are not Android releases.
        assertNull(select(unified("0.30.0").put("tag_name", "ui-stable")))
        assertNull(select(unified("0.30.0").put("tag_name", "ios-v0.30.0")))
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
    fun takesOffdeskDevCopiesOfThisReleaseWithGitHubAsTheFallback() {
        val mirrored = release("0.25.0", "arm64-v8a").put("tag_name", "v0.25.0")
        mirrored
            .getJSONArray("assets")
            .getJSONObject(0)
            .put(
                "browser_download_url",
                "https://offdesk.dev/download/v0.25.0/offdesk-0.25.0-arm64-v8a.apk",
            )
        val picked = select(mirrored)!!
        assertEquals("https://offdesk.dev/download/v0.25.0/offdesk-0.25.0-arm64-v8a.apk", picked.url)
        assertEquals(
            "https://github.com/zalify/offdesk/releases/download/v0.25.0/offdesk-0.25.0-arm64-v8a.apk",
            picked.fallbackUrl,
        )
        // A GitHub link needs no fallback.
        assertNull(select(release("0.25.0", "arm64-v8a"))!!.fallbackUrl)
    }

    @Test
    fun rejectsOffdeskDevLinksToAnyOtherFile() {
        for (url in
            listOf(
                "https://offdesk.dev/download/v0.24.0/offdesk-0.25.0-arm64-v8a.apk",
                "https://offdesk.dev/download/app-v0.25.0/offdesk-0.25.0-universal.apk",
                "https://offdesk.dev/updates/offdesk-0.25.0-arm64-v8a.apk",
                "http://offdesk.dev/download/app-v0.25.0/offdesk-0.25.0-arm64-v8a.apk",
                "https://offdesk.dev.evil.example/download/app-v0.25.0/offdesk-0.25.0-arm64-v8a.apk",
            )) {
            val bad = release("0.25.0", "arm64-v8a")
            bad.getJSONArray("assets").getJSONObject(0).put("browser_download_url", url)
            assertNull(url, select(bad))
        }
    }

    @Test
    fun readsOffdeskDevFirstAndGitHubSecond() {
        assertEquals("https://offdesk.dev/updates/releases.json", RELEASE_FEEDS[0])
        assertTrue(RELEASE_FEEDS[1].startsWith("https://api.github.com/repos/zalify/offdesk/releases"))
    }

    private val update = Release("0.25.0", "https://offdesk.dev/download/v0.25.0/a.apk", 1, "a")

    @Test
    fun theFirstFeedOfferingAnUpdateWins() {
        val asked = mutableListOf<String>()
        val found = newestFromFeeds(listOf("mirror", "github")) { asked.add(it); update }
        assertEquals(update, found)
        assertEquals(listOf("mirror"), asked)
    }

    @Test
    fun aFailingMirrorFallsBackToGitHub() {
        val found =
            newestFromFeeds(listOf("mirror", "github")) {
                if (it == "mirror") error("offline") else update
            }
        assertEquals(update, found)
    }

    @Test
    fun aMirrorWithNothingNewerIsCheckedAgainstGitHubWhoseFailureIsNoError() {
        // offdesk.dev lags a release GitHub has:
        assertEquals(
            update,
            newestFromFeeds(listOf("mirror", "github")) { if (it == "mirror") null else update },
        )
        // GitHub unreachable, as in mainland China: simply no update.
        assertNull(
            newestFromFeeds(listOf("mirror", "github")) {
                if (it == "mirror") null else error("unreachable")
            }
        )
    }

    @Test
    fun noFeedAnsweringIsAnError() {
        val error =
            assertThrows(IllegalStateException::class.java) {
                newestFromFeeds(listOf("mirror", "github")) { error("down: $it") }
            }
        assertEquals("down: github", error.message)
    }

    @Test
    fun downloadsTryTheMirrorThenGitHub() {
        assertEquals("github", firstAnswer(listOf("mirror", "github")) { if (it == "mirror") error("x") else it })
        assertEquals("mirror", firstAnswer(listOf("mirror", "github")) { it })
    }

    @Test
    fun rejectsMalformedAndPrereleaseVersionTags() {
        assertNull(
            select(release("0.7.0-rc.1", "arm64-v8a"), release("999999999999.0.0", "arm64-v8a"))
        )
        assertTrue(ReleasePolicy.compare("1.0.0", "0.99.99") > 0)
    }
}
