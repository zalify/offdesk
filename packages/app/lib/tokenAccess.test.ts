import type { TokenScope } from "@offdesk/shared";
import { describe, expect, it } from "vitest";

import {
  accessFromForm,
  defaultTokenAccessForm,
  describeAccess,
} from "./tokenAccess";

describe("token access", () => {
  it("defaults to seeing runs, nothing more", () => {
    expect(accessFromForm(defaultTokenAccessForm())).toEqual({
      access: { scopes: ["runs:read"], content: "metadata" },
    });
  });

  it("makes full access only when asked", () => {
    expect(
      accessFromForm({ ...defaultTokenAccessForm(), kind: "full" }),
    ).toEqual({});
  });

  it("needs folders to start agents, one per line", () => {
    const scopes: TokenScope[] = ["runs:read", "runs:start"];
    const form = { ...defaultTokenAccessForm(), scopes };
    expect(accessFromForm(form).error).toBe(
      "List the folders it may start agents in",
    );
    expect(
      accessFromForm({
        ...form,
        dirs: " ~/work \n\n/srv/app\n",
        includeProduction: true,
      }).access,
    ).toEqual({
      scopes: ["runs:read", "runs:start"],
      content: "metadata",
      include_production: true,
      dirs: ["~/work", "/srv/app"],
    });
    expect(
      accessFromForm({ ...defaultTokenAccessForm(), scopes: [] }).error,
    ).toBe("Choose what the token may do");
  });

  it("describes a token in one line", () => {
    expect(describeAccess(null)).toBe("full access: every terminal and machine");
    expect(
      describeAccess({
        scopes: ["runs:read", "runs:start"],
        content: "requests",
        dirs: ["~/work"],
      }),
    ).toBe("runs:read, runs:start · status and what they ask · in ~/work");
  });
});
