// Something outside Settings — the update card, the status line, the phone
// panel's warning — asks for Settings at one section. TerminalCanvas owns
// whether Settings shows; SettingsPage scrolls to the section, taking the
// request when it mounts (it loads lazily, after the ask) or as it comes.

type Listener = (section: string | null) => void;
const listeners = new Set<Listener>();
let requested: string | null = null;

/** Open Settings, at the section titled `section` ("Versions") when given. */
export function openSettings(section: string | null = null): void {
  requested = section;
  listeners.forEach((listener) => listener(section));
}

export function subscribeOpenSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The section asked for, once. */
export function takeRequestedSection(): string | null {
  const section = requested;
  requested = null;
  return section;
}
