import { Show } from "solid-js";
import type { PermissionDecision, PermissionRequest } from "@picone/protocol";
import { respondPermission } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tag } from "./ui/primitives.tsx";

const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow_once: "Allowed once",
  allow_session: "Allowed for this session",
  deny: "Denied",
};

export function PermissionCard(props: { request: PermissionRequest; decision?: PermissionDecision }) {
  return (
    <div data-component="permission" data-resolved={props.decision ? "" : undefined}>
      <div data-slot="permission-head">
        <Icon name="shield" size={14} />
        <span class="font-[530]">{props.request.title}</span>
        <Tag tone={props.decision ? "neutral" : "warning"}>{props.request.category}</Tag>
      </div>

      <pre data-slot="permission-detail">{props.request.detail}</pre>

      <Show when={props.request.cwd}>
        <div data-slot="permission-cwd">Directory: {props.request.cwd}</div>
      </Show>

      <Show
        when={!props.decision}
        fallback={
          <div data-slot="permission-outcome">
            <Icon name={props.decision === "deny" ? "close" : "check"} size={13} />
            {DECISION_LABEL[props.decision!]}
          </div>
        }
      >
        <div data-slot="permission-actions">
          <Button size="normal" variant="contrast" onClick={() => respondPermission(props.request.id, "allow_once")}>
            Allow once
          </Button>
          <Button size="normal" variant="neutral" onClick={() => respondPermission(props.request.id, "allow_session")}>
            Allow for session
          </Button>
          <Button size="normal" variant="danger" onClick={() => respondPermission(props.request.id, "deny")}>
            Deny
          </Button>
        </div>
      </Show>
    </div>
  );
}
