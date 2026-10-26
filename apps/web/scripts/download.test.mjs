import assert from "node:assert/strict";
import test from "node:test";
import { download } from "./download.mjs";

const sleep = async () => {};

test("retries CDN resets and returns complete bytes", async () => {
  let calls = 0;
  const bytes = await download("https://assets.example.org/font", {
    sleep,
    fetchImpl: async () => {
      if (++calls === 1) throw new TypeError("fetch failed: ECONNRESET");
      return new Response("font");
    },
  });
  assert.equal(calls, 2);
  assert.equal(new TextDecoder().decode(bytes), "font");
});

test("retries rate limits and server errors", async () => {
  for (const status of [429, 502, 503]) {
    let calls = 0;
    await download("https://assets.example.org/font", {
      sleep,
      fetchImpl: async () =>
        new Response("", { status: ++calls === 1 ? status : 200 }),
    });
    assert.equal(calls, 2);
  }
});

test("permanent HTTP errors fail without retry", async () => {
  let calls = 0;
  await assert.rejects(
    download("https://assets.example.org/font", {
      sleep,
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 404 });
      },
    }),
    /HTTP 404/,
  );
  assert.equal(calls, 1);
});

test("a persistent outage fails after three attempts", async () => {
  let calls = 0;
  await assert.rejects(
    download("https://assets.example.org/font", {
      sleep,
      fetchImpl: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    }),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

test("an interrupted body is downloaded again", async () => {
  let calls = 0;
  await download("https://assets.example.org/font", {
    sleep,
    fetchImpl: async () =>
      ++calls === 1
        ? {
            ok: true,
            arrayBuffer: async () => {
              throw new Error("body reset");
            },
          }
        : new Response("font"),
  });
  assert.equal(calls, 2);
});
