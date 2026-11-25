import { type CSSProperties, type RefObject } from 'react';
export interface AnchoredRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
}
export interface AnchoredPanelSize {
    width: number;
    height: number;
}
export interface AnchoredViewport {
    width: number;
    height: number;
}
/**
 * Place a fixed panel against a header trigger.
 * Prefer below the anchor, right edges aligned; flip above when the panel
 * would leave the viewport and the space above can hold it.
 */
export declare function placeAnchoredPanel(options: {
    anchor: AnchoredRect;
    panel: AnchoredPanelSize;
    viewport: AnchoredViewport;
    gap: number;
    margin: number;
}): {
    top: number;
    left: number;
};
export interface AnchoredPositionOptions {
    open: boolean;
    anchorRef: RefObject<HTMLElement | null>;
    panelRef: RefObject<HTMLElement | null>;
    gap?: number;
    margin?: number;
}
/** Local replacement for the removed `useAnchoredPosition` primitive. */
export declare function useAnchoredPosition({ open, anchorRef, panelRef, gap, margin, }: AnchoredPositionOptions): CSSProperties | null;
//# sourceMappingURL=useAnchoredPosition.d.ts.map