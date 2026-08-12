import { For, Show, createSignal, onMount } from "solid-js";
import {
  BUNDLED_MONO,
  BUNDLED_SANS,
  BASE_FONT_SIZE,
  FONT_SIZES,
  SCALES,
  SYSTEM_MONO,
  SYSTEM_SANS,
  fontKind,
  notificationPermission,
  notify,
  requestNotificationPermission,
} from "../lib/app-settings.ts";
import type { ColorSchemePreference } from "../lib/app-settings.ts";
import { resetAppSettings, state, updateAppSettings } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Select, Switch, Tag, TextInput } from "./ui/primitives.tsx";

/**
 * Settings for this browser on this device (DESIGN §49). They apply the moment
 * they change and persist to `localStorage`, so unlike the workspace sections
 * there is nothing to save and no unsaved state to lose.
 */

const SCHEME_OPTIONS: Array<{ value: ColorSchemePreference; label: string }> = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const FONT_OPTIONS = [
  { value: "default", label: "Bundled" },
  { value: "system", label: "System" },
  { value: "custom", label: "Custom…" },
];

export function AppearancePanel() {
  const appearance = () => state.app.appearance;

  /** Kept in component state so the field does not vanish while it is empty. */
  const [customSans, setCustomSans] = createSignal(
    fontKind(state.app.appearance.interfaceFont, SYSTEM_SANS) === "custom" ? "custom" : "",
  );
  const [customMono, setCustomMono] = createSignal(
    fontKind(state.app.appearance.codeFont, SYSTEM_MONO) === "custom" ? "custom" : "",
  );

  const sansKind = () => customSans() || fontKind(appearance().interfaceFont, SYSTEM_SANS);
  const monoKind = () => customMono() || fontKind(appearance().codeFont, SYSTEM_MONO);

  const pickFont = (which: "sans" | "mono", kind: string) => {
    const setCustom = which === "sans" ? setCustomSans : setCustomMono;
    setCustom(kind === "custom" ? "custom" : "");
    if (kind === "custom") return;
    const value = kind === "system" ? (which === "sans" ? SYSTEM_SANS : SYSTEM_MONO) : "";
    updateAppSettings({ appearance: which === "sans" ? { interfaceFont: value } : { codeFont: value } });
  };

  /** The bundled stacks are the fallback, so a name that is not installed still reads. */
  const setCustomFont = (which: "sans" | "mono", value: string) => {
    const trimmed = value.trim();
    const fallback = which === "sans" ? BUNDLED_SANS : BUNDLED_MONO;
    const font = trimmed ? `${trimmed}, ${fallback}` : "";
    updateAppSettings({ appearance: which === "sans" ? { interfaceFont: font } : { codeFont: font } });
  };

  /** The family the user typed, without the fallback stack we appended. */
  const customValue = (font: string) => font.split(",")[0]?.trim() ?? "";

  return (
    <div class="flex flex-col gap-4">
      <div data-slot="section-title">Appearance</div>

      <div data-slot="settings-row">
        <span>Theme</span>
        <Select
          aria-label="Theme"
          width="180px"
          value={appearance().colorScheme}
          options={SCHEME_OPTIONS}
          onChange={(value) => updateAppSettings({ appearance: { colorScheme: value as ColorSchemePreference } })}
        />
      </div>

      <div data-slot="settings-row">
        <span>Interface size</span>
        <Select
          aria-label="Interface size"
          width="180px"
          value={String(appearance().scale)}
          options={SCALES.map((s) => ({ value: String(s.value), label: `${s.label} · ${Math.round(s.value * 100)}%` }))}
          onChange={(value) => updateAppSettings({ appearance: { scale: Number(value) } })}
        />
      </div>

      <div data-slot="settings-row">
        <span>Font size</span>
        <Select
          aria-label="Font size"
          width="180px"
          value={String(appearance().fontSize)}
          options={FONT_SIZES.map((size) => ({
            value: String(size),
            label: size === BASE_FONT_SIZE ? `${size}px · default` : `${size}px`,
          }))}
          onChange={(value) => updateAppSettings({ appearance: { fontSize: Number(value) } })}
        />
      </div>

      <div data-slot="settings-row">
        <span>Interface font</span>
        <Select
          aria-label="Interface font"
          width="180px"
          value={sansKind()}
          options={FONT_OPTIONS}
          onChange={(value) => pickFont("sans", value)}
        />
      </div>
      <Show when={sansKind() === "custom"}>
        <TextInput
          value={customValue(appearance().interfaceFont)}
          placeholder="Font family installed on this device, e.g. IBM Plex Sans"
          onValue={(value) => setCustomFont("sans", value)}
        />
      </Show>

      <div data-slot="settings-row">
        <span>Code font</span>
        <Select
          aria-label="Code font"
          width="180px"
          value={monoKind()}
          options={FONT_OPTIONS}
          onChange={(value) => pickFont("mono", value)}
        />
      </div>
      <Show when={monoKind() === "custom"}>
        <TextInput
          value={customValue(appearance().codeFont)}
          placeholder="Monospace family, e.g. Berkeley Mono"
          onValue={(value) => setCustomFont("mono", value)}
        />
      </Show>

      <div>
        <Switch
          checked={appearance().layoutWidgets}
          onChange={(value) => updateAppSettings({ appearance: { layoutWidgets: value } })}
          label="Lay out extension widgets"
        />
        <p data-slot="field-hint">
          Reads the indentation and colour an extension drew and renders it as text. Turn this off to print widgets
          exactly as they came, in monospace.
        </p>
      </div>

      <div data-slot="appearance-preview" style={{ "font-family": appearance().interfaceFont || undefined }}>
        <div>The quick brown fox jumps over the lazy dog.</div>
        <code style={{ "font-family": appearance().codeFont || undefined }}>
          const answer = 42; // 0O1lI —{">"}=
        </code>
      </div>

      <div>
        <Button variant="neutral" onClick={resetAppSettings}>
          Reset app settings
        </Button>
      </div>
    </div>
  );
}

