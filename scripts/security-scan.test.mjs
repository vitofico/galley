import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the actual audit-policy evaluator in the shell entrypoint. No registry
// or optional scanner is contacted, and no duplicate evaluator is kept in tests.
const script = readFileSync(
  new URL("./security-scan.sh", import.meta.url),
  "utf8",
);
const evaluator = script.match(/<<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
assert.ok(evaluator, "audit evaluator exists in the scanner entrypoint");

function evaluate(report) {
  const dir = mkdtempSync(join(tmpdir(), "galley-audit-policy-"));
  try {
    const auditPath = join(dir, "audit.json");
    const policyPath = join(dir, "policy.json");
    writeFileSync(auditPath, JSON.stringify(report));
    writeFileSync(policyPath, JSON.stringify({ ignore: [] }));
    return spawnSync(process.execPath, ["-", auditPath, policyPath], {
      input: evaluator,
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clean = () => ({
  advisories: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  },
});

test("an actual clean advisory report passes", () => {
  assert.equal(evaluate(clean()).status, 0);
});

test("pnpm registry-error JSON fails rather than reporting a clean audit", () => {
  const result = evaluate({
    error: {
      code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
      message: "registry unavailable",
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /complete advisory report/);
});

test("incomplete reports and malformed advisories fail closed", () => {
  const inconsistent = clean();
  inconsistent.metadata.vulnerabilities.high = 1;
  const unknown = clean();
  unknown.advisories[1] = { severity: "unexpected" };
  for (const report of [
    null,
    [],
    {},
    { advisories: {} },
    { ...clean(), advisories: [] },
    unknown,
    inconsistent,
  ]) {
    assert.equal(evaluate(report).status, 2);
  }
});

test("blocking high advisories still fail, while moderate reports are allowed", () => {
  for (const [severity, expected] of [
    ["moderate", 0],
    ["high", 1],
  ]) {
    const report = clean();
    report.metadata.vulnerabilities[severity] = 1;
    report.advisories[1] = {
      id: 1,
      severity,
      module_name: "fixture",
      title: "test advisory",
    };
    assert.equal(evaluate(report).status, expected);
  }
});
