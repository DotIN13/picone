import { Dynamic } from "solid-js/web";
import { splitProps, type ComponentProps } from "solid-js";
import { effectiveZoom } from "../../lib/app-settings.ts";
import { state } from "../../store.ts";

import ArrowUp from "lucide-solid/icons/arrow-up";
import Bell from "lucide-solid/icons/bell";
import Box from "lucide-solid/icons/box";
import Calendar from "lucide-solid/icons/calendar";
import Check from "lucide-solid/icons/check";
import CaseSensitive from "lucide-solid/icons/case-sensitive";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import ChevronUp from "lucide-solid/icons/chevron-up";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Eye from "lucide-solid/icons/eye";
import EyeOff from "lucide-solid/icons/eye-off";
import ExternalLink from "lucide-solid/icons/external-link";
import FileText from "lucide-solid/icons/file-text";
import FileAudio from "lucide-solid/icons/file-audio";
import Film from "lucide-solid/icons/film";
import Folder from "lucide-solid/icons/folder";
import Globe from "lucide-solid/icons/globe";
import ImageIcon from "lucide-solid/icons/image";
import GitBranch from "lucide-solid/icons/git-branch";
import MessageSquare from "lucide-solid/icons/message-square";
import Mic from "lucide-solid/icons/mic";
import Minus from "lucide-solid/icons/minus";
import Moon from "lucide-solid/icons/moon";
import PanelLeft from "lucide-solid/icons/panel-left";
import Pencil from "lucide-solid/icons/pencil";
import Plug from "lucide-solid/icons/plug";
import Plus from "lucide-solid/icons/plus";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Undo2 from "lucide-solid/icons/undo-2";
import Search from "lucide-solid/icons/search";
import Settings from "lucide-solid/icons/settings";
import Shield from "lucide-solid/icons/shield";
import Sparkles from "lucide-solid/icons/sparkles";
import Square from "lucide-solid/icons/square";
import Sun from "lucide-solid/icons/sun";
import Target from "lucide-solid/icons/target";
import Terminal from "lucide-solid/icons/terminal";
import User from "lucide-solid/icons/user";
import Workflow from "lucide-solid/icons/workflow";
import TriangleAlert from "lucide-solid/icons/triangle-alert";
import X from "lucide-solid/icons/x";
import { ClaudeMark, PiMark } from "./agent-marks.tsx";

/**
 * Lucide, imported one icon at a time so the bundle only carries what is used.
 * The keys are product names rather than glyph names, so swapping a glyph never
 * touches a call site.
 */
const ICONS = {
  // The two that are not Lucide's: one mark per agent (§58), drawn to sit in
  // this set rather than beside it.
  "agent-pi": PiMark,
  "agent-claude": ClaudeMark,
  "arrow-up": ArrowUp,
  alert: TriangleAlert,
  bell: Bell,
  box: Box,
  calendar: Calendar,
  "case-sensitive": CaseSensitive,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "external-link": ExternalLink,
  eye: Eye,
  "eye-off": EyeOff,
  close: X,
  comment: MessageSquare,
  file: FileText,
  film: Film,
  folder: Folder,
  globe: Globe,
  image: ImageIcon,
  "git-branch": GitBranch,
  mic: Mic,
  minus: Minus,
  moon: Moon,
  more: Ellipsis,
  panel: PanelLeft,
  plug: Plug,
  plus: Plus,
  refresh: RefreshCw,
  rewind: Undo2,
  rename: Pencil,
  search: Search,
  settings: Settings,
  shield: Shield,
  sparkle: Sparkles,
  stop: Square,
  sun: Sun,
  target: Target,
  terminal: Terminal,
  user: User,
  waveform: FileAudio,
  workflow: Workflow,
} as const;

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<ComponentProps<"svg">, "children"> {
  name: IconName;
  size?: number;
  /**
   * With `absoluteStrokeWidth` this is device pixels, so a 12px and a 22px icon
   * keep the same hairline weight — the way opencode's set behaves.
   */
  strokeWidth?: number;
}

/**
 * The hairline, undone by the interface zoom.
 *
 * `absoluteStrokeWidth` pins the stroke in the icon's own pixels, which is what
 * keeps a 12px and a 22px icon the same weight. The zoom on the root then
 * multiplies it like any other length, so at 130% the hairline is a 2px line
 * and the icons read heavier than the text beside them — type does not gain
 * weight as it gains size, and an icon set drawn to match it should not either.
 * Dividing here leaves the stroke the same on the glass at every scale.
 */
const hairline = () => 1.5 / effectiveZoom(state.app.appearance, state.compact);

export function Icon(props: IconProps) {
  const [local, rest] = splitProps(props, ["name", "size", "strokeWidth"]);
  return (
    <Dynamic
      component={ICONS[local.name]}
      {...rest}
      data-slot="icon-svg"
      size={local.size ?? 16}
      strokeWidth={local.strokeWidth ?? hairline()}
      absoluteStrokeWidth
      aria-hidden="true"
    />
  );
}
