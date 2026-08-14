import {
  assertNever,
  childrenOf,
  span,
  type BinaryOp,
  type BinaryOperator,
  type DiagnosticFix,
  type Expr,
  type FunctionCall,
  type Paren,
  type Span,
  type UnaryOp,
} from "../syntax/index.ts";
import { t } from "../i18n/index.ts";

/**
 * Quick-fix for the `nonstandard-operator` diagnostic: rewrite `&&`/`||` into
 * `AND()`/`OR()` and `==`/`!=` into `=`/`<>`.
 *
 * The rewrite works on source text, not on a printed AST: the formatter prints
 * a synthetic tree and would drop the user's comments. Everything the rewrite
 * does not need to touch is copied verbatim from the original slice, and when
 * a piece it *does* need to touch would swallow a comment the whole fix is
 * dropped — no fix at all beats a fix that destroys a comment.
 */

/** The conventional Salesforce spelling of each nonstandard operator. */
const STANDARD_FORM: Partial<Record<BinaryOperator, string>> = {
  "==": "=",
  "!=": "<>",
  "&&": "AND()",
  "||": "OR()",
};

export function isNonstandardOperator(node: Expr): node is BinaryOp {
  return node.kind === "BinaryOp" && STANDARD_FORM[node.op] !== undefined;
}

/** The conventional form named in the diagnostic message and the fix title. */
export function standardForm(op: BinaryOperator): string {
  // Only ever called for the four nonstandard operators.
  return STANDARD_FORM[op]!;
}

/**
 * Fix for a *topmost* nonstandard node — one with no nonstandard ancestor.
 * Nested occurrences carry no fix: they sit inside this one's edit and
 * disappear from the re-diagnose that follows it, which is what keeps the
 * fixes of distinct diagnostics non-overlapping.
 *
 * Returns null when the subtree cannot be rewritten faithfully.
 */
export function nonstandardOperatorFix(
  node: BinaryOp,
  source: string,
): DiagnosticFix | null {
  const title = t().checker.fixes.replaceNonstandardOperator(
    standardForm(node.op),
  );

  // `==`/`!=` over ordinary operands is a two-character swap; leaving the
  // operands untouched keeps whatever they contain, comments included.
  if (
    (node.op === "==" || node.op === "!=") &&
    !containsNonstandard(node.left) &&
    !containsNonstandard(node.right)
  ) {
    return {
      title,
      edits: [{ span: node.opSpan, newText: standardForm(node.op) }],
    };
  }

  const rewritten = rewrite(node, source);
  if (rewritten === null) {
    return null;
  }
  return { title, edits: [{ span: node.span, newText: rewritten }] };
}

function containsNonstandard(node: Expr): boolean {
  return (
    isNonstandardOperator(node) || childrenOf(node).some(containsNonstandard)
  );
}

/**
 * Rewritten text for a subtree, or null when a comment (or a span the parser
 * only recovered) sits where the rebuilder needs plain punctuation.
 */
function rewrite(node: Expr, src: string): string | null {
  // Recovery leaves zero-width holes (`a && `); splicing one into an argument
  // list would emit a differently-broken formula.
  if (node.span.end <= node.span.start) {
    return null;
  }
  if (!containsNonstandard(node)) {
    return slice(src, node.span);
  }

  switch (node.kind) {
    case "BinaryOp":
      return rewriteBinary(node, src);
    case "UnaryOp":
      return rewriteUnary(node, src);
    case "Paren":
      return rewriteParen(node, src);
    case "FunctionCall":
      return rewriteCall(node, src);
    case "NumberLit":
    case "StringLit":
    case "BooleanLit":
    case "NullLit":
    case "FieldRef":
    case "ErrorNode":
      // Leaves hold no nonstandard operator, so the check above already
      // returned their slice.
      return slice(src, node.span);
    default:
      return assertNever(node);
  }
}

function rewriteBinary(node: BinaryOp, src: string): string | null {
  if (node.op === "&&" || node.op === "||") {
    const operands = flatten(node, src);
    if (operands === null) {
      return null;
    }
    const parts: string[] = [];
    for (const operand of operands) {
      const text = rewrite(operand, src);
      if (text === null) {
        return null;
      }
      parts.push(text);
    }
    return `${node.op === "&&" ? "AND" : "OR"}(${parts.join(", ")})`;
  }

  const left = rewrite(node.left, src);
  const right = rewrite(node.right, src);
  const before = gap(src, node.left.span.end, node.opSpan.start);
  const after = gap(src, node.opSpan.end, node.right.span.start);
  if (left === null || right === null || before === null || after === null) {
    return null;
  }
  const op =
    node.op === "==" || node.op === "!="
      ? standardForm(node.op)
      : slice(src, node.opSpan);
  return left + before + op + after + right;
}

/**
 * Operands of a same-operator chain, flattened into one variadic call. Parens
 * are a boundary: `a && (b && c)` keeps the user's grouping as an operand
 * rather than hoisting its terms into the outer AND().
 */
function flatten(node: BinaryOp, src: string): Expr[] | null {
  if (
    gap(src, node.left.span.end, node.opSpan.start) === null ||
    gap(src, node.opSpan.end, node.right.span.start) === null
  ) {
    return null;
  }
  const out: Expr[] = [];
  for (const side of [node.left, node.right]) {
    if (side.kind === "BinaryOp" && side.op === node.op) {
      const nested = flatten(side, src);
      if (nested === null) {
        return null;
      }
      out.push(...nested);
    } else {
      out.push(side);
    }
  }
  return out;
}

function rewriteUnary(node: UnaryOp, src: string): string | null {
  const operand = rewrite(node.operand, src);
  const between = gap(src, node.opSpan.end, node.operand.span.start);
  if (operand === null || between === null) {
    return null;
  }
  return slice(src, node.opSpan) + between + operand;
}

function rewriteParen(node: Paren, src: string): string | null {
  const inner = rewrite(node.expr, src);
  const open = gap(src, node.span.start, node.expr.span.start, "(");
  const close = gap(src, node.expr.span.end, node.span.end, ")");
  if (inner === null || open === null || close === null) {
    return null;
  }
  return open + inner + close;
}

function rewriteCall(node: FunctionCall, src: string): string | null {
  if (node.args.length === 0) {
    const parens = gap(src, node.calleeSpan.end, node.span.end, "()");
    return parens === null ? null : slice(src, node.calleeSpan) + parens;
  }

  let out = slice(src, node.calleeSpan);
  let prevEnd = node.calleeSpan.end;
  let separator = "(";
  for (const arg of node.args) {
    const before = gap(src, prevEnd, arg.span.start, separator);
    const text = rewrite(arg, src);
    if (before === null || text === null) {
      return null;
    }
    out += before + text;
    prevEnd = arg.span.end;
    separator = ",";
  }
  const close = gap(src, prevEnd, node.span.end, ")");
  return close === null ? null : out + close;
}

function slice(src: string, s: Span): string {
  return src.slice(s.start, s.end);
}

/**
 * Text between two component spans, copied verbatim so the user's spacing
 * survives — or null when it holds anything beyond whitespace and the
 * punctuation the position calls for. That "anything" is a block comment or a
 * token the parser had to synthesize during recovery; either way the rebuilt
 * text would not faithfully replace the original.
 */
function gap(
  src: string,
  from: number,
  to: number,
  punctuation = "",
): string | null {
  const text = slice(src, span(from, to));
  return text.replace(/\s+/g, "") === punctuation ? text : null;
}
