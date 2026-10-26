import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishFileProposal,
  getFileProposal,
  type WebSocketLike,
} from "@galley/collab";
import { gotoEditor } from "./app-helpers.js";

// Synthetic authenticated cloud transport + REAL relay/mailbox/editor apply.
// This suite never calls a model or billing provider.
const requireFromMcp = createRequire(
  resolve(fileURLToPath(import.meta.url), "../../../mcp/package.json"),
);
const { WebSocket: WS } = requireFromMcp("ws") as {
  WebSocket: new (url: string) => WebSocketLike;
};
const AUTHOR = { kind: "agent", runId: "hosted" } as const;
type Peer = { project: CollabProject; connection: CollabConnection };
type Run = {
  id: string;
  kind: "document";
  state: string;
  clientRef: string;
  draftRef?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  reviewDecision?: "accepted" | "rejected";
};

async function fixture(
  page: Page,
  projectId: string,
  mode: "draft" | "queued" | "quota" | "uncertain" = "draft",
) {
  await page.addInitScript((id) => {
    (window as unknown as { __GALLEY_CONFIG__: unknown }).__GALLEY_CONFIG__ = {
      hostedRuns: {
        apiPath: "/cloud/api/agent-runs",
        accountPath: "/cloud/dashboard",
      },
    };
    // Hosted proposals MUST remain manual even with the local in-app mode Auto.
    localStorage.setItem(`galley.agentAcceptanceMode.${id}`, "auto");
  }, projectId);
  const peers: Peer[] = [];
  const runs: Run[] = [];
  const state = {
    access: "enabled",
    keyConfigured: true,
    creates: 0,
    saves: [] as string[],
    removed: 0,
    unauthorized: false,
    gets: 0,
  };
  await page.route("**/cloud/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (state.unauthorized) return json({ error: "unauthorized" }, 401);
    if (path.endsWith("/model-keys/default")) {
      if (req.method() === "PUT") {
        state.saves.push(req.postDataJSON().secret);
        state.keyConfigured = true;
      }
      if (req.method() === "DELETE") {
        state.removed++;
        state.keyConfigured = false;
      }
      return json({ stored: state.keyConfigured });
    }
    if (req.method() === "GET") {
      state.gets++;
      return json({
        runs,
        access: state.access,
        keyConfigured: state.keyConfigured,
        documentRuns: true,
      });
    }
    if (path.endsWith("/cancel")) {
      runs[0]!.state = "canceled";
      return json({ canceled: true });
    }
    if (path.endsWith("/reviewed")) {
      runs[0]!.reviewedAt = Date.now();
      runs[0]!.reviewDecision = req.postDataJSON().decision;
      return json({ recorded: true });
    }
    state.creates++;
    if (mode === "quota") return json({ error: "monthly_agent_limit" }, 429);
    const input = req.postDataJSON();
    expect(input.kind).toBe("document");
    expect(input.clientRef).toBe(projectId);
    const run: Run = {
      id: `hosted-${state.creates}`,
      kind: "document",
      state:
        mode === "queued"
          ? "queued"
          : mode === "uncertain"
            ? "failed"
            : "awaiting_accept",
      ...(mode === "uncertain" ? { error: "agent run execution error" } : {}),
      clientRef: projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    runs.unshift(run);
    if (mode === "draft" || mode === "uncertain") {
      const { syncUrl, room } = input.draftTarget;
      const project = new CollabProject();
      const connection = new CollabConnection(
        project,
        new WebSocketTransport(
          () => new WS(`${syncUrl}/${encodeURIComponent(room)}`),
        ),
        { author: AUTHOR },
      );
      connection.connect();
      peers.push({ project, connection });
      const snapshot = JSON.parse(input.prompt).files[0];
      await expect
        .poll(
          () =>
            project.snapshot().files.find((f) => f.path === snapshot.path)
              ?.text,
          { timeout: 30_000 },
        )
        .toBe(snapshot.text);
      const proposed = `${snapshot.text}\nHosted change awaiting Accept.\n`;
      const proposalId = await publishFileProposal(
        project,
        {
          runId: run.id,
          request: "Hosted proposal",
          ops: [
            {
              kind: "edit",
              path: snapshot.path,
              baseText: snapshot.text,
              proposedText: proposed,
              blocks: [{ search: snapshot.text, replace: proposed }],
            },
          ],
        },
        AUTHOR,
      );
      if (mode === "draft") run.draftRef = `doc:test-fingerprint:${proposalId}`;
    }
    return json({ runId: run.id }, 201);
  });
  return {
    state,
    runs,
    peers,
    close: () =>
      peers.forEach(({ connection, project }) => {
        connection.destroy();
        project.destroy();
      }),
  };
}
async function prepare(page: Page) {
  await page
    .getByLabel("Hosted request", { exact: true })
    .fill("Improve the active file.");
  await page.getByTestId("hosted-prepare").click();
  await expect(page.getByTestId("hosted-consent")).toBeVisible();
}
async function start(page: Page) {
  await prepare(page);
  await page
    .getByRole("button", { name: "Send snapshot and start run" })
    .click();
  await expect(page.getByTestId("hosted-run")).toBeVisible();
}

