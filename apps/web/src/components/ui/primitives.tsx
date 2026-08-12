import { Dialog as KDialog } from "@kobalte/core/dialog";
import { Select as KSelect } from "@kobalte/core/select";
import { Switch as KSwitch } from "@kobalte/core/switch";
import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import { TextField as KTextField } from "@kobalte/core/text-field";
import { For, Show, splitProps, type ComponentProps, type JSX, type ParentProps } from "solid-js";
import { state } from "../../store.ts";
import { Icon } from "./icon.tsx";
import { IconButton } from "./button.tsx";

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export function Tooltip(props: ParentProps<{ label: JSX.Element; placement?: "top" | "bottom" | "left" | "right" }>) {
  return (
    <KTooltip openDelay={400} closeDelay={80} placement={props.placement ?? "bottom"} gutter={6}>
      <KTooltip.Trigger as="span" data-slot="tooltip-trigger">
        {props.children}
      </KTooltip.Trigger>
      <KTooltip.Portal>
        <KTooltip.Content data-component="tooltip">{props.label}</KTooltip.Content>
      </KTooltip.Portal>
    </KTooltip>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: JSX.Element;
  description?: JSX.Element;
  width?: string;
  children: JSX.Element;
  footer?: JSX.Element;
  /**
   * The content manages its own scrolling, so the body must not add a second.
   *
   * A dialog body scrolls by default, which is right for a column of settings.
   * It is wrong for content that is already a fixed frame around a scrolling
   * list — the two nest, the sheet grows to the height of the frame, and the
   * page under the list drags around beneath it.
   */
  fill?: boolean;
}

/**
 * Every dialog closes: Escape, the scrim, or the button in the corner. Even the
 * workspace picker with no workspace open, which has the splash behind it and
 * its own way back in — a dialog you cannot leave is a trap, not a safeguard.
 */
export function Dialog(props: DialogProps) {
  // On phones a centred dialog fights the keyboard and the safe areas, so the
  // same content docks to the bottom as a sheet instead.
  const sheet = () => state.compact;

  return (
    <KDialog open={props.open} onOpenChange={props.onOpenChange} modal>
      <KDialog.Portal>
        <KDialog.Overlay data-component="dialog-overlay" />
        <div data-slot="dialog-positioner" data-sheet={sheet() ? "" : undefined}>
          <KDialog.Content
            data-component="dialog"
            data-sheet={sheet() ? "" : undefined}
            style={{ width: sheet() ? undefined : (props.width ?? "560px") }}
          >
            <Show when={sheet()}>
              <div data-slot="sheet-grip" />
            </Show>
            <div data-slot="dialog-header">
              <div data-slot="dialog-heading">
                <KDialog.Title data-slot="dialog-title">{props.title}</KDialog.Title>
                <Show when={props.description}>
                  <KDialog.Description data-slot="dialog-description">{props.description}</KDialog.Description>
                </Show>
              </div>
              <KDialog.CloseButton as="div">
                <IconButton icon="close" label="Close" variant="ghost-muted" />
              </KDialog.CloseButton>
            </div>
            <div data-slot="dialog-body" data-fill={props.fill ? "" : undefined}>
              {props.children}
            </div>
            <Show when={props.footer}>
              <div data-slot="dialog-footer">{props.footer}</div>
            </Show>
          </KDialog.Content>
        </div>
      </KDialog.Portal>
    </KDialog>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  width?: string;
  "aria-label"?: string;
}

export function Select(props: SelectProps) {
  const selected = () => props.options.find((o) => o.value === props.value);
  return (
    <KSelect<SelectOption>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={selected()}
      onChange={(option) => option && props.onChange(option.value)}
      placeholder={props.placeholder ?? "Select…"}
      itemComponent={(itemProps) => (
        <KSelect.Item item={itemProps.item} data-slot="select-item">
          <KSelect.ItemLabel>{itemProps.item.rawValue.label}</KSelect.ItemLabel>
          <KSelect.ItemIndicator data-slot="select-item-indicator">
            <Icon name="check" size={14} />
          </KSelect.ItemIndicator>
        </KSelect.Item>
      )}
    >
      <KSelect.Trigger data-component="select" aria-label={props["aria-label"]} style={{ width: props.width }}>
        <KSelect.Value<SelectOption> data-slot="select-value">
          {(state) => state.selectedOption()?.label}
        </KSelect.Value>
        <KSelect.Icon data-slot="select-icon">
          <Icon name="chevron-down" size={14} />
        </KSelect.Icon>
      </KSelect.Trigger>
      <KSelect.Portal>
        <KSelect.Content data-component="select-content">
          <KSelect.Listbox data-slot="select-listbox" />
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: JSX.Element }) {
  return (
    <KSwitch checked={props.checked} onChange={props.onChange} data-component="switch">
      <KSwitch.Label data-slot="switch-label">{props.label}</KSwitch.Label>
      <KSwitch.Input />
      <KSwitch.Control data-slot="switch-control">
        <KSwitch.Thumb data-slot="switch-thumb" />
      </KSwitch.Control>
    </KSwitch>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export interface TextInputProps extends Omit<ComponentProps<"input">, "onInput" | "value"> {
  value: string;
  onValue: (value: string) => void;
  label?: JSX.Element;
  size?: "small" | "normal";
}

export function TextInput(props: TextInputProps) {
  const [local, rest] = splitProps(props, ["value", "onValue", "label", "size"]);
  return (
    <KTextField value={local.value} onChange={local.onValue} data-component="text-field">
      <Show when={local.label}>
        <KTextField.Label data-slot="field-label">{local.label}</KTextField.Label>
      </Show>
      <KTextField.Input {...rest} data-slot="text-input" data-size={local.size ?? "normal"} />
    </KTextField>
  );
}

export interface TextAreaProps extends Omit<ComponentProps<"textarea">, "onInput" | "value"> {
  value: string;
  onValue: (value: string) => void;
  label?: JSX.Element;
}

export function TextArea(props: TextAreaProps) {
  const [local, rest] = splitProps(props, ["value", "onValue", "label"]);
  return (
    <KTextField value={local.value} onChange={local.onValue} data-component="text-field">
      <Show when={local.label}>
        <KTextField.Label data-slot="field-label">{local.label}</KTextField.Label>
      </Show>
      <KTextField.TextArea {...rest} data-slot="textarea" />
    </KTextField>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function SegmentedControl<T extends string>(props: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  fullWidth?: boolean;
}) {
  return (
    <div data-slot="segmented-control" role="tablist" classList={{ "w-full": props.fullWidth }}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="tab"
            data-slot="segmented-control-item"
            data-selected={props.value === option.value ? "" : undefined}
            aria-selected={props.value === option.value}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

/** `magic` marks what belongs to the agent rather than to the project (§50). */
export function Tag(props: ParentProps<{ tone?: "neutral" | "success" | "warning" | "danger" | "info" | "magic" }>) {
  return (
    <span data-component="tag" data-tone={props.tone ?? "neutral"}>
      {props.children}
    </span>
  );
}

export function Spinner(props: { size?: number }) {
  return <span data-component="spinner" style={{ width: `${props.size ?? 10}px`, height: `${props.size ?? 10}px` }} />;
}
