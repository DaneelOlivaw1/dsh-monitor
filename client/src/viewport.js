// The diagram viewport's arithmetic, kept away from React and mermaid so it can
// be tested: how far to shrink so the whole run is visible, and where to scroll
// so the point under the cursor stays where it is while zooming.
//
// A mermaid diagram is a fixed drawing: `viewBox` gives its natural size, and the
// only way to show more or less of it is a scale plus a scroll offset. Both are
// pure numbers, so they live here instead of inside a component's effects.

/** The zoom range the diagram viewport allows. */
export const MIN_SCALE = 0.05
export const MAX_SCALE = 4

/** What one click or one wheel notch multiplies the scale by. */
export const ZOOM_STEP = 1.25

/**
 * The scale at which the whole drawing fits the viewport.
 *
 * Both axes matter: fitting the width of a tall chain leaves its bottom half
 * below the fold, which is exactly the "can't see the whole graph" case.
 */
export function fitScale(natural, viewport) {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(viewport.width / natural.width, viewport.height / natural.height)
}

export function clampScale(value) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

/** The scale the page shows before the reader touches anything: the whole run. */
export function initialScale(natural, viewport) {
  return clampScale(Math.min(1, fitScale(natural, viewport)))
}

/**
 * Scroll offsets that keep the content point under (x, y) at (x, y).
 *
 * `x`/`y` are viewport-relative, `prev`/`next` the scale before and after the
 * change. A zoom that ignored this would throw the reader to the top-left
 * corner of the drawing on every step.
 */
export function scrollAfterZoom({ scrollLeft, scrollTop, x, y, prev, next }) {
  if (!(prev > 0) || !(next > 0)) return { left: scrollLeft, top: scrollTop }
  const ratio = next / prev
  return {
    left: (scrollLeft + x) * ratio - x,
    top: (scrollTop + y) * ratio - y,
  }
}
