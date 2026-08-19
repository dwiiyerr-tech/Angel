#!/usr/bin/env python3
"""
Retroactive fill reconstruction for Angel dry-run trades.

Dry-run "fills" at the snapshot price. This script pulls the REAL 1-second
price prints from Jupiter's chart API (quote=usd) around each entry/exit
timestamp and recomputes PnL with realistic fills (slippage + latency drift),
then subtracts known fees + priority/tip. Read-only: never touches the running
bot, never sends a transaction, never spends capital.

The only cost it CANNOT model is whether your tx actually lands (tip sufficiency
/ MEV) — that is irreducibly live.

Usage: python3 scripts/fill_reconstruct.py [--days 7] [--limit N] [--latency 2]
"""
import sqlite3, json, time, argparse, urllib.request, urllib.error, os
from statistics import median

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DB = os.path.join(PROJECT_ROOT, "angel.sqlite")
CHART = "https://datapi.jup.ag/v2/charts/{mint}?interval=1_SECOND&to={to_ms}&candles=90&type=price&quote=usd"

# ---- friction knobs (analytic grid applied after fills are fetched) ----
LATENCIES_S   = [0, 1, 2, 4]          # seconds between signal and fill
FEE_PCT_SIDE  = [0.0025, 0.005, 0.010] # AMM/LP+platform fee per side (0.25% / 0.5% / 1%)
TIP_SOL_TX    = [0.0005, 0.001, 0.002] # priority fee + jito tip per tx (SOL)

REQ_DELAY = 0.18
HEADERS = {"Accept": "application/json", "User-Agent": "angel-fill-recon/1.0"}

def http_get(url, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=12) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(1.5 * (i + 1)); continue
            return None
        except Exception:
            time.sleep(0.4); continue
    return None

_cache = {}
def candles_near(mint, event_ms):
    key = (mint, round(event_ms / 1000))
    if key in _cache: return _cache[key]
    data = http_get(CHART.format(mint=mint, to_ms=event_ms + 15000))
    time.sleep(REQ_DELAY)
    c = (data or {}).get("candles") or []
    pts = sorted(((int(x["time"]), float(x["close"])) for x in c if x.get("close")), key=lambda z: z[0])
    _cache[key] = pts
    return pts

