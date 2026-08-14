import { assertNever, type Expr } from "../../syntax/index.ts";
import { extractFields } from "../../features/index.ts";
import {
  asBool,
  asDecimal,
  asText,
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
  /** The row's expected text doesn't parse as the actual result's type —
   * distinct from a real mismatch, since comparing against it would be
   * comparing against buildFieldValue's blank fallback, not what the user
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
      const expected = buildFieldValue(result.type, row.expected.value, false);
      if (row.expected.value.trim() !== "" && expected.blank) {
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
 * Value equality for a test assertion — never a rendered-string comparison
 * (a text result of "1.50" and an expected "1.5" must differ; a numeric
 * result of 1.50 and an expected "1.5" must not). `expected` is always built
 * from `actual`'s own type, so the two variants line up by construction.
 */
function typedEquals(actual: SfValue, expected: SfValue): boolean {
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
      return true;
    default:
      return assertNever(actual);
  }
}
