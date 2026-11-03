import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProposalSequenceAllocator } from "./proposal-sequence.js";

const exec = promisify(execFile);
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const moduleUrl = new URL("./proposal-sequence.ts", import.meta.url).href;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-sequences-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function child(count: number, crash = false): Promise<number[]> {
  const script = `
    import { createProposalSequenceAllocator } from ${JSON.stringify(moduleUrl)};
    const reserve = createProposalSequenceAllocator(${JSON.stringify(root)});
    const values = [];
    for (let i = 0; i < ${count}; i++) values.push(await reserve("mcpFileProposals"));
    process.stdout.write(JSON.stringify(values), () => {
      ${crash ? 'process.kill(process.pid, "SIGKILL")' : "process.exit(0)"};
    });
  `;
  try {
    const result = await exec(process.execPath, [
      "--import",
      tsx,
      "--input-type=module",
      "-e",
      script,
    ]);
    return JSON.parse(result.stdout);
  } catch (error) {
    if (!crash) throw error;
    const result = error as { signal: string; stdout: string };
    expect(result.signal).toBe("SIGKILL");
    return JSON.parse(result.stdout);
  }
}

describe("durable signed proposal ordering", () => {
  it("continues across independent OS processes and a crash before publishing", async () => {
    const first = await child(1);
    const crashed = await child(1, true);
    const resumed = await child(1);
    expect(first[0]).toBeGreaterThan(1_000_000_000_000);
    expect(crashed[0]).toBe(first[0]! + 1);
    expect(resumed[0]).toBe(crashed[0]! + 1);
    expect(await readdir(join(root, "mcpFileProposals"))).toHaveLength(1);
  });

  it("reserves unique numbers under concurrent bootstrap and writers", async () => {
    const results = (
      await Promise.all(Array.from({ length: 6 }, () => child(12)))
    ).flat();
    expect(new Set(results).size).toBe(72);
    expect(Math.max(...results) - Math.min(...results)).toBe(71);
    expect((await child(1))[0]).toBe(Math.max(...results) + 1);
  });

  it("keeps mailbox ordering independent and store permissions private", async () => {
    const reserve = createProposalSequenceAllocator(root);
    const single = await reserve("mcpProposals");
    expect(await reserve("mcpFileProposals")).toBe(single);
    expect(await reserve("mcpProposals")).toBe(single + 1);
    expect((await stat(join(root, "mcpProposals"))).mode & 0o777).toBe(0o700);
    const [name] = await readdir(join(root, "mcpProposals"));
    expect((await stat(join(root, "mcpProposals", name!))).mode & 0o777).toBe(
      0o600,
    );
  });

  it.each([
    [],
    ["bad"],
    ["sequence-1"],
    [`sequence-${Number.MAX_SAFE_INTEGER}`],
    ["sequence-1000000000001", "sequence-1000000000002"],
  ])(
    "fails closed on corrupt or exhausted state: %j",
    async (...names: string[]) => {
      const directory = join(root, "mcpProposals");
      await mkdir(directory);
      for (const name of names) await writeFile(join(directory, name), "");
      await expect(
        createProposalSequenceAllocator(root)("mcpProposals"),
      ).rejects.toThrow("invalid or exhausted");
      expect((await readdir(directory)).sort()).toEqual(names.sort());
    },
  );
});
