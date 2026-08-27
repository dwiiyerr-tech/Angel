function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function pathLabelsFromObservations(observations = [], {
  openedAtMs = null,
  levels = [1, 2, 3, 5],
  failureR = 1,
} = {}) {
  const path = observations
    .map(row => ({ atMs: finite(row?.atMs ?? row?.at_ms), r: finite(row?.r ?? row?.r_multiple) }))
    .filter(row => row.atMs != null && row.r != null)
    .sort((a, b) => a.atMs - b.atMs);
  if (!path.length) return { version: 'path-labels-v1', runnerClass: 'unknown', observed: false, levels: {} };
  const opened = finite(openedAtMs) ?? path[0].atMs;
  const failureBoundary = -Math.abs(Number(failureR) || 1);
  const firstFailure = path.find(row => row.r <= failureBoundary) || null;
  const levelLabels = {};
  for (const rawLevel of levels) {
    const level = Math.abs(Number(rawLevel));
    const reached = path.find(row => row.r >= level) || null;
    levelLabels[`${level}R`] = {
      reached: Boolean(reached),
      atMs: reached?.atMs ?? null,
      timeMs: reached ? reached.atMs - opened : null,
      beforeFailure: Boolean(reached && (!firstFailure || reached.atMs < firstFailure.atMs)),
    };
  }
  const maxR = Math.max(...path.map(row => row.r));
  const minR = Math.min(...path.map(row => row.r));
  const highest = [...levels].map(Number).sort((a, b) => b - a)
    .find(level => levelLabels[`${level}R`]?.beforeFailure) || 0;
  const runnerClass = highest >= 5 ? 'runner_5r'
    : highest >= 3 ? 'runner_3r'
      : highest >= 2 ? 'runner_2r'
        : highest >= 1 ? 'runner_1r'
          : firstFailure ? 'failed' : 'non_runner';
  return {
    version: 'path-labels-v1', observed: true, runnerClass,
    maxR, minR, failureBoundary, firstFailureAtMs: firstFailure?.atMs ?? null,
    levels: levelLabels,
  };
}

