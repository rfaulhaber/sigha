import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parse, type Diagnostic, type TextEdit } from "../syntax/index.ts";
import {
  Decimal,
  evaluateFormula,
  isError,
  type EvalResult,
  type SfValue,
} from "../engine/index.ts";
import { analyze } from "./checker.ts";

/** The nonstandard-operator findings of a formula, in source order. */
function findings(source: string): Diagnostic[] {
  return analyze(parse(source).ast, source, "formula_field").filter(
    (d) => d.code === "nonstandard-operator",
  );
}

function applyEdits(source: string, edits: readonly TextEdit[]): string {
  // Back to front, so an earlier edit's offsets stay valid.
  return [...edits]
    .sort((a, b) => b.span.start - a.span.start)
    .reduce(
      (text, e) =>
        text.slice(0, e.span.start) + e.newText + text.slice(e.span.end),
      source,
    );
}

/** The formula with every offered nonstandard-operator fix applied. */
function autofixed(source: string): string {
  return applyEdits(
    source,
    findings(source).flatMap((d) => d.fix?.edits ?? []),
  );
}

/** How many of the findings carry a fix. */
function fixCount(source: string): number {
  return findings(source).filter((d) => d.fix).length;
}

describe("nonstandard-operator fix: infix AND/OR", () => {
  it("rewrites a single operator into the variadic call", () => {
    expect(autofixed("a && b")).toBe("AND(a, b)");
    expect(autofixed("a || b")).toBe("OR(a, b)");
    expect(autofixed("a&&b")).toBe("AND(a, b)");
  });

  it("flattens a chain under one fix on the outermost finding", () => {
    expect(findings("a && b && c")).toHaveLength(2);
    expect(fixCount("a && b && c")).toBe(1);
    expect(autofixed("a && b && c")).toBe("AND(a, b, c)");
  });

  it("rewrites mixed operators through the single topmost fix", () => {
    expect(fixCount("a && b || c")).toBe(1);
    expect(autofixed("a && b || c")).toBe("OR(AND(a, b), c)");
  });

  it("keeps parentheses as a grouping boundary", () => {
    expect(autofixed("a && (b && c)")).toBe("AND(a, (AND(b, c)))");
  });

  it("fixes an operator nested in a function argument", () => {
    expect(autofixed("IF(a || b, x, y)")).toBe("IF(OR(a, b), x, y)");
  });

  it("rebuilds the surrounding call when the fix spans it", () => {
    expect(autofixed("IF(a || b, TODAY(), x) && c")).toBe(
      "AND(IF(OR(a, b), TODAY(), x), c)",
    );
  });

  it("preserves the operand's own spacing and comments", () => {
    expect(autofixed("(a /* keep */) && b")).toBe("AND((a /* keep */), b)");
    expect(autofixed("NOT(  a  ) && b")).toBe("AND(NOT(  a  ), b)");
  });
});

describe("nonstandard-operator fix: == and !=", () => {
  it("swaps only the operator when the operands need no rewrite", () => {
    const [d] = findings("a == b");
    expect(d!.fix?.edits).toEqual([
      { span: { start: 2, end: 4 }, newText: "=" },
    ]);
    expect(autofixed("a == b")).toBe("a = b");
    expect(autofixed("a != b")).toBe("a <> b");
    // The minimal edit cannot disturb a comment, wherever it sits.
    expect(autofixed("a /* keep */ == b")).toBe("a /* keep */ = b");
  });

  it("rewrites nested equality as part of an enclosing AND/OR fix", () => {
    expect(autofixed("a == b && c")).toBe("AND(a = b, c)");
    expect(autofixed("-a != b || c")).toBe("OR(-a <> b, c)");
  });
});

