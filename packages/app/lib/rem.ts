// UI text is sized in rem so the Interface text size setting scales all of
// it. Sizes are written as their px at the default setting: rem(13) is 13px
// until the setting changes the root size (see applyUiFontPreferences).
export const ROOT_PX = 16;

export function rem(px: number): string {
  return `${px / ROOT_PX}rem`;
}
