/**
 * WS4 differential fuzzer — the pure core: plan probes, evaluate them with our
 * engine, diff against the JVM oracle's answers, and render the triage report.
 *
 * All file, process and clock access lives in `run.mjs`; everything here is a
 * pure function of its inputs so the whole pipeline is testable with a mocked
 * oracle transcript.
 *
 * Comparison is delegated to `src/engine/conformance.ts` — the same `runRow`
 * the conformance suite uses — so the fuzzer cannot drift into a second,
 * friendlier notion of "equal".
 *
 * This tool never writes corpus rows. The oracle is the *second* tier of the
 * trust order; a difference it alone witnesses is a question for a real org,
 * not a golden expectation.
 */

import type { CorpusRow } from "../../src/engine/corpus.ts";
import { runRow } from "../../src/engine/conformance.ts";
import {
  Decimal,
  asDecimal,
  evaluateFormula,
  isError,
  type EvalResult,
} from "../../src/engine/index.ts";
import { parse, visitExpr, type Expr } from "../../src/syntax/index.ts";
import { generateFormulas, type FuzzOptions } from "./generate.ts";
import {
  buildProbes,
  corpusDataType,
  renderProbeFile,
  type OracleResult,
  type Probe,
} from "./probes.ts";
import { triage, type Bucket, type Verdict } from "./triage.ts";

export interface FuzzPlan {
  readonly probes: readonly Probe[];
  readonly probeFile: string;
  readonly formulaCount: number;
}

export interface Discrepancy {
  readonly formula: string;
  readonly blankMode: Probe["blankMode"];
  readonly dataType: string;
  readonly ours: string;
  readonly oracle: string;
  readonly verdict: Verdict;
}

export interface FuzzSummary {
  readonly formulas: number;
  readonly probes: number;
  readonly agree: number;
  readonly differ: number;
  readonly inconclusive: number;
  readonly quarantine: number;
  readonly refusedByUs: number;
  readonly byBucket: Readonly<Record<Bucket, number>>;
}

export interface FuzzDiff {
  readonly summary: FuzzSummary;
  readonly discrepancies: readonly Discrepancy[];
  /** Formulas our evaluator declined to simulate, for the report's tail. */
  readonly refusals: readonly string[];
  /** Probes the comparator could not judge either way. */
  readonly quarantined: readonly string[];
}

export interface ReportMeta {
  readonly seed: number;
  readonly count: number;
  readonly depth: number;
  readonly generatedAt: string;
  readonly oracleCommand: string;
}

export function planFuzz(opts: FuzzOptions): FuzzPlan {
  const formulas = generateFormulas(opts);
  const probes = buildProbes(formulas);
  return {
    probes,
    probeFile: renderProbeFile(probes),
    formulaCount: formulas.length,
  };
}

export function diffProbes(
  probes: readonly Probe[],
  oracleResults: readonly OracleResult[],
): FuzzDiff {
  if (probes.length !== oracleResults.length) {
    throw new Error(
      `oracle returned ${oracleResults.length} lines for ${probes.length} probes; ` +
        "results are matched positionally, so the run cannot be trusted",
    );
  }
  const byBucket: Record<Bucket, number> = {
    "our-bug": 0,
    "org-probe-candidate": 0,
    "known-divergence": 0,
    inconclusive: 0,
  };
  const discrepancies: Discrepancy[] = [];
  const refusals: string[] = [];
  const quarantined: string[] = [];
  let agree = 0;
  let inconclusive = 0;

  probes.forEach((probe, i) => {
    const oracle = oracleResults[i]!;
    if (oracle.formula !== probe.formula) {
      throw new Error(
        `oracle line ${i} echoes ${JSON.stringify(oracle.formula)} but probe ${i} is ` +
          `${JSON.stringify(probe.formula)}; positional matching has drifted`,
      );
    }
    if (oracle.infra) {
      inconclusive += 1;
      byBucket.inconclusive += 1;
      return;
    }
    const row: CorpusRow = {
      source: "ws4-fuzz (JVM oracle, not corpus-eligible)",
      name: `fuzz#${i}`,
      formula: probe.formula,
      dataType: corpusDataType(probe.type),
      fields: [],
      blankMode: probe.blankMode,
      expected: oracle.expected,
    };
    const outcome = safeRunRow(row);
    switch (outcome.status) {
      case "pass":
        agree += 1;
        return;
      case "unsupported":
        refusals.push(`[${probe.blankMode}] ${probe.formula}`);
        return;
      case "quarantine":
        quarantined.push(
          `[${probe.blankMode}] ${probe.formula} => oracle ${oracle.expected}`,
        );
        return;
      case "fail": {
        const ours = outcome.got ?? "";
        const verdict = triage({
          formula: probe.formula,
          blankMode: probe.blankMode,
          oracle: oracle.expected,
          ours,
          agreesAtOraclePrecision: reproducesAtOraclePrecision(row),
          agreesWithOraclePower: reproducesWithOraclePower(row),
        });
        byBucket[verdict.bucket] += 1;
        discrepancies.push({
          formula: probe.formula,
          blankMode: probe.blankMode,
          dataType: row.dataType,
          ours,
          oracle: oracle.expected,
          verdict,
        });
        return;
      }
      default: {
        const never: never = outcome.status;
        throw new Error(`unhandled row status ${String(never)}`);
      }
    }
  });

  return {
    summary: {
      formulas: new Set(probes.map((p) => p.formula)).size,
      probes: probes.length,
      agree,
      differ: discrepancies.length,
      inconclusive,
      quarantine: quarantined.length,
      refusedByUs: refusals.length,
      byBucket,
    },
    discrepancies,
    refusals,
    quarantined,
  };
}

