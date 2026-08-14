import { lazy, Suspense, useMemo, useRef, useState } from "react";
import {
  isBlankSource,
  type Diagnostic,
  type TextEdit,
} from "../syntax/index.ts";
// Deep imports: the features barrel re-exports the simplifier, whose engine
// dependency (decimal.js sets global config at module load) must stay in the
// lazy chunks, not the first paint.
import { diagnoseParsed } from "../features/linter.ts";
import {
  decodePermalink,
  encodePermalink,
  type PermalinkField,
  type PermalinkTests,
} from "../features/permalink.ts";
import type { BlankMode } from "../engine/value.ts";
import { CONTEXTS, DEFAULT_CONTEXT_ID, getContext } from "../registry/index.ts";
import {
  localizedContextLabel,
  localizedContextNote,
  t,
} from "../i18n/index.ts";
import { palette, product } from "../theme/theme.ts";
import { nextPreference, type ThemePreference } from "../theme/mode.ts";
import { FormulaEditor, type EditorHandle } from "./editor/FormulaEditor.tsx";
import { InsertFunctionPicker } from "./InsertFunctionPicker.tsx";
import { Panel } from "./Panel.tsx";
import { newRowId, type TestSuiteState } from "./testsuite/state.ts";
import { useThemeMode, type ThemeControl } from "./useThemeMode.ts";
import { offsetToLineCol } from "./util/position.ts";

// The simulator is the only route to the evaluator (and its decimal.js
// dependency), so it is code-split out of the first paint — the editor, parser,
// and diagnostics load without it. It appears once the user types a formula.
const SimulatePanel = lazy(async () => {
  const m = await import("./simulate/SimulatePanel.tsx");
  return { default: m.SimulatePanel };
});

// The simplifier folds constants through the evaluator, so it shares the
// engine/decimal.js chunk with the simulator and stays off the first paint.
const SimplifyPanel = lazy(async () => {
  const m = await import("./simplify/SimplifyPanel.tsx");
  return { default: m.SimplifyPanel };
});

// Same evaluator dependency as the simulator, same treatment: code-split out
// of the first paint. TestSuiteState itself lives in testsuite/state.ts,
// which stays free of the evaluator so this file can seed and update it
// synchronously without eagerly loading this chunk.
const TestSuitePanel = lazy(async () => {
  const m = await import("./testsuite/TestSuitePanel.tsx");
  return { default: m.TestSuitePanel };
});

const SAMPLE = `/* Weighted deal value — a blank discount means list price */
IF(
  ISBLANK(Discount__c),
  Amount * 0.85,
  Amount * (1 - Discount__c)
)`;

const SEVERITY_COLOR: Record<string, string> = {
  error: palette.danger,
  warning: palette.warning,
  info: palette.accent,
};

/** Seed the test suite from a decoded permalink, assigning each row a fresh
 * id rather than trusting one carried in the URL. */
function seedTests(tests: PermalinkTests | undefined): TestSuiteState {
  if (!tests) {
    return { rows: [], types: {}, blankMode: "zero" };
  }
  return {
    rows: tests.rows.map((row) => ({ ...row, id: newRowId() })),
    types: tests.types,
    blankMode: tests.blankMode,
  };
}

