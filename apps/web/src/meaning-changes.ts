/** Deterministic token inventory: attention cues, never factual validation. */
export interface MeaningChange {
  kind: string;
  removed: string[];
  added: string[];
}
const patterns: [string, RegExp][] = [
  [
    "Numbers, dates and units",
    /\b\d+(?:[.,:/-]\d+)*(?:\s?(?:%|kg|mg|g|km|cm|mm|m|ms|s|h|Hz|kWh|MW|USD|EUR))?(?!\w)/g,
  ],
  ["Citation and reference keys", /@[\p{L}\p{N}_][\p{L}\p{N}_.:-]*/gu],
  [
    "Obligation and certainty wording",
    /\b(?:must|shall|should|may|might|will|always|never|not)\b/gi,
  ],
];
export function meaningChanges(base: string, next: string): MeaningChange[] {
  return patterns.flatMap(([kind, pattern]) => {
    const before = base.match(pattern) ?? [];
    const after = next.match(pattern) ?? [];
    const subtract = (a: string[], b: string[]) => {
      const remaining = [...b];
      return a.filter((token) => {
        const index = remaining.indexOf(token);
        if (index < 0) return true;
        remaining.splice(index, 1);
        return false;
      });
    };
    const removed = subtract(before, after),
      added = subtract(after, before);
    return removed.length || added.length ? [{ kind, removed, added }] : [];
  });
}
