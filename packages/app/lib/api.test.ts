import { afterEach, describe, expect, test, vi } from "vitest";

import {
  configure,
  getMe,
  fsOp,
  RemoteFileError,
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

  test("file routes: a bare 404 means an old hub, a coded 404 stays not_found", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(fsOp("m", { op: "mkdir", path: "/a" })).rejects.toMatchObject({
      status: 404,
      code: "hub_outdated",
    });
    spy.mockResolvedValueOnce(new Response("404 page not found", { status: 404 }));
    await expect(fsOp("m", { op: "mkdir", path: "/a" })).rejects.toMatchObject({ code: "hub_outdated" });
    spy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not_found", message: "gone" }), { status: 404 }),
    );
    const err = await fsOp("m", { op: "mkdir", path: "/a" }).catch((e) => e);
    expect(err).toBeInstanceOf(RemoteFileError);
    expect(err.code).toBe("not_found");
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
