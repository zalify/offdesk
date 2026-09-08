#!/usr/bin/env python3
"""Build the small terminal playback-symbol fallback (requires fonttools[woff])."""
import argparse
from fontTools import subset
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", help="Upstream IosevkaTerm-Regular.woff2, v34.8.1")
parser.add_argument("output", help="Output OffdeskTerminalSymbols.woff2")
args = parser.parse_args()
font = TTFont(args.source)
codepoints = set(range(0x23F4, 0x23FB))  # ⏴ ⏵ ⏶ ⏷ ⏸ ⏹ ⏺
assert codepoints <= font.getBestCmap().keys(), "Source is missing required symbols"
options = subset.Options()
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=codepoints)
subsetter.subset(font)
# Give the modified font its own identity; preserve upstream copyright/license.
names = {
    1: "Offdesk Terminal Symbols", 2: "Regular",
    3: "OffdeskTerminalSymbols-1.0", 4: "Offdesk Terminal Symbols",
    6: "OffdeskTerminalSymbols-Regular",
    16: "Offdesk Terminal Symbols", 17: "Regular",
}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
assert set(font.getBestCmap()) == codepoints
font.flavor = "woff2"
font.save(args.output)
