/** Match structured revert evidence only; never infer a retry from free-form text. */
export function isFillOrKillNotFillable(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<object>();
  for (let depth = 0; pending.length && depth < 32; depth++) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (/^0xc04ad919$/i.test(value)) return true;
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.errorName === 'FillOrKillNotFillable') return true;
    pending.push(record.cause, record.data);
  }
  return false;
}
