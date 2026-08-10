import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { applyThemeVars, type ThemeMode } from "../theme/theme.ts";
import {
  nextPreference,
  readPreference,
  resolveMode,
  storePreference,
  systemMode,
  watchSystemMode,
  type ThemePreference,
} from "../theme/mode.ts";

export interface ThemeControl {
  /** What the user chose, including "system". */
  readonly preference: ThemePreference;
  /** What that resolves to right now — the only thing the palette sees. */
  readonly mode: ThemeMode;
  /** Advance to the next preference (system → light → dark → system). */
  readonly cycle: () => void;
}

/**
 * `matchMedia` is an external mutable store, so it is read through
 * `useSyncExternalStore` rather than mirrored into state — that keeps the OS
 * value authoritative and re-renders only while the preference is "system".
 *
 * The custom properties are written in a layout effect: it runs before the
 * browser paints, so a mode switch lands in the same frame as the re-render
 * and never flashes the outgoing palette.
 */
export function useThemeMode(): ThemeControl {
  const [preference, setPreference] = useState(readPreference);

  const osMode = useSyncExternalStore(
    useCallback((notify: () => void) => watchSystemMode(notify), []),
    systemMode,
  );

  const mode = preference === "system" ? osMode : resolveMode(preference);

  useLayoutEffect(() => {
    applyThemeVars(mode);
  }, [mode]);

  const cycle = useCallback(() => {
    setPreference((current) => {
      const next = nextPreference(current);
      storePreference(next);
      return next;
    });
  }, []);

  return { preference, mode, cycle };
}
