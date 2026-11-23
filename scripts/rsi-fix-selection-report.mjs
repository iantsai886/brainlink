export function formatCoveragePercent(hits, total) {
  if (!Number.isInteger(hits) || !Number.isInteger(total) || total < 1 || hits < 0 || hits > total) {
    throw new RangeError('Coverage requires integer hits between zero and a positive total.');
  }
  return `${((hits / total) * 100).toFixed(1)}%`;
}
