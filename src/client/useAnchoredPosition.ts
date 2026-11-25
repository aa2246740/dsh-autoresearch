import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

export interface AnchoredRect {
  top: number
  right: number
  bottom: number
  left: number
}

export interface AnchoredPanelSize {
  width: number
  height: number
}

export interface AnchoredViewport {
  width: number
  height: number
}

/**
 * Place a fixed panel against a header trigger.
 * Prefer below the anchor, right edges aligned; flip above when the panel
 * would leave the viewport and the space above can hold it.
 */
export function placeAnchoredPanel(options: {
  anchor: AnchoredRect
  panel: AnchoredPanelSize
  viewport: AnchoredViewport
  gap: number
  margin: number
}): { top: number; left: number } {
  const { anchor, panel, viewport, gap, margin } = options
  const width = Math.max(0, panel.width)
  const height = Math.max(0, panel.height)
  let top = anchor.bottom + gap
  const belowLimit = viewport.height - margin
  const aboveTop = anchor.top - gap - height
  if (top + height > belowLimit && aboveTop >= margin) top = aboveTop
  const maxTop = Math.max(margin, viewport.height - margin - height)
  top = Math.min(Math.max(top, margin), maxTop)
  let left = anchor.right - width
  const maxLeft = Math.max(margin, viewport.width - margin - width)
  left = Math.min(Math.max(left, margin), maxLeft)
  return { top, left }
}

export interface AnchoredPositionOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
  gap?: number
  margin?: number
}

/** Local replacement for the removed `useAnchoredPosition` primitive. */
export function useAnchoredPosition({
  open,
  anchorRef,
  panelRef,
  gap = 8,
  margin = 12,
}: AnchoredPositionOptions): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    const place = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (anchor === null || panel === null) return
      const anchorRect = anchor.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const next = placeAnchoredPanel({
        anchor: anchorRect,
        panel: { width: panelRect.width, height: panelRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        gap,
        margin,
      })
      setStyle((previous) => {
        if (
          previous !== null
          && previous.top === next.top
          && previous.left === next.left
          && previous.visibility === 'visible'
        ) return previous
        return { position: 'fixed', top: next.top, left: next.left, visibility: 'visible' }
      })
    }
    place()
    const panel = panelRef.current
    const observer = typeof ResizeObserver === 'function' && panel !== null
      ? new ResizeObserver(place)
      : null
    observer?.observe(panel as HTMLElement)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchorRef, panelRef, gap, margin])

  return open ? style : null
}
