import { describe, expect, it } from "vitest";
import { parse } from "../../syntax/index.ts";
import type { DatetimeVal } from "../../engine/index.ts";
import { evaluateTestRow } from "./rowEval.ts";
import type { TestRow } from "./state.ts";

const NOW: DatetimeVal = { epochMillis: Date.UTC(2026, 6, 21) };

function row(
  values: TestRow["values"],
  expected: TestRow["expected"],
): TestRow {
  return { id: "row-under-test", values, expected };
}

/** Evaluate a row against a formula with the field-type overrides and blank
 * mode a test case needs; `types` and `blankMode` default to the panel's
 * out-of-the-box state (no overrides, blanks as zeroes). */
function outcomeFor(
  source: string,
  testRow: TestRow,
  types: Record<string, string> = {},
  blankMode: "zero" | "blank" = "zero",
) {
  return evaluateTestRow(parse(source).ast, testRow, types, blankMode, NOW);
}

describe("evaluateTestRow: pass/fail classification", () => {
  it("passes and fails a Boolean row against the formula's actual result", () => {
    const source = "Amount > 100";
    const expectTrue = { mode: "value" as const, value: "true" };

    const passing = outcomeFor(
      source,
      row({ Amount: { value: "150", blank: false } }, expectTrue),
      { Amount: "Number" },
    );
    expect(passing).toEqual({ kind: "pass", actualText: "TRUE" });

    const failing = outcomeFor(
      source,
      row({ Amount: { value: "50", blank: false } }, expectTrue),
      { Amount: "Number" },
    );
    expect(failing).toEqual({ kind: "fail", actualText: "FALSE" });
  });

  it("compares numerics by value, not by rendered text (1.5 vs a 1.50-rendered result)", () => {
    const outcome = outcomeFor(
      "Amount / 2",
      row(
        { Amount: { value: "3", blank: false } },
        { mode: "value", value: "1.50" },
      ),
      { Amount: "Number" },
    );
    expect(outcome).toEqual({ kind: "pass", actualText: "1.5" });
  });

  it("compares text case-sensitively", () => {
    const source = "Name";
    const matching = outcomeFor(
      source,
      row(
        { Name: { value: "Acme", blank: false } },
        { mode: "value", value: "Acme" },
      ),
    );
    expect(matching.kind).toBe("pass");

    const mismatched = outcomeFor(
      source,
      row(
        { Name: { value: "ACME", blank: false } },
        { mode: "value", value: "Acme" },
      ),
    );
    expect(mismatched.kind).toBe("fail");
  });

  it("passes an expected-blank row only when the actual result is blank", () => {
    const source = "Name";
    const blankRow = row(
      { Name: { value: "", blank: true } },
      { mode: "blank", value: "" },
    );
    expect(outcomeFor(source, blankRow).kind).toBe("pass");

    const nonBlankRow = row(
      { Name: { value: "Acme", blank: false } },
      { mode: "blank", value: "" },
    );
    expect(outcomeFor(source, nonBlankRow).kind).toBe("fail");
  });

  it("passes an expected-error row only against a genuine #Error!, never a text result that reads the same", () => {
    // 1 / 0 is a real FormulaError.
    const realError = row({}, { mode: "error", value: "" });
    expect(outcomeFor("1 / 0", realError).kind).toBe("pass");

    // A Text result that happens to be the literal string "#Error!" is not
    // an error — mode "error" must reject it, and mode "value" must accept it.
    const literalErrorText = row({}, { mode: "error", value: "" });
    expect(outcomeFor('"#Error!"', literalErrorText).kind).toBe("fail");

    const asValue = row({}, { mode: "value", value: "#Error!" });
    expect(outcomeFor('"#Error!"', asValue)).toEqual({
      kind: "pass",
      actualText: "#Error!",
    });
  });

  it("refuses to evaluate a non-simulatable function with an unsupported outcome", () => {
    const outcome = outcomeFor(
      "PRIORVALUE(Amount)",
      row(
        { Amount: { value: "1", blank: false } },
        { mode: "value", value: "1" },
      ),
      { Amount: "Number" },
    );
    expect(outcome).toEqual({
      kind: "unsupported",
      functionName: "PRIORVALUE",
    });
  });

  it("reports badExpected when the expected text doesn't parse as the result's type, rather than a false pass or fail", () => {
    const outcome = outcomeFor(
      "Amount",
      row(
        { Amount: { value: "42", blank: false } },
        { mode: "value", value: "not-a-number" },
      ),
      { Amount: "Number" },
    );
    expect(outcome).toEqual({ kind: "badExpected", actualText: "42" });
  });

  it("does not raise badExpected for an empty expected value in value mode", () => {
    // Empty text parses as 0 for a Number field (buildFieldValue's own
    // convention), not as blank — so the guard, which only fires on
    // malformed *non-empty* text, must not fire here.
    const outcome = outcomeFor(
      "Amount",
      row(
        { Amount: { value: "0", blank: false } },
        { mode: "value", value: "" },
      ),
      { Amount: "Number" },
    );
    expect(outcome).toEqual({ kind: "pass", actualText: "0" });
  });

  it("changes outcome with the blank-handling mode, same row and formula", () => {
    const source = "NumberField__c + 1";
    const blankCell = row(
      { NumberField__c: { value: "", blank: true } },
      { mode: "value", value: "1" },
    );
    const types = { NumberField__c: "Number" };

    // Zero mode: the blank field reads as 0, so the result is 1 — a pass.
    expect(outcomeFor(source, blankCell, types, "zero")).toEqual({
      kind: "pass",
      actualText: "1",
    });
    // Blank mode: the blank field stays blank, so the whole result is blank
    // — a fail against an expected literal value.
    const blankModeOutcome = outcomeFor(source, blankCell, types, "blank");
    expect(blankModeOutcome.kind).toBe("fail");
  });

  it("treats a missing cell as blank, the same as a field the row predates", () => {
    // The row has no entry at all for Name — as if the field was added to
    // the formula after this row was created. (A Number field would instead
    // exercise the "blanks as zeroes" FieldRef coercion tested above; Text
    // isn't subject to it, so this isolates the missing-cell fallback.)
    const outcome = outcomeFor("Name", row({}, { mode: "blank", value: "" }));
    expect(outcome.kind).toBe("pass");
  });
});
