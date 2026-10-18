// Back/forward between a screen's own same-page entries (the terminal
// screen's #/t/<id>, Android's back button included) belongs to that screen.
// Expo Router listens for popstate too, and on an entry it did not push it
// resets its navigation root, remounting the screen. Its listener is added
// when the router mounts; this one is added when the app's modules load,
// before it, and so runs first (window listeners run in the order they were
// added, whatever their phase). A pop that stays on the claiming screen's
// path goes to that screen and no further.

type Claim = { path: string; onPop: () => void };

let claim: Claim | null = null;

/** Take this page's same-path pops; returns the release. */
export function claimSamePagePops(onPop: () => void): () => void {
  const entry: Claim = { path: currentPath(), onPop };
  claim = entry;
  return () => {
    if (claim === entry) claim = null;
  };
}

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "popstate",
    (event) => {
      if (!claim || currentPath() !== claim.path) return;
      event.stopImmediatePropagation();
      claim.onPop();
    },
    true,
  );
}
