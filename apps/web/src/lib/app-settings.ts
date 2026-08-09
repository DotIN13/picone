/**
 * Settings for the app itself, as opposed to the workspace (DESIGN §49).
 *
 * These describe this browser on this device — how big the text is, whether it
 * may raise a notification — so they live in `localStorage` rather than in the
 * workspace JSON, which is shared and checked in.
 */

export type ColorSchemePreference = "system" | "light" | "dark";

export interface AppearanceSettings {
  colorScheme: ColorSchemePreference;
  /** Empty means the bundled family; anything else is a CSS font-family list. */
  interfaceFont: string;
  codeFont: string;
  /** Whole-interface zoom, 1 being the design size. */
  scale: number;
  /** Base text size in px, on top of the interface scale. */
  fontSize: number;
}

export interface NotificationSettings {
  enabled: boolean;
  turnFinished: boolean;
  permissionNeeded: boolean;
  errors: boolean;
  /** Stay quiet while the window is in front — you can already see it happen. */
  onlyWhenUnfocused: boolean;
}

export interface AppSettings {
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
}

export const BUNDLED_SANS = `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
export const BUNDLED_MONO = `"JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`;
export const SYSTEM_SANS = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
export const SYSTEM_MONO = `ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`;

export const SCALES = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
  { value: 1.4, label: "Largest" },
];

/**
 * The design's body size. Every other size in the CSS is a multiple of it, so
 * the chosen px value drives them all through `--font-scale`.
 */
export const BASE_FONT_SIZE = 13;

/** Narrower than the interface scale: text grows inside containers that do not. */
export const FONT_SIZES = [11, 12, 13, 14, 15, 16];

const DEFAULTS: AppSettings = {
  appearance: { colorScheme: "system", interfaceFont: "", codeFont: "", scale: 1, fontSize: BASE_FONT_SIZE },
  notifications: {
    enabled: false,
    turnFinished: true,
    permissionNeeded: true,
    errors: true,
    onlyWhenUnfocused: true,
  },
};

const KEY = "picone:app-settings";
/** The colour scheme was a setting of its own before this file existed. */
const LEGACY_SCHEME_KEY = "picone:color-scheme";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge one level deep, so a setting added later gets its default. */
export function loadAppSettings(): AppSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    raw = null;
  }

  const stored = isRecord(raw) ? raw : {};
  const settings: AppSettings = {
    appearance: { ...DEFAULTS.appearance, ...(isRecord(stored.appearance) ? stored.appearance : {}) },
    notifications: { ...DEFAULTS.notifications, ...(isRecord(stored.notifications) ? stored.notifications : {}) },
  };

  if (!isRecord(stored.appearance)) {
    const legacy = localStorage.getItem(LEGACY_SCHEME_KEY);
    if (legacy === "light" || legacy === "dark") settings.appearance.colorScheme = legacy;
  }

  // Text size was briefly a multiplier before it was a px value.
  const previous = isRecord(stored.appearance) ? stored.appearance : {};
  if (typeof previous.fontScale === "number" && previous.fontSize === undefined) {
    settings.appearance.fontSize = Math.round(BASE_FONT_SIZE * previous.fontScale);
  }

  return settings;
}

export function saveAppSettings(settings: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function defaultAppSettings(): AppSettings {
  return structuredClone(DEFAULTS);
}

// ---------------------------------------------------------------------------
// Applying them
// ---------------------------------------------------------------------------

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");

export function resolveColorScheme(preference: ColorSchemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return systemDark().matches ? "dark" : "light";
}

/** Re-resolve `system` when the OS flips, for as long as the app is open. */
export function watchSystemColorScheme(onChange: () => void): void {
  systemDark().addEventListener("change", onChange);
}

export function applyAppearance(appearance: AppearanceSettings): void {
  const root = document.documentElement;
  root.dataset.colorScheme = resolveColorScheme(appearance.colorScheme);

  // A custom family still falls back to the bundled one, so a name that is not
  // installed degrades to the design font rather than to Times New Roman.
  root.style.setProperty("--v2-font-family-sans", appearance.interfaceFont || BUNDLED_SANS);
  root.style.setProperty("--v2-font-family-mono", appearance.codeFont || BUNDLED_MONO);
  root.style.setProperty("--ui-scale", String(appearance.scale));
  root.style.setProperty("--font-scale", String(appearance.fontSize / BASE_FONT_SIZE));
}

/**
 * Which preset a font string corresponds to, for the picker. Anything that is
 * neither empty nor the system stack is something the user typed.
 */
export function fontKind(font: string, system: string): "default" | "system" | "custom" {
  if (!font) return "default";
  if (font === system) return "system";
  return "custom";
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function notificationsSupported(): boolean {
  // Absent on an insecure origin, which is how Picone is reached over a LAN.
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  return Notification.requestPermission();
}

export interface NotifyOptions {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag?: string;
  onClick?: () => void;
}

/**
 * Raise a system notification, if the settings and the browser both allow it.
 * Silent about failure: a notification is a courtesy, never the only way to
 * learn what happened — the transcript always has it.
 */
export function notify(settings: NotificationSettings, options: NotifyOptions): void {
  if (!settings.enabled || notificationPermission() !== "granted") return;
  if (settings.onlyWhenUnfocused && document.hasFocus()) return;

  try {
    const notification = new Notification(options.title, { body: options.body, tag: options.tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
      options.onClick?.();
    };
  } catch {
    // Some browsers require a service worker for notifications; nothing to do.
  }
}
