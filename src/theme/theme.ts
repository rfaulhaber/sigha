/**
 * Single source of truth for branding and visual identity.
 *
 * Keep the product name, palette, fonts, and any cross-linking here so a
 * rebrand is a one-file change — no Salesforce semantics should leak into
 * components. Product *copy* is translatable prose and lives in i18n/
 * (en/copy.ts), not here.
 *
 * Visual direction: "calibrated instrument." The tool's promise is
 * Salesforce-internals accuracy, so the page reads as a precision bench
 * instrument — ink field, blueprint grid, hairline module panels, phosphor
 * signal accent, LED readout — with an Instrument Serif nameplate as the one
 * editorial counterpoint. The UI is deliberately all-mono.
 *
 * The instrument has two lightings, dark and light, and neither is an
 * inversion of the other: dark is the darkroom bench (phosphor on ink),
 * light is the drafting table (plotter ink on cool paper). Values differ per
 * mode; *roles* do not. Consumers never read a mode-specific color — they use
 * the `palette`/`syntax` token maps below, which resolve through CSS custom
 * properties at paint time and so follow whichever mode is active.
 */

export type ThemeMode = "dark" | "light";

export const product = {
  name: "Sigha",
  /**
   * Cross-link to the Cirrus platform the tool belongs to. Dormant until the
   * platform site is live — set to "https://cirrus.tools" to show the link.
   */
  platformUrl: null as string | null,
  /** Public source repository, linked in the footer. */
  repoUrl: "https://github.com/rfaulhaber/sigha",
} as const;

interface Palette {
  /** Page field. */
  readonly bg: string;
  /** Panel surfaces, one step off the field. */
  readonly surface: string;
  /** The editor's "screen" — the most recessed layer. */
  readonly well: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  /** Signal color — the single loud hue on the page. */
  readonly accent: string;
  /** Ink for text set on top of the accent (filled buttons). */
  readonly accentText: string;
  readonly danger: string;
  readonly warning: string;
}

const palettes: Record<ThemeMode, Palette> = {
  // Darkroom bench: near-black cold ink, phosphor signal.
  dark: {
    bg: "#070b14",
    surface: "#0d1424",
    well: "#05080f",
    border: "#202c49",
    text: "#e3e9f8",
    textMuted: "#8ea0c4",
    accent: "#3fe0b0",
    accentText: "#052019",
    danger: "#ff6b85",
    warning: "#f2b45c",
  },
  // Drafting table: cool paper stock, graphite rule, plotter-ink green. The
  // phosphor accent cannot survive here — at 1.5:1 on paper it is decoration,
  // not a signal — so light runs the same hue at ink density instead. Every
  // text-bearing role clears 4.5:1 against both `bg` and `well`.
  light: {
    bg: "#eaeef6",
    surface: "#f7f9fd",
    well: "#ffffff",
    border: "#c9d4e8",
    text: "#131b2e",
    textMuted: "#4f5f80",
    accent: "#07785e",
    accentText: "#f0fff9",
    danger: "#c0243f",
    warning: "#9a5b06",
  },
};

interface SyntaxColors {
  readonly number: string;
  readonly string: string;
  readonly keyword: string;
  readonly field: string;
  readonly operator: string;
  readonly punctuation: string;
  readonly comment: string;
  readonly error: string;
}

/** Editor syntax-token colors, keyed to lexer token classes. */
const syntaxColors: Record<ThemeMode, SyntaxColors> = {
  dark: {
    number: "#6fd6ff",
    string: "#efb080",
    keyword: "#b9a3ff",
    field: "#93b4ff",
    operator: "#c9d2ea",
    punctuation: "#6f7ea6",
    comment: "#5c6a8f",
    error: "#ff6b85",
  },
  // Same hue assignments an octave down, so a formula keeps its shape when the
  // lighting changes. All clear 4.5:1 on `well` (#fff), including punctuation
  // and comments — recessive is not the same as unreadable.
  light: {
    number: "#0b6b93",
    string: "#9b4a15",
    keyword: "#6a45c8",
    field: "#2350ba",
    operator: "#3a4863",
    punctuation: "#66748f",
    comment: "#5f6b7e",
    error: "#c0243f",
  },
};

/**
 * Depth and atmosphere cues that do not survive a straight value swap. A drop
 * shadow that reads as depth on ink reads as soot on paper; a phosphor bloom
 * reads as a smudge. These carry complete CSS values (or bare percentages fed
 * to `color-mix`) so global.css and the editor theme stay free of mode
 * branching — they just read the variable.
 */
interface Effects {
  readonly shadowPanel: string;
  readonly shadowPopover: string;
  /** Inset top-edge highlight that lifts a panel off the field. */
  readonly panelBevel: string;
  /** Filled-button hover: dark brightens toward white, light deepens. */
  readonly accentHover: string;
  /** Focus bloom around the editor frame. */
  readonly editorGlow: string;
  readonly grainOpacity: string;
  /**
   * Bare `color-mix` percentages, for tints whose geometry is identical
   * across modes and only their strength differs. A wash that reads at 6% on
   * ink disappears at 6% on paper.
   */
  readonly gridMix: string;
  readonly washMix: string;
  readonly selectionMix: string;
  readonly editorSelectionMix: string;
  readonly focusRingMix: string;
  readonly activeRowMix: string;
  readonly glowMix: string;
}

