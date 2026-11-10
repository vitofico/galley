/**
 * Replace a `Y.Text`'s content with `target` using the MINIMAL differing edit
 * (shared prefix + shared suffix preserved), inside the given `Y.Text` directly.
 * Must be called inside a transaction. Replacing only the middle span (rather
 * than clobbering the whole text) lets a disjoint concurrent edit merge.
 */
export function applyMinimalDiff(text: import("yjs").Text, target: string): void {
  const current = text.toString();
  if (current === target) return;
  let prefix = 0;
  while (prefix < current.length && prefix < target.length && current[prefix] === target[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < target.length - prefix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const deleteLen = current.length - prefix - suffix;
  const insert = target.slice(prefix, target.length - suffix);
  if (deleteLen > 0) text.delete(prefix, deleteLen);
  if (insert.length > 0) text.insert(prefix, insert);
}

