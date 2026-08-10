import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { ResolvedPath } from "@picone/protocol";
import { api } from "../lib/api.ts";
import type { Reference, ReferenceKind } from "../lib/references.ts";
import { resolution } from "../lib/resolver.ts";
import { openFile, revealInTree } from "../store.ts";
import { Icon, type IconName } from "./ui/icon.tsx";

/**
 * A thing the agent mentioned, shown rather than named (DESIGN §51).
 *
 * Two shapes. Small things are **pills** — an icon, a name, one line, inline
 * with the prose. Substantial things are **boxes** that occupy their own block
 * and show the actual content. The split is by what is useful to see, not by
 * file type: you want to look at an image, and you only want to know that a
 * file was touched.
 *
 * Anything that fails to resolve renders as the plain text it always was. That
 * is the whole safety net for the detector being liberal, so it matters that
 * this component never draws a broken affordance.
 */

const ICON: Record<ReferenceKind, IconName> = {
  image: "image",
  audio: "waveform",
  video: "film",
  pdf: "file",
  webpage: "globe",
  file: "file",
  directory: "folder",
};

/** Boxes are for what you would want to look at; everything else is a pill. */
const BOXED = new Set<ReferenceKind>(["image", "audio", "video"]);

export interface MediaReferenceProps {
  reference: Reference;
  /**
   * Prose keeps its rhythm, so a path in a sentence stays a modest inline chip
   * even when it names an image. A markdown `![]()` asked for the picture.
   */
  display?: "inline" | "block";
  /** What the source wrote, used verbatim when there is nothing to upgrade to. */
  label?: string;
}

export function MediaReference(props: MediaReferenceProps) {
  const remote = () => props.reference.kind === "webpage" || /^https?:\/\//i.test(props.reference.target);
  // Only local paths need the server's opinion; a URL is already an answer.
  const resolved = (): ResolvedPath | undefined => (remote() ? undefined : resolution(props.reference.target));

  const kind = (): ReferenceKind => {
    const r = resolved();
    // Only the server can tell a directory from a file, so it gets the last word.
    if (r?.exists && r.type === "directory") return "directory";
    return props.reference.kind;
  };

  const known = () => remote() || resolved()?.exists === true;
  const boxed = () => props.display === "block" && BOXED.has(kind()) && known();

  return (
    <Switch fallback={<>{props.label ?? props.reference.target}</>}>
      <Match when={boxed()}>
        <MediaBox kind={kind()} src={sourceUrl(props.reference.target, resolved())} label={props.label} />
      </Match>
      <Match when={known()}>
        <ReferencePill
          kind={kind()}
          reference={props.reference}
          resolved={resolved()}
          label={props.label}
        />
      </Match>
    </Switch>
  );
}

/** Local files are served through the root guard; a URL is used as written. */
function sourceUrl(target: string, resolved: ResolvedPath | undefined): string {
  if (/^https?:\/\//i.test(target)) return target;
  return api.rawUrl(resolved?.absolute ?? target);
}

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

function ReferencePill(props: {
  kind: ReferenceKind;
  reference: Reference;
  resolved: ResolvedPath | undefined;
  label?: string;
}) {
  const text = () => {
    if (props.label) return props.label;
    if (props.kind === "webpage") return hostOf(props.reference.target);
    return basename(props.reference.target);
  };

  const activate = () => {
    const target = props.reference.target;
    if (/^https?:\/\//i.test(target)) {
      // noopener because a page opened from a transcript has no business
      // reaching back into this one.
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    const absolute = props.resolved?.absolute ?? target;
    if (props.kind === "directory") void revealInTree(absolute);
    else void openFile(absolute);
  };

  return (
    <button
      type="button"
      data-component="reference-pill"
      data-kind={props.kind}
      title={props.reference.target}
      onClick={activate}
    >
      <Icon name={ICON[props.kind]} size={11} />
      <span data-slot="reference-label">{text()}</span>
      <Show when={props.kind === "webpage"}>
        <Icon name="external-link" size={10} />
      </Show>
    </button>
  );
}

function basename(target: string): string {
  const clean = target.replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/**
 * Nothing loads until it is nearly on screen. A long transcript can mention
 * fifty images, and decoding fifty images to show three is the difference
 * between a scroll that keeps up and one that does not.
 */
function MediaBox(props: { kind: ReferenceKind; src: string; label?: string }) {
  const [near, setNear] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  let host: HTMLDivElement | undefined;

  /*
   * Observed on mount rather than in the `ref` callback. Solid runs a ref
   * before the element is in the document, and observing a disconnected
   * element does not report it as intersecting when it is finally inserted —
   * so an image sitting in plain view stayed a grey placeholder until some
   * unrelated scroll happened to nudge the observer awake.
   */
  onMount(() => {
    if (!host || !("IntersectionObserver" in window)) {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      // Start a screen early, so scrolling reaches a picture already there.
      { rootMargin: "600px 0px" },
    );
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div data-component="media-box" data-kind={props.kind} ref={host}>
      <Show
        when={!failed()}
        fallback={
          <div data-slot="media-failed">
            <Icon name="alert" size={12} />
            {props.label || "could not be loaded"}
          </div>
        }
      >
        <Show when={near()} fallback={<div data-slot="media-placeholder" />}>
          <Switch>
            <Match when={props.kind === "image"}>
              {/* An <img> never runs an SVG's scripts, which is why an SVG is
                  shown this way and never inlined. */}
              <img
                src={props.src}
                alt={props.label ?? ""}
                loading="lazy"
                decoding="async"
                onError={() => setFailed(true)}
              />
            </Match>
            <Match when={props.kind === "audio"}>
              <audio src={props.src} controls preload="none" onError={() => setFailed(true)} />
            </Match>
            <Match when={props.kind === "video"}>
              <video src={props.src} controls preload="metadata" onError={() => setFailed(true)} />
            </Match>
          </Switch>
        </Show>
      </Show>

      <Show when={props.label && props.kind === "image" && !failed()}>
        <figcaption data-slot="media-caption">{props.label}</figcaption>
      </Show>
    </div>
  );
}