export function App() {
  // Owns the --sfa-* custom properties every stylesheet and inline style
  // resolves against, so this also covers tests that mount <App/> without
  // going through main.tsx.
  const themeControl = useThemeMode();

  // Restore shared state from the URL hash, synchronously, so the editor
  // mounts with the restored formula instead of flashing the sample.
  const [restored] = useState(() => decodePermalink(window.location.hash));
  const initialDoc = restored?.formula ?? SAMPLE;

  const [source, setSource] = useState(initialDoc);
  const [contextId, setContextId] = useState(
    restored && getContext(restored.context)
      ? restored.context
      : DEFAULT_CONTEXT_ID,
  );
  const [tests, setTests] = useState<TestSuiteState>(() =>
    seedTests(restored?.tests),
  );
  const editorRef = useRef<EditorHandle>(null);

  // The only place formula text leaves the editor: explicit user action,
  // into the URL hash, nowhere else.
  const share = (
    fields: Record<string, PermalinkField>,
    blankMode: BlankMode,
  ): string => {
    const hash = encodePermalink({
      context: contextId,
      formula: source,
      fields,
      blankMode,
      // An empty suite is the default state, not something worth restoring;
      // only travel it once the user has actually written a test case.
      ...(tests.rows.length > 0
        ? {
            tests: {
              rows: tests.rows.map((row) => ({
                values: row.values,
                expected: row.expected,
              })),
              types: tests.types,
              blankMode: tests.blankMode,
            },
          }
        : {}),
    });
    const url = `${window.location.origin}${window.location.pathname}#${hash}`;
    window.history.replaceState(null, "", `#${hash}`);
    return url;
  };

  const { ast, diagnostics, syntaxErrors } = useMemo(
    () => diagnoseParsed(source, contextId),
    [source, contextId],
  );

  const context = getContext(contextId);

  return (
    <main className="shell">
      <header
        className="nameplate rise rise-1"
        style={{ marginBottom: "2rem" }}
      >
        <h1>{product.name}</h1>
        <p
          style={{
            marginTop: "0.75rem",
            color: palette.textMuted,
            fontSize: "0.88rem",
            maxWidth: "36rem",
          }}
        >
          {t().copy.tagline}
        </p>
      </header>

      <div
        className="rise rise-2"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.6rem",
          flexWrap: "wrap",
          marginBottom: "0.85rem",
        }}
      >
        <ContextPicker contextId={contextId} onChange={setContextId} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            minWidth: 0,
          }}
        >
          <InsertFunctionPicker
            contextId={contextId}
            onInsert={(template) => editorRef.current?.insertSnippet(template)}
          />
          <button
            type="button"
            className="btn"
            onClick={() => editorRef.current?.format()}
            title={t().ui.toolbar.formatTitle}
          >
            {t().ui.toolbar.format}
          </button>
          <ModeSwitch {...themeControl} />
        </div>
      </div>

      <div className="reticle rise rise-2">
        <FormulaEditor
          initialDoc={initialDoc}
          contextId={contextId}
          themeMode={themeControl.mode}
          onChange={setSource}
          handleRef={editorRef}
        />
      </div>

      {context?.notes ? (
        <p
          style={{
            marginTop: "0.7rem",
            fontSize: "0.78rem",
            color: palette.warning,
            display: "flex",
            gap: "0.45rem",
          }}
        >
          <span aria-hidden>⚠</span>
          {localizedContextNote(context.id, context.notes)}
        </p>
      ) : null}

      <div className="rise rise-3">
        {isBlankSource(source) ? null : (
          <Suspense fallback={null}>
            <SimulatePanel
              ast={ast}
              source={source}
              syntaxErrors={syntaxErrors}
              blankToggle={context?.blankModeToggle ?? false}
              contextId={contextId}
              runtimeErrorNote={context?.runtimeErrorNote}
              initialSim={
                restored
                  ? { fields: restored.fields, blankMode: restored.blankMode }
                  : undefined
              }
              onShare={share}
            />
            <TestSuitePanel
              ast={ast}
              syntaxErrors={syntaxErrors}
              blankToggle={context?.blankModeToggle ?? false}
              state={tests}
              onChange={setTests}
            />
            <SimplifyPanel
              source={source}
              onApply={(text) => editorRef.current?.setText(text)}
            />
          </Suspense>
        )}

        <ProblemsPanel
          source={source}
          diagnostics={diagnostics}
          onApplyFix={(edits) => editorRef.current?.applyEdits(edits, source)}
        />
      </div>

      <section
        className="rise rise-4"
        aria-labelledby="about-label"
        style={{ marginTop: "3rem" }}
      >
        <h2
          id="about-label"
          className="microcopy"
          style={{ fontWeight: 600, marginBottom: "1.1rem" }}
        >
          {t().copy.about.label}
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
            gap: "1.5rem 2.25rem",
          }}
        >
          {t().copy.about.sections.map((s) => (
            <div key={s.heading}>
              <h3
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  marginBottom: "0.4rem",
                }}
              >
                {s.heading}
              </h3>
              <p
                style={{
                  fontSize: "0.8rem",
                  lineHeight: 1.65,
                  color: palette.textMuted,
                }}
              >
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <footer
        className="rise rise-4"
        style={{
          marginTop: "2.75rem",
          paddingTop: "1.1rem",
          borderTop: `1px solid ${palette.border}`,
          fontSize: "0.72rem",
          color: palette.textMuted,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "1rem",
            flexWrap: "wrap",
          }}
        >
          <span>{t().copy.footer}</span>
          <span style={{ display: "flex", gap: "1.1rem" }}>
            <a href={product.repoUrl}>{t().ui.footer.sourceLink}</a>
          </span>
        </div>
        <p style={{ margin: "0.65rem 0 0", fontSize: "0.66rem", opacity: 0.7 }}>
          {t().copy.disclaimer}
        </p>
      </footer>
    </main>
  );
}

interface ContextPickerProps {
  readonly contextId: string;
  readonly onChange: (id: string) => void;
}

