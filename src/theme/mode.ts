/**
 * Which of the two lightings in theme.ts is active, and why.
 *
 * The user picks a *preference*, not a mode: "system" defers to the OS, and is
 * the default because an unasked-for theme is a worse guess than the one the
 * user already made for every other app. "light"/"dark" pin it. Only the
 * resolved `ThemeMode` reaches the palette.
 *
 * Framework-free on purpose — main.tsx needs the mode before React exists, so
 * this cannot be a hook. src/ui/useThemeMode.ts wraps it for components.
 */

import type { ThemeMode } from "./theme.ts";

export type ThemePreference = "system" | "light" | "dark";

/**
 * Also read by the pre-paint snippet in index.html, which cannot import from
 * here. Changing this key means changing it there too.
 */
const STORAGE_KEY = "sigha:theme";

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function isPreference(value: unknown): value is ThemePreference {
  return PREFERENCES.includes(value as ThemePreference);
}

/** The OS-level choice. Without `matchMedia`, fall back to the original theme. */
export function systemMode(): ThemeMode {
  return typeof window.matchMedia === "function" &&
    window.matchMedia(LIGHT_QUERY).matches
    ? "light"
    : "dark";
}

export function resolveMode(preference: ThemePreference): ThemeMode {
  return preference === "system" ? systemMode() : preference;
}

/**
 * Storage access is guarded: a browser with cookies/site-data blocked throws
 * on `localStorage` access rather than returning null, and a theme preference
 * is never worth taking the page down for.
 */
export function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Preference is best-effort; the in-memory choice still applies.
  }
}

/** The order the toolbar control cycles through. */
export function nextPreference(current: ThemePreference): ThemePreference {
  const i = PREFERENCES.indexOf(current);
  return PREFERENCES[(i + 1) % PREFERENCES.length] ?? "system";
}

/**
 * Watch for the OS flipping (a scheduled night shift, say). Callers are
 * expected to ignore this while the preference is pinned; subscribing
 * unconditionally keeps the listener lifecycle off the preference state.
 * Returns an unsubscribe.
 */
export function watchSystemMode(
  onChange: (mode: ThemeMode) => void,
): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(LIGHT_QUERY);
  const listener = (e: MediaQueryListEvent) =>
    onChange(e.matches ? "light" : "dark");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