/**
 * The OSS engine computes at MathContext(39, HALF_UP) while our evaluator
 * carries a 40th digit (value.ts). A disagreement that vanishes at the
 * oracle's own precision is the digit model alone, not the arithmetic —
 * information triage cannot recover from the two renderings.
 */
const ORACLE_PRECISION = 39;

function reproducesAtOraclePrecision(row: CorpusRow): boolean {
  const ours = Decimal.precision;
  Decimal.set({ precision: ORACLE_PRECISION });
  try {
    return safeRunRow(row).status === "pass";
  } finally {
    Decimal.set({ precision: ours });
  }
}

/**
 * The OSS engine returns a negative-exponent `^` at 18 significant digits;
 * the product carries it at scale 42 (org-verified, VERIFICATION.md `^`
 * entry: literal and field-valued 3^-25 / 7^-20 / 9^-30 are digit-exact at
 * place 42). `MOD` amplifies that last-digit difference by the integer
 * quotient. When `x / d` is mathematically an exact integer, the rounding
 * direction of `d` decides between a remainder near 0 and one near `d`.
 * Triage cannot tell that apart from a real MOD bug by looking at the two
 * renderings.
 *
 * So: splice the oracle's 18-digit value in place of each outermost
 * negative-exponent `^` (located by span) and re-run our evaluator. An exact
 * reproduction proves everything around the `^` agrees with the oracle, and
 * the only difference is the already-overruled `^` precision. Any failure to
 * rewrite or reproduce returns false and leaves the finding where it was.
 */
const ORACLE_POW_SIG_DIGITS = 18;

function reproducesWithOraclePower(row: CorpusRow): boolean {
  const rewritten = withOracleNegativePowers(row.formula, row.blankMode);
  return (
    rewritten !== null &&
    safeRunRow({ ...row, formula: rewritten }).status === "pass"
  );
}

