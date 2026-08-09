import DrawerPrimitive from "@corvu/drawer";
import type { JSX } from "solid-js";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "bottom";
  children: JSX.Element;
}

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
