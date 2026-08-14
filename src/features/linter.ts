import {
  parse,
  span,
  spanLength,
  childrenOf,
  isBlankSource,
  visitExpr,
  codePointHex,
  findPasteCharRuns,
  type BinaryOp,
  type Diagnostic,
  type Expr,
  type FieldRef,
  type FunctionCall,
  type StringLit,
} from "../syntax/index.ts";
import { analyze } from "../analysis/index.ts";
import {
  localizedContextLabel,
  localizedFunctionLintNote,
  t,
} from "../i18n/index.ts";
import { getContext, getFunction } from "../registry/index.ts";

/**
 * Linter (DESIGN §8.4): registry- and AST-driven style/robustness hints, emitted
 * as ordinary `Diagnostic`s so they surface in the same Problems panel and
 * editor squiggles as syntax and type findings.
 *
 * Every rule here is a heuristic over an AST whose field types are Unknown, so
 * messages hedge ("looks like", "if X is a picklist") and severity never
 * exceeds `warning` — unlike the evaluator, which must be exact or refuse,
 * the linter is allowed to be helpfully unsure.
 */

/** IF chains nested deeper than this suggest CASE() or restructuring. */
const MAX_IF_DEPTH = 3;

/**
 * Salesforce record-ID shape: 15 (case-sensitive) or 18 (case-safe) base-62
 * characters. Requiring at least one digit and one letter filters out ordinary
 * words and numbers of coincidental length.
 */
const ID_SHAPE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

const EQUALITY_OPS: ReadonlySet<BinaryOp["op"]> = new Set([
  "=",
  "<>",
  "==",
  "!=",
]);

export interface DiagnosedFormula {
  /** Always present; error recovery yields a partial tree, never nothing. */
  readonly ast: Expr;
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Whether the *syntax* is invalid. Read off the parse diagnostics, not the
   * AST shape: recovery can produce a complete tree from invalid text (e.g.
   * pasted invisible characters recovered as trivia).
   */
  readonly syntaxErrors: boolean;
}

/**
 * Full diagnostic pipeline — parse (syntax + recovery), analyze (types, arity,
 * availability, return type), lint (style/robustness) — in source order. The
 * single entry point for the editor's lint source and the UI Problems panel;
 * both consume the same AST and the same diagnostics from one pass.
 * Lives here rather than in analysis/ because the dependency arrow points
 * features → analysis, never back.
 */
export function diagnoseParsed(
  source: string,
  contextId: string,
): DiagnosedFormula {
  const { ast, diagnostics } = parse(source);
  const syntaxErrors = diagnostics.some((d) => d.severity === "error");
  // Not trim(): trim() also strips NBSP/BOM-class paste artifacts, which would
  // report a document containing only them as clean.
  if (isBlankSource(source)) {
    return { ast, diagnostics: [], syntaxErrors };
  }
  const merged = [
    ...diagnostics,
    ...analyze(ast, source, contextId),
    ...lint(ast, source, contextId),
  ].sort((a, b) => a.span.start - b.span.start);
  return { ast, diagnostics: withDisjointFixes(merged), syntaxErrors };
}

/** The diagnostics alone, for callers that already have (or don't need) the AST. */
export function diagnose(
  source: string,
  contextId: string,
): readonly Diagnostic[] {
  return diagnoseParsed(source, contextId).diagnostics;
}

/**
 * Enforce the `DiagnosticFix` invariant across producers: a structural fix
 * from the checker can textually contain a character-level fix from the lexer
 * (a smart-quoted string inside `"a" == b`). Keep the smaller fix and drop the
 * larger one — the character fix is the prerequisite, and the structural fix
 * comes back on the re-diagnose that follows it. With every surviving fix
 * disjoint, any subset applies as one batch.
 */
function withDisjointFixes(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  const fixable = diagnostics
    .filter((d) => d.fix)
    .sort((a, b) => editedLength(a) - editedLength(b));
  const kept: Diagnostic[] = [];
  const dropped = new Set<Diagnostic>();
  for (const d of fixable) {
    if (kept.some((k) => overlaps(k, d))) {
      dropped.add(d);
    } else {
      kept.push(d);
    }
  }
  if (dropped.size === 0) {
    return diagnostics;
  }
  return diagnostics.map((d) =>
    dropped.has(d) ? { ...d, fix: undefined } : d,
  );
}

function editedLength(d: Diagnostic): number {
  return (d.fix?.edits ?? []).reduce((n, e) => n + spanLength(e.span), 0);
}

function overlaps(a: Diagnostic, b: Diagnostic): boolean {
  return (a.fix?.edits ?? []).some((x) =>
    (b.fix?.edits ?? []).some(
      (y) => x.span.start < y.span.end && y.span.start < x.span.end,
    ),
  );
}

/** Run only the lint rules over an already-parsed formula. */
export function lint(
  root: Expr,
  source: string,
  contextId: string,
): readonly Diagnostic[] {
  const out: Diagnostic[] = [];

  visitExpr(root, (node) => {
    switch (node.kind) {
      case "StringLit":
        checkHardcodedId(node, out);
        checkInvisibleInString(node, out);
        return;
      case "BinaryOp":
        checkTextPicklistComparison(node, out);
        return;
      case "FunctionCall":
        checkLintNotes(node, out);
        return;
      default:
        return;
    }
  });

  checkIfNesting(root, out);
  checkCharLimit(source, contextId, out);

  return out.sort((a, b) => a.span.start - b.span.start);
}