function ContextPicker({ contextId, onChange }: ContextPickerProps) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.6rem",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <span className="microcopy">{t().ui.toolbar.contextLabel}</span>
      {/* min-width: 0 lets the select shrink below its widest option on
          narrow viewports instead of forcing horizontal page scroll. */}
      <select
        className="select"
        style={{ minWidth: 0 }}
        value={contextId}
        onChange={(e) => onChange(e.target.value)}
      >
        {CONTEXTS.map((c) => (
          <option key={c.id} value={c.id}>
            {localizedContextLabel(c.id, c.label)}
            {c.tier === 2 ? t().ui.toolbar.contextUnverifiedSuffix : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Filled / hollow / half — a dial position, matching the all-mono chrome. */
const MODE_GLYPH: Record<ThemePreference, string> = {
  system: "◐",
  light: "○",
  dark: "●",
};

/**
 * Cycles system → light → dark. The state is a visible word rather than an
 * icon alone: "Auto" has no glyph anyone reads reliably, and the button's
 * text is also its accessible name.
 */
function ModeSwitch({ preference, mode, cycle }: ThemeControl) {
  const strings = t().ui.theme;
  const current =
    preference === "system"
      ? strings.following(strings[mode])
      : strings[preference];
  const description = strings.action(
    current,
    strings[nextPreference(preference)],
  );

  return (
    <button
      type="button"
      className="btn mode-switch"
      onClick={cycle}
      title={description}
      aria-label={description}
    >
      <span aria-hidden className="mode-switch__glyph">
        {MODE_GLYPH[preference]}
      </span>
      {strings[preference]}
    </button>
  );
}

interface ProblemsPanelProps {
  readonly source: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly onApplyFix: (edits: readonly TextEdit[]) => void;
}

/**
 * Diagnostics readout, and the one place automatic fixes are offered: a button
 * per fixable problem, plus a bulk apply. Bulk skips fixes that would change
 * the formula's meaning — those need a per-problem decision — and the
 * non-overlap invariant on `DiagnosticFix` is what lets the rest go in one edit.
 */
function ProblemsPanel({
  source,
  diagnostics,
  onApplyFix,
}: ProblemsPanelProps) {
  const bulk = diagnostics.filter((d) => d.fix && !d.fix.changesSemantics);

  return (
    <Panel
      label={t().ui.problems.label}
      right={
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.7rem",
            color: palette.textMuted,
            fontSize: "0.72rem",
          }}
        >
          {/* A lone fix's own button already covers it; bulk earns its place
              only when it batches. */}
          {bulk.length >= 2 ? (
            <button
              type="button"
              className="btn"
              onClick={() => onApplyFix(bulk.flatMap((d) => d.fix!.edits))}
              title={t().ui.problems.fixAllTitle}
            >
              {t().ui.problems.fixAll(bulk.length)}
            </button>
          ) : null}
          {diagnostics.length === 0
            ? t().ui.problems.none
            : t().ui.problems.count(diagnostics.length)}
        </span>
      }
    >
      {diagnostics.length === 0 ? (
        <p
          style={{
            padding: "0.8rem 1rem",
            color: palette.textMuted,
            fontSize: "0.85rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span aria-hidden style={{ color: palette.accent }}>
            ✓
          </span>
          <span>{t().ui.problems.clean}</span>
        </p>
      ) : (
        <ul style={{ listStyle: "none" }}>
          {diagnostics.map((d, i) => {
            const { line, col } = offsetToLineCol(source, d.span.start);
            return (
              <li
                key={i}
                className="row-hover"
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.7rem",
                  padding: "0.5rem 1rem",
                  borderTop: i === 0 ? "none" : `1px solid ${palette.border}`,
                  fontSize: "0.84rem",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    alignSelf: "center",
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    flex: "none",
                    background: SEVERITY_COLOR[d.severity] ?? palette.text,
                  }}
                />
                <span
                  style={{
                    color: palette.textMuted,
                    fontSize: "0.72rem",
                    whiteSpace: "nowrap",
                    minWidth: "2.4rem",
                  }}
                >
                  {line}:{col}
                </span>
                <span style={{ flex: 1 }}>
                  {d.message}
                  <span className="chip" style={{ marginLeft: "0.5rem" }}>
                    {d.code}
                  </span>
                  {d.docsUrl ? (
                    <a
                      href={d.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: "0.72rem", marginLeft: "0.5rem" }}
                    >
                      {t().ui.problems.docsLink}
                    </a>
                  ) : null}
                </span>
                {d.fix ? (
                  <button
                    type="button"
                    className="btn"
                    style={{ alignSelf: "center", flex: "none" }}
                    onClick={() => onApplyFix(d.fix!.edits)}
                    title={
                      d.fix.changesSemantics
                        ? t().ui.problems.fixChangesSemantics
                        : undefined
                    }
                  >
                    {d.fix.title}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
