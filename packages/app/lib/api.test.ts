import { afterEach, describe, expect, test, vi } from "vitest";

import {
  configure,
  getMe,
  ApiError,
  deleteWorkspaceGroup,
  deleteMachine,
  createApiToken,
  deleteApiToken,
} from "./api";

describe("api request", () => {
  test("auth validation receives its abort signal and keeps HTTP status", async () => {
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    await expect(getMe(controller.signal)).rejects.toBeInstanceOf(ApiError);
    await expect(getMe()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/me", expect.objectContaining({ signal: controller.signal }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configure("", null);
  });

  test("resolves void requests with 204 responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      deleteWorkspaceGroup("machine-a", "group-a"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/machines/machine-a/workspace-groups/group-a",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("deletes a machine with 204", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteMachine("machine-a")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/machines/machine-a",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  test("creates and deletes api tokens", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "tok-1",
            name: "cli",
            token: "odk_abc",
            created_at: 123,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(createApiToken("cli")).resolves.toMatchObject({
      token: "odk_abc",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/api-tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "cli" }),
      }),
    );

    await expect(deleteApiToken("tok-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/auth/api-tokens/tok-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

});
