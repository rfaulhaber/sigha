import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent } from "lz-string";
import {
  decodePermalink,
  encodePermalink,
  type PermalinkState,
} from "./permalink.ts";

const STATE: PermalinkState = {
  context: "formula_field",
  formula: "IF(ISBLANK(Amount), 0, Amount * 1.1) /* keep */",
  fields: {
    Amount: { type: "Currency", value: "100", blank: false },
    "Account.Name": { type: "Text", value: "", blank: true },
  },
  blankMode: "blank",
};

describe("permalink codec", () => {
  it("round-trips full state through a URL-safe string", () => {
    const encoded = encodePermalink(STATE);
    // lz-string's URI-safe alphabet (A-Za-z0-9 + - $): every character is
    // legal in a URL fragment, so browsers pass the hash through verbatim.
    expect(encoded).toMatch(/^[A-Za-z0-9+\-$]+$/);
    expect(decodePermalink(encoded)).toEqual(STATE);
    // With the leading '#' a browser hands back.
    expect(decodePermalink(`#${encoded}`)).toEqual(STATE);
  });

  it("rejects garbage, empty hashes, and non-JSON payloads", () => {
    expect(decodePermalink("")).toBeNull();
    expect(decodePermalink("#")).toBeNull();
    expect(decodePermalink("#not-a-permalink")).toBeNull();
    expect(
      decodePermalink(compressToEncodedURIComponent("not json")),
    ).toBeNull();
    expect(decodePermalink(compressToEncodedURIComponent("42"))).toBeNull();
  });

  it("refuses unknown versions instead of guessing", () => {
    const future = compressToEncodedURIComponent(
      JSON.stringify({ v: 2, context: "formula_field", formula: "1" }),
    );
    expect(decodePermalink(future)).toBeNull();
  });

  it("requires formula and context, defaults blankMode, drops bad fields", () => {
    const enc = (payload: unknown): string =>
      compressToEncodedURIComponent(JSON.stringify(payload));

    expect(decodePermalink(enc({ v: 1, context: "x" }))).toBeNull();
    expect(decodePermalink(enc({ v: 1, formula: "1" }))).toBeNull();

    const decoded = decodePermalink(
      enc({
        v: 1,
        context: "formula_field",
        formula: "A + B",
        blankMode: "bogus",
        fields: {
          A: { type: "Number", value: "1", blank: false },
          B: { type: "Number", value: 5, blank: false }, // value not a string
          C: "nonsense",
        },
      }),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.blankMode).toBe("zero");
    expect(Object.keys(decoded!.fields)).toEqual(["A"]);
  });
});

describe("permalink codec: test suite", () => {
  const STATE_WITH_TESTS: PermalinkState = {
    ...STATE,
    tests: {
      rows: [
        {
          values: { Amount: { value: "100", blank: false } },
          expected: { mode: "value", value: "110.00" },
        },
        {
          values: {},
          expected: { mode: "blank", value: "" },
        },
      ],
      types: { Amount: "Currency" },
      blankMode: "blank",
    },
  };

  it("round-trips a test suite alongside the rest of the state", () => {
    const encoded = encodePermalink(STATE_WITH_TESTS);
    expect(decodePermalink(encoded)).toEqual(STATE_WITH_TESTS);
  });

  it("decodes a hash with no tests key at all (older links, or none added yet)", () => {
    const decoded = decodePermalink(encodePermalink(STATE));
    expect(decoded).not.toBeNull();
    expect(decoded!.tests).toBeUndefined();
  });

  it("drops a garbage-shaped tests field without rejecting the rest of the link", () => {
    const enc = (payload: unknown): string =>
      compressToEncodedURIComponent(JSON.stringify(payload));

    // Not an object at all.
    const notAnObject = decodePermalink(
      enc({ v: 1, context: "formula_field", formula: "1", tests: "nonsense" }),
    );
    expect(notAnObject).not.toBeNull();
    expect(notAnObject!.tests).toBeUndefined();

    // An object, but rows isn't an array.
    const rowsNotArray = decodePermalink(
      enc({
        v: 1,
        context: "formula_field",
        formula: "1",
        tests: { rows: "nope", types: {}, blankMode: "zero" },
      }),
    );
    expect(rowsNotArray).not.toBeNull();
    expect(rowsNotArray!.tests).toBeUndefined();
  });

  it("drops individual malformed rows and type entries, keeping the rest", () => {
    const enc = (payload: unknown): string =>
      compressToEncodedURIComponent(JSON.stringify(payload));

    const decoded = decodePermalink(
      enc({
        v: 1,
        context: "formula_field",
        formula: "Amount",
        tests: {
          rows: [
            {
              values: { Amount: { value: "1", blank: false } },
              expected: { mode: "value", value: "1" },
            },
            { values: {}, expected: { mode: "bogus", value: "1" } }, // bad mode
            "nonsense", // not even an object
            {
              values: { A: "nonsense" },
              expected: { mode: "blank", value: "" },
            },
          ],
          types: { Amount: "Number", Bad: 5 },
          blankMode: "not-a-mode",
        },
      }),
    );

    expect(decoded).not.toBeNull();
    expect(decoded!.tests).toEqual({
      rows: [
        {
          values: { Amount: { value: "1", blank: false } },
          expected: { mode: "value", value: "1" },
        },
        { values: {}, expected: { mode: "blank", value: "" } },
      ],
      types: { Amount: "Number" },
      blankMode: "zero",
    });
  });
});
