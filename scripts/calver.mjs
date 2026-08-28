#!/usr/bin/env node
// CalVer (calendar versioning) helper — generates YYYY.MM.MICRO tags.
//
//   YYYY  full year            MM  zero-padded month (01-12)
//   MICRO auto-incrementing counter for releases within the same month (from 0)
//
// Usage:
//   node scripts/calver.mjs            print the next version (no git changes)
//   node scripts/calver.mjs --current  print the latest existing CalVer tag
//   node scripts/calver.mjs --tag      create the git tag for the next version
//   node scripts/calver.mjs --tag --push  also push the tag to origin
//
// Pure Node + git; no dependencies. Ported from the Python service template so
// the release workflow doesn't need a Python toolchain.

import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Parse a CalVer tag into [year, month, micro], or null if it doesn't match. */
function parseCalver(tag) {
  const cleaned = tag.replace(/^v/, "");
  const parts = cleaned.split(".");
  if (parts.length !== 3) return null;
  const [year, month, micro] = parts.map((p) => Number(p));
  if (!Number.isInteger(year) || year < 2000 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(micro) || micro < 0) return null;
  return [year, month, micro];
}

function allTags() {
  return git(["tag", "-l"])
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

function currentVersion() {
  const tagged = allTags()
    .map((tag) => ({ tag, parsed: parseCalver(tag) }))
    .filter((t) => t.parsed);
  if (tagged.length === 0) return null;
  tagged.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (b.parsed[i] !== a.parsed[i]) return b.parsed[i] - a.parsed[i];
    }
    return 0;
  });
  return tagged[0].tag;
}

function nextVersion(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const microsThisMonth = allTags()
    .map(parseCalver)
    .filter((p) => p && p[0] === year && p[1] === month)
    .map((p) => p[2]);
  const nextMicro = microsThisMonth.length
    ? Math.max(...microsThisMonth) + 1
    : 0;
  return `${year}.${String(month).padStart(2, "0")}.${nextMicro}`;
}

function createTag(version, push) {
  git(["tag", "-a", version, "-m", `Release ${version}`]);
  process.stderr.write(`✓ Tag '${version}' created\n`);
  if (push) {
    git(["push", "origin", version]);
    process.stderr.write(`✓ Tag '${version}' pushed to origin\n`);
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--push") && !args.has("--tag")) {
    process.stderr.write("Error: --push requires --tag\n");
    process.exit(1);
  }

  if (args.has("--current")) {
    const current = currentVersion();
    if (!current) {
      process.stderr.write("No CalVer tags found\n");
      process.exit(1);
    }
    process.stdout.write(`${current}\n`);
    return;
  }

  const version = nextVersion();
  process.stdout.write(`${version}\n`);
  if (args.has("--tag")) createTag(version, args.has("--push"));
}

main();
