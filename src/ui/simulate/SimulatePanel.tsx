import { useMemo, useState, type ReactNode } from "react";
import { assertNever, type Expr } from "../../syntax/index.ts";
import { extractFields } from "../../features/index.ts";
import type { PermalinkField } from "../../features/permalink.ts";
import {
  evaluateFormula,
  isError,
  materialize,
  UnsupportedError,
  type BlankMode,
  type EvalResult,
  type SfValue,
} from "../../engine/index.ts";
import type { SfType } from "../../registry/index.ts";
import { localizedContextRuntimeErrorNote, t } from "../../i18n/index.ts";
import { palette, syntax, font } from "../../theme/theme.ts";
import { Panel } from "../Panel.tsx";
import {
  buildFieldValue,
  classifyResult,
  FIELD_TYPES,
  renderResult,
  type ResultOutcome,
} from "./fieldValue.ts";
import { snippetOf } from "./snippet.ts";

/**
 * The simulation's evaluation outcome: a typed discriminant carried alongside
 * the display text so a formula that legitimately evaluates to the text
 * "#Error!" is never confused with a genuine runtime FormulaError (both would
 * otherwise render the identical string). Every outcome that actually ran the
 * evaluator carries the sub-expression trace the Steps section reads from —
 * including "unsupported", so a formula that hits the simulation boundary
 * partway through still shows what led up to it.
 */
type Outcome =
  | (ResultOutcome & { readonly trace: ReadonlyMap<Expr, EvalResult> })
  | {
      readonly kind: "unsupported";
      readonly functionName: string;
      readonly trace: ReadonlyMap<Expr, EvalResult>;
    }
  | { readonly kind: "invalid" };

interface FieldInput {
  readonly type: SfType;
  readonly value: string;
  readonly blank: boolean;
}

interface SimulatePanelProps {
  readonly ast: Expr;
  /** The formula text `ast` was parsed from, for slicing Steps trace snippets
   * (spans are offsets into this string). */
  readonly source: string;
  /** True when the source has error-severity syntax diagnostics. Recovery can
   * hand us a complete AST for invalid text (pasted invisible characters,
   * typographic quotes); simulating that AST would silently answer for a
   * formula Salesforce rejects, so evaluation refuses instead (rule 1). */
  readonly syntaxErrors: boolean;
  readonly blankToggle: boolean;
  /** Current formula context id, for localizing runtimeErrorNote. */
  readonly contextId: string;
  /** Registry's English runtimeErrorNote for the current context, if its
   * runtime-error behavior has been org-verified (see FormulaContext). */
  readonly runtimeErrorNote?: string | undefined;
  /** Decoded permalink state to seed the form with (untrusted; sanitized here). */
  readonly initialSim?:
    | {
        readonly fields: Readonly<Record<string, PermalinkField>>;
        readonly blankMode: BlankMode;
      }
    | undefined;
  /** Builds the permalink for the current state and returns its URL. */
  readonly onShare?: (
    fields: Record<string, PermalinkField>,
    blankMode: BlankMode,
  ) => string;
}

/** Keep only permalink fields whose type is one the simulator offers. */
function seedInputs(
  fields: Readonly<Record<string, PermalinkField>> | undefined,
): Record<string, FieldInput> {
  const out: Record<string, FieldInput> = {};
  for (const [name, f] of Object.entries(fields ?? {})) {
    if ((FIELD_TYPES as readonly string[]).includes(f.type)) {
      out[name] = { type: f.type as SfType, value: f.value, blank: f.blank };
    }
  }
  return out;
}

