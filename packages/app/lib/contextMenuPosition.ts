export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

export interface SubmenuPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Computes fixed viewport coordinates for a context-menu submenu so it never
 * overflows off the right, left, top, or bottom edges of the viewport.
 *
 * Prefers opening to the right of `anchor` (overlapping by `overlap` px so
 * moving the pointer across stays inside the hover region); flips to the left
 * when the right edge would clip; clamps vertically and caps `maxHeight` so
 * long submenus scroll inside the viewport.
 */
export function computeSubmenuPosition(
  anchor: RectLike,
  submenu: SizeLike,
  viewport: SizeLike,
  margin = 8,
  overlap = 4,
): SubmenuPlacement {
  const maxHeight = Math.max(80, viewport.height - margin * 2);
  const effectiveHeight = Math.min(submenu.height, maxHeight);

  const rightCandidate = anchor.right - overlap;
  const leftCandidate = anchor.left - submenu.width + overlap;

  let left: number;
  if (rightCandidate + submenu.width <= viewport.width - margin) {
    left = rightCandidate;
  } else if (leftCandidate >= margin) {
    left = leftCandidate;
  } else {
    const spaceRight = viewport.width - anchor.right;
    const spaceLeft = anchor.left;
    const preferred = spaceLeft > spaceRight ? leftCandidate : rightCandidate;
    left = Math.max(
      margin,
      Math.min(preferred, Math.max(margin, viewport.width - submenu.width - margin)),
    );
  }

  const idealTop = anchor.top - 4;
  const maxTop = Math.max(margin, viewport.height - effectiveHeight - margin);
  const top = Math.max(margin, Math.min(idealTop, maxTop));

  return { left, top, maxHeight };
}
