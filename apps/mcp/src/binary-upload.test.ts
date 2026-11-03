import { describe, expect, it, vi } from "vitest";
import { buildBinaryUploader } from "./control-tools.js";
import type { KernelBlobSession } from "./blob-session.js";
import type { ControlRpcOutcome } from "./control.js";

const bytes = new Uint8Array(563_196).fill(7);

function setup(result: unknown, failPush = false, failRelease = false) {
  const calls: string[] = [];
  const putBlob = vi.fn(async () => {
    if (failPush) throw new Error("private socket detail must not be reflected");
    return { hash: "verified-hash", size: bytes.length };
  });
  const upload = buildBinaryUploader({
    projectId: "proj-test",
    blob: { connect() {}, putBlob } as unknown as KernelBlobSession,
    rpc: async (op): Promise<ControlRpcOutcome> => {
      calls.push(op);
      if (op === "release_blob" && failRelease) throw new Error("unavailable");
      return { ok: true, result: op === "expect_blob" ? result : { released: true } };
    },
  });
  return { upload, calls, putBlob };
}

describe("binary upload compatibility and reservation cleanup", () => {
  it("fails before pushing to an older browser and releases its reservation", async () => {
    const t = setup({ reserved: true });
    expect(await t.upload(bytes, "font/otf")).toMatchObject({
      ok: false, reason: "binary_protocol_unsupported",
    });
    expect(t.putBlob).not.toHaveBeenCalled();
    expect(t.calls).toEqual(["expect_blob", "release_blob"]);
  });

  it("releases a failed font transfer, even when cleanup also fails", async () => {
    const t = setup({ reserved: true, protocol: "galley-blob-v1" }, true, true);
    const result = await t.upload(bytes, "font/otf");
    expect(result).toMatchObject({ ok: false, reason: "push_failed" });
    expect(JSON.stringify(result)).not.toContain("private socket detail");
    expect(t.calls).toEqual(["expect_blob", "release_blob"]);
  });

  it("publishes a pointer only after the compatible browser verifies completion", async () => {
    const t = setup({ reserved: true, protocol: "galley-blob-v1" });
    expect(await t.upload(bytes, "font/otf")).toEqual({
      ok: true, hash: "verified-hash", size: bytes.length, mime: "font/otf",
    });
    expect(t.calls).toEqual(["expect_blob"]);
  });

  it("does not push or release a reservation the browser refused", async () => {
    const t = setup({ reserved: false, protocol: "galley-blob-v1" });
    expect(await t.upload(bytes, "font/otf")).toMatchObject({ ok: false, reason: "blob_quota_exceeded" });
    expect(t.putBlob).not.toHaveBeenCalled();
    expect(t.calls).toEqual(["expect_blob"]);
  });
});
