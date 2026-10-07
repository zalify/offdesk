import { describe, expect, it, vi } from "vitest";
import { RemoteFileError } from "./api";
import { fetchRemoteFile } from "./fetchRemoteFile";

const file = { name: "report.pdf", path: "/tmp/report.pdf", mime: "application/pdf", size: 3, data_base64: "YWJj" };

function deps(over: Record<string, unknown> = {}) {
  return {
    read: vi.fn().mockResolvedValue(file),
    save: vi.fn().mockResolvedValue({ location: "下载", open: vi.fn().mockResolvedValue(undefined) }),
    notify: vi.fn(),
    ...over,
  };
}

describe("fetchRemoteFile", () => {
  it("shows progress then success with an open action", async () => {
    const d = deps();
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf", cwd: "/tmp" }, d as never);
    expect(d.read).toHaveBeenCalledWith("m", "/tmp/report.pdf", "/tmp");
    expect(d.save).toHaveBeenCalledWith({ filename: "report.pdf", mime: "application/pdf", dataBase64: "YWJj" });
    expect(d.notify.mock.calls[0][0]).toBe("正在取 report.pdf…");
    expect(d.notify.mock.calls[1][0]).toBe("已保存 report.pdf → 下载");
    expect(d.notify.mock.calls[1][1].action.label).toBe("打开");
  });

  it("omits the open action when unavailable", async () => {
    const d = deps({ save: vi.fn().mockResolvedValue({ location: "下载" }) });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf" }, d as never);
    expect(d.notify.mock.calls[1][1]).toBeUndefined();
  });

  it("explains too_large", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(413, "too_large", "x", 34 * 1024 * 1024)) });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf" }, d as never);
    expect(d.notify.mock.calls[1][0]).toBe("report.pdf 有 34 MB，超过 20 MB 上限");
    expect(d.save).not.toHaveBeenCalled();
  });

  it("explains machine_outdated", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(409, "machine_outdated", "x")) });
    await fetchRemoteFile({ machineId: "m", path: "/a/b" }, d as never);
    expect(d.notify.mock.calls[1][0]).toBe("这台机器的 node 版本太旧，升级后才能取文件");
  });

  it("hands directories to onDirectory", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(400, "is_directory", "x", undefined, "/tmp/dir")) });
    const onDirectory = vi.fn();
    await fetchRemoteFile({ machineId: "m", path: "./dir", cwd: "/tmp", onDirectory }, d as never);
    expect(onDirectory).toHaveBeenCalledWith("/tmp/dir");
  });

  it("notices a directory when there is no hook", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(400, "is_directory", "x", undefined, "/tmp/dir")) });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/dir" }, d as never);
    expect(d.notify.mock.calls[1][0]).toContain("是目录");
  });

  it("ignores a concurrent fetch of the same path", async () => {
    let release!: () => void;
    const d = deps({ read: vi.fn().mockReturnValue(new Promise((r) => { release = () => r(file); })) });
    const first = fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf" }, d as never);
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf" }, d as never);
    expect(d.read).toHaveBeenCalledTimes(1);
    release();
    await first;
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdf" }, d as never);
    expect(d.read).toHaveBeenCalledTimes(2);
  });
});
