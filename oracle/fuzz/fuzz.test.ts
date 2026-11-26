import { describe, expect, it } from "vitest";
import { parse } from "../../src/syntax/index.ts";
import { generateFormulas } from "./generate.ts";
import {
  buildProbes,
  parseOracleOutput,
  renderProbeFile,
  type Probe,
} from "./probes.ts";
import { diffProbes, withOracleNegativePowers } from "./differential.ts";
import { triage } from "./triage.ts";
import { Decimal } from "../../src/engine/index.ts";

/**
 * WS4 fuzzer unit suite. The JVM leg is mocked with harness transcripts so this
 * runs in the ordinary test pass — a real oracle run is a manual command
 * (oracle/README.md).
 */

describe("generator", () => {
  it("is a pure function of the seed", () => {
    const a = generateFormulas({ seed: 7, count: 40 });
    const b = generateFormulas({ seed: 7, count: 40 });
    const other = generateFormulas({ seed: 8, count: 40 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
  });

  it("emits well-typed formulas that parse without diagnostics", () => {
    for (const g of generateFormulas({ seed: 3, count: 300 })) {
      const { diagnostics } = parse(g.formula);
      expect(
        diagnostics,
        `${g.formula}: ${JSON.stringify(diagnostics)}`,
      ).toEqual([]);
    }
  });

  it("never emits probe-file delimiters or duplicates", () => {
    const formulas = generateFormulas({ seed: 11, count: 200 });
    expect(new Set(formulas.map((f) => f.formula)).size).toBe(formulas.length);
    for (const g of formulas) {
      expect(/[\t\n\r]/.test(g.formula)).toBe(false);
    }
  });
});

describe("probe encoding", () => {
  it("emits one field-valued line per formula per blank mode", () => {
    const probes = buildProbes([{ formula: '1 + LEN("ab")', type: "Number" }]);
    expect(renderProbeFile(probes)).toBe(
      'DOUBLE\tzero\t1 + LEN("ab")\t\nDOUBLE\tblank\t1 + LEN("ab")\t\n',
    );
  });

  it("decodes values, nulls and errors from the harness transcript", () => {
    const stdout = [
      "DOUBLE\t1/3\tBigDecimal\t0.333",
      'TEXT\tLEFT("", 3)\tnull\tnull',
      "DOUBLE\tMOD(10, 0)\tERROR\tArithmeticException: Division by zero",
      'DOUBLE\tVALUE("abc")\tERROR\tExecutionError: java.lang.ExceptionInInitializerError',
      "",
    ].join("\n");
    expect(parseOracleOutput(stdout)).toEqual([
      { formula: "1/3", expected: "0.333", infra: false },
      { formula: 'LEFT("", 3)', expected: "null", infra: false },
      {
        formula: "MOD(10, 0)",
        expected: "Error: ArithmeticException: Division by zero",
        infra: false,
      },
      {
        formula: 'VALUE("abc")',
        expected:
          "Error: ExecutionError: java.lang.ExceptionInInitializerError",
        infra: true,
      },
    ]);
  });
});

describe("triage", () => {
  const base = { blankMode: "zero" } as const;

  it("routes the org-overruled MOD(x, 0) error to known divergence", () => {
    expect(
      triage({
        ...base,
        formula: "MOD(3, 0)",
        oracle: "Error: ArithmeticException: Division by zero",
        ours: "3",
      }).bucket,
    ).toBe("known-divergence");
  });

  it("routes a TEXT() digit-budget difference to known divergence", () => {
    expect(
      triage({
        ...base,
        formula: "TEXT(1 / 3)",
        oracle: "0.333333333333333333333333333333333333333",
        ours: ".3333333333333333333333333333333333333333",
      }).bucket,
    ).toBe("known-divergence");
  });

  it("recognizes a TEXT() rendering difference inside a longer string", () => {
    expect(
      triage({
        ...base,
        formula: "TEXT(3.75) & TEXT(1 / 3)",
        oracle: "3.750.333333333333333333333333333333333333333",
        ours: "3.75.3333333333333333333333333333333333333333",
      }).bucket,
    ).toBe("known-divergence");
  });

  it("recognizes the `^` double-precision path", () => {
    expect(
      triage({
        ...base,
        formula: "((7 - 9) - MFLOOR(10)) / MIN((1), (9) ^ -2)",
        oracle: "-972.00000000000000097200000000000000",
        ours: "-971.9999999999999999999999999996598",
      }).bucket,
    ).toBe("known-divergence");
  });

  it("sends the oracle's blank-where-we-compute to an org probe", () => {
    expect(
      triage({
        ...base,
        formula: '"" < "a"',
        oracle: "null",
        ours: "true",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("sends negative-digit rounding to an org probe", () => {
    expect(
      triage({
        ...base,
        formula: 'ROUND(LEN(" " & "abcabc"), -1)',
        oracle: "0",
        ours: "10",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("treats an oracle-only error over a computed value as an org question", () => {
    expect(
      triage({
        ...base,
        formula: 'LEN("abc") + 1',
        oracle: "Error: FormulaEvaluationException: something",
        ours: "4",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("treats a shared-precision numeric tail as an org question", () => {
    expect(
      triage({
        ...base,
        formula: "1 / 7",
        oracle: "0.14285714285714285714285714285714",
        ours: "0.142857142857142857142857142857142857",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("sends a TEXT() rendering measured through LEN/FIND to an org probe", () => {
    expect(
      triage({
        ...base,
        formula: 'FIND(LOWER("0" & "0"), TEXT((7 / 1000)))',
        oracle: "3",
        ours: "2",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("sends a TEXT() rendering flipping a comparison to an org probe", () => {
    // Seed-6 weekly finding: we render the computed TEXT(0.5) as ".5"
    // (org-verified), the oracle constant-folds to "0.5"; both engines order
    // the strings identically, so only the rendering flips the boolean.
    expect(
      triage({
        ...base,
        formula: '(TEXT(MOD(0.5, 2.5)) < TEXT(FIND("0", " ")))',
        oracle: "false",
        ours: "true",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("treats a negative-exponent `^` precision gap amplified by MOD as the known `^` divergence when the oracle's power value reproduces it", () => {
    // Seed-19 weekly finding: 123456789^-1 at the org's scale 42 rounds up,
    // so MOD's floor quotient drops by one and the remainder is ~the divisor;
    // the OSS 18-digit value rounds down and leaves a remainder near zero.
    const d = {
      ...base,
      formula:
        "MOD(IF(IF(TRUE, TRUE, TRUE), 2, (0.5 - 0)), (ROUND(123456789, 3)) ^ -1)",
      oracle: "1.8790274E-19",
      ours: "8.10000007371000067076101e-9",
    };
    expect(triage({ ...d, agreesWithOraclePower: true }).bucket).toBe(
      "known-divergence",
    );
    expect(triage(d).bucket).toBe("our-bug");
  });

  it("sends a 39-vs-40 digit disagreement to an org probe when our evaluator reproduces the oracle at its precision", () => {
    // Seed-10 weekly finding: MOD scales the divisor's last-digit rounding by
    // the integer quotient, so the 40th digit our numeric model carries
    // (value.ts) lands inside the 32-place materialization.
    const d = {
      ...base,
      formula: '(MCEILING(LEN("12")) / MOD(CEILING(1.5), 0.0001 / 3.75))',
      oracle: "75000.00000000000000000000000000000703",
      ours: "75000.0000000000000000000000000000007",
    };
    expect(triage({ ...d, agreesAtOraclePrecision: true }).bucket).toBe(
      "org-probe-candidate",
    );
    expect(triage(d).bucket).toBe("our-bug");
  });

  it("sends an OSS null from CONTAINS on an empty subject, absorbed by IF, to an org probe", () => {
    // Seed-8 weekly finding: the OSS FunctionContains pushes null for an
    // empty subject, NOT propagates it and IF takes the else branch. The org
    // evidence for CONTAINS(blank, y) = false is IF-only, so it cannot split
    // a real false from a null.
    expect(
      triage({
        ...base,
        formula:
          'IF(NOT(CONTAINS("", "0")), MOD(LEN("abcabc"), SQRT(0.5)), MCEILING(2))',
        oracle: "2",
        ours: "0.3431457505076192",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("sends the `^` fold-boundary refusal to an org probe", () => {
    expect(
      triage({
        ...base,
        formula: "(SQRT(1234.5 - 12.125)) ^ 3",
        oracle: "42737.2613545133959",
        ours: "#Error(#Error! (^ result exceeds the numeric precision limit))",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("sends an oracle-only error over our blank to an org probe", () => {
    expect(
      triage({
        ...base,
        formula: '(ABS(0) / CEILING(VALUE("")))',
        oracle:
          'Error: NumberFormatException: Character N is neither a decimal digit number, decimal point, nor "e" notation exponential mark.',
        ours: "blank",
      }).bucket,
    ).toBe("org-probe-candidate");
  });

  it("calls a plain value disagreement our bug", () => {
    expect(
      triage({ ...base, formula: "2 * 3", oracle: "7", ours: "6" }).bucket,
    ).toBe("our-bug");
  });
});

describe("diffProbes against a mocked oracle", () => {
  const probes: readonly Probe[] = [
    { formula: "1 + 1", type: "Number", blankMode: "zero" },
    { formula: "2 * 3", type: "Number", blankMode: "zero" },
    { formula: 'VALUE("abc")', type: "Number", blankMode: "zero" },
  ];
  const transcript = [
    "DOUBLE\t1 + 1\tBigDecimal\t2",
    "DOUBLE\t2 * 3\tBigDecimal\t7",
    'DOUBLE\tVALUE("abc")\tERROR\tExecutionError: java.lang.ExceptionInInitializerError',
  ].join("\n");

  it("separates agreement, disagreement and unreportable probes", () => {
    const diff = diffProbes(probes, parseOracleOutput(transcript));
    expect(diff.summary.agree).toBe(1);
    expect(diff.summary.differ).toBe(1);
    expect(diff.summary.inconclusive).toBe(1);
    expect(diff.discrepancies[0]).toMatchObject({
      formula: "2 * 3",
      ours: "6",
      oracle: "7",
      verdict: { bucket: "our-bug" },
    });
  });

  it("re-evaluates a disagreement at the oracle's 39-digit precision before triage", () => {
    // Seeds 8 and 10: MOD and a large multiplier promote the 40th digit our
    // model carries into the materialized range; at the OSS engine's own
    // MathContext our evaluator reproduces both oracle values exactly.
    const amplified: readonly Probe[] = [
      {
        formula: '(MCEILING(LEN("12")) / MOD(CEILING(1.5), 0.0001 / 3.75))',
        type: "Number",
        blankMode: "zero",
      },
      {
        formula: "(9 / 7) * CEILING(123456789)",
        type: "Number",
        blankMode: "zero",
      },
    ];
    const oracle = parseOracleOutput(
      [
        'DOUBLE\t(MCEILING(LEN("12")) / MOD(CEILING(1.5), 0.0001 / 3.75))\tBigDecimal\t75000.00000000000000000000000000000703',
        "DOUBLE\t(9 / 7) * CEILING(123456789)\tBigDecimal\t158730157.285714285714285714285714285715",
      ].join("\n"),
    );
    const diff = diffProbes(amplified, oracle);
    expect(diff.summary.differ).toBe(2);
    expect(diff.discrepancies.map((d) => d.verdict.bucket)).toEqual([
      "org-probe-candidate",
      "org-probe-candidate",
    ]);
    // The re-evaluation must not leak the oracle's precision into later probes.
    expect(Decimal.precision).toBe(40);
  });

  it("re-evaluates a disagreement with the oracle's 18-digit negative-exponent `^` before triage", () => {
    // Seed 19: MOD amplifies the 18-vs-scale-42 `^` precision gap past the
    // 15-digit fold signature. With the OSS power value spliced in, our
    // evaluator reproduces both oracle values exactly.
    const amplified: readonly Probe[] = [
      {
        formula: 'MOD(ABS(100) - LEN("-3"), MOD((3) ^ -2, FLOOR(12.125)))',
        type: "Number",
        blankMode: "zero",
      },
      {
        formula:
          "MOD(IF(IF(TRUE, TRUE, TRUE), 2, (0.5 - 0)), (ROUND(123456789, 3)) ^ -1)",
        type: "Number",
        blankMode: "blank",
      },
    ];
    const oracle = parseOracleOutput(
      [
        'DOUBLE\tMOD(ABS(100) - LEN("-3"), MOD((3) ^ -2, FLOOR(12.125)))\tBigDecimal\t9.8E-17',
        "DOUBLE\tMOD(IF(IF(TRUE, TRUE, TRUE), 2, (0.5 - 0)), (ROUND(123456789, 3)) ^ -1)\tBigDecimal\t1.8790274E-19",
      ].join("\n"),
    );
    const diff = diffProbes(amplified, oracle);
    expect(diff.summary.differ).toBe(2);
    expect(diff.discrepancies.map((d) => d.verdict.bucket)).toEqual([
      "known-divergence",
      "known-divergence",
    ]);
  });

  it("splices only outermost negative-exponent `^` nodes", () => {
    expect(withOracleNegativePowers("MOD(98, 3 ^ -2)", "zero")).toBe(
      "MOD(98, (0.111111111111111111))",
    );
    // A positive exponent is the fold path the 15-digit rule already covers.
    expect(withOracleNegativePowers("MOD(98, 3 ^ 2)", "zero")).toBeNull();
    expect(withOracleNegativePowers("(2 ^ -1) ^ -2 + 1", "zero")).toBe(
      "(4) + 1",
    );
  });

  it("refuses to compare a transcript that does not line up", () => {
    const short = parseOracleOutput("DOUBLE\t1 + 1\tBigDecimal\t2");
    expect(() => diffProbes(probes, short)).toThrow(/positionally/);
    const drifted = parseOracleOutput(
      [
        "DOUBLE\t1 + 1\tBigDecimal\t2",
        "DOUBLE\t9 * 9\tBigDecimal\t81",
        'DOUBLE\tVALUE("abc")\tnull\tnull',
      ].join("\n"),
    );
    expect(() => diffProbes(probes, drifted)).toThrow(/drifted/);
  });
});