def price_at(pts, target_s):
    """first print at or after target_s; fallback to last print <= target; else None"""
    after = [p for p in pts if p[0] >= target_s]
    if after: return after[0][1]
    before = [p for p in pts if p[0] < target_s]
    return before[-1][1] if before else None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); db.row_factory = sqlite3.Row
    rows = db.execute(f"""
      SELECT id, mint, opened_at_ms, closed_at_ms, entry_price, exit_price,
             size_sol, pnl_percent, pnl_sol,
             CAST(json_extract(snapshot_json,'$.candidate.metrics.liquidityUsd') AS REAL) liq,
             CAST(json_extract(snapshot_json,'$.candidate.metrics.marketCapUsd') AS REAL) mc
      FROM dry_run_positions
      WHERE status='closed'
        AND opened_at_ms >= strftime('%s','now','-{args.days} days')*1000
        AND json_extract(snapshot_json,'$.candidate.signals.route')='pumpportal_graduated'
        AND entry_price > 0 AND exit_price > 0
      ORDER BY opened_at_ms DESC
    """).fetchall()
    rows = [r for r in rows if r["mc"] and r["liq"] and r["mc"] > 0 and r["liq"]/r["mc"] >= 0.30]
    if args.limit: rows = rows[:args.limit]
    print(f"scope: {len(rows)} positions (ppg & liq_ratio>=0.30, last {args.days}d)\n")

    recs, no_data = [], 0
    for i, r in enumerate(rows):
        ent = candles_near(r["mint"], r["opened_at_ms"])
        ext = candles_near(r["mint"], r["closed_at_ms"]) if r["closed_at_ms"] else []
        if not ent or not ext:
            no_data += 1
            continue
        e_s = r["opened_at_ms"] / 1000; x_s = r["closed_at_ms"] / 1000
        rec = {"size": r["size_sol"], "paper_entry": r["entry_price"], "paper_exit": r["exit_price"],
               "paper_pnl_sol": r["pnl_sol"], "paper_pnl_pct": r["pnl_percent"],
               "mkt_entry": price_at(ent, e_s), "mkt_exit": price_at(ext, x_s),
               "entry_fill": {}, "exit_fill": {}}
        for L in LATENCIES_S:
            rec["entry_fill"][L] = price_at(ent, e_s + L)
            rec["exit_fill"][L]  = price_at(ext, x_s + L)
        recs.append(rec)
        if (i + 1) % 50 == 0:
            print(f"  ...{i+1}/{len(rows)} fetched")

    n = len(recs)
    print(f"\nreconstructed: {n}   (no chart data: {no_data})\n")
    if not n: return

    # --- headline: paper vs market-at-signal (latency 0), no fee, size-normalized to 0.1 ---
    def norm(v, size): return v * (0.1 / size) if size else 0.0
    paper_tot = sum(norm(r["paper_pnl_sol"], r["size"]) for r in recs)

    # entry/exit slippage distribution at each latency (vs paper price)
    print("=== ENTRY latency drift (real fill vs paper entry price; + = you pay MORE) ===")
    for L in LATENCIES_S:
        sl = [(r["entry_fill"][L] / r["paper_entry"] - 1) * 100 for r in recs if r["entry_fill"][L]]
        sl.sort()
        print(f"  +{L}s: median {median(sl):+5.1f}%   p90 {sl[int(0.9*len(sl))]:+6.1f}%   mean {sum(sl)/len(sl):+5.1f}%")
    print("\n=== EXIT latency drift (real fill vs paper exit price; - = you get LESS) ===")
    for L in LATENCIES_S:
        sl = [(r["exit_fill"][L] / r["paper_exit"] - 1) * 100 for r in recs if r["exit_fill"][L]]
        sl.sort()
        print(f"  +{L}s: median {median(sl):+5.1f}%   p10 {sl[int(0.1*len(sl))]:+6.1f}%   mean {sum(sl)/len(sl):+5.1f}%")

    # --- reconstructed net PnL grid (size-normalized to 0.1 SOL each) ---
    print(f"\n=== RECONSTRUCTED NET PnL  (size-normalized to 0.1 SOL/trade; n={n}) ===")
    print(f"PAPER baseline (as recorded): {paper_tot:+.2f} SOL\n")
    print(f"{'latency':>7} {'fee/side':>9} {'tip/tx':>8} {'net_SOL':>9} {'vs_paper':>9} {'win%':>6} {'mSOL/trd':>9}")
    for L in LATENCIES_S:
        for fee in FEE_PCT_SIDE:
            for tip in TIP_SOL_TX:
                tot = 0.0; wins = 0; used = 0
                for r in recs:
                    ef = r["entry_fill"][L]; xf = r["exit_fill"][L]
                    if not ef or not xf: continue
                    used += 1
                    gross = xf / ef - 1.0
                    net_pct = gross - 2 * fee
                    pos = 0.1
                    net_sol = pos * net_pct - 2 * tip     # tip is absolute SOL per tx
                    tot += net_sol
                    if net_sol > 0: wins += 1
                if used:
                    print(f"{L:>6}s {fee*100:>7.2f}% {tip:>8.4f} {tot:>+9.2f} {tot-paper_tot:>+9.2f} {100*wins/used:>5.1f}% {tot/used*1000:>+8.1f}")
    # persist per-trade for inspection
    out_dir = os.path.join(PROJECT_ROOT, "reports")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "fill_recon.json")
    with open(out, "w") as f:
        json.dump({"n": n, "paper_norm_sol": paper_tot,
                   "trades": [{"size": r["size"], "paper_entry": r["paper_entry"], "paper_exit": r["paper_exit"],
                               "mkt_entry": r["mkt_entry"], "mkt_exit": r["mkt_exit"],
                               "entry_fill": r["entry_fill"], "exit_fill": r["exit_fill"],
                               "paper_pnl_sol": r["paper_pnl_sol"]} for r in recs]}, f)
    print(f"\nper-trade detail -> {out}")

if __name__ == "__main__":
    main()