test("hosted snapshot consent, reload recovery, manual Accept in Auto mode and live compile", async ({
  page,
}, testInfo) => {
  const f = await fixture(page, "hosted-accept");
  try {
    await gotoEditor(page, { id: "hosted-accept" });
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
      timeout: 60_000,
    });
    await prepare(page);
    expect(f.state.creates).toBe(0);
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    const contrasts = await page.evaluate(() => {
      const root = document.documentElement;
      const before = {
        skin: root.getAttribute("data-skin"),
        theme: root.getAttribute("data-theme"),
      };
      const button = document.querySelector(
        ".hosted-consent button:last-child",
      )!;
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const rows = [];
      for (const skin of ["studio", "press"])
        for (const theme of ["light", "dark"]) {
          if (skin === "press") root.setAttribute("data-skin", skin);
          else root.removeAttribute("data-skin");
          if (theme === "dark") root.setAttribute("data-theme", theme);
          else root.removeAttribute("data-theme");
          const style = getComputedStyle(button),
            bg = luminance(style.backgroundColor),
            fg = luminance(style.color);
          rows.push({
            skin,
            theme,
            foreground: style.color,
            background: style.backgroundColor,
            ratio: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05),
          });
        }
      if (before.skin === null) root.removeAttribute("data-skin");
      else root.setAttribute("data-skin", before.skin);
      if (before.theme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before.theme);
      return rows;
    });
    for (const contrast of contrasts)
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    await writeFile(
      testInfo.outputPath("hosted-contrast.json"),
      JSON.stringify(contrasts, null, 2),
    );
    await page.screenshot({
      path: testInfo.outputPath("hosted-consent.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("hosted-consent")).toHaveCount(0);
    expect(f.state.creates).toBe(0);
    await start(page);
    await expect(page.getByTestId("hosted-run")).toContainText(
      "Draft ready for review",
    );
    await expect(
      page.locator('[data-testid="editor"] .cm-content'),
    ).not.toContainText("Hosted change awaiting Accept.");
    // The previously-consented room is rejoined, but no model request is repeated.
    await page.reload();
    await expect(page.getByTestId("hosted-run")).toContainText(
      "Draft ready for review",
    );
    await page.getByRole("button", { name: "Review pending drafts" }).click();
    const card = page.getByTestId("mcp-file-proposal");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Hosted change awaiting Accept.");
    expect(f.state.creates).toBe(1);
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
      timeout: 60_000,
    });
    await page.screenshot({
      path: testInfo.outputPath("hosted-review.png"),
      fullPage: true,
    });
    await card.getByTestId("file-proposal-accept").click();
    await expect(card).toHaveCount(0);
    await expect(
      page.locator('[data-testid="editor"] .cm-content'),
    ).toContainText("Hosted change awaiting Accept.");
    await expect(page.getByTestId("hosted-run")).toContainText(
      "Accepted in editor",
    );
    await expect.poll(() => f.runs[0]!.reviewDecision).toBe("accepted");
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("preview")).toContainText(
      "Hosted change awaiting Accept.",
    );
    expect(f.runs[0]!.state).toBe("awaiting_accept"); // Server can never Accept for the human.
    await page.screenshot({
      path: testInfo.outputPath("hosted-accepted.png"),
      fullPage: true,
    });
    await page.getByTestId("share-button").click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("unshare-button").click();
    await expect(page.getByTestId("share-button")).toHaveText("Share");
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("galley.hostedMailbox."),
        ),
      ),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("hosted Accept checks concurrent typing and preserves a conflicting live edit", async ({
  page,
}) => {
  const f = await fixture(page, "hosted-conflict");
  try {
    await gotoEditor(page, { id: "hosted-conflict" });
    await start(page);
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.insertText("= My concurrent edit\n\nKeep my words.");
    await page.getByRole("button", { name: "Review pending drafts" }).click();
    const card = page.getByTestId("mcp-file-proposal");
    await expect(card).toBeVisible();
    await card.getByTestId("file-proposal-accept").click();
    await expect(
      page.getByRole("alert").filter({ hasText: /changed since the proposal/ }),
    ).toBeVisible();
    await expect(editor).toContainText("Keep my words.");
    await expect(editor).not.toContainText("Hosted change awaiting Accept.");
    const proposal = f.runs[0]!.draftRef!.split(":").slice(2).join(":");
    expect(getFileProposal(f.peers[0]!.project, proposal)?.status).toBe(
      "pending",
    );
    await card.getByTestId("file-proposal-reject").click();
    await expect(page.getByTestId("hosted-run")).toContainText(
      "Rejected in editor",
    );
  } finally {
    f.close();
  }
});