export function NotificationsPanel() {
  const notifications = () => state.app.notifications;
  const [permission, setPermission] = createSignal(notificationPermission());

  onMount(() => setPermission(notificationPermission()));

  const enable = async (enabled: boolean) => {
    if (!enabled) {
      updateAppSettings({ notifications: { enabled: false } });
      return;
    }
    // Browsers only grant this from a user gesture, which is exactly here.
    const result = await requestNotificationPermission();
    setPermission(result);
    updateAppSettings({ notifications: { enabled: result === "granted" } });
  };

  const detail: Array<{ key: "turnFinished" | "permissionNeeded" | "errors"; label: string }> = [
    { key: "turnFinished", label: "When the agent finishes a turn" },
    { key: "permissionNeeded", label: "When a tool needs permission" },
    { key: "errors", label: "On errors" },
  ];

  return (
    <div class="flex flex-col gap-4">
      <div data-slot="section-title">Notifications</div>

      <Show
        when={permission() !== "unsupported"}
        fallback={
          <p data-slot="field-hint">
            This browser offers no notifications here. They need a secure origin — <code>localhost</code> or HTTPS —
            so reaching Picone over plain HTTP on a LAN address rules them out.
          </p>
        }
      >
        <div class="flex items-center gap-3">
          <Switch
            checked={notifications().enabled}
            onChange={(enabled) => void enable(enabled)}
            label="Desktop notifications"
          />
          <Show when={permission() === "denied"}>
            <Tag tone="danger">blocked by the browser</Tag>
          </Show>
        </div>

        <Show when={permission() === "denied"}>
          <p data-slot="field-hint">
            Notifications are blocked for this site. Allow them in the browser's site settings, then switch this back
            on.
          </p>
        </Show>

        {/* A fieldset rather than dimming: these read as unavailable while
            notifications are off, and a native `disabled` makes that true
            instead of merely looking it. */}
        <fieldset data-slot="settings-fieldset" disabled={!notifications().enabled}>
          <For each={detail}>
            {(item) => (
              <Switch
                checked={notifications()[item.key]}
                onChange={(value) => updateAppSettings({ notifications: { [item.key]: value } })}
                label={item.label}
              />
            )}
          </For>

          <Switch
            checked={notifications().onlyWhenUnfocused}
            onChange={(value) => updateAppSettings({ notifications: { onlyWhenUnfocused: value } })}
            label="Only when Picone is not in front"
          />

          <div>
            <Button
              variant="neutral"
              disabled={!notifications().enabled}
              onClick={() =>
                // Bypass the focus rule: a test you cannot see is not a test.
                notify(
                  { ...notifications(), onlyWhenUnfocused: false },
                  { title: "Picone", body: "Notifications are working.", tag: "test" },
                )
              }
            >
              Send a test notification
            </Button>
          </div>
        </fieldset>
      </Show>
    </div>
  );
}
