import DrawerPrimitive from "@corvu/drawer";
import type { JSX } from "solid-js";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "bottom";
  children: JSX.Element;
}

/**
 * Layers that are visually inside the drawer but not inside its DOM.
 *
 * A select, a popover or a tooltip renders through a portal at the end of
 * `<body>`, so a click on one is a click *outside* the drawer as far as the DOM
 * is concerned. Corvu is right to close on an outside click and has no way to
 * know these belong to it — they come from a different library, with its own
 * layer stack.
 */
const FLOATING_LAYERS = [
  "[data-popper-positioner]",
  '[data-component="dialog"]',
  '[data-component="tooltip"]',
  '[data-component="drawer"]',
].join(",");

/**
 * Side panel built on Corvu, matching opencode's drawer: inset 6px from the
 * viewport edge, 8px radius, overlay elevation, and a drag-to-dismiss handle.
 */
export function Drawer(props: DrawerProps) {
  return (
    <DrawerPrimitive
      open={props.open}
      onOpenChange={props.onOpenChange}
      side={props.side ?? "right"}
      breakPoints={[0.75]}
      /*
       * Choosing from a select inside the drawer used to close the drawer: the
       * option is portaled out of it, so picking one read as clicking away. The
       * scrim still dismisses, which is the behaviour worth keeping — this only
       * declines the ones that came from the drawer's own controls.
       */
      onOutsidePointer={(event) => {
        const target = event.target as Element | null;
        if (target?.closest?.(FLOATING_LAYERS)) event.preventDefault();
      }}
    >
      {(drawer) => (
        <DrawerPrimitive.Portal>
          <DrawerPrimitive.Overlay
            data-component="drawer-overlay"
            // The render prop hands back unwrapped values, so the scrim tracks
            // the drag position rather than snapping open.
            style={{
              "background-color": `color-mix(in srgb, var(--v2-overlay-simple-overlay-scrim) ${
                drawer.openPercentage * 100
              }%, transparent)`,
              "backdrop-filter": `blur(${3 * drawer.openPercentage}px)`,
            }}
          />
          <DrawerPrimitive.Content data-component="drawer" data-side={props.side ?? "right"}>
            {props.children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Portal>
      )}
    </DrawerPrimitive>
  );
}

export const DrawerLabel = DrawerPrimitive.Label;
export const DrawerDescription = DrawerPrimitive.Description;
export const DrawerClose = DrawerPrimitive.Close;
