/**
 * Test-suite state shape and row-id allocation. Deliberately free of the
 * evaluator dependency (see rowEval.ts) — App seeds and updates this state
 * eagerly, on the same synchronous path as the permalink restore, so it must
 * not pull decimal.js into the first-paint bundle the way the lazy
 * Simulate/Tests panels do.
 */

export interface TestCell {
  readonly value: string;
  readonly blank: boolean;
}

export interface TestRow {
  readonly id: string;
  readonly values: Readonly<Record<string, TestCell>>;
  readonly expected: {
    readonly mode: "value" | "blank" | "error";
    readonly value: string;
  };
}

export interface TestSuiteState {
  readonly rows: readonly TestRow[];
  /** Per-field type override (one column property, shared by every row). */
  readonly types: Readonly<Record<string, string>>;
  readonly blankMode: "zero" | "blank";
}

let rowIdCounter = 0;

/** A React key for a new row. A single module-level counter so ids never
 * collide between a permalink-restored batch and rows added afterward in the
 * same session. */
export function newRowId(): string {
  return `row-${rowIdCounter++}`;
}
