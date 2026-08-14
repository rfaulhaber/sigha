import { useMemo, useState, type ReactNode } from "react";
import { assertNever, type Expr } from "../../syntax/index.ts";
import { extractFields } from "../../features/index.ts";
import type { BlankMode } from "../../engine/index.ts";
import type { SfType } from "../../registry/index.ts";
import { t } from "../../i18n/index.ts";
import { palette, syntax, font } from "../../theme/theme.ts";
import { Panel } from "../Panel.tsx";
import { FIELD_TYPES } from "../simulate/fieldValue.ts";
import { evaluateTestRow, type TestRowOutcome } from "./rowEval.ts";
import {
  newRowId,
  type TestCell,
  type TestRow,
  type TestSuiteState,
} from "./state.ts";

/** A row's display state also covers "the formula doesn't parse" — a panel-
 * level concern the pure evaluator doesn't know about (rule 1: no row claims
 * a pass or fail against a formula that isn't valid syntax). */
type Outcome = TestRowOutcome | { readonly kind: "invalid" };

interface TestSuitePanelProps {
  readonly ast: Expr;
  readonly syntaxErrors: boolean;
  readonly blankToggle: boolean;
  readonly state: TestSuiteState;
  readonly onChange: (next: TestSuiteState) => void;
}

/**
 * regexr.com-style assertion table (DESIGN §8.5): one row per test case, one
 * column per referenced field plus Expected/Result, re-evaluated live as the
 * formula or any cell changes.
 */
export function TestSuitePanel({
  ast,
  syntaxErrors,
  blankToggle,
  state,
  onChange,
}: TestSuitePanelProps) {
  const fields = useMemo(() => extractFields(ast), [ast]);
  // Capture the clock once so TODAY()/NOW() are stable across re-renders.
  const [now] = useState(() => ({ epochMillis: Date.now() }));

  const outcomes = useMemo((): Outcome[] => {
    if (syntaxErrors) {
      return state.rows.map((): Outcome => ({ kind: "invalid" }));
    }
    return state.rows.map((row) =>
      evaluateTestRow(ast, row, state.types, state.blankMode, now),
    );
  }, [ast, syntaxErrors, state.rows, state.types, state.blankMode, now]);

  const passCount = outcomes.filter((o) => o.kind === "pass").length;

  const updateRow = (id: string, patch: Partial<TestRow>): void => {
    onChange({
      ...state,
      rows: state.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };

  const updateCell = (
    rowId: string,
    field: string,
    patch: Partial<TestCell>,
  ): void => {
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    const current = row.values[field] ?? { value: "", blank: true };
    updateRow(rowId, {
      values: { ...row.values, [field]: { ...current, ...patch } },
    });
  };

  const addRow = (): void => {
    onChange({
      ...state,
      rows: [
        ...state.rows,
        {
          id: newRowId(),
          values: {},
          expected: { mode: "value", value: "" },
        },
      ],
    });
  };

  const removeRow = (id: string): void => {
    onChange({ ...state, rows: state.rows.filter((r) => r.id !== id) });
  };

  const setType = (field: string, type: string): void => {
    onChange({ ...state, types: { ...state.types, [field]: type } });
  };

  return (
    <Panel
      label={t().ui.testSuite.label}
      right={
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          {state.rows.length > 0 ? (
            <span className="chip">
              {t().ui.testSuite.passing(passCount, state.rows.length)}
            </span>
          ) : null}
          {blankToggle ? (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.45rem",
                color: palette.textMuted,
                fontSize: "0.75rem",
              }}
            >
              {t().ui.testSuite.blankFieldsAs}
              <select
                className="select"
                value={state.blankMode}
                onChange={(e) =>
                  onChange({ ...state, blankMode: e.target.value as BlankMode })
                }
              >
                <option value="zero">{t().ui.testSuite.blankAsZeroes}</option>
                <option value="blank">{t().ui.testSuite.blankAsBlanks}</option>
              </select>
            </label>
          ) : null}
        </div>
      }
    >
      {state.rows.length === 0 ? (
        <p
          style={{
            padding: "0.7rem 1rem",
            color: palette.textMuted,
            fontSize: "0.82rem",
          }}
        >
          {t().ui.testSuite.empty}
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.name} style={thStyle}>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "0.3rem",
                      }}
                    >
                      <code
                        style={{ color: syntax.field, fontSize: "0.78rem" }}
                      >
                        {f.name}
                      </code>
                      <select
                        className="select"
                        style={columnTypeSelectStyle}
                        value={state.types[f.name] ?? f.inferredType}
                        onChange={(e) => setType(f.name, e.target.value)}
                      >
                        {FIELD_TYPES.map((ty) => (
                          <option key={ty} value={ty}>
                            {ty}
                          </option>
                        ))}
                      </select>
                    </div>
                  </th>
                ))}
                <th style={thStyle}>{t().ui.testSuite.expectedHeader}</th>
                <th style={thStyle}>{t().ui.testSuite.resultHeader}</th>
                <th style={thStyle} aria-hidden />
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row, i) => {
                const outcome = outcomes[i]!;
                return (
                  <tr key={row.id} className="row-hover">
                    {fields.map((f) => {
                      const type =
                        (state.types[f.name] as SfType | undefined) ??
                        f.inferredType;
                      const cell = row.values[f.name] ?? {
                        value: "",
                        blank: true,
                      };
                      return (
                        <td key={f.name} style={tdStyle}>
                          <TestCellInput
                            type={type}
                            cell={cell}
                            onChange={(patch) =>
                              updateCell(row.id, f.name, patch)
                            }
                          />
                        </td>
                      );
                    })}
                    <td style={tdStyle}>
                      <ExpectedInput
                        expected={row.expected}
                        onChange={(expected) => updateRow(row.id, { expected })}
                      />
                    </td>
                    <td style={tdStyle}>
                      <ResultCell outcome={outcome} />
                    </td>
                    <td style={tdStyle}>
                      <button
                        type="button"
                        className="btn"
                        style={removeButtonStyle}
                        onClick={() => removeRow(row.id)}
                        aria-label={t().ui.testSuite.removeTest}
                        title={t().ui.testSuite.removeTest}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          padding: "0.7rem 1rem",
          borderTop:
            state.rows.length > 0 ? `1px solid ${palette.border}` : "none",
        }}
      >
        <button type="button" className="btn" onClick={addRow}>
          {t().ui.testSuite.addTest}
        </button>
      </div>
    </Panel>
  );
}

