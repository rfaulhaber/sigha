import type { Span } from "../../syntax/index.ts";

/** Trace row snippets are truncated around this many characters. */
export const SNIPPET_MAX = 60;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Nudge a truncation index left by one if it falls between the two halves of
 * a UTF-16 surrogate pair. Cutting exactly there would keep one half and
 * drop the other, leaving a lone surrogate — invalid UTF-16 that renders as
 * U+FFFD. Moving the boundary one unit earlier puts both halves on the same
 * side of the cut (excluded from a head slice, included in a tail slice),
 * which is never a split either way.
 */
function safeBoundary(s: string, index: number): number {
  if (
    index > 0 &&
    index < s.length &&
    isHighSurrogate(s.charCodeAt(index - 1)) &&
    isLowSurrogate(s.charCodeAt(index))
  ) {
    return index - 1;
  }
  return index;
}

/** Whitespace-collapsed, middle-truncated source slice for a Steps trace row. */
export function snippetOf(source: string, span: Span): string {
  const collapsed = source
    .slice(span.start, span.end)
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= SNIPPET_MAX) {
    return collapsed;
  }
  const head = Math.ceil((SNIPPET_MAX - 1) / 2);
  const tail = SNIPPET_MAX - 1 - head;
  const headEnd = safeBoundary(collapsed, head);
  const tailStart = safeBoundary(collapsed, collapsed.length - tail);
  return `${collapsed.slice(0, headEnd)}…${collapsed.slice(tailStart)}`;
}
