/**
 * Per-key in-process serialization (roadmap #4). Many adapter ops are
 * read-compute-write against shared on-disk state (a sequence number, a members
 * file, a git index); without serialization, concurrent calls for the SAME key
 * race and corrupt it. `run` chains ops per key so each runs to completion before
 * the next starts. Cross-process safety needs file locks — single-writer per key
 * is assumed (the sync server owns each doc/project).
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(op, op); // run regardless of the previous op's outcome
    // Install a never-rejecting tail so a failed op can't poison the chain.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    // Drop the entry once this tail settles AND it's still the installed one, so
    // the map doesn't grow unbounded across many distinct keys.
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }
}
