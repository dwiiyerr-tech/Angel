import { db } from '../db/connection.js';
import { now, safeJson } from '../utils.js';
import { validateDryRunRows } from './dataQuality.js';
import { DRY_RUN_SIMULATOR_VERSION } from './simulatorVersion.js';

function positionSnapshotCandidate(position) {
  return safeJson(position.snapshot_json, {})?.candidate || {};
}

const FEATURE_READERS = {
  entryMcapUsd: candidate => candidate.metrics?.marketCapUsd,
  liquidityUsd: candidate => candidate.metrics?.liquidityUsd,
  holderCount: candidate => candidate.metrics?.holderCount,
  botHoldersPct: candidate => candidate.jupiterAsset?.audit?.botHoldersPercentage,
  topHoldersPct: candidate => candidate.jupiterAsset?.audit?.topHoldersPercentage,
  traders5m: candidate => candidate.jupiterAsset?.stats5m?.numTraders,
  netBuyers5m: candidate => candidate.jupiterAsset?.stats5m?.numNetBuyers,
  preScore: candidate => candidate.filters?.preScore,
  momentumScore: candidate => candidate.filters?.momentumScore,
};

function numericStats(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return { count: 0, mean: null, median: null };
  return {
    count: clean.length,
    mean: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    median: clean[Math.floor(clean.length / 2)],
  };
}

function expectancyStats(closed) {
  const wins = closed.filter(row => Number(row.pnl_percent) > 0);
  const losses = closed.filter(row => Number(row.pnl_percent) <= 0);
  const avgWinPercent = wins.length ? wins.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / wins.length : 0;
  const avgLossPercent = losses.length ? losses.reduce((sum, row) => sum + Number(row.pnl_percent || 0), 0) / losses.length : 0;
  const grossProfitSol = wins.reduce((sum, row) => sum + Math.max(0, Number(row.pnl_sol || 0)), 0);
  const grossLossSol = Math.abs(losses.reduce((sum, row) => sum + Math.min(0, Number(row.pnl_sol || 0)), 0));
  return {
    winRate: closed.length ? wins.length / closed.length : null,
    avgWinPercent: wins.length ? avgWinPercent : null,
    avgLossPercent: losses.length ? avgLossPercent : null,
    expectancyPercent: closed.length ? (wins.length / closed.length) * avgWinPercent + (losses.length / closed.length) * avgLossPercent : null,
    profitFactor: grossLossSol > 0 ? grossProfitSol / grossLossSol : (grossProfitSol > 0 ? Infinity : null),
    grossProfitSol,
    grossLossSol,
  };
}

