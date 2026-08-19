import { createCanvas } from 'canvas';

const W = 800;
const H = 600;
const PROFIT = '#00d4aa';
const LOSS = '#ff4757';
const NEUTRAL = '#8a93b0';
const LABEL = '#8a93b0';
const TEXT = '#e8ecf4';
const DIM = '#5a627d';
const PANEL = 'rgba(255, 255, 255, 0.04)';
const PANEL_BORDER = 'rgba(255, 255, 255, 0.06)';
const ACCENT = '#5b8cff';
const CARD_BG = '#0f3460';

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fmtSol(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)}`;
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `1:${n.toFixed(2)}`;
}

function fmtDate(value) {
  if (!value) {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function pickAccent(solValue) {
  const n = Number(solValue);
  if (!Number.isFinite(n) || n === 0) return NEUTRAL;
  return n > 0 ? PROFIT : LOSS;
}

// Normalize the report — accept either the spec shape (date, totalTrades, pnlSol,
// bestTrade) or the dailyAggregate() shape (total, totalSol, best, worst, rows).
function normalizeReport(report) {
  const best = report.bestTrade || report.best || null;
  const worst = report.worstTrade || report.worst || null;
  const positions = Array.isArray(report.positions) ? report.positions
    : Array.isArray(report.rows) ? report.rows : [];
  return {
    date: fmtDate(report.date),
    totalTrades: Number(report.totalTrades ?? report.total ?? positions.length ?? 0),
    wins: Number(report.wins ?? 0),
    losses: Number(report.losses ?? 0),
    winRate: Number(report.winRate ?? 0),
    pnlSol: Number(report.pnlSol ?? report.totalSol ?? 0),
    pnlPercent: Number(report.pnlPercent ?? 0),
    bestTrade: best ? {
      pnlPercent: Number(best.pnlPercent ?? 0),
      symbol: String(best.symbol || best.mint || '—'),
    } : null,
    worstTrade: worst ? {
      pnlPercent: Number(worst.pnlPercent ?? 0),
      symbol: String(worst.symbol || worst.mint || '—'),
    } : null,
    avgWin: Number(report.avgWin ?? 0),
    avgLoss: Number(report.avgLoss ?? 0),
    riskReward: Number(report.riskReward ?? 0),
    positions,
    strategy: report.strategy || report.strategyId || 'sniper',
  };
}

function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a1a2e');
  grad.addColorStop(1, '#16213e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W * 0.85, 0, 20, W * 0.85, 0, 320);
  glow.addColorStop(0, 'rgba(91, 140, 255, 0.10)');
  glow.addColorStop(1, 'rgba(91, 140, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawHeader(ctx, report) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.fillText('ANGEL DAILY PNL', 32, 50);

  // date pill on right
  ctx.font = '600 13px sans-serif';
  const dateText = report.date;
  const dateW = ctx.measureText(dateText).width + 20;
  const dateX = W - 32 - dateW;
  const dateY = 32;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  roundedRect(ctx, dateX, dateY, dateW, 26, 6);
  ctx.fill();
  ctx.fillStyle = '#c8cee0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(dateText, dateX + dateW / 2, dateY + 14);

  // brand subtitle
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 10px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText('SOLANA · SNIPER BOT', 32, 70);
}

function drawDivider(ctx, y) {
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, y);
  ctx.lineTo(W - 32, y);
  ctx.stroke();
}

function drawPnlHero(ctx, report) {
  const accent = pickAccent(report.pnlSol);
  const panelX = 32;
  const panelY = 90;
  const panelW = W - 64;
  const panelH = 180;
  ctx.fillStyle = PANEL;
  roundedRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // accent stripe on left
  ctx.fillStyle = accent === NEUTRAL ? 'rgba(138, 147, 176, 0.35)' : `${accent}55`;
  roundedRect(ctx, panelX, panelY, 4, panelH, 2);
  ctx.fill();

  // label
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 11px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText('TOTAL PNL', panelX + 24, panelY + 30);

  // big SOL number
  ctx.font = 'bold 64px sans-serif';
  ctx.fillStyle = accent;
  ctx.textAlign = 'center';
  const pnlText = `${fmtSol(report.pnlSol)} SOL`;
  ctx.fillText(pnlText, W / 2, panelY + 96);

  // percentage below
  ctx.font = '600 18px sans-serif';
  ctx.fillStyle = accent;
  const pctText = fmtPct(report.pnlPercent);
  ctx.fillText(pctText, W / 2, panelY + 128);

  // outcome pill
  const outcome = !Number.isFinite(report.pnlSol) || report.pnlSol === 0
    ? 'BREAK-EVEN'
    : report.pnlSol > 0 ? 'PROFIT' : 'LOSS';
  ctx.font = 'bold 11px sans-serif';
  const outcomeW = ctx.measureText(outcome).width + 18;
  const outcomeX = W - 24 - outcomeW;
  const outcomeY = panelY + 18;
  ctx.fillStyle = accent === NEUTRAL ? 'rgba(138, 147, 176, 0.18)' : `${accent}26`;
  roundedRect(ctx, outcomeX, outcomeY, outcomeW, 22, 5);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(outcome, outcomeX + outcomeW / 2, outcomeY + 12);
}

function drawStatBlock(ctx, x, y, w, h, label, value, sub, valueColor) {
  ctx.fillStyle = PANEL;
  roundedRect(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 10px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText(label, x + 14, y + 20);

  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = valueColor || TEXT;
  ctx.fillText(value, x + 14, y + 50);

  if (sub) {
    ctx.font = '600 11px sans-serif';
    ctx.fillStyle = valueColor || DIM;
    ctx.fillText(sub, x + 14, y + 70);
  }
}

function drawStats(ctx, report) {
  const y = 290;
  const h = 90;
  const gap = 14;
  const colW = (W - 64 - gap * 3) / 4;
  const x0 = 32;

  // left column
  drawStatBlock(
    ctx, x0, y, colW, h,
    'TOTAL TRADES',
    String(report.totalTrades),
    `${report.wins}W · ${report.losses}L`,
  );

  drawStatBlock(
    ctx, x0 + colW + gap, y, colW, h,
    'WIN RATE',
    `${report.winRate.toFixed(1)}%`,
    `${report.wins}/${report.totalTrades || 0}`,
    report.winRate >= 50 ? PROFIT : report.winRate >= 40 ? NEUTRAL : LOSS,
  );

  drawStatBlock(
    ctx, x0 + (colW + gap) * 2, y, colW, h,
    'BEST TRADE',
    report.bestTrade ? fmtPct(report.bestTrade.pnlPercent) : '—',
    report.bestTrade ? String(report.bestTrade.symbol).toUpperCase() : '—',
    report.bestTrade ? PROFIT : DIM,
  );

  drawStatBlock(
    ctx, x0 + (colW + gap) * 3, y, colW, h,
    'WORST TRADE',
    report.worstTrade ? fmtPct(report.worstTrade.pnlPercent) : '—',
    report.worstTrade ? String(report.worstTrade.symbol).toUpperCase() : '—',
    report.worstTrade ? LOSS : DIM,
  );

  // second row
  const y2 = y + h + 12;
  const halfW = (W - 64 - gap) / 2;

  drawStatBlock(
    ctx, x0, y2, halfW, h,
    'AVG WIN',
    fmtPct(report.avgWin),
    'Per winning trade',
    PROFIT,
  );

  drawStatBlock(
    ctx, x0 + halfW + gap, y2, halfW, h,
    'AVG LOSS',
    fmtPct(report.avgLoss),
    'Per losing trade',
    LOSS,
  );

  // risk/reward small inline (placed inside avg loss panel space wouldn't fit; add a small chip on right of avg loss)
  // Use a small label below to keep parity with the spec's three right-column items.
  // We'll display risk/reward as a small line below the second row.
  const rrY = y2 + h + 24;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 10px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText('RISK / REWARD', W - 32, rrY);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = report.riskReward >= 1 ? PROFIT : LOSS;
  ctx.fillText(fmtRatio(report.riskReward), W - 32, rrY + 22);

  ctx.textAlign = 'left';
  ctx.fillStyle = LABEL;
  ctx.font = '600 10px sans-serif';
  ctx.fillText('VOLUME', 32, rrY);
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.fillText(`${report.totalTrades} trades`, 32, rrY + 22);
}

function drawBarChart(ctx, report) {
  const positions = report.positions || [];
  // last 20 trades
  const last20 = positions.slice(0, 20);
  if (!last20.length) return;

  const panelX = 32;
  const panelY = 488;
  const panelW = W - 64;
  const panelH = 78;
  ctx.fillStyle = PANEL;
  roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 9px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText('LAST 20 TRADES', panelX + 12, panelY + 14);

  // bars
  const barAreaX = panelX + 12;
  const barAreaY = panelY + 20;
  const barAreaW = panelW - 24;
  const barAreaH = panelH - 30;
  const barGap = 3;
  const barW = (barAreaW - barGap * (last20.length - 1)) / last20.length;
  const midY = barAreaY + barAreaH / 2;

  // find max abs for scaling
  let maxAbs = 0;
  for (const p of last20) {
    const v = Math.abs(Number(p.pnlPercent || 0));
    if (v > maxAbs) maxAbs = v;
  }
  if (maxAbs === 0) maxAbs = 1;

  for (let i = 0; i < last20.length; i++) {
    const p = last20[i];
    const v = Number(p.pnlPercent || 0);
    const x = barAreaX + i * (barW + barGap);
    const h = Math.max(2, (Math.abs(v) / maxAbs) * (barAreaH / 2 - 2));
    const isUp = v >= 0;
    ctx.fillStyle = isUp ? PROFIT : LOSS;
    if (isUp) {
      ctx.fillRect(x, midY - h, barW, h);
    } else {
      ctx.fillRect(x, midY, barW, h);
    }
  }

  // midline
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + 8, midY);
  ctx.lineTo(panelX + panelW - 8, midY);
  ctx.stroke();

  // legend
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 9px sans-serif';
  ctx.fillStyle = DIM;
  ctx.fillText(`${last20.length} trades · up green / down red`, panelX + panelW - 12, panelY + 14);
}

function drawFooter(ctx, report) {
  ctx.font = '10px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const strategy = String(report.strategy || 'sniper').toUpperCase();
  ctx.fillText(`Strategy: ${strategy}`, 32, H - 16);

  ctx.textAlign = 'right';
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  ctx.fillText(`Report generated ${ts}`, W - 32, H - 16);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#3f4660';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText('ANGEL', W / 2, H - 16);
}

export async function generateDailyCard(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('generateDailyCard: report object is required');
  }
  const data = normalizeReport(report);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';
  ctx.patternQuality = 'bilinear';
  ctx.quality = 'bilinear';

  drawBackground(ctx);
  drawHeader(ctx, data);
  drawDivider(ctx, 80);
  drawPnlHero(ctx, data);
  drawStats(ctx, data);
  drawBarChart(ctx, data);
  drawFooter(ctx, data);

  return canvas.toBuffer('image/png');
}

export default generateDailyCard;
