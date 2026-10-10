import { describe, expect, it, vi } from "vitest";
import { RemoteFileError } from "./api";
import { fetchRemoteFile, saveFetchedFile } from "./fetchRemoteFile";

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

  it("tries the fallback when the path does not exist", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new RemoteFileError(404, "not_found", "x"))
      .mockResolvedValueOnce(file);
    const d = deps({ read });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/report.pdfand", fallbackPath: "/tmp/report.pdf" }, d as never);
    expect(read.mock.calls.map((call) => call[1])).toEqual(["/tmp/report.pdfand", "/tmp/report.pdf"]);
    expect(d.notify.mock.calls[1][0]).toBe("已保存 report.pdf → 下载");
  });

  it("names the path as shown when the fallback is missing too", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(404, "not_found", "x")) });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/a/joined.txt", fallbackPath: "/tmp/a/join" }, d as never);
    expect(d.read).toHaveBeenCalledTimes(2);
    expect(d.notify.mock.calls[1][0]).toBe("找不到 joined.txt");
  });

  it("only falls back when the path does not exist", async () => {
    const d = deps({ read: vi.fn().mockRejectedValue(new RemoteFileError(403, "permission_denied", "x")) });
    await fetchRemoteFile({ machineId: "m", path: "/tmp/a/b.txt", fallbackPath: "/tmp/a/b" }, d as never);
    expect(d.read).toHaveBeenCalledTimes(1);
    expect(d.notify.mock.calls[1][0]).toBe("没有权限读取 b.txt");
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

describe("saveFetchedFile", () => {
  it("saves loaded bytes and notifies with an open action", async () => {
    const d = deps();
    await saveFetchedFile(file, d as never);
    expect(d.save).toHaveBeenCalledWith({ filename: "report.pdf", mime: "application/pdf", dataBase64: "YWJj" });
    expect(d.read).not.toHaveBeenCalled();
    expect(d.notify.mock.calls[0][0]).toBe("已保存 report.pdf → 下载");
    expect(d.notify.mock.calls[0][1].action.label).toBe("打开");
  });

  it("reports save failures without throwing", async () => {
    const d = deps({ save: vi.fn().mockRejectedValue(new Error("disk full")) });
    await saveFetchedFile(file, d as never);
    expect(d.notify).toHaveBeenCalledWith("保存 report.pdf 失败：disk full", { tone: "error", timeoutMs: 8000 });
  });
});
