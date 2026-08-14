import { describe, expect, it } from "vitest";
import { span } from "../../syntax/index.ts";
import { snippetOf, SNIPPET_MAX } from "./snippet.ts";

function full(source: string) {
  return snippetOf(source, span(0, source.length));
}

/**
 * True if `s` contains a surrogate code unit with no matching other half —
 * invalid UTF-16 that would render as U+FFFD. A validly paired astral
 * character (like an emoji) also contains surrogate-range code units, so
 * this can't be a bare regex over the surrogate range; it has to track
 * pairing.
 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // paired: skip the low half, it's accounted for
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe("snippetOf", () => {
  it("passes a short snippet through unchanged", () => {
    expect(full("Amount * 2")).toBe("Amount * 2");
  });

  it("collapses internal whitespace and trims the ends", () => {
    expect(full("  a   +\n\tb  ")).toBe("a + b");
  });

  it("slices to the given span, not the whole source", () => {
    expect(snippetOf("IF(a, b, c)", span(3, 4))).toBe("a");
  });

  it("middle-truncates a long snippet with an ellipsis", () => {
    const long = "x".repeat(SNIPPET_MAX + 20);
    const result = full(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("…");
  });

  it("keeps an astral character whole when it sits away from the cut points", () => {
    const source = `"${"x".repeat(SNIPPET_MAX + 10)}🎉"`;
    const result = full(source);
    expect(hasLoneSurrogate(result)).toBe(false);
  });

  it("never emits a lone surrogate when a pair straddles the head cut point", () => {
    // head = ceil((SNIPPET_MAX - 1) / 2) = 30: an astral char at UTF-16
    // indices 29-30 straddles that boundary exactly (high at 29, low at 30).
    const head = Math.ceil((SNIPPET_MAX - 1) / 2);
    const source = "x".repeat(head - 1) + "🎉" + "y".repeat(40);
    const result = full(source);
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(result).toContain("…");
  });

  it("never emits a lone surrogate when a pair straddles the tail cut point", () => {
    const head = Math.ceil((SNIPPET_MAX - 1) / 2);
    const tail = SNIPPET_MAX - 1 - head;
    // Built so the naive "last `tail` characters" cut lands one code unit
    // inside the emoji: length - tail is between its two surrogate halves.
    const source = "x".repeat(40) + "🎉" + "y".repeat(tail - 1);
    const result = full(source);
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(result.endsWith("y".repeat(tail - 1))).toBe(true);
  });
});
