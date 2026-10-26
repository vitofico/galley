export interface AccountResourcePolicy {
  maxBytes: number;
  maxOwnedProjects: number | null;
  expiresAt: number;
}
/** A generic, bounded service-to-service policy reader. Self-hosted deployments may omit it. */
export function createAccountResourcePolicyReader(options: {
  url: string;
  key: Uint8Array;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): (subject: string) => Promise<AccountResourcePolicy> {
  const url = new URL(options.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    options.key.byteLength !== 32
  )
    throw new Error("Invalid resource policy configuration");
  const authorization = `Bearer ${Buffer.from(options.key).toString("base64url")}`;
  return async (subject) => {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ subject }),
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Resource policy unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Invalid resource policy");
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) throw new Error("Invalid resource policy");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const p = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as AccountResourcePolicy;
    const now = (options.now ?? Date.now)();
    if (
      !p ||
      !Number.isSafeInteger(p.maxBytes) ||
      p.maxBytes < 0 ||
      (p.maxOwnedProjects !== null &&
        (!Number.isSafeInteger(p.maxOwnedProjects) ||
          p.maxOwnedProjects < 0)) ||
      !Number.isSafeInteger(p.expiresAt) ||
      p.expiresAt <= now ||
      p.expiresAt > now + 300000
    )
      throw new Error("Invalid resource policy");
    return p;
  };
}
