import { describe, it, expect } from "vitest";
import { errorNotice, infoNotice } from "./app-notice.js";
import { noticeRole } from "./components/Notice.js";

/**
 * AppNotice model (corrections C3): the shell-root banner must give failures the
 * interrupting `alert` role and keep hints polite — the finding's "role='alert'
 * for failures" requirement, pinned offline.
 */
describe("AppNotice model (C3)", () => {
  it("a failure carries error severity → interrupting alert role", () => {
    const n = errorNotice("Could not restore the version.");
    expect(n.severity).toBe("error");
    expect(noticeRole(n.severity)).toBe("alert");
    expect(n.message).toBe("Could not restore the version.");
  });

  it("a hint carries info severity → polite status role, never alert", () => {
    const n = infoNotice("Select some text in the editor first.");
    expect(n.severity).toBe("info");
    expect(noticeRole(n.severity)).toBe("status");
    expect(n.message).toBe("Select some text in the editor first.");
  });
});