describe("nonstandard-operator fix: refusals", () => {
  it("offers no fix when rewriting would swallow a comment", () => {
    expect(findings("a /* keep */ && b")).toHaveLength(1);
    expect(fixCount("a /* keep */ && b")).toBe(0);
    expect(fixCount("a && /* keep */ b")).toBe(0);
    // The comment sits in a call the rewrite has to rebuild (its last
    // argument holds the nested operator), so the whole fix is dropped.
    expect(fixCount("IF(a /* keep */, b, c || d) && e")).toBe(0);
  });

  it("still fixes when the comment sits inside an untouched operand", () => {
    expect(autofixed("IF(a /* keep */, b, c) && d")).toBe(
      "AND(IF(a /* keep */, b, c), d)",
    );
  });

  it("offers no fix over a recovered hole", () => {
    expect(fixCount("a && ")).toBe(0);
  });
});

// --- equivalence under the real evaluator --------------------------------

const bools = fc.constantFrom<SfValue>(
  { type: "Boolean", blank: false, data: true },
  { type: "Boolean", blank: false, data: false },
  { type: "Boolean", blank: true, data: false },
);
const nums = fc.constantFrom<SfValue>(
  { type: "Number", blank: false, data: new Decimal(0) },
  { type: "Number", blank: false, data: new Decimal(1) },
  { type: "Number", blank: true, data: new Decimal(0) },
);
const texts = fc.constantFrom<SfValue>(
  { type: "Text", blank: false, data: "" },
  { type: "Text", blank: false, data: "x" },
  { type: "Text", blank: true, data: "" },
);

const envArb = fc
  .record({
    A: bools,
    B: bools,
    N: nums,
    M: nums,
    S: texts,
    blankMode: fc.constantFrom("zero" as const, "blank" as const),
  })
  .map(({ blankMode, ...fields }) => ({
    fields: new Map(Object.entries(fields)),
    blankMode,
  }));

// Boolean-yielding leaves, deliberately including blank-prone comparisons and
// a division that errors when M is zero.
const leaf = fc.constantFrom(
  "A",
  "B",
  "TRUE",
  "FALSE",
  "ISBLANK(S)",
  "N > M",
  "N = 0",
  'S = "x"',
  "N / M > 1",
);

const formulaArb: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    leaf,
    fc.tuple(tie("node"), tie("node")).map(([a, b]) => `${a} && ${b}`),
    fc.tuple(tie("node"), tie("node")).map(([a, b]) => `${a} || ${b}`),
    fc.tuple(tie("node"), tie("node")).map(([a, b]) => `${a} == ${b}`),
    fc.tuple(tie("node"), tie("node")).map(([a, b]) => `${a} != ${b}`),
    tie("node").map((x) => `(${x})`),
    tie("node").map((x) => `NOT(${x})`),
    fc
      .tuple(tie("node"), tie("node"), tie("node"))
      .map(([c, a, b]) => `IF(${c}, ${a}, ${b})`),
  ),
})).node;

/** Same simulated outcome: same error-ness, blankness, type, and data. */
function sameResult(a: EvalResult, b: EvalResult): boolean {
  if (isError(a) || isError(b)) {
    return isError(a) && isError(b);
  }
  if (a.blank || b.blank) {
    return a.blank === b.blank;
  }
  if (a.type !== b.type) {
    return false;
  }
  if (a.data instanceof Decimal && b.data instanceof Decimal) {
    return a.data.equals(b.data);
  }
  return a.data === b.data;
}

describe("nonstandard-operator fix: rule-7 property — the rewrite preserves engine semantics", () => {
  it("original and fixed agree over random inputs, blanks, both modes", () => {
    fc.assert(
      fc.property(formulaArb, envArb, (source, env) => {
        const fixed = autofixed(source);
        const original = parse(source);
        const rewritten = parse(fixed);
        expect(
          rewritten.diagnostics.filter((d) => d.severity === "error"),
        ).toEqual([]);
        // Every occurrence goes away: nested findings are covered by the
        // topmost fix, so one pass leaves nothing behind.
        expect(findings(fixed)).toEqual([]);

        const before = evaluateFormula(original.ast, env);
        const after = evaluateFormula(rewritten.ast, env);
        if (!sameResult(before, after)) {
          throw new Error(
            `fix changed behavior\n  original: ${source}\n  fixed:    ${fixed}\n` +
              `  env: ${JSON.stringify([...env.fields], null, 0)} mode=${env.blankMode}\n` +
              `  before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
          );
        }
      }),
      { numRuns: 500 },
    );
  });
});
