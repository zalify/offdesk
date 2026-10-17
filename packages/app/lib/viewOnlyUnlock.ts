import { createContext } from "react";

/**
 * Turns this device's view-only lock off, for the key bar's "turn off".
 * Null outside the terminal canvas (the Settings key bar preview).
 */
export const ViewOnlyUnlockContext = createContext<(() => void) | null>(null);