export function SimulatePanel({
  ast,
  source,
  syntaxErrors,
  blankToggle,
  contextId,
  runtimeErrorNote,
  initialSim,
  onShare,
}: SimulatePanelProps) {
  const fields = useMemo(() => extractFields(ast), [ast]);
  const [inputs, setInputs] = useState<Record<string, FieldInput>>(() =>
    seedInputs(initialSim?.fields),
  );
  const [blankMode, setBlankMode] = useState<BlankMode>(
    initialSim?.blankMode ?? "zero",
  );
  // Capture the clock once so TODAY()/NOW() are stable across re-renders.
  const [now] = useState(() => ({ epochMillis: Date.now() }));

  const getInput = (name: string, inferred: SfType): FieldInput =>
    inputs[name] ?? { type: inferred, value: "", blank: false };

  const update = (
    name: string,
    inferred: SfType,
    patch: Partial<FieldInput>,
  ): void => {
    setInputs((prev) => ({
      ...prev,
      [name]: { ...getInput(name, inferred), ...patch },
    }));
  };

  const outcome = useMemo((): Outcome => {
    if (syntaxErrors) {
      return { kind: "invalid" };
    }
    const map = new Map<string, SfValue>();
    for (const f of fields) {
      const input = inputs[f.name] ?? {
        type: f.inferredType,
        value: "",
        blank: false,
      };
      map.set(f.name, buildFieldValue(input.type, input.value, input.blank));
    }
    const trace = new Map<Expr, EvalResult>();
    try {
      const result = evaluateFormula(ast, {
        fields: map,
        blankMode,
        now,
        trace: (node, r) => trace.set(node, r),
      });
      return { ...classifyResult(result), trace };
    } catch (e) {
      // evaluateFormula only throws UnsupportedError; anything else already
      // degraded to a FormulaError inside it. The trace collected up to the
      // throw (see EvalEnv.trace) is still valid and worth keeping.
      if (e instanceof UnsupportedError) {
        return { kind: "unsupported", functionName: e.functionName, trace };
      }
      return { kind: "error", text: "#Error!", trace };
    }
  }, [ast, syntaxErrors, fields, inputs, blankMode, now]);

  return (
    <Panel
      label={t().ui.simulate.label}
      right={
        blankToggle ? (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.45rem",
              color: palette.textMuted,
              fontSize: "0.75rem",
            }}
          >
            {t().ui.simulate.blankFieldsAs}
            <select
              className="select"
              value={blankMode}
              onChange={(e) => setBlankMode(e.target.value as BlankMode)}
            >
              <option value="zero">{t().ui.simulate.blankAsZeroes}</option>
              <option value="blank">{t().ui.simulate.blankAsBlanks}</option>
            </select>
          </label>
        ) : undefined
      }
    >
      {fields.length === 0 ? (
        <p
          style={{
            padding: "0.7rem 1rem",
            color: palette.textMuted,
            fontSize: "0.82rem",
          }}
        >
          {t().ui.simulate.noFields}
        </p>
      ) : (
        <div style={{ padding: "0.4rem 0" }}>
          {fields.map((f) => {
            const input = getInput(f.name, f.inferredType);
            return (
              <div key={f.name} className="row-hover" style={rowStyle}>
                <code
                  style={{
                    fontSize: "0.82rem",
                    color: syntax.field,
                    minWidth: "9rem",
                  }}
                >
                  {f.name}
                </code>
                <select
                  className="select"
                  value={input.type}
                  onChange={(e) =>
                    update(f.name, f.inferredType, {
                      type: e.target.value as SfType,
                    })
                  }
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <FieldWidget
                  input={input}
                  onChange={(patch) => update(f.name, f.inferredType, patch)}
                />
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    color: palette.textMuted,
                    fontSize: "0.72rem",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={input.blank}
                    onChange={(e) =>
                      update(f.name, f.inferredType, {
                        blank: e.target.checked,
                      })
                    }
                  />
                  {t().ui.simulate.blankCheckbox}
                </label>
              </div>
            );
          })}
        </div>
      )}

      <ResultBar outcome={outcome}>
        {onShare ? (
          <ShareButton onShare={() => onShare({ ...inputs }, blankMode)} />
        ) : null}
      </ResultBar>

      {outcome.kind === "error" && runtimeErrorNote ? (
        <p
          style={{
            padding: "0 1rem 0.7rem",
            margin: 0,
            display: "flex",
            gap: "0.4rem",
            color: palette.textMuted,
            fontSize: "0.78rem",
          }}
        >
          <span aria-hidden>↳</span>
          <span>
            {localizedContextRuntimeErrorNote(contextId, runtimeErrorNote)}
          </span>
        </p>
      ) : null}

      {"trace" in outcome ? (
        <StepsSection ast={ast} source={source} trace={outcome.trace} />
      ) : null}
    </Panel>
  );
}

