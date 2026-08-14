import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder,
  tooltips,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { lintGutter } from "@codemirror/lint";
import { completionKeymap, snippet } from "@codemirror/autocomplete";
// Deep import — keeps the engine-dependent simplifier out of the eager bundle.
import { format } from "../../features/formatter.ts";
import { PASTE_CHAR_PATTERN, type TextEdit } from "../../syntax/index.ts";
import { t } from "../../i18n/index.ts";
import type { ThemeMode } from "../../theme/theme.ts";
import { sfHighlight } from "./highlight.ts";
import { sfLinter } from "./lint.ts";
import { editorThemes } from "./editorTheme.ts";
import { sfCompletion } from "./completion.ts";
import { sfHover } from "./hover.ts";
import { contextField, setContext } from "./contextField.ts";

/** Imperative handle so the parent can trigger a format from a toolbar button,
 * replace the document (the simplifier's Apply), apply diagnostic fixes (the
 * Problems panel), or insert a function template (the Insert-function
 * picker). */
export interface EditorHandle {
  format(): void;
  setText(text: string): void;
  /**
   * Apply diagnostic fix edits as one transaction — CodeMirror maps the
   * offsets against each other, so non-overlapping edits need no ordering.
   * `expectedDoc` is the text the edits were computed against; a mismatch
   * means a keystroke landed in between and the edits are stale, so nothing
   * is applied and the next render supplies freshly positioned ones.
   */
  applyEdits(edits: readonly TextEdit[], expectedDoc: string): void;
  /** Apply a CodeMirror snippet template at the cursor, replacing any
   * selection, and return focus to the editor so Tab walks the fields. */
  insertSnippet(template: string): void;
}

interface FormulaEditorProps {
  readonly initialDoc: string;
  readonly contextId: string;
  readonly themeMode: ThemeMode;
  readonly onChange: (doc: string) => void;
  readonly handleRef?: Ref<EditorHandle>;
}

/**
 * Reformat the document in place. Formatting invalid or comment-bearing input is
 * a no-op (the formatter returns it unchanged), so this never destroys work.
 */
function formatView(view: EditorView): boolean {
  const current = view.state.doc.toString();
  const formatted = format(current);
  if (formatted === current) {
    return false;
  }
  view.dispatch({
    changes: { from: 0, to: current.length, insert: formatted },
  });
  return true;
}

/**
 * Uncontrolled CodeMirror editor: it owns the document and reports changes via
 * `onChange`. The parent uses that text only to render side panels, never to
 * feed the value back in, so there is no update loop. The `onChange` ref keeps
 * the update listener from capturing a stale closure. The active context is
 * pushed in as an editor-state effect so the linter can read it live.
 */
export function FormulaEditor({
  initialDoc,
  contextId,
  themeMode,
  onChange,
  handleRef,
}: FormulaEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Colors follow the --sfa-* variables on their own; the compartment exists
  // for CodeMirror's `dark` flag, which the base theme branches on and which
  // therefore has to be swapped as configuration. See editorTheme.ts. It is
  // an identity token the editor state holds, so it has to outlive renders
  // without being recreated by them.
  const [themeSlot] = useState(() => new Compartment());
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useImperativeHandle(handleRef, () => ({
    format() {
      if (viewRef.current) {
        formatView(viewRef.current);
      }
    },
    setText(text: string) {
      const view = viewRef.current;
      if (view && view.state.doc.toString() !== text) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      }
    },
    applyEdits(edits: readonly TextEdit[], expectedDoc: string) {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() !== expectedDoc) {
        return;
      }
      view.dispatch({
        changes: edits.map((e) => ({
          from: e.span.start,
          to: e.span.end,
          insert: e.newText,
        })),
      });
    },
    insertSnippet(template: string) {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      const { from, to } = view.state.selection.main;
      snippet(template)(view, null, from, to);
      view.focus();
    },
  }));

  useEffect(() => {
    if (!host.current) {
      return;
    }

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          contextField,
          history(),
          // Draw the caret ourselves instead of using the native one: the
          // native caret sizes itself from CM's 1em widget buffer and floats
          // above the placeholder text at our 1.65 line-height, while CM's
          // drawn cursor uses the placeholder widget's real coordinates.
          // Also activates the .cm-cursor/.cm-selectionBackground styling in
          // editorTheme.ts.
          drawSelection(),
          keymap.of([
            { key: "Shift-Alt-f", run: formatView },
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          placeholder(t().ui.editor.placeholder),
          // Render every character the lexer diagnoses as a paste artifact —
          // the pattern is derived from the same classification (chars.ts),
          // so a diagnosed character always gets a visible placeholder. The
          // characters are themselves zero-width, so without it the editor
          // would show nothing where the Problems panel reports a fault.
          highlightSpecialChars({ addSpecialChars: PASTE_CHAR_PATTERN }),
          // Mount tooltips on <body>: the .rise entrance animations create
          // stacking contexts on the page sections, so tooltips rendered
          // inside the editor would paint beneath later siblings (e.g. the
          // completion list disappearing behind the simulation panel).
          tooltips({ parent: document.body }),
          sfHighlight,
          sfCompletion,
          sfHover,
          sfLinter,
          lintGutter(),
          themeSlot.of(editorThemes[themeMode]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              onChangeRef.current(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;

    onChangeRef.current(initialDoc);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Create the editor exactly once; initialDoc is an initial value, not a prop
    // to react to on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setContext.of(contextId) });
  }, [contextId]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeSlot.reconfigure(editorThemes[themeMode]),
    });
  }, [themeMode, themeSlot]);

  return <div ref={host} />;
}
