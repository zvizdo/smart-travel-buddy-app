export function setsEqual<T>(
  a: Set<T> | null | undefined,
  b: Set<T> | null | undefined,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