function TestCellInput({
  type,
  cell,
  onChange,
}: {
  type: SfType;
  cell: TestCell;
  onChange: (patch: Partial<TestCell>) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <TestCellValue type={type} cell={cell} onChange={onChange} />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.2rem",
          color: palette.textMuted,
          fontSize: "0.66rem",
          whiteSpace: "nowrap",
        }}
      >
        <input
          type="checkbox"
          checked={cell.blank}
          onChange={(e) => onChange({ blank: e.target.checked })}
        />
        {t().ui.testSuite.blankCheckbox}
      </label>
    </div>
  );
}

function TestCellValue({
  type,
  cell,
  onChange,
}: {
  type: SfType;
  cell: TestCell;
  onChange: (patch: Partial<TestCell>) => void;
}) {
  if (cell.blank) {
    return (
      <span style={{ color: palette.textMuted, fontSize: "0.78rem" }}>
        {t().ui.testSuite.nullField}
      </span>
    );
  }
  if (type === "Boolean") {
    return (
      <input
        type="checkbox"
        checked={cell.value === "true"}
        onChange={(e) =>
          onChange({ value: e.target.checked ? "true" : "false" })
        }
      />
    );
  }
  return (
    <input
      type={type === "Date" ? "date" : "text"}
      value={cell.value}
      placeholder={placeholderFor(type)}
      onChange={(e) => onChange({ value: e.target.value })}
      style={cellInputStyle}
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
      return t().ui.testSuite.valuePlaceholder;
  }
}

function ExpectedInput({
  expected,
  onChange,
}: {
  expected: TestRow["expected"];
  onChange: (expected: TestRow["expected"]) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <select
        className="select"
        value={expected.mode}
        onChange={(e) =>
          onChange({
            ...expected,
            mode: e.target.value as TestRow["expected"]["mode"],
          })
        }
      >
        <option value="value">{t().ui.testSuite.modeValue}</option>
        <option value="blank">{t().ui.testSuite.modeBlank}</option>
        <option value="error">{t().ui.testSuite.modeError}</option>
      </select>
      {expected.mode === "value" ? (
        <input
          type="text"
          value={expected.value}
          placeholder={t().ui.testSuite.expectedPlaceholder}
          onChange={(e) => onChange({ ...expected, value: e.target.value })}
          style={cellInputStyle}
        />
      ) : null}
    </div>
  );
}

function ResultCell({ outcome }: { outcome: Outcome }) {
  switch (outcome.kind) {
    case "pass":
      return (
        <Readout led="led--ok" color={palette.text} text={outcome.actualText} />
      );
    case "fail":
      return (
        <Readout
          led="led--err"
          color={palette.danger}
          text={outcome.actualText}
        />
      );
    case "badExpected":
      return (
        <Readout
          led="led--warn"
          color={palette.textMuted}
          text={outcome.actualText}
        >
          <span className="chip">{t().ui.testSuite.badExpected}</span>
        </Readout>
      );
    case "unsupported":
      return (
        <Readout
          led="led--warn"
          color={palette.textMuted}
          text={t().ui.testSuite.cannotSimulate(outcome.functionName)}
        />
      );
    case "invalid":
      return (
        <Readout
          led="led--warn"
          color={palette.textMuted}
          text={t().ui.testSuite.invalidFormula}
        />
      );
    default:
      return assertNever(outcome);
  }
}

function Readout({
  led,
  color,
  text,
  children,
}: {
  led: string;
  color: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        flexWrap: "wrap",
      }}
    >
      <span className={`led ${led}`} aria-hidden />
      <span
        style={{
          fontFamily: font.mono,
          fontSize: "0.8rem",
          color,
          overflowWrap: "anywhere",
        }}
      >
        {text || "—"}
      </span>
      {children}
    </div>
  );
}

const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.82rem",
} as const;

const thStyle = {
  textAlign: "left",
  fontWeight: 600,
  fontSize: "0.68rem",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: palette.textMuted,
  padding: "0.5rem 0.75rem",
  borderBottom: `1px solid ${palette.border}`,
  whiteSpace: "nowrap",
} as const;

const tdStyle = {
  padding: "0.45rem 0.75rem",
  borderBottom: `1px solid ${palette.border}`,
  verticalAlign: "middle",
} as const;

const cellInputStyle = {
  width: "6.5rem",
  background: palette.well,
  color: palette.text,
  border: `1px solid ${palette.border}`,
  borderRadius: "8px",
  padding: "0.25rem 0.5rem",
  fontFamily: font.mono,
  fontSize: "0.8rem",
} as const;

const columnTypeSelectStyle = {
  fontSize: "0.68rem",
  padding: "0.15rem 1.3rem 0.15rem 0.4rem",
} as const;

const removeButtonStyle = {
  padding: "0.2rem 0.5rem",
  fontSize: "0.7rem",
  lineHeight: 1,
} as const;