function unwrapParen(node: Expr): Expr {
  return node.kind === "Paren" ? unwrapParen(node.expr) : node;
}

// --- rules ---------------------------------------------------------------

function checkHardcodedId(node: StringLit, out: Diagnostic[]): void {
  if (!ID_SHAPE.test(node.value)) {
    return;
  }
  out.push({
    code: "hardcoded-id",
    severity: "warning",
    span: node.span,
    message: t().linter.hardcodedId(node.value),
  });
}

/**
 * Invisible characters inside a string literal are legal — Salesforce
 * compiles them — but they become part of the compared value, so equality
 * against text that *looks* identical fails with no visible reason. Warn with
 * a removal fix. Non-standard spaces (no-break space etc.) are left alone:
 * space-like content inside a string may be intentional.
 */
function checkInvisibleInString(node: StringLit, out: Diagnostic[]): void {
  for (const run of findPasteCharRuns(node.raw, node.span.start)) {
    if (run.kind !== "format") {
      continue;
    }
    const hex = codePointHex(run.char);
    out.push({
      code: "invisible-in-string",
      severity: "warning",
      span: run.span,
      message: t().linter.invisibleInString(
        hex,
        t().syntax.lexer.characterNames[hex] ?? null,
        run.count,
      ),
      fix: {
        title: t().syntax.lexer.fixes.removeInvisible(run.count),
        edits: [{ span: run.span, newText: "" }],
        changesSemantics: true,
      },
    });
  }
}

/**
 * Report the outermost IF whose nesting depth exceeds the threshold, then stop
 * descending — one finding per chain, not one per level.
 */
function checkIfNesting(node: Expr, out: Diagnostic[]): void {
  if (isIf(node)) {
    const depth = ifDepth(node);
    if (depth > MAX_IF_DEPTH) {
      out.push({
        code: "deep-if-nesting",
        severity: "info",
        span: node.calleeSpan,
        message: t().linter.deepIfNesting(depth),
        docsUrl: getFunction("CASE")?.docsUrl,
      });
      return;
    }
  }
  for (const child of childrenOf(node)) {
    checkIfNesting(child, out);
  }
}

function isIf(node: Expr): node is FunctionCall {
  return node.kind === "FunctionCall" && node.callee.toUpperCase() === "IF";
}

/** Maximum count of IF calls along any root-to-leaf path of the subtree. */
function ifDepth(node: Expr): number {
  const inner = Math.max(0, ...childrenOf(node).map(ifDepth));
  return isIf(node) ? inner + 1 : inner;
}

function checkTextPicklistComparison(node: BinaryOp, out: Diagnostic[]): void {
  if (!EQUALITY_OPS.has(node.op)) {
    return;
  }
  const left = unwrapParen(node.left);
  const right = unwrapParen(node.right);

  let field: FieldRef | null = null;
  let literal: StringLit | null = null;
  if (right.kind === "StringLit") {
    field = textOfField(left);
    literal = right;
  } else if (left.kind === "StringLit") {
    field = textOfField(right);
    literal = left;
  }
  if (!field || !literal) {
    return;
  }

  const path = field.path.join(".");
  out.push({
    code: "prefer-ispickval",
    severity: "info",
    span: node.span,
    message: t().linter.preferIspickval(path, literal.raw),
    docsUrl: getFunction("ISPICKVAL")?.docsUrl,
  });
}

/** Match `TEXT(field)` and return the field, else null. */
function textOfField(node: Expr): FieldRef | null {
  if (
    node.kind !== "FunctionCall" ||
    node.callee.toUpperCase() !== "TEXT" ||
    node.args.length !== 1
  ) {
    return null;
  }
  const arg = unwrapParen(node.args[0]!);
  return arg.kind === "FieldRef" && !arg.isGlobal ? arg : null;
}

/** Surface the registry's per-function `lintNotes` (discouraged constructs). */
function checkLintNotes(node: FunctionCall, out: Diagnostic[]): void {
  const spec = getFunction(node.callee);
  if (!spec?.lintNotes) {
    return;
  }
  for (const note of spec.lintNotes) {
    out.push({
      code: "discouraged-function",
      severity: "info",
      span: node.calleeSpan,
      message: localizedFunctionLintNote(note.id, note.message),
      docsUrl: spec.docsUrl,
    });
  }
}

function checkCharLimit(
  source: string,
  contextId: string,
  out: Diagnostic[],
): void {
  const context = getContext(contextId);
  if (!context?.charLimit || source.length <= context.charLimit) {
    return;
  }
  out.push({
    code: "char-limit",
    severity: "warning",
    // Highlight the overflowing tail rather than the whole document.
    span: span(context.charLimit, source.length),
    message: t().linter.charLimit(
      source.length,
      localizedContextLabel(context.id, context.label),
      context.charLimit,
    ),
  });
}