const effects: Record<ThemeMode, Effects> = {
  dark: {
    shadowPanel: "0 16px 40px -28px rgb(0 0 0 / 0.9)",
    shadowPopover: "0 12px 32px -12px rgb(0 0 0 / 0.8)",
    panelBevel: "rgb(255 255 255 / 0.035)",
    accentHover: "color-mix(in srgb, var(--sfa-accent) 82%, white)",
    editorGlow:
      "0 0 0 3px color-mix(in srgb, var(--sfa-accent) 12%, transparent)," +
      " 0 0 28px color-mix(in srgb, var(--sfa-accent) 8%, transparent)",
    grainOpacity: "0.05",
    gridMix: "55%",
    washMix: "6%",
    selectionMix: "28%",
    editorSelectionMix: "18%",
    focusRingMix: "40%",
    activeRowMix: "15%",
    glowMix: "70%",
  },
  light: {
    // Paper takes a shorter, cooler shadow tinted with the text ink rather
    // than black, which would read as grey dirt against the blue-cast stock.
    shadowPanel: "0 10px 26px -20px rgb(19 27 46 / 0.35)",
    shadowPopover: "0 10px 26px -10px rgb(19 27 46 / 0.22)",
    // No bevel: a white inset on near-white surface is a no-op, and a dark one
    // reads as a stray rule. On paper the border and shadow do the lifting.
    panelBevel: "transparent",
    accentHover: "color-mix(in srgb, var(--sfa-accent) 86%, black)",
    // No outer bloom: on paper the ring alone reads as focus, and the bloom
    // reads as a printing defect.
    editorGlow:
      "0 0 0 3px color-mix(in srgb, var(--sfa-accent) 16%, transparent)",
    grainOpacity: "0.028",
    // Lower than dark, not higher: the grid has to sit the same *perceptual*
    // distance off the field, and a neutral step that reads as a whisper down
    // in the ink range reads as drawn graph paper up near white.
    gridMix: "38%",
    washMix: "9%",
    selectionMix: "22%",
    editorSelectionMix: "26%",
    // A 40% accent border would sit *lighter* than the resting `border` on
    // paper, making focus read as a loss of definition. Focus must gain ink.
    focusRingMix: "72%",
    activeRowMix: "18%",
    glowMix: "45%",
  },
};

export const font = {
  /** Nameplate only — everything else is mono. */
  display: "'Instrument Serif', 'Iowan Old Style', Georgia, serif",
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
} as const;

/**
 * Turn a color group into `var(--…)` references keyed the same way. Consumers
 * hold the token, not the value, so a mode swap is a variable rewrite on
 * :root — no re-render, no re-import, no stale snapshot inlined into a style
 * prop at module-evaluation time.
 */
function cssVarTokens<T extends object>(
  shape: T,
  prefix: string,
): { readonly [K in keyof T]: string } {
  const out: Record<string, string> = {};
  for (const key of Object.keys(shape)) {
    out[key] = `var(--${prefix}${key})`;
  }
  return out as { readonly [K in keyof T]: string };
}

/** Role tokens for page chrome. Values resolve from the active mode. */
export const palette = cssVarTokens(palettes.dark, "sfa-");

/** Role tokens for editor syntax highlighting. */
export const syntax = cssVarTokens(syntaxColors.dark, "sfa-syntax-");

/** Role tokens for the depth/atmosphere cues above. */
export const effect = cssVarTokens(effects.dark, "sfa-fx-");

/**
 * Composite a token with transparency. The `#rrggbb` + alpha-suffix trick used
 * before a token existed cannot work on a `var()` reference — the alpha would
 * land outside the substituted value — so transparency goes through
 * `color-mix`, which composes with variables.
 *
 * `amount` takes a literal percentage or one of the `effect.*Mix` tokens, for
 * tints whose strength is itself mode-dependent.
 */
export function alpha(token: string, amount: number | string): string {
  const percent = typeof amount === "number" ? `${amount}%` : amount;
  return `color-mix(in srgb, ${token} ${percent}, transparent)`;
}

/**
 * Write `mode`'s values onto the `--sfa-*` custom properties so global.css,
 * the CodeMirror theme, and every inline style resolve to it. Also stamps
 * `data-theme` (global.css keys `color-scheme` off it, which is what gives the
 * browser the right canvas and native-widget rendering) and syncs the
 * mobile browser-chrome color.
 *
 * Idempotent, and safe to call on every mode change — switching themes is
 * exactly this function running again.
 */
export function applyThemeVars(
  mode: ThemeMode,
  el: HTMLElement = document.documentElement,
): void {
  for (const [key, value] of Object.entries(palettes[mode])) {
    el.style.setProperty(`--sfa-${key}`, value);
  }
  for (const [key, value] of Object.entries(syntaxColors[mode])) {
    el.style.setProperty(`--sfa-syntax-${key}`, value);
  }
  for (const [key, value] of Object.entries(effects[mode])) {
    el.style.setProperty(`--sfa-fx-${key}`, value);
  }
  el.style.setProperty("--sfa-font-mono", font.mono);
  el.style.setProperty("--sfa-font-display", font.display);
  el.dataset.theme = mode;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", palettes[mode].bg);
  }
}

export const theme = {
  product,
  palette,
  syntax,
  effect,
  font,
} as const;