/** `formula` with each negative-exponent `^` replaced by its OSS value, or null. */
export function withOracleNegativePowers(
  formula: string,
  blankMode: CorpusRow["blankMode"],
): string | null {
  let ast: Expr;
  try {
    ast = parse(formula).ast;
  } catch {
    return null;
  }
  const evalNumber = (node: Expr): Decimal | null => {
    let r: EvalResult;
    try {
      r = evaluateFormula(
        parse(formula.slice(node.span.start, node.span.end)).ast,
        {
          fields: new Map(),
          blankMode,
          now: { epochMillis: 0 },
        },
      );
    } catch {
      return null;
    }
    if (isError(r) || r.blank || r.type !== "Number") {
      return null;
    }
    return asDecimal(r);
  };

  const splices: { start: number; end: number; text: string }[] = [];
  visitExpr(ast, (node) => {
    if (node.kind !== "BinaryOp" || node.op !== "^") {
      return;
    }
    // Pre-order: an enclosing splice already covers this node.
    if (
      splices.some((s) => s.start <= node.span.start && node.span.end <= s.end)
    ) {
      return;
    }
    const exponent = evalNumber(node.right);
    if (exponent === null || !exponent.isNegative()) {
      return;
    }
    const value = evalNumber(node);
    if (value === null) {
      return;
    }
    const oss = value.toSignificantDigits(
      ORACLE_POW_SIG_DIGITS,
      Decimal.ROUND_HALF_UP,
    );
    splices.push({
      start: node.span.start,
      end: node.span.end,
      text: `(${oss.toFixed()})`,
    });
  });
  if (splices.length === 0) {
    return null;
  }
  let out = formula;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

/** An evaluator crash is itself a finding, so it is reported, not thrown. */
function safeRunRow(row: CorpusRow): ReturnType<typeof runRow> {
  try {
    return runRow(row);
  } catch (e) {
    return {
      status: "fail",
      got: `#Error(threw: ${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

const BUCKET_HEADINGS: Readonly<Record<Bucket, string>> = {
  "our-bug": "(a) Suspected our-bug",
  "org-probe-candidate":
    "(b) Suspected OSS-vs-product divergence — ORG-PROBE CANDIDATES",
  "known-divergence":
    "(c) Known intentional divergence (org already overruled)",
  inconclusive: "(d) Inconclusive — oracle channel could not report",
};

const MAX_LISTED = 80;

export function renderReport(meta: ReportMeta, diff: FuzzDiff): string {
  const s = diff.summary;
  const lines: string[] = [
    "# WS4 differential fuzz report",
    "",
    `Seed \`${meta.seed}\` · ${meta.count} requested formulas · depth ${meta.depth} · ` +
      `${s.formulas} generated · ${s.probes} probes (both blank modes)`,
    "",
    `Generated ${meta.generatedAt} · oracle: \`${meta.oracleCommand}\``,
    "",
    'The "ours" side is whatever `src/` holds at run time, so a report ages the',
    "moment the evaluator changes; re-run it rather than reading an old copy.",
    "",
    "> **Not a corpus source.** The oracle is tier 2 of the trust order",
    "> (`org-verified > formula-engine oracle > formulon`). Nothing in this",
    "> report may be written into `corpus/*.json`: bucket (b) rows are questions",
    "> for a real org (`orgcheck/`), and only an org answer earns a golden row.",
    "",
    "## Summary",
    "",
    "| outcome | probes |",
    "| --- | ---: |",
    `| agree | ${s.agree} |`,
    `| differ | ${s.differ} |`,
    `| our evaluator refused to simulate | ${s.refusedByUs} |`,
    `| not comparable (quarantine) | ${s.quarantine} |`,
    `| oracle channel unable to report | ${s.inconclusive} |`,
    "",
    "Differences by triage bucket:",
    "",
    "| bucket | count |",
    "| --- | ---: |",
    `| (a) suspected our-bug | ${s.byBucket["our-bug"]} |`,
    `| (b) org-probe candidate | ${s.byBucket["org-probe-candidate"]} |`,
    `| (c) known intentional divergence | ${s.byBucket["known-divergence"]} |`,
    `| (d) inconclusive (oracle channel) | ${s.byBucket.inconclusive} |`,
    "",
  ];

  const order: readonly Bucket[] = [
    "our-bug",
    "org-probe-candidate",
    "known-divergence",
  ];
  for (const bucket of order) {
    const rows = diff.discrepancies.filter((d) => d.verdict.bucket === bucket);
    lines.push(`## ${BUCKET_HEADINGS[bucket]} — ${rows.length}`, "");
    if (rows.length === 0) {
      lines.push("_None._", "");
      continue;
    }
    for (const d of rows.slice(0, MAX_LISTED)) {
      lines.push(
        `- \`${d.formula}\` _(${d.dataType}, ${d.blankMode} mode)_`,
        `  - ours: \`${d.ours}\``,
        `  - oracle: \`${d.oracle}\``,
        `  - triage: ${d.verdict.rationale}`,
      );
    }
    if (rows.length > MAX_LISTED) {
      lines.push("", `_… ${rows.length - MAX_LISTED} more omitted._`);
    }
    lines.push("");
  }

  lines.push(
    `## ${BUCKET_HEADINGS.inconclusive} — ${s.inconclusive}`,
    "",
    "The open-source engine's placeholder i18n grammar throws while building a",
    "rejection message, so the harness reports an initialization failure instead",
    "of the verdict. These probes carry no information in either direction.",
    "",
  );

  if (diff.refusals.length > 0) {
    lines.push(
      `## Our evaluator refused to simulate — ${diff.refusals.length}`,
      "",
      "Honest refusals (hard rule 1), not failures:",
      "",
      ...diff.refusals.slice(0, MAX_LISTED).map((r) => `- \`${r}\``),
      "",
    );
  }
  if (diff.quarantined.length > 0) {
    lines.push(
      `## Not comparable — ${diff.quarantined.length}`,
      "",
      ...diff.quarantined.slice(0, MAX_LISTED).map((q) => `- \`${q}\``),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
