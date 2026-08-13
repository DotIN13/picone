import { For, Show } from "solid-js";
import type { PermissionDecision, PermissionRequest } from "@picone/protocol";
import { respondPermission } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { Tag } from "./ui/primitives.tsx";

/**
 * A permission request, as the special case of asking (§10, §59).
 *
 * One question with three fixed answers, drawn in the same shape as any other
 * question the agent asks — the option rows with their consequences spelled
 * out, rather than a row of buttons whose meaning you had to already know. The
 * tone stays the warning one, because a permission *is* a hazard where a
 * question is not.
 *
 * The wire underneath is unchanged. Permissions carry a decision that grants
 * for a whole session, and they are the one thing in the app that must not be
 * refactored for tidiness; so this shares the surface and nothing else.
 */
const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow_once: "Allowed once",
  allow_session: "Allowed for this session",
  deny: "Denied",
};

const CHOICES: Array<{ decision: PermissionDecision; label: string; note: string }> = [
  { decision: "allow_once", label: "Allow once", note: "Just this call, and ask again next time." },
  {
    decision: "allow_session",
    label: "Allow for this session",
    note: "Stop asking about this until the session ends.",
  },
  { decision: "deny", label: "Deny", note: "Refuse it, and tell the agent why in your next message." },
];

export function PermissionCard(props: { request: PermissionRequest; decision?: PermissionDecision }) {
  return (
    <div data-component="ask" data-kind="permission" data-resolved={props.decision ? "" : undefined}>
      <div data-slot="ask-head">
        <Icon name="shield" size={14} />
        <span class="font-[530]">{props.request.title}</span>
        <Tag tone={props.decision ? "neutral" : "warning"}>{props.request.category}</Tag>
      </div>

      {/* The command or the path, which is what is actually being agreed to. */}
      <pre data-slot="ask-detail" data-mono="">{props.request.detail}</pre>

      <Show when={props.request.cwd}>
        <div data-slot="ask-where">Directory: {props.request.cwd}</div>
      </Show>

      <Show
        when={!props.decision}
        fallback={
          <div data-slot="ask-outcome">
            <Icon name={props.decision === "deny" ? "close" : "check"} size={13} />
            {DECISION_LABEL[props.decision!]}
          </div>
        }
      >
        <div data-slot="ask-options">
          <For each={CHOICES}>
            {(choice) => (
              <button
                type="button"
                data-slot="ask-option"
                data-tone={choice.decision === "deny" ? "danger" : undefined}
                onClick={() => respondPermission(props.request.id, choice.decision)}
              >
                <span data-slot="ask-option-label">{choice.label}</span>
                <span data-slot="ask-option-note">{choice.note}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
