/**
 * Friendly random project names (project-model redesign §4) — an
 * `adjective-noun` generator (e.g. `crimson-otter`) used by every create path
 * EXCEPT import (which prefers the zip filename, falling back here). Replaces the
 * old universal `"Untitled project"` default so a fresh library is a set of
 * distinct, memorable names rather than a wall of identical entries.
 *
 * PURE + deterministic-testable: the RNG is injectable (a `() => number` in
 * `[0, 1)`, like `Math.random`), so a test can pin exact picks and assert the
 * format without flakiness. Both word lists are curated, lowercase, and
 * hyphen-free so the joined name is always a clean `adjective-noun` slug.
 */

/** Curated adjectives — calm, friendly, lowercase, no hyphens. */
export const ADJECTIVES: readonly string[] = [
  "amber",
  "azure",
  "brisk",
  "calm",
  "clever",
  "cobalt",
  "coral",
  "crimson",
  "dapper",
  "eager",
  "fabled",
  "gentle",
  "golden",
  "hazel",
  "jolly",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "merry",
  "nimble",
  "olive",
  "plucky",
  "quiet",
  "rapid",
  "rustic",
  "sage",
  "scarlet",
  "silver",
  "snug",
  "spry",
  "sunny",
  "teal",
  "tidy",
  "vivid",
  "witty",
];

/** Curated nouns — concrete, friendly, lowercase, no hyphens. */
export const NOUNS: readonly string[] = [
  "otter",
  "falcon",
  "maple",
  "comet",
  "harbor",
  "lantern",
  "meadow",
  "pebble",
  "river",
  "thicket",
  "willow",
  "badger",
  "cedar",
  "ember",
  "fjord",
  "garnet",
  "heron",
  "ibis",
  "juniper",
  "kestrel",
  "lynx",
  "marten",
  "nectar",
  "orchard",
  "puffin",
  "quartz",
  "raven",
  "sparrow",
  "tundra",
  "vireo",
  "walnut",
  "yarrow",
  "zephyr",
];

/** Pick an element from `list` using an RNG value in `[0, 1)`. */
function pick<T>(list: readonly T[], rng: () => number): T {
  const i = Math.floor(rng() * list.length) % list.length;
  return list[i]!;
}

/**
 * A friendly `adjective-noun` project name. `rng` defaults to `Math.random` and
 * is injectable for deterministic tests. Never returns an empty string, never
 * contains whitespace, and always has exactly one hyphen separating two words.
 */
export function randomProjectName(rng: () => number = Math.random): string {
  return `${pick(ADJECTIVES, rng)}-${pick(NOUNS, rng)}`;
}
