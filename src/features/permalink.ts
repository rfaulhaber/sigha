import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

/**
 * Permalink codec (DESIGN §8.6): the shareable editor state, lz-compressed
 * into a URL hash fragment. Encoding happens only on the explicit "Copy link"
 * action — formula text is user data and must never leave the editor on its
 * own.
 *
 * The payload carries a version field; decoding refuses unknown versions
 * rather than guessing at a future schema. A hash is untrusted input: decode
 * never throws, and every field is shape-checked (the UI additionally
 * validates field types and context ids against its own registries).
 */

export interface PermalinkField {
  /** An SfType name; validated by the simulation UI, not here. */
  readonly type: string;
  readonly value: string;
  readonly blank: boolean;
}

export interface PermalinkTestCell {
  readonly value: string;
  readonly blank: boolean;
}

export interface PermalinkTestRow {
  readonly values: Readonly<Record<string, PermalinkTestCell>>;
  readonly expected: {
    readonly mode: "value" | "blank" | "error";
    readonly value: string;
  };
}

/** The test suite panel's state, minus row ids — a fresh id is assigned to
 * each row on decode rather than trusting one from the URL. */
export interface PermalinkTests {
  readonly rows: readonly PermalinkTestRow[];
  readonly types: Readonly<Record<string, string>>;
  readonly blankMode: "zero" | "blank";
}

export interface PermalinkState {
  readonly context: string;
  readonly formula: string;
  readonly fields: Readonly<Record<string, PermalinkField>>;
  readonly blankMode: "zero" | "blank";
  /** Present only when the test suite has at least one row (DESIGN §8.5, §8.6). */
  readonly tests?: PermalinkTests;
}

const VERSION = 1;

/** Encode state as a URL-safe hash fragment (without the leading '#'). */
export function encodePermalink(state: PermalinkState): string {
  return compressToEncodedURIComponent(
    JSON.stringify({ v: VERSION, ...state }),
  );
}

/** Decode a location.hash (with or without '#'). Null on anything invalid. */
export function decodePermalink(hash: string): PermalinkState | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") {
    return null;
  }
  const json = decompressFromEncodedURIComponent(raw);
  if (!json) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (d["v"] !== VERSION) {
    return null;
  }
  if (typeof d["formula"] !== "string" || typeof d["context"] !== "string") {
    return null;
  }
  const state: PermalinkState = {
    context: d["context"],
    formula: d["formula"],
    fields: decodeFields(d["fields"]),
    blankMode: d["blankMode"] === "blank" ? "blank" : "zero",
  };
  const tests = decodeTests(d["tests"]);
  return tests ? { ...state, tests } : state;
}

function decodeFields(raw: unknown): Record<string, PermalinkField> {
  const out: Record<string, PermalinkField> = {};
  if (typeof raw !== "object" || raw === null) {
    return out;
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const f = entry as Record<string, unknown>;
    if (
      typeof f["type"] === "string" &&
      typeof f["value"] === "string" &&
      typeof f["blank"] === "boolean"
    ) {
      out[name] = { type: f["type"], value: f["value"], blank: f["blank"] };
    }
  }
  return out;
}

/** A malformed `tests` payload drops the whole field rather than the link
 * (undefined, not []), since an empty suite and "couldn't decode" mean
 * different things to the panel that seeds from it. */
function decodeTests(raw: unknown): PermalinkTests | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d["rows"])) {
    return undefined;
  }
  const rows: PermalinkTestRow[] = [];
  for (const entry of d["rows"]) {
    const row = decodeTestRow(entry);
    if (row) {
      rows.push(row);
    }
  }
  const types: Record<string, string> = {};
  if (typeof d["types"] === "object" && d["types"] !== null) {
    for (const [name, value] of Object.entries(
      d["types"] as Record<string, unknown>,
    )) {
      if (typeof value === "string") {
        types[name] = value;
      }
    }
  }
  return {
    rows,
    types,
    blankMode: d["blankMode"] === "blank" ? "blank" : "zero",
  };
}

function decodeTestRow(raw: unknown): PermalinkTestRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const expected = decodeExpected(r["expected"]);
  // A row with no valid expectation isn't a test case at all; drop it rather
  // than keep a row that can never say pass or fail.
  if (!expected) {
    return null;
  }
  return { values: decodeTestValues(r["values"]), expected };
}

function decodeTestValues(raw: unknown): Record<string, PermalinkTestCell> {
  const out: Record<string, PermalinkTestCell> = {};
  if (typeof raw !== "object" || raw === null) {
    return out;
  }
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const c = entry as Record<string, unknown>;
    if (typeof c["value"] === "string" && typeof c["blank"] === "boolean") {
      out[name] = { value: c["value"], blank: c["blank"] };
    }
  }
  return out;
}

function decodeExpected(raw: unknown): PermalinkTestRow["expected"] | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  if (
    (e["mode"] === "value" || e["mode"] === "blank" || e["mode"] === "error") &&
    typeof e["value"] === "string"
  ) {
    return { mode: e["mode"], value: e["value"] };
  }
  return null;
}
