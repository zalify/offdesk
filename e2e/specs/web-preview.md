# Private Web Preview: Hub relay and browser handoff

## Setup

- Run the current worktree with `pnpm e2e:test`; use the container browser and preview-edge HTTPS fixture from `e2e/env-playbook.md`.
- Sign into the test Hub, reset the machine's terminals/workspaces, and take control.
- Start `/opt/offdesk/preview-fixture/server.mjs` on the node and wait for `PREVIEW_FIXTURE_READY`. It runs actual Vite and Next development servers on loopback ports 5127 and 5128.
- The executable specification is `e2e/tests/web-preview.spec.ts`. Native behavior is emulated only at the OS opener boundary; a clean Pixel 7 browser context receives its URL.

## Steps

1. **action:** Right click the terminal pane and select **Open web preview**.
   **eval:** The dialog contains **Local address** and **Open in browser**.
2. **action:** Enter `http://localhost:5127/` and click **Open in browser**.
   **eval:** A new HTTPS preview hostname shows **Vite preview ready**. The dialog retains **open preview here**, with **Done** to close it. The preview has no Hub token in localStorage; its authentication cookie is Secure and HttpOnly.
3. **action:** Click **Navigate**, then change the Vite fixture's module through another node terminal.
   **eval:** The nested path and query survive. The heading becomes **Vite preview updated** over real HMR without replacing the document.
4. **action:** Print `http://localhost:5128/` in a terminal, select that terminal's tab, and click the URL. Open the URL handed to the native opener in an independent mobile browser context without a Hub login.
   **eval:** **Next preview ready** appears. The one-use code is removed from the address, no Hub token is present, and refresh remains authenticated.
5. **action:** Update the Next fixture source through the node terminal.
   **eval:** The mobile heading changes to **Next preview updated**.
6. **action:** In an anonymous context open the preview URL, then replay the consumed launch URL. Attempt a sibling-preview cross-origin request.
   **eval:** Direct access returns 401; replay reports the expired/already-used link; CORS does not disclose the sibling response.
7. **action:** Revoke the lease through the authenticated Hub API and reload the mobile page.
   **eval:** It returns 410. Close the remaining test leases and contexts.

## Related regression checks

The same container run includes touch terminal hyperlinks and desktop Fit sizing. These retain their existing specifications; this spec adds the private-preview flow only.

## Compact phone entry

At 390px width, tap the session title, then the machine name. **Open web preview**
opens the same dialog inside the compact workspace. A blocked popup retains the
launcher link. Reopening the dialog lists existing previews, and **Close preview**
revokes the lease through the API.
