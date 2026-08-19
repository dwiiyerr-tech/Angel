import { createCanvas } from 'canvas';

const W = 800;
const H = 420;
const PROFIT = '#00d4aa';
const LOSS = '#ff4757';
const NEUTRAL = '#8a93b0';
const LABEL = '#8a93b0';
const TEXT = '#e8ecf4';
const DIM = '#5a627d';
const PANEL = 'rgba(255, 255, 255, 0.04)';
const PANEL_BORDER = 'rgba(255, 255, 255, 0.06)';
const ACCENT = '#5b8cff';

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
  if (!Number.isFinite(n)) return '\u2014';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)}`;
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '\u2014';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '\u2014';
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toExponential(2)}`;
}

function pickAccent(solValue) {
  const n = Number(solValue);
  if (!Number.isFinite(n) || n === 0) return NEUTRAL;
  return n > 0 ? PROFIT : LOSS;
}

function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a1a2e');
  grad.addColorStop(1, '#16213e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawHeader(ctx, position) {
  const symbol = position.symbol || position.mint?.slice(0, 8) || 'UNKNOWN';

  // Token symbol left
  ctx.textBaseline = 'middle';
  ctx.font = '600 22px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.fillText(symbol, 32, 40);

  // ENTRY badge right
  ctx.textAlign = 'right';
  ctx.font = '600 16px sans-serif';
  ctx.fillStyle = PROFIT;
  const entryLabel = position.execution_mode === 'live' ? '\u2705 LIVE ENTRY' : '\u2705 ENTRY';
  ctx.fillText(entryLabel, W - 32, 40);
}

function drawDivider(ctx, y) {
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, y);
  ctx.lineTo(W - 32, y);
  ctx.stroke();
}

function drawInfoRow(ctx, y, label1, value1, label2, value2) {
  // Panel background
  roundedRect(ctx, 32, y - 14, W - 64, 36, 8);
  ctx.fillStyle = PANEL;
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.font = '11px sans-serif';

  // Column 1
  ctx.textAlign = 'left';
  ctx.fillStyle = LABEL;
  ctx.fillText(label1, 48, y);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.font = '600 13px sans-serif';
  ctx.fillText(value1, 48, y + 16);

  // Column 2
  ctx.textAlign = 'right';
  ctx.font = '11px sans-serif';
  ctx.fillStyle = LABEL;
  ctx.fillText(label2, W - 48, y);
  ctx.textAlign = 'right';
  ctx.font = '600 13px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.fillText(value2, W - 48, y + 16);
}

function drawColumns(ctx, position) {
  let snap = null;
  try {
    snap = JSON.parse(position.snapshot_json || '{}');
  } catch { /* ignore */ }

  const candidate = snap?.candidate || {};
  const metrics = candidate.metrics || {};
  const signals = candidate.signals || {};

  const mcap = fmtUsd(position.entry_mcap || metrics.marketCapUsd);
  const price = fmtUsd(position.entry_price || metrics.priceUsd);
  const holders = metrics.holderCount ?? '\u2014';
  const liquidity = fmtUsd(metrics.liquidityUsd);
  const size = `${fmtSol(position.size_sol)} SOL`;
  const tp = position.tp_percent ? `${position.tp_percent >= 0 ? '+' : ''}${position.tp_percent}%` : '\u2014';
  const sl = position.sl_percent ? `${position.sl_percent}%` : '\u2014';
  const route = signals.route || 'trenches';

  drawInfoRow(ctx, 110, 'Market Cap', mcap, 'Price', price);
  drawInfoRow(ctx, 158, 'Holders', String(holders), 'Liquidity', liquidity);
  drawInfoRow(ctx, 206, 'Size', size, 'TP', tp);
  drawInfoRow(ctx, 254, 'Route', route, 'SL', sl);
}

function drawSummary(ctx, position) {
  const mode = (position.execution_mode || 'dry_run').toUpperCase();
  const opened = position.opened_at_ms
    ? new Date(position.opened_at_ms).toISOString().slice(0, 19).replace('T', ' ')
    : '\u2014';

  // Summary panel
  const panelX = 80;
  const panelW = W - 160;
  const panelY = 298;
  const panelH = 52;

  roundedRect(ctx, panelX, panelY, panelW, panelH, 10);
  ctx.fillStyle = PANEL;
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Mode badge left
  ctx.textBaseline = 'middle';
  ctx.font = '600 14px sans-serif';
  ctx.fillStyle = PROFIT;
  ctx.textAlign = 'center';
  ctx.fillText(mode, W / 2, panelY + 18);

  // Timestamp
  ctx.font = '10px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'center';
  ctx.fillText(opened, W / 2, panelY + 36);
}

function drawFooter(ctx, position) {
  const mint = position.mint?.slice(0, 16) || '\u2014';

  ctx.textBaseline = 'alphabetic';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'left';
  ctx.fillText(`${mint}...`, 32, H - 18);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#3f4660';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText('ANGEL', W / 2, H - 18);

  ctx.textAlign = 'right';
  ctx.font = '10px sans-serif';
  ctx.fillStyle = DIM;
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  ctx.fillText(ts, W - 32, H - 18);
}

export async function generateEntryCard(position) {
  if (!position || typeof position !== 'object') {
    throw new Error('generateEntryCard: position object is required');
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';
  ctx.patternQuality = 'bilinear';
  ctx.quality = 'bilinear';

  drawBackground(ctx);
  drawHeader(ctx, position);
  drawDivider(ctx, 80);
  drawColumns(ctx, position);
  drawDivider(ctx, 280);
  drawSummary(ctx, position);
  drawFooter(ctx, position);

  return canvas.toBuffer('image/png');
}

export default generateEntryCard;