function lossStreakStats(closed) {
  let current = 0;
  let max = 0;
  for (const row of [...closed].sort((a, b) => Number(a.closed_at_ms || 0) - Number(b.closed_at_ms || 0))) {
    if (Number(row.pnl_percent) <= 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return { current, max };
}

function featureOutcomeEvidence(closed) {
  const evidence = [];
  for (const [feature, read] of Object.entries(FEATURE_READERS)) {
    const winners = numericStats(closed.filter(row => Number(row.pnl_percent) > 0).map(row => read(positionSnapshotCandidate(row))));
    const losers = numericStats(closed.filter(row => Number(row.pnl_percent) <= 0).map(row => read(positionSnapshotCandidate(row))));
    if (winners.count < 5 || losers.count < 5) continue;
    evidence.push({ feature, winners, losers, meanDifference: winners.mean - losers.mean, evidenceOnly: true });
  }
  return evidence;
}

export function summarizeLearningWindow(windowMs) {
  const cutoff = now() - windowMs;
  const positions = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE ((status = 'closed' AND COALESCE(closed_at_ms, opened_at_ms) >= ?)
       OR (status != 'closed' AND opened_at_ms >= ?))
      AND (
        execution_mode = 'dry_run'
        OR (
          execution_mode = 'shadow_live'
          AND json_extract(snapshot_json, '$.shadowLiveCompatible') = 1
          AND json_extract(snapshot_json, '$.entryQuoteMode') = 'position_sized'
          AND json_extract(snapshot_json, '$.simulatorVersion') = ?
        )
      )
    ORDER BY opened_at_ms ASC
  `).all(cutoff, cutoff, DRY_RUN_SIMULATOR_VERSION);
  const closed = positions.filter(position => position.status === 'closed');
  const positionIds = positions.map(position => Number(position.id));
  const trades = positionIds.length
    ? db.prepare(`SELECT position_id, side FROM dry_run_trades WHERE position_id IN (${positionIds.map(() => '?').join(',')})`).all(...positionIds)
    : [];
  const dataQuality = validateDryRunRows(positions, trades, { expectedSimulatorVersion: DRY_RUN_SIMULATOR_VERSION });
  const winners = closed.filter(position => Number(position.pnl_percent || 0) > 0);
  const losers = closed.filter(position => Number(position.pnl_percent || 0) < 0);
  const totalPnlPercent = closed.reduce((sum, position) => sum + Number(position.pnl_percent || 0), 0);
  const totalPnlSol = closed.reduce((sum, position) => sum + Number(position.pnl_sol || 0), 0);
  const expectancy = expectancyStats(closed);
  const lossStreak = lossStreakStats(closed);
  const byRoute = new Map();
  for (const position of closed) {
    const candidate = positionSnapshotCandidate(position);
    const route = safeJson(position.snapshot_json, {})?.signalRoute || candidate.signals?.route || candidate.signals?.label || 'unknown';
    const row = byRoute.get(route) || { route, count: 0, wins: 0, losses: 0, pnlPercent: 0, pnlSol: 0 };
    row.count += 1;
    row.wins += Number(position.pnl_percent || 0) > 0 ? 1 : 0;
    row.losses += Number(position.pnl_percent || 0) < 0 ? 1 : 0;
    row.pnlPercent += Number(position.pnl_percent || 0);
    row.pnlSol += Number(position.pnl_sol || 0);
    byRoute.set(route, row);
  }
  const batches = db.prepare(`
    SELECT verdict, COUNT(*) AS count, AVG(confidence) AS avg_confidence
    FROM llm_batches
    WHERE created_at_ms >= ?
    GROUP BY verdict
  `).all(cutoff);
  const actions = db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM decision_logs
    WHERE at_ms >= ?
    GROUP BY action
    ORDER BY count DESC
  `).all(cutoff);
  const buyFunnel = db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM decision_logs
    WHERE at_ms >= ? AND verdict = 'BUY'
    GROUP BY action
    ORDER BY count DESC
  `).all(cutoff);
  const best = [...closed].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0)).slice(0, 10).map(position => {
    const candidate = positionSnapshotCandidate(position);
    return {
      mint: position.mint,
      symbol: position.symbol,
      pnlPercent: Number(position.pnl_percent || 0),
      exitReason: position.exit_reason,
      entryMcap: position.entry_mcap,
      exitMcap: position.exit_mcap,
      botPct: candidate.jupiterAsset?.audit?.botHoldersPercentage,
      smartMoney: candidate.gmgn?.smart_degen_count,
      momentum: candidate.filters?.momentumScore ?? candidate.signals?.score,
      route: safeJson(position.snapshot_json, {})?.signalRoute || candidate.signals?.route || 'unknown',
    };
  });
  const worst = [...closed].sort((a, b) => Number(a.pnl_percent || 0) - Number(b.pnl_percent || 0)).slice(0, 10).map(position => {
    const candidate = positionSnapshotCandidate(position);
    return {
      mint: position.mint,
      symbol: position.symbol,
      pnlPercent: Number(position.pnl_percent || 0),
      exitReason: position.exit_reason,
      entryMcap: position.entry_mcap,
      exitMcap: position.exit_mcap,
      botPct: candidate.jupiterAsset?.audit?.botHoldersPercentage,
      smartMoney: candidate.gmgn?.smart_degen_count,
      momentum: candidate.filters?.momentumScore ?? candidate.signals?.score,
      route: safeJson(position.snapshot_json, {})?.signalRoute || candidate.signals?.route || 'unknown',
    };
  });
  return {
    windowMs,
    simulatorVersion: DRY_RUN_SIMULATOR_VERSION,
    fromMs: cutoff,
    toMs: now(),
    positions: {
      observed: positions.length,
      opened: positions.filter(position => Number(position.opened_at_ms) >= cutoff).length,
      closed: closed.length,
      open: positions.length - closed.length,
      wins: winners.length,
      losses: losers.length,
      winRate: closed.length ? winners.length / closed.length * 100 : null,
      totalPnlPercent,
      avgPnlPercent: closed.length ? totalPnlPercent / closed.length : null,
      totalPnlSol,
      expectancy,
      lossStreak,
      byRoute: [...byRoute.values()].map(row => ({
        ...row,
        winRate: row.count ? row.wins / row.count * 100 : null,
        avgPnlPercent: row.count ? row.pnlPercent / row.count : null,
      })).sort((a, b) => b.pnlPercent - a.pnlPercent),
      best,
      worst,
    },
    llm: {
      batches,
      actions,
      buyFunnel: {
        totalBuyEvents: buyFunnel.reduce((sum, row) => sum + Number(row.count), 0),
        executedEntries: buyFunnel.filter(row => ['dry_run_entry', 'shadow_live_entry_simulated'].includes(row.action)).reduce((sum, row) => sum + Number(row.count), 0),
        byAction: buyFunnel,
      },
    },
    dataQuality,
    featureOutcomeEvidence: featureOutcomeEvidence(closed),
  };
}
