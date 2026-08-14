import { assertNever, type Expr } from "../../syntax/index.ts";
import { extractFields } from "../../features/index.ts";
import {
  asBool,
  asDecimal,
  asText,
  blank,
  bool,
  evaluateFormula,
  isError,
  UnsupportedError,
  type BlankMode,
  type DatetimeVal,
  type EvalResult,
  type SfValue,
} from "../../engine/index.ts";
import type { SfType } from "../../registry/index.ts";
import {
  buildFieldValue,
  FIELD_TYPES,
  renderResult,
} from "../simulate/fieldValue.ts";
import type { TestRow } from "./state.ts";

/**
 * A row's evaluation outcome. `pass`/`fail` are the only outcomes that make a
 * claim about the formula; the rest are calm refusals, matching the
 * simulator's rule that a wrong answer is worse than an honest "can't tell".
 */
export type TestRowOutcome =
  | { readonly kind: "pass"; readonly actualText: string }
  | { readonly kind: "fail"; readonly actualText: string }
  /** Mode "value" with no expected text yet. Distinct from fail: an empty
   * string parses to a real 0/false/"" (buildFieldValue's own convention for
   * a blank-unchecked cell), so a row the user hasn't written an assertion
   * for yet must not silently compare against that fabricated value. */
  | { readonly kind: "incomplete"; readonly actualText: string }
  /** The row's expected text doesn't parse as the actual result's type —
   * distinct from a real mismatch, since comparing against it would be
   * comparing against the parser's blank fallback, not what the user
   * meant. */
  | { readonly kind: "badExpected"; readonly actualText: string }
  | { readonly kind: "unsupported"; readonly functionName: string };

/**
 * Evaluate one test row against the formula: build the field env from the
 * row's cells (a missing cell reads as blank, same as a field the row
 * predates), run the formula, and classify the result against the row's
 * expected outcome. Pure — the caller decides what to do with syntax errors
 * (DESIGN §8.1's simulation-boundary refusal applies per row here too).
 */
export function evaluateTestRow(
  ast: Expr,
  row: TestRow,
  types: Readonly<Record<string, string>>,
  blankMode: BlankMode,
  now: DatetimeVal,
): TestRowOutcome {
  const map = new Map<string, SfValue>();
  for (const f of extractFields(ast)) {
    const raw = types[f.name];
    const type: SfType =
      raw && (FIELD_TYPES as readonly string[]).includes(raw)
        ? (raw as SfType)
        : f.inferredType;
    const cell = row.values[f.name] ?? { value: "", blank: true };
    map.set(f.name, buildFieldValue(type, cell.value, cell.blank));
  }

  let result: EvalResult;
  try {
    result = evaluateFormula(ast, { fields: map, blankMode, now });
  } catch (e) {
    if (e instanceof UnsupportedError) {
      return { kind: "unsupported", functionName: e.functionName };
    }
    throw e;
  }

  const actualText = renderResult(result);

  // No assertion has been written yet — this takes priority over every other
  // classification (including a genuine error or blank result) so a fresh
  // row never reads as a pass or fail the user never asked for.
  if (row.expected.mode === "value" && row.expected.value.trim() === "") {
    return { kind: "incomplete", actualText };
  }

  if (isError(result)) {
    return {
      kind: row.expected.mode === "error" ? "pass" : "fail",
      actualText,
    };
  }
  if (result.blank) {
    return {
      kind: row.expected.mode === "blank" ? "pass" : "fail",
      actualText,
    };
  }
  switch (row.expected.mode) {
    case "error":
    case "blank":
      return { kind: "fail", actualText };
    case "value": {
      const expected = parseExpected(result.type, row.expected.value);
      if (expected.blank) {
        return { kind: "badExpected", actualText };
      }
      return {
        kind: typedEquals(result, expected) ? "pass" : "fail",
        actualText,
      };
    }
    default:
      return assertNever(row.expected.mode);
  }
}

/**
 * Parse the row's expected text as a value of the actual result's type.
 * Boolean and Percent can't reuse buildFieldValue's own raw-text convention
 * as-is: the simulator's Boolean cells are a checkbox and never round-trip
 * through free text, so buildFieldValue's `raw === "true"` is unfailable and
 * case-sensitive here; and buildFieldValue's Percent parsing divides by 100
 * (a form-input convention — "99" means 99%), but renderResult shows the
 * stored fraction, so pasting a displayed Percent result back into Expected
 * must parse as that same fraction, not re-divide it.
 */
function parseExpected(type: SfType, raw: string): SfValue {
  switch (type) {
    case "Boolean": {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "true") {
        return bool(true);
      }
      if (normalized === "false") {
        return bool(false);
      }
      return blank("Boolean");
    }
    case "Percent":
      return buildFieldValue("Number", raw, false);
    default:
      return buildFieldValue(type, raw, false);
  }
}

/**
 * Value equality for a test assertion — never a rendered-string comparison
 * (a text result of "1.50" and an expected "1.5" must differ; a numeric
 * result of 1.50 and an expected "1.5" must not). `expected` is always built
 * from `actual`'s own type, so the two variants line up by construction.
 * Exported for direct coverage of the Unknown arm, which the evaluator never
 * reaches with a non-blank value today (see engine/value.ts's `blank()`) but
 * which must still refuse rather than default to a silent pass.
 */
export function typedEquals(actual: SfValue, expected: SfValue): boolean {
  switch (actual.type) {
    case "Number":
    case "Currency":
    case "Percent":
      return asDecimal(actual).equals(asDecimal(expected));
    case "Text":
    case "Id":
    case "Picklist":
    case "Multipicklist":
      return asText(actual) === asText(expected);
    case "Boolean":
      return asBool(actual) === asBool(expected);
    case "Date":
      return (
        expected.type === "Date" &&
        actual.data.year === expected.data.year &&
        actual.data.month === expected.data.month &&
        actual.data.day === expected.data.day
      );
    case "Datetime":
      return (
        expected.type === "Datetime" &&
        actual.data.epochMillis === expected.data.epochMillis
      );
    case "Time":
      return (
        expected.type === "Time" &&
        actual.data.millisOfDay === expected.data.millisOfDay
      );
    case "Unknown":
      // Unreachable via evaluateTestRow (a non-blank Unknown never occurs),
      // but a silent universal pass would be the wrong default if that ever
      // changed — an unclassifiable value can't honestly match anything.
      return false;
    default:
      return assertNever(actual);
  }
}
