import { describe, expect, it } from "vitest";

import { withoutFocusZoom } from "./iosFocusZoom";

describe("withoutFocusZoom", () => {
  it("caps the viewport at scale 1", () => {
    expect(withoutFocusZoom("width=device-width, initial-scale=1, shrink-to-fit=no")).toBe(
      "width=device-width, initial-scale=1, shrink-to-fit=no, maximum-scale=1",
    );
    expect(withoutFocusZoom("width=device-width, initial-scale=1,")).toBe(
      "width=device-width, initial-scale=1, maximum-scale=1",
    );
  });

  it("leaves a viewport that already sets a maximum scale", () => {
    expect(withoutFocusZoom("width=device-width, maximum-scale=5")).toBe("width=device-width, maximum-scale=5");
  });
});
