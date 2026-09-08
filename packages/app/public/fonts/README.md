# Bundled fonts

JetBrainsMono-Regular.woff2 is the unmodified regular webfont from JetBrains Mono v2.304:
https://github.com/JetBrains/JetBrainsMono/tree/v2.304/fonts/webfonts
Its copyright and SIL Open Font License are in JetBrainsMono-OFL.txt.
It is the fixed default terminal text face; user-selected fonts remain optional.

OffdeskTerminalSymbols.woff2 is a 2,988-byte subset of Iosevka Term v34.8.1,
renamed for this derivative. It contains only U+23F4–U+23FA (⏴ ⏵ ⏶ ⏷ ⏸ ⏹ ⏺),
which are missing from the bundled JetBrains Mono. The CSS face is restricted
to this range, so it cannot change Latin letters, numbers, punctuation or CJK.
Its upstream copyright and SIL Open Font License are in Iosevka-LICENSE.md.
The full Iosevka font is not bundled.

To regenerate the subset:

1. Download PkgWebFont-IosevkaTerm-34.8.1.zip from
   https://github.com/be5invis/Iosevka/releases/tag/v34.8.1 and extract
   WOFF2/IosevkaTerm-Regular.woff2.
2. Install `fonttools[woff]` in a temporary Python environment, then run from
   the repository root:
   `python scripts/subset-terminal-symbols.py /path/to/IosevkaTerm-Regular.woff2 packages/app/public/fonts/OffdeskTerminalSymbols.woff2`.

Both terminal resources are served locally. Chinese and other unsupported
characters use system fallback; no third-party font request is made.
Nunito Variable and Fredoka Variable are the existing bundled interface fonts.
