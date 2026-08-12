import { Show } from "solid-js";
import { activeCapabilities, activeMode, setMode, state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * Planning, or working (§58).
 *
 * Beside the model, because it is the same kind of decision: something about
 * the next turn rather than about the workspace, taking effect immediately and
 * remembered by the session rather than the file. Drawn only where the agent
 * has more than one mode, which today means Claude — Pi has one way of working
 * and an empty `capabilities.modes` says so.
 *
 * A toggle rather than a menu of every mode Claude Code offers. `acceptEdits`
 * is the third one there and is deliberately not here: it stops the *CLI*
 * asking about file edits, which changes nothing in Picone because our own gate
 * asks anyway (§9). `permissions.files` in the workspace is the setting that
 * means that, and two switches for one decision is how they come to disagree.
 */
export function ModeSwitch() {
  const modes = () => activeCapabilities()?.modes ?? [];
  const planning = () => activeMode() === "plan";

  return (
    <Show when={state.activeSessionId && modes().includes("plan")}>
      <button
        type="button"
        data-slot="mode-switch"
        data-on={planning() ? "" : undefined}
        aria-pressed={planning()}
        title={
          planning()
            ? "In plan mode: it reads and thinks, and changes nothing. Click to let it act."
            : "Plan first: it reads and thinks, and changes nothing, until you say go."
        }
        onClick={() => setMode(planning() ? "default" : "plan")}
      >
        <Icon name="target" size={12} />
        <span>plan</span>
      </button>
    </Show>
  );
}
