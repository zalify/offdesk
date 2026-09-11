import { useCallback, useEffect, useRef, useState } from "react";
import { ctrlLatchTransform } from "./ctrlLatch";
import { shiftKeyTransform } from "./shiftKey";

export function useTerminalModifiers(terminalId: string, enabled: boolean) {
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [shiftArmed, setShiftArmed] = useState(false);
  const ctrl = useRef(false);
  const shift = useRef({ armed: false, held: false, used: false, started: 0 });
  const setCtrl = useCallback((value: boolean) => { ctrl.current = value; setCtrlArmed(value); }, []);
  const showShift = useCallback(() => setShiftArmed(shift.current.armed || shift.current.held), []);
  const clear = useCallback(() => {
    setCtrl(false);
    shift.current = { armed: false, held: false, used: false, started: 0 };
    showShift();
  }, [setCtrl, showShift]);
  useEffect(clear, [clear, terminalId, enabled]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) clear(); };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", clear); document.removeEventListener("visibilitychange", hidden); };
  }, [clear]);
  const transform = useCallback((data: string) => {
    if (!enabled) return data;
    const withCtrl = ctrl.current;
    if (withCtrl) setCtrl(false);
    const current = shift.current;
    if (current.held || current.armed) {
      current.used = true;
      current.armed = false;
      data = shiftKeyTransform(data, withCtrl);
      showShift();
    }
    return withCtrl ? ctrlLatchTransform(data) ?? data : data;
  }, [enabled, setCtrl, showShift]);
  return {
    ctrlArmed, shiftArmed, transform,
    toggleCtrl: useCallback(() => { if (enabled) setCtrl(!ctrl.current); }, [enabled, setCtrl]),
    toggleShift: useCallback(() => {
      if (!enabled) return;
      shift.current.armed = !shift.current.armed; showShift();
    }, [enabled, showShift]),
    pressShift: useCallback(() => {
      if (!enabled) return;
      Object.assign(shift.current, { held: true, used: false, started: performance.now() });
      showShift();
    }, [enabled, showShift]),
    releaseShift: useCallback((cancelled: boolean) => {
      const current = shift.current;
      if (!current.held && !cancelled) return;
      current.held = false;
      current.armed = !cancelled && !current.used && performance.now() - current.started < 350 && !current.armed;
      showShift();
    }, [showShift]),
  };
}