test("hosted queued cancellation survives reload without another create", async ({
  page,
}) => {
  const f = await fixture(page, "hosted-cancel", "queued");
  try {
    await gotoEditor(page, { id: "hosted-cancel" });
    await start(page);
    await expect(page.getByTestId("hosted-run")).toContainText("Queued");
    await page.getByRole("button", { name: "Cancel hosted run" }).click();
    await expect(page.getByTestId("hosted-run")).toContainText("Canceled");
    await page.reload();
    await expect(page.getByTestId("hosted-run")).toContainText("Canceled");
    expect(f.state.creates).toBe(1);
  } finally {
    f.close();
  }
});

test("uncertain delivery stays failed and exposes pending review without repeating the run", async ({
  page,
}) => {
  const f = await fixture(page, "hosted-uncertain", "uncertain");
  try {
    await gotoEditor(page, { id: "hosted-uncertain" });
    await start(page);
    await expect(page.getByTestId("hosted-run")).toContainText("Run failed");
    await expect(page.getByTestId("hosted-run")).toContainText(
      "A draft may have been delivered before confirmation failed",
    );
    await expect(page.getByTestId("hosted-run")).not.toContainText(
      "Draft ready",
    );
    await page.getByRole("button", { name: "Review pending drafts" }).click();
    const card = page.getByTestId("mcp-file-proposal");
    await expect(card).toBeVisible();
    await expect(
      page.locator('[data-testid="editor"] .cm-content'),
    ).not.toContainText("Hosted change awaiting Accept.");
    await card.getByTestId("file-proposal-reject").click();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "Start another request" }).click();
    await expect(
      page.getByLabel("Hosted request", { exact: true }),
    ).toBeFocused();
    expect(f.state.creates).toBe(1);
    expect(f.runs[0]!.state).toBe("failed");
  } finally {
    f.close();
  }
});

test("hosted BYOK, account access, quota and sign-in errors are actionable without secret persistence or automatic retries", async ({
  page,
}) => {
  const f = await fixture(page, "hosted-gates", "quota");
  try {
    f.state.access = "upgrade_required";
    f.state.keyConfigured = false;
    await gotoEditor(page, { id: "hosted-gates" });
    await expect(page.getByTestId("hosted-access")).toContainText(
      "Account access is required",
    );
    await expect(
      page.getByRole("link", { name: "Account and billing" }),
    ).toHaveAttribute("href", "/cloud/dashboard");
    await expect(page.getByTestId("hosted-prepare")).toBeDisabled();
    f.state.access = "enabled";
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.getByText("Manage model key", { exact: true }).click();
    await page
      .getByLabel("Provider API key", { exact: true })
      .fill("synthetic-secret-not-for-storage");
    await page.getByRole("button", { name: "Save encrypted key" }).click();
    await expect(page.getByTestId("hosted-key-status")).toContainText(
      "A key is stored",
    );
    await expect(
      page.getByLabel("Provider API key", { exact: true }),
    ).toHaveValue("");
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain("synthetic-secret-not-for-storage");
    await prepare(page);
    await page
      .getByRole("button", { name: "Send snapshot and start run" })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "allowance is used" }),
    ).toBeVisible();
    const gets = f.state.gets;
    await expect.poll(() => f.state.gets).toBeGreaterThan(gets); // background polling never resubmits POST.
    expect(f.state.creates).toBe(1);
    await expect(
      page.getByRole("alert").filter({ hasText: "allowance is used" }),
    ).toBeVisible();
    f.state.access = "upgrade_required";
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.getByRole("button", { name: "Remove stored key" }).click();
    await expect(page.getByTestId("hosted-key-status")).toContainText(
      "No key is stored",
    );
    expect(f.state.removed).toBe(1);
    f.state.unauthorized = true;
    await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Sign in" }),
    ).toBeVisible();
  } finally {
    f.close();
  }
});
