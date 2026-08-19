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

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalSec = Math.floor(n / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function shortMint(mint) {
  if (!mint || typeof mint !== 'string') return '—';
  if (mint.length <= 10) return mint;
  return `${mint.slice(0, 6)}…${mint.slice(-4)}`;
}

function pickAccent(pnlSol) {
  const n = Number(pnlSol);
  if (!Number.isFinite(n) || n === 0) return NEUTRAL;
  return n > 0 ? PROFIT : LOSS;
}

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

function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1a1a2e');
  grad.addColorStop(1, '#16213e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // subtle radial glow top-right
  const glow = ctx.createRadialGradient(W * 0.85, 0, 20, W * 0.85, 0, 320);
  glow.addColorStop(0, 'rgba(91, 140, 255, 0.10)');
  glow.addColorStop(1, 'rgba(91, 140, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function drawHeader(ctx, position, accent) {
  // CLOSED badge
  const badgeX = 32;
  const badgeY = 28;
  const badgeH = 26;
  ctx.font = 'bold 12px sans-serif';
  const badgeText = 'CLOSED';
  const badgeW = ctx.measureText(badgeText).width + 20;
  ctx.fillStyle = accent === NEUTRAL ? 'rgba(138, 147, 176, 0.18)' : `${accent}26`;
  roundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 6);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(badgeText, badgeX + 10, badgeY + badgeH / 2 + 1);

  // exit reason pill
  const reason = String(position.exit_reason || position.exitReason || 'EXIT');
  ctx.font = '600 11px sans-serif';
  const reasonW = ctx.measureText(reason).width + 16;
  const reasonX = badgeX + badgeW + 8;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  roundedRect(ctx, reasonX, badgeY, reasonW, badgeH, 6);
  ctx.fill();
  ctx.fillStyle = '#c8cee0';
  ctx.fillText(reason, reasonX + 8, badgeY + badgeH / 2 + 1);

  // token symbol (right-aligned)
  ctx.font = 'bold 28px sans-serif';
  const symbol = String(position.symbol || shortMint(position.mint)).toUpperCase();
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(symbol, W - 32, 56);

  // mint subtitle
  ctx.font = '11px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'right';
  ctx.fillText(shortMint(position.mint), W - 32, 72);
}

function drawDivider(ctx, y) {
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(32, y);
  ctx.lineTo(W - 32, y);
  ctx.stroke();
}

function drawColumns(ctx, position) {
  const columns = [
    { label: 'DEPOSITED', value: `${fmtSol(position.size_sol)} SOL` },
    {
      label: 'PNL',
      value: `${fmtPct(position.pnl_percent ?? position.pnlPercent)}`,
      sub: `${fmtSol(position.pnl_sol ?? position.pnlSol)} SOL`,
      accent: pickAccent(position.pnl_sol ?? position.pnlSol),
    },
    {
      label: 'DURATION',
      value: fmtDuration((position.closed_at_ms ?? Date.now()) - position.opened_at_ms),
    },
  ];

  const padX = 32;
  const colW = (W - padX * 2) / columns.length;
  const y = 108;

  columns.forEach((col, i) => {
    const x = padX + colW * i + colW / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 10px sans-serif';
    ctx.fillStyle = LABEL;
    ctx.fillText(col.label, x, y);

    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = col.accent || TEXT;
    ctx.fillText(col.value, x, y + 36);

    if (col.sub) {
      ctx.font = '600 12px sans-serif';
      ctx.fillStyle = col.accent || LABEL;
      ctx.fillText(col.sub, x, y + 56);
    }
  });

  // column dividers
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  for (let i = 1; i < columns.length; i++) {
    const x = padX + colW * i;
    ctx.beginPath();
    ctx.moveTo(x, y + 6);
    ctx.lineTo(x, y + 64);
    ctx.stroke();
  }
}

function drawSummary(ctx, position, accent) {
  const panelX = 32;
  const panelY = 200;
  const panelW = W - panelX * 2;
  const panelH = 158;
  ctx.fillStyle = PANEL;
  roundedRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.fill();
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // lock icon
  const iconX = panelX + 24;
  const iconY = panelY + 24;
  drawLockIcon(ctx, iconX, iconY, accent);

  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('POSITION SUMMARY', iconX + 36, iconY + 12);

  // right side: outcome label
  const pnlSol = Number(position.pnl_sol ?? position.pnlSol);
  const outcome = !Number.isFinite(pnlSol) || pnlSol === 0 ? 'BREAK-EVEN' : pnlSol > 0 ? 'PROFIT' : 'LOSS';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  ctx.fillText(outcome, panelX + panelW - 24, iconY + 12);

  // stats grid 2x2
  const stats = [
    { label: 'Entry mcap', value: fmtUsd(position.entry_mcap) },
    { label: 'Exit mcap', value: fmtUsd(position.exit_mcap) },
    { label: 'Strategy', value: String(position.strategy_id || 'sniper').toUpperCase() },
    { label: 'Mode', value: String(position.execution_mode || 'dry_run').toUpperCase() },
  ];
  const gridX = panelX + 24;
  const gridY = panelY + 64;
  const cellW = (panelW - 48) / 2;
  const cellH = 38;

  stats.forEach((stat, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = gridX + col * cellW;
    const y = gridY + row * cellH;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 10px sans-serif';
    ctx.fillStyle = LABEL;
    ctx.fillText(stat.label, x, y);
    ctx.font = '600 14px sans-serif';
    ctx.fillStyle = TEXT;
    ctx.fillText(stat.value, x, y + 18);
  });
}

function drawLockIcon(ctx, x, y, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  // shackle
  ctx.beginPath();
  ctx.arc(x + 8, y + 4, 5, Math.PI, 0);
  ctx.lineTo(x + 16, y + 4);
  ctx.stroke();
  // body
  roundedRect(ctx, x, y + 8, 16, 12, 2);
  ctx.fill();
  ctx.restore();
}

function drawFooter(ctx, position) {
  ctx.font = '10px sans-serif';
  ctx.fillStyle = DIM;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const opened = position.opened_at_ms ? new Date(position.opened_at_ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—';
  ctx.fillText(`Opened: ${opened}`, 32, H - 22);

  ctx.textAlign = 'right';
  const closed = position.closed_at_ms ? new Date(position.closed_at_ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '—';
  ctx.fillText(`Closed: ${closed}`, W - 32, H - 22);

  // center brand
  ctx.textAlign = 'center';
  ctx.fillStyle = '#3f4660';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText('ANGEL', W / 2, H - 22);
}

export async function generateExitCard(position) {
  if (!position || typeof position !== 'object') {
    throw new Error('generateExitCard: position object is required');
  }
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';
  ctx.patternQuality = 'bilinear';
  ctx.quality = 'bilinear';

  const accent = pickAccent(position.pnl_sol ?? position.pnlSol);

  drawBackground(ctx);
  drawHeader(ctx, position, accent);
  drawDivider(ctx, 92);
  drawColumns(ctx, position);
  drawDivider(ctx, 184);
  drawSummary(ctx, position, accent);
  drawFooter(ctx, position);

  return canvas.toBuffer('image/png');
}

export default generateExitCard;
