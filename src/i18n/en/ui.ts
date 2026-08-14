/**
 * Strings rendered by React components and CodeMirror extensions, grouped by
 * surface. Formula-language tokens (function names, TRUE/FALSE, the literal
 * "#Error!" Salesforce shows) are not prose and stay in code.
 */
export const ui = {
  editor: {
    placeholder: "Type a Salesforce formula...",
  },
  toolbar: {
    format: "Format",
    formatTitle: "Format (Shift+Alt+F)",
    contextLabel: "Context",
    contextUnverifiedSuffix: " (unverified)",
    insertFunction: "Insert function...",
    insertFunctionTitle:
      "Insert a function available in this context at the cursor",
  },
  theme: {
    system: "Auto",
    light: "Light",
    dark: "Dark",
    /** Reads back the resolved mode, since "Auto" alone doesn't say which. */
    following: (mode: string) => `Auto, following your system (${mode})`,
    /** Tooltip and accessible name for the cycling mode switch. */
    action: (current: string, next: string) =>
      `Theme: ${current}. Click for ${next}.`,
  },
  problems: {
    label: "Problems",
    none: "no problems",
    count: (n: number) => `${n} problem${n === 1 ? "" : "s"}`,
    clean: "Parses correctly.",
    docsLink: "docs ↗",
    fixAll: (n: number) => `Fix all problems (${n})`,
    fixAllTitle:
      "Apply every fix that leaves the formula's meaning unchanged, in one edit",
    /** Why a fix has its own button but is left out of "Fix all". */
    fixChangesSemantics: "This fix changes what the formula evaluates to",
  },
  simulate: {
    label: "Simulate",
    blankFieldsAs: "Blank fields as",
    blankAsZeroes: "zeroes",
    blankAsBlanks: "blanks",
    noFields: "No fields referenced.",
    blankCheckbox: "blank",
    nullField: "null",
    valuePlaceholder: "value",
    blankResult: "(blank)",
    resultLabel: "Result",
    cannotSimulate: (functionName: string) =>
      `Cannot simulate: ${functionName} depends on org state`,
    errorResult: "Salesforce would show #Error! here",
    invalidFormula: "Fix the syntax errors to simulate this formula",
    copyLink: "Copy link",
    copied: "Copied!",
    linkInUrlBar: "Link is in the URL bar",
    copyLinkTitle: "Copy a link that restores this formula, inputs, and result",
    stepsLabel: "Steps",
    stepsNotEvaluated: "not evaluated",
  },
  testSuite: {
    label: "Tests",
    passing: (pass: number, total: number) => `${pass}/${total} passing`,
    empty:
      "No test cases yet. Add one to check the formula against a value as you edit it.",
    addTest: "Add test",
    removeTest: "Remove test",
    expectedHeader: "Expected",
    resultHeader: "Result",
    modeValue: "Value",
    modeBlank: "Blank",
    modeError: "#Error!",
    expectedPlaceholder: "expected value",
    valuePlaceholder: "value",
    nullField: "null",
    blankCheckbox: "blank",
    badExpected: "Expected value doesn't parse as this result's type",
    incomplete: "Enter an expected value",
    cannotSimulate: (functionName: string) =>
      `Cannot simulate: ${functionName} depends on org state`,
    invalidFormula: "Fix the syntax errors to run tests",
    blankFieldsAs: "Blank fields as",
    blankAsZeroes: "zeroes",
    blankAsBlanks: "blanks",
  },
  simplify: {
    label: "Simplify",
    apply: "Apply",
    applyWouldRemoveComments: "Applying would remove the formula's comments",
    applyReplaces: "Replace the formula with the simplified version",
  },
  hover: {
    notSimulatable: "Not available in simulation (depends on org state).",
    salesforceDocs: "Salesforce docs ↗",
  },
  footer: {
    platformLink: (host: string) => `${host} ↗`,
    sourceLink: "GitHub ↗",
  },
};
