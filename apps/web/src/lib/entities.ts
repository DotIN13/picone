/**
 * Turning `&amp;` back into `&`.
 *
 * marked's lexer hands back source text verbatim and leaves escaping to its
 * HTML renderer. Rendering to DOM nodes instead means doing that step here, or
 * every ampersand a model writes shows up spelled out.
 *
 * `DOMParser` rather than the usual detached-`<textarea>` trick. A parsed
 * document is inert — nothing loads, nothing runs — whereas assigning
 * `innerHTML`, even to an element that is not in the page, constructs live
 * elements: a string carrying `</textarea><img src=x onerror=…>` would build an
 * image that starts loading and fires its handler. The parser is not on any hot
 * path, because text without an `&` never reaches it.
 */

let parser: DOMParser | undefined;

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  parser ??= new DOMParser();
  return parser.parseFromString(text, "text/html").documentElement.textContent ?? text;
}