/** Rows a Steps trace should render for `node`, at `depth`, appended to `out`. */
function collectTraceRows(
  node: Expr,
  depth: number,
  trace: ReadonlyMap<Expr, EvalResult>,
  out: { node: Expr; depth: number }[],
): void {
  switch (node.kind) {
    // Transparent: formatting, not evaluation — recurse without a row of its own.
    case "Paren":
      collectTraceRows(node.expr, depth, trace, out);
      return;
    // A literal's value is its source text; a row would just repeat it.
    case "NumberLit":
    case "StringLit":
    case "BooleanLit":
    case "NullLit":
      return;
    // An unparseable region is only worth a row if it was actually reached —
    // otherwise it is redundant with the syntax errors that already blocked
    // simulation, or with the branch that skipped over it.
    case "ErrorNode":
      if (trace.has(node)) {
        out.push({ node, depth });
      }
      return;
    case "FieldRef":
      out.push({ node, depth });
      return;
    case "UnaryOp":
      out.push({ node, depth });
      collectTraceRows(node.operand, depth + 1, trace, out);
      return;
    case "BinaryOp":
      out.push({ node, depth });
      collectTraceRows(node.left, depth + 1, trace, out);
      collectTraceRows(node.right, depth + 1, trace, out);
      return;
    case "FunctionCall":
      out.push({ node, depth });
      for (const arg of node.args) {
        collectTraceRows(arg, depth + 1, trace, out);
      }
      return;
    default:
      return assertNever(node);
  }
}

/** A traced value at the same display scale as the result readout. */
function renderTracedValue(result: EvalResult): string {
  return renderResult(isError(result) ? result : materialize(result));
}

/**
 * Row color: muted for a skipped node, danger for #Error!, else normal. A
 * skipped row dims through color alone — stacking a row-wide `opacity` on
 * top of an already-muted value would compound past the light palette's
 * documented 4.5:1 floor (theme.ts), so the snippet and the value always
 * share this one color, never opacity.
 */
function stepColor(result: EvalResult | undefined): string {
  if (result === undefined) {
    return palette.textMuted;
  }
  return isError(result) ? palette.danger : palette.text;
}

/**
 * The formula's evaluation as an expandable tree, echoing the sub-expression
 * trace hook (EvalEnv.trace): every evaluated function call, operator, and
 * field reference alongside its value, with short-circuited branches shown as
 * not evaluated rather than silently missing. Collapsed by default — a
 * debugger detail, not the headline. Hidden entirely when the tree has
 * nothing to show (e.g. the formula is a bare literal).
 */
function StepsSection({
  ast,
  source,
  trace,
}: {
  ast: Expr;
  source: string;
  trace: ReadonlyMap<Expr, EvalResult>;
}) {
  // Rows mount only once opened: a formula's value can repeat verbatim
  // inside its own trace (e.g. a formula that's just "Amount + 1"), and a
  // closed <details> only hides its body visually — its children stay in the
  // DOM, which would give the result readout's own text a duplicate match.
  const [open, setOpen] = useState(false);
  const rows: { node: Expr; depth: number }[] = [];
  collectTraceRows(ast, 0, trace, rows);
  if (rows.length === 0) {
    return null;
  }
  return (
    <details
      className="steps"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="steps__summary">{t().ui.simulate.stepsLabel}</summary>
      <div>
        {open
          ? rows.map(({ node, depth }) => {
              const result = trace.get(node);
              const skipped = result === undefined;
              return (
                <div
                  key={`${node.span.start}:${node.span.end}`}
                  className="row-hover"
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: "0.8rem",
                    padding: "0.32rem 1rem",
                    paddingLeft: `${1 + depth * 0.9}rem`,
                    fontSize: "0.8rem",
                  }}
                >
                  <code
                    style={{
                      overflowWrap: "anywhere",
                      color: skipped ? palette.textMuted : palette.text,
                    }}
                  >
                    {snippetOf(source, node.span)}
                  </code>
                  <span
                    style={{
                      flex: "none",
                      fontFamily: font.mono,
                      color: stepColor(result),
                    }}
                  >
                    {skipped
                      ? t().ui.simulate.stepsNotEvaluated
                      : renderTracedValue(result)}
                  </span>
                </div>
              );
            })
          : null}
      </div>
    </details>
  );
}

