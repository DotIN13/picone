/**
 * A browser key event, as the bytes a terminal would have sent (DESIGN §55).
 *
 * `ui.custom` components parse raw terminal input — they were written for a
 * terminal, and the component runs unchanged on the server. So the translation
 * happens here, in the only place that has a `KeyboardEvent` to translate.
 *
 * Only what a text UI actually reads is mapped. An unrecognised key produces
 * nothing rather than a guess: a stray byte is indistinguishable from a real
 * keystroke to the component, and doing nothing is the recoverable failure.
 */

/** Escape sequences for the keys that have them. */
const SEQUENCES: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
  Escape: "\x1b",
  Tab: "\t",
  Enter: "\r",
  Backspace: "\x7f",
};

/** Shift+Tab, which is its own sequence rather than a modifier on Tab. */
const BACK_TAB = "\x1b[Z";

export function encodeKey(event: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): string | null {
  // A browser shortcut, not text for the component.
  if (event.metaKey) return null;

  if (event.key === "Tab" && event.shiftKey) return BACK_TAB;

  if (event.ctrlKey) {
    // Ctrl+A..Z are the control codes 1..26; anything else is a shortcut.
    const letter = event.key.toLowerCase();
    if (letter.length === 1 && letter >= "a" && letter <= "z") {
      return String.fromCharCode(letter.charCodeAt(0) - 96);
    }
    return null;
  }

  const sequence = SEQUENCES[event.key];
  if (sequence) return event.altKey ? `\x1b${sequence}` : sequence;

  // Anything that is a single character is that character. `key` is already the
  // composed result, so shift and the keyboard layout are accounted for.
  if ([...event.key].length === 1) return event.altKey ? `\x1b${event.key}` : event.key;

  return null;
}
