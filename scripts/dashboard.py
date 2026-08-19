#!/usr/bin/env python3
"""Angel HTML dashboard — mobile-friendly, Chart.js, auto-refresh."""
import sqlite3, json, time, os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DB = os.path.join(PROJECT_ROOT, "angel.sqlite")
REFRESH_SEC = 30
# Audit started: 2026-07-05 19:21:19 UTC (when LLM was disabled)
AUDIT_START_MS = 1783250479272


def q(sql, params=()):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(sql, params)]
    conn.close()
    return rows


def pnl_data():
    now_ms = int(time.time() * 1000)
    day = 86400000
    results = {}
    for label, cutoff in [("24h", now_ms - day), ("7d", now_ms - 7 * day), ("audit", AUDIT_START_MS)]:
        r = q("""SELECT COUNT(*) as total, ROUND(AVG(pnl_sol),4) as avg_pnl,
            ROUND(SUM(pnl_sol),4) as total_pnl,
            SUM(CASE WHEN exit_reason='TRAILING_TP' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN exit_reason='SL' THEN 1 ELSE 0 END) as losses
        FROM dry_run_positions WHERE status='closed' AND closed_at_ms > ?""", (cutoff,))
        if r and r[0]["total"]:
            d = r[0]
            d["wr"] = round(100 * d["wins"] / max(d["wins"] + d["losses"], 1), 1)
            results[label] = d
    return results


HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>Angel Monitor</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px;max-width:100vw;overflow-x:hidden}
h1{font-size:18px;margin-bottom:12px;color:#58a6ff}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;text-align:center}
.card .label{font-size:11px;color:#8b949e;text-transform:uppercase}
.card .value{font-size:24px;font-weight:700;margin-top:4px}
.card .sub{font-size:11px;color:#8b949e;margin-top:2px}
.green{color:#3fb950}
.red{color:#f85149}
.orange{color:#d2991d}
.blue{color:#58a6ff}
.chart-box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin-bottom:12px}
.chart-box h2{font-size:14px;margin-bottom:8px;color:#8b949e}
canvas{max-height:300px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:8px 6px;border-bottom:1px solid #30363d;color:#8b949e;font-weight:500}
td{padding:6px;border-bottom:1px solid #21262d}
tr:hover{background:#1c2128}
.refresh{font-size:11px;color:#484f58;text-align:center;margin-top:12px}
.pnl-positive{color:#3fb950}
.pnl-negative{color:#f85149}
</style>
</head>
<body>
<h1>🛶 Angel Audit Monitor</h1>
<div class="stats" id="stats"></div>
<div class="chart-box"><h2>PnL Timeline (since LLM off)</h2><canvas id="pnlChart"></canvas></div>
<div class="chart-box"><h2>Route PnL (since LLM off)</h2><canvas id="routeChart"></canvas></div>
<div class="chart-box"><h2>Recent Trades</h2><table id="trades"></table></div>
<div class="refresh">Auto-refresh: __REFRESH__s</div>
<script>
const REFRESH = __REFRESH__;
let pnlChart, routeChart;

async function load() {
  const r = await fetch('/api/data');
  const d = await r.json();
  renderStats(d.pnl);
  renderChart(d.timeline);
  renderRoutes(d.routes);
  renderTrades(d.trades);
}

function renderStats(pnl) {
  const d = pnl['24h'] || {};
  const d7 = pnl['7d'] || {};
  const da = pnl['audit'] || {};
  const cl = (v) => v >= 0 ? 'green' : 'red';
  document.getElementById('stats').innerHTML = `
    <div class="card"><div class="label">Total PnL</div><div class="value ${cl(d.total_pnl||0)}">${(d.total_pnl||0).toFixed(3)} SOL</div><div class="sub">24h</div></div>
    <div class="card"><div class="label">Win Rate</div><div class="value ${(d.wr||0)>=50?'green':'orange'}">${d.wr||0}%</div><div class="sub">${d.wins||0}W / ${d.losses||0}L</div></div>
    <div class="card"><div class="label">24h Trades</div><div class="value blue">${d.total||0}</div><div class="sub">avg ${(d.avg_pnl||0).toFixed(4)} SOL</div></div>
    <div class="card"><div class="label">7d PnL</div><div class="value ${cl(d7.total_pnl||0)}">${(d7.total_pnl||0).toFixed(3)} SOL</div><div class="sub">${d7.wins||0}W / ${d7.losses||0}L</div></div>
    <div class="card"><div class="label">Audit PnL</div><div class="value ${cl(da.total_pnl||0)}">${(da.total_pnl||0).toFixed(3)} SOL</div><div class="sub">${da.wins||0}W / ${da.losses||0}L (${da.wr||0}%)</div></div>
    <div class="card"><div class="label">Open</div><div class="value blue">${d.open||0}</div><div class="sub">positions</div></div>
    <div class="card"><div class="label">Candidates</div><div class="value blue">${d.candidates||0}</div><div class="sub">${d.filtered||0} filtered, ${d.buys||0} buys</div></div>
  `;
}

function renderChart(timeline) {
  const labels = timeline.map(t => t.time?.slice(11,16) || '');
  const data = timeline.map(t => t.pnl_sol);
  const colors = data.map(v => v >= 0 ? '#3fb95033' : '#f8514933');
  const borders = data.map(v => v >= 0 ? '#3fb950' : '#f85149');
  if (pnlChart) pnlChart.destroy();
  pnlChart = new Chart(document.getElementById('pnlChart'), {
    type: 'bar',
    data: {labels, datasets: [{data, backgroundColor: colors, borderColor: borders, borderWidth: 1}]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: false}},
      scales: {
        x: {ticks: {color: '#484f58', maxTicksLimit: 20, font: {size: 9}}},
        y: {ticks: {color: '#484f58', callback: v => v.toFixed(2), font: {size: 10}}}
      }
    }
  });
}

function renderRoutes(routes) {
  const labels = routes.map(r => r.route);
  const data = routes.map(r => r.total_pnl);
  const colors = data.map(v => v >= 0 ? '#3fb950' : '#f85149');
  if (routeChart) routeChart.destroy();
  routeChart = new Chart(document.getElementById('routeChart'), {
    type: 'bar',
    data: {labels, datasets: [{data, backgroundColor: colors, borderRadius: 4}]},
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {legend: {display: false}},
      scales: {
        x: {ticks: {color: '#484f58', callback: v => v.toFixed(2), font: {size: 10}}},
        y: {ticks: {color: '#8b949e', font: {size: 10}}}
      }
    }
  });
}

function renderTrades(trades) {
  const rows = trades.slice(0,20).map(t => `
    <tr>
      <td>${t.symbol||'?'}</td>
      <td class="${t.pnl_sol>=0?'pnl-positive':'pnl-negative'}">${(t.pnl_sol||0).toFixed(4)}</td>
      <td>${t.pnl_pct?.toFixed(1)||0}%</td>
      <td>${t.exit_reason||'?'}</td>
      <td style="color:#484f58">${t.closed_at?.slice(5,16)||''}</td>
    </tr>`).join('');
  document.getElementById('trades').innerHTML = `
    <tr><th>Token</th><th>PnL SOL</th><th>%</th><th>Exit</th><th>Time</th></tr>${rows}`;
}

load();
setInterval(load, REFRESH * 1000);
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML.replace("__REFRESH__", str(REFRESH_SEC)).encode())
        elif path == "/api/data":
            try:
                pnl = pnl_data()
                d24 = pnl.get("24h", {})
                # Open positions + candidates
                open_r = q("SELECT COUNT(*) as c FROM dry_run_positions WHERE status='open'")
                cand_r = q("""SELECT COUNT(*) as total,
                    SUM(CASE WHEN status='buy' THEN 1 ELSE 0 END) as buys,
                    SUM(CASE WHEN status='filtered' THEN 1 ELSE 0 END) as filtered
                FROM candidates WHERE created_at_ms > (strftime('%s','now')-86400)*1000""")
                d24["open"] = open_r[0]["c"] if open_r else 0
                if cand_r:
                    d24["candidates"] = cand_r[0]["total"]
                    d24["filtered"] = cand_r[0]["filtered"]
                    d24["buys"] = cand_r[0]["buys"]

                timeline = q("""SELECT datetime(closed_at_ms/1000,'unixepoch','localtime') as time,
                    ROUND(pnl_sol,4) as pnl_sol FROM dry_run_positions
                    WHERE status='closed' AND closed_at_ms >= ?
                    ORDER BY closed_at_ms ASC""", (AUDIT_START_MS,))
                routes = q("""SELECT json_extract(snapshot_json,'$.candidate.signals.route') as route,
                    ROUND(SUM(pnl_sol),4) as total_pnl FROM dry_run_positions
                    WHERE status='closed' AND closed_at_ms >= ?
                    GROUP BY route ORDER BY total_pnl ASC""", (AUDIT_START_MS,))
                trades = q("""SELECT symbol, ROUND(pnl_sol,4) as pnl_sol,
                    ROUND(pnl_percent,1) as pnl_pct, exit_reason,
                    datetime(closed_at_ms/1000,'unixepoch','localtime') as closed_at
                    FROM dry_run_positions WHERE status='closed' AND closed_at_ms >= ?
                    ORDER BY closed_at_ms DESC LIMIT 20""", (AUDIT_START_MS,))

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"pnl": pnl, "timeline": timeline, "routes": routes, "trades": trades}).encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()