/**
 * "Copy link" (DESIGN §8.5) — placed next to the result, the shareable moment,
 * and styled as the page's single filled button: this is the growth mechanism.
 * The parent encodes and updates the hash; this button only copies the URL and
 * gives feedback. Clipboard access can be denied; the link is still in the
 * address bar then.
 */
function ShareButton({ onShare }: { onShare: () => string }) {
  const [label, setLabel] = useState(() => t().ui.simulate.copyLink);

  const share = async (): Promise<void> => {
    const url = onShare();
    try {
      await navigator.clipboard.writeText(url);
      setLabel(t().ui.simulate.copied);
    } catch {
      setLabel(t().ui.simulate.linkInUrlBar);
    }
    setTimeout(() => setLabel(t().ui.simulate.copyLink), 2000);
  };

  return (
    <button
      type="button"
      className="btn btn--primary"
      onClick={() => {
        void share();
      }}
      title={t().ui.simulate.copyLinkTitle}
      style={{ marginLeft: "auto" }}
    >
      {label}
    </button>
  );
}

function FieldWidget({
  input,
  onChange,
}: {
  input: FieldInput;
  onChange: (patch: Partial<FieldInput>) => void;
}) {
  if (input.blank) {
    return (
      <span style={{ flex: 1, color: palette.textMuted, fontSize: "0.8rem" }}>
        {t().ui.simulate.nullField}
      </span>
    );
  }
  if (input.type === "Boolean") {
    return (
      <label
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: "0.35rem",
          fontSize: "0.82rem",
        }}
      >
        <input
          type="checkbox"
          checked={input.value === "true"}
          onChange={(e) =>
            onChange({ value: e.target.checked ? "true" : "false" })
          }
        />
        {input.value === "true" ? "TRUE" : "FALSE"}
      </label>
    );
  }
  return (
    <input
      type={input.type === "Date" ? "date" : "text"}
      value={input.value}
      inputMode={
        input.type === "Number" ||
        input.type === "Currency" ||
        input.type === "Percent"
          ? "decimal"
          : undefined
      }
      placeholder={placeholderFor(input.type)}
      onChange={(e) => onChange({ value: e.target.value })}
      style={inputStyle}
    />
  );
}

/** Format-template placeholders are formula-language tokens, not prose. */
function placeholderFor(type: SfType): string {
  switch (type) {
    case "Date":
      return "";
    case "Time":
      return "HH:MM:SS";
    case "Datetime":
      return "YYYY-MM-DD HH:MM:SS";
    default:
      return t().ui.simulate.valuePlaceholder;
  }
}

function resultLabel(outcome: Outcome): string {
  switch (outcome.kind) {
    case "unsupported":
      return t().ui.simulate.cannotSimulate(outcome.functionName);
    case "invalid":
      return t().ui.simulate.invalidFormula;
    case "error":
      return t().ui.simulate.errorResult;
    case "value":
      return outcome.text;
  }
}

function ResultBar({
  outcome,
  children,
}: {
  outcome: Outcome;
  children?: ReactNode;
}) {
  const label = resultLabel(outcome);
  let led = "led--ok";
  let color: string = palette.text;
  if (outcome.kind === "unsupported" || outcome.kind === "invalid") {
    led = "led--warn";
    color = palette.textMuted;
  } else if (outcome.kind === "error") {
    led = "led--err";
    color = palette.danger;
  }

  return (
    <div
      style={{
        borderTop: `1px solid ${palette.border}`,
        padding: "0.7rem 1rem",
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
      }}
    >
      <span className="microcopy">{t().ui.simulate.resultLabel}</span>
      <span className={`led ${led}`} aria-hidden />
      {/* Keyed so a changed result re-triggers the readout-in flash. */}
      <span
        key={label}
        className="readout"
        style={{
          fontFamily: font.mono,
          fontSize: "1rem",
          fontWeight: 600,
          color,
          overflowWrap: "anywhere",
        }}
      >
        {label || "—"}
      </span>
      {children}
    </div>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  padding: "0.4rem 1rem",
  flexWrap: "wrap",
} as const;

const inputStyle = {
  flex: 1,
  minWidth: "6rem",
  background: palette.well,
  color: palette.text,
  border: `1px solid ${palette.border}`,
  borderRadius: "8px",
  padding: "0.3rem 0.55rem",
  fontFamily: font.mono,
  fontSize: "0.82rem",
} as const;
