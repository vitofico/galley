import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePairingFile } from "./pairing-store.js";

type Mailbox = "mcpProposals" | "mcpFileProposals";

// Above the old, process-local counters when upgrading an already armed tab.
// This is only ordering metadata: it confers no grant or signing authority.
const INITIAL_SEQUENCE = 1_000_000_000_000;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Reserve BEFORE signing/publishing, including across concurrent kernel processes.
 * Each mailbox has one empty `sequence-N` marker. Renaming that exact source to
 * N+1 is an atomic compare-and-swap: only one process can move N; losers retry.
 * There is no lock owner to strand on a crash, and a crashed reservation is never
 * reused. Install the initial, nonempty directory atomically too. This store is
 * local ordering metadata, not reusable project authority or a source of truth
 * for the browser's signature, grant, audit and rollback checks.
 */
export function createProposalSequenceAllocator(
  root = join(dirname(resolvePairingFile()), "proposal-sequences"),
): (mailbox: Mailbox) => Promise<number> {
  return async (mailbox) => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(root, mailbox);
    for (let attempt = 0; attempt < 256; attempt++) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (code(error) !== "ENOENT")
          throw new Error("Proposal sequence store is unreadable");
        const temporary = await mkdtemp(join(root, ".init-"));
        try {
          const marker = await open(
            join(temporary, `sequence-${INITIAL_SEQUENCE}`),
            "wx",
            0o600,
          );
          try {
            await marker.sync();
          } finally {
            await marker.close();
          }
          await syncDirectory(temporary);
          try {
            await rename(temporary, directory);
            await syncDirectory(root);
          } catch (installError) {
            if (!["EEXIST", "ENOTEMPTY"].includes(code(installError) ?? "")) {
              throw new Error(
                "Proposal sequence store could not be initialized",
              );
            }
          }
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
        continue;
      }
      const entry = entries[0];
      const match = entry && /^sequence-(\d+)$/.exec(entry.name);
      const previous = match ? Number(match[1]) : NaN;
      if (
        entries.length !== 1 ||
        !entry?.isFile() ||
        !Number.isSafeInteger(previous) ||
        previous < INITIAL_SEQUENCE ||
        previous >= Number.MAX_SAFE_INTEGER
      ) {
        // Never reset corrupt/exhausted state and silently reuse a signed seq.
        throw new Error("Proposal sequence store is invalid or exhausted");
      }
      const next = previous + 1;
      try {
        await rename(
          join(directory, entry.name),
          join(directory, `sequence-${next}`),
        );
      } catch (error) {
        if (code(error) === "ENOENT") continue; // another kernel reserved it
        throw new Error("Proposal sequence could not be reserved");
      }
      await syncDirectory(directory);
      return next;
    }
    throw new Error("Proposal sequence store is busy; retry the proposal");
  };
}
