import { useState } from "react";
import { ArrowUp, ArrowDown, X } from "lucide-react";
import { DEFAULT_KEYBAR_LAYOUT, KEYBAR_KEYS, saveKeyBarLayout, useKeyBarLayout, type KeyBarKey, type KeyBarLayout } from "@/lib/keyBarPreferences";
import { ExtendedKeyBar } from "./ExtendedKeyBar";
import "./KeyBarSettings.css";

const noop = () => {};
export function KeyBarSettings() {
  const layout = useKeyBarLayout();
  const [error, setError] = useState(false);
  const save = (value: KeyBarLayout) => setError(!saveKeyBarLayout(value));
  const available = (Object.keys(KEYBAR_KEYS) as KeyBarKey[]).filter(id => !layout.primary.includes(id) && !layout.secondary.includes(id));
  const move = (row: keyof KeyBarLayout, index: number, delta: number) => {
    const keys = [...layout[row]];
    [keys[index], keys[index + delta]] = [keys[index + delta], keys[index]];
    save({ ...layout, [row]: keys });
  };
  const transfer = (row: keyof KeyBarLayout, id: KeyBarKey) => {
    const other = row === "primary" ? "secondary" : "primary";
    if (other === "primary" && layout.primary.length >= 5) return;
    save({ ...layout, [row]: layout[row].filter(key => key !== id), [other]: [...layout[other], id] });
  };
  return <section className="offdesk-keybar-settings" data-testid="keybar-settings">
    <h2>Terminal keys</h2>
    <p>Arrow keys, Enter and the keyboard button stay in place. Choose the other keys to match how you work. Saved on this device.</p>
    <details>
      <summary>Customize terminal keys</summary>
      <p>First row: up to 5 keys. Second row: swipe to reach more keys. Keep Ctrl+C on the left to avoid accidental interrupts near Enter.</p>
      <div aria-label="Terminal key layout preview" className="offdesk-keybar-preview" inert>
        <ExtendedKeyBar layout={layout} onKey={noop} onToggleKeyboard={noop} keyboardVisible={false} isController
          onToggleCtrl={noop} onToggleShift={noop} onShiftPress={noop} onShiftRelease={noop}
          onPasteText={noop} onAttachFile={noop} onEnterSelectMode={noop} onExitSelectMode={noop} onCopySelection={() => null} />
      </div>
      {(["primary", "secondary"] as const).map(row => <div key={row} className="offdesk-keybar-editor" data-testid={`keybar-editor-${row}`}>
        <h3>{row === "primary" ? "First row" : "Second row · scrollable"}</h3>
        <ol>
          {layout[row].map((id, index) => <li key={id} data-key={id}>
            <span>{KEYBAR_KEYS[id]}</span>
            <div className="offdesk-keybar-edit-actions">
              <button type="button" aria-label={`Move ${KEYBAR_KEYS[id]} earlier`} disabled={index === 0} onClick={() => move(row, index, -1)}><ArrowUp size={16} aria-hidden /></button>
              <button type="button" aria-label={`Move ${KEYBAR_KEYS[id]} later`} disabled={index === layout[row].length - 1} onClick={() => move(row, index, 1)}><ArrowDown size={16} aria-hidden /></button>
              <button type="button" aria-label={`Move ${KEYBAR_KEYS[id]} to ${row === "primary" ? "second" : "first"} row`}
                disabled={row === "secondary" && layout.primary.length >= 5} onClick={() => transfer(row, id)}>{row === "primary" ? "Row 2" : "Row 1"}</button>
              <button type="button" aria-label={`Hide ${KEYBAR_KEYS[id]}`} onClick={() => save({ ...layout, [row]: layout[row].filter(key => key !== id) })}><X size={16} aria-hidden /></button>
            </div>
          </li>)}
        </ol>
        <select aria-label={`Add key to ${row === "primary" ? "first" : "second"} row`} value=""
          disabled={!available.length || (row === "primary" && layout.primary.length >= 5)}
          onChange={event => { if (event.target.value) save({ ...layout, [row]: [...layout[row], event.target.value as KeyBarKey] }); }}>
          <option value="">{row === "primary" && layout.primary.length >= 5 ? "First row is full · move or hide a key" : "Add a key…"}</option>
          {available.map(id => <option key={id} value={id}>{KEYBAR_KEYS[id]}</option>)}
        </select>
      </div>)}
      <p>Shift: tap to modify the next key, or hold while pressing other keys. Backspace deletes the character before the cursor; hold to repeat.</p>
      <button type="button" className="offdesk-keybar-reset" onClick={() => save(DEFAULT_KEYBAR_LAYOUT)}>Restore default keys</button>
      {error && <p role="alert">Could not save this layout. Check that local storage is available and try again.</p>}
    </details>
  </section>;
}
