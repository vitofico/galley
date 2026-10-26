import { setTimeout as delay } from "node:timers/promises";

// CDN resets and 5xx responses must not fail a whole image build on first use.
// Limit both attempts and request time; permanent HTTP errors still fail fast.
export async function download(url, { fetchImpl = fetch, sleep = delay } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let retryable = true;
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} downloading ${url}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (!retryable || attempt === 3) throw error;
      console.warn(`Asset download failed; retrying (${attempt}/3): ${url}`);
      await sleep(attempt * 1_000);
    }
  }
}
