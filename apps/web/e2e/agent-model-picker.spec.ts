import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #15 model picker — the agent pane lets the author switch the run's model,
 * populated by the provider's own "list models" API (OpenAI-compatible `/models`,
 * Anthropic `/v1/models`, Ollama `/api/tags`). Direct mode lists; proxy mode
 * can't (the proxy forwards chat only) and says so.
 *
 * We seed a provider in localStorage and stub its `/models` endpoint, then drive
 * the picker UX. (The default boot uses the Demo model and shows NO picker.)
 */

const DIRECT_PROVIDER = {
  kind: "openai-compatible",
  label: "Test",
  baseUrl: "https://api.example.test/v1",
  model: "gpt-4o",
  isLocal: false,
  transport: { mode: "direct", apiKey: "sk-test" },
};

const PROXY_PROVIDER = {
  kind: "openai-compatible",
  label: "Proxied",
  baseUrl: "https://api.example.test/v1",
  model: "gpt-4o",
  isLocal: false,
  transport: { mode: "proxy", proxyUrl: "http://localhost:8088", upstreamId: "openai" },
};

async function waitReady(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}

test("model picker lists the provider's models and switching updates the control", async ({
  page,
}) => {
  await page.addInitScript((cfg) => {
    localStorage.setItem("galley.provider", JSON.stringify(cfg));
  }, DIRECT_PROVIDER);
  await page.route(/api\.example\.test\/v1\/models/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "o3" }] }),
    }),
  );

  await gotoEditor(page);
  await waitReady(page);

  // The model button lives inside the overflow menu — open it first.
  await page.getByTestId("agent-overflow-button").click();
  await expect(page.getByTestId("agent-overflow-menu")).toBeVisible();

  const button = page.getByTestId("agent-model-button");
  await expect(button).toContainText("gpt-4o");

  await button.click();
  await expect(page.getByTestId("agent-model-list")).toBeVisible();
  await expect(page.getByTestId("agent-model-option-o3")).toBeVisible();

  // a11y: the list is a listbox whose model rows are options.
  await expect(page.getByRole("option", { name: /o3/ })).toBeVisible();

  await page.getByTestId("agent-model-option-o3").click();
  await expect(button).toContainText("o3");
  await expect(page.getByTestId("agent-model-list")).toHaveCount(0);
});

test("model picker under a proxy says listing isn't available (no models endpoint)", async ({
  page,
}) => {
  await page.addInitScript((cfg) => {
    localStorage.setItem("galley.provider", JSON.stringify(cfg));
  }, PROXY_PROVIDER);

  await gotoEditor(page);
  await waitReady(page);

  // The model button lives inside the overflow menu — open it first.
  await page.getByTestId("agent-overflow-button").click();
  await expect(page.getByTestId("agent-overflow-menu")).toBeVisible();

  await page.getByTestId("agent-model-button").click();
  await expect(page.getByTestId("agent-model-error")).toContainText(/proxy/i);
});
