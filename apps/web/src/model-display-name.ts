/** Friendly names for Claude's standard model IDs; custom IDs stay verbatim. */
export function modelDisplayName(id: string): string {
  const match = /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)$/.exec(id);
  if (!match) return id;
  const family = match[1]!;
  return `Claude ${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}
