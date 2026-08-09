import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";

/**
 * A deliberately small set of grammars. Anything else renders as plain text with
 * line numbers, which is enough for reading and commenting (DESIGN §15).
 */
export function languageExtension(language: string): Extension[] {
  switch (language) {
    case "typescript":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "jsx":
      return [javascript({ jsx: true })];
    case "javascript":
      return [javascript()];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "python":
      return [python()];
    default:
      return [];
  }
}
