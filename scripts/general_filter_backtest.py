#!/usr/bin/env python3
"""General filter: find best UNIVERSAL filters across ALL routes."""

import sqlite3, json, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DB_PATH = os.path.join(PROJECT_ROOT, 'angel.sqlite')

def extract(row):
    cj = json.loads(row['candidate_json']) if row['candidate_json'] else {}
    c = cj.get('candidate', cj)
    ja = c.get('jupiterAsset', {}) or {}
    ho = c.get('holders', {}) or {}
    me = c.get('metrics', {}) or {}
    te = c.get('trenchesEntry', {}) or {}
    si = c.get('signals', {}) or {}
    return {
        'pnl_sol': row['pnl_sol'] or 0,
        'exit': row['exit_reason'] or '',
        'entry_mcap': row['entry_mcap'] or 0,
        'route': row['route'] or 'unknown',
        'ja_bondingCurve': ja.get('bondingCurve', 0) or 0,
        'ja_liquidity': ja.get('liquidity', 0) or 0,
        'ja_mcap': ja.get('mcap', 0) or 0,
        'ja_organicScore': ja.get('organicScore', 0) or 0,
        'ho_count': ho.get('count', 0) or 0,
        'ho_maxHolderPercent': ho.get('maxHolderPercent', 0) or 0,
        'ho_top20Percent': ho.get('top20Percent', 0) or 0,
        'me_gmgnTotalFeesSol': me.get('gmgnTotalFeesSol', 0) or 0,
        'me_liquidityUsd': me.get('liquidityUsd', 0) or 0,
        'me_trendingVolumeUsd': me.get('trendingVolumeUsd', 0) or 0,
        'me_marketCapUsd': me.get('marketCapUsd', 0) or 0,
        'si_hasTrending': 1 if si.get('hasTrending') else 0,
        'ch_distanceFromAth': 0,
        'smart_degen_count': te.get('smart_degen_count', 0) or 0,
        'bot_degen_count': te.get('bot_degen_count', 0) or 0,
        'rug_ratio': te.get('rug_ratio', 0) or 0,
        'fresh_wallet_rate': te.get('fresh_wallet_rate', 0) or 0,
        'dev_team_hold_rate': te.get('dev_team_hold_rate', 0) or 0,
        'volume_24h': te.get('volume_24h', 0) or 0,
    }

def analyze(subset):
    if len(subset) < 10: return None
    n = len(subset)
    wr = sum(1 for d in subset if d['pnl_sol'] > 0) / n * 100
    pnl = sum(d['pnl_sol'] for d in subset)
    sl = sum(1 for d in subset if d['exit'] == 'SL')
    tp = sum(1 for d in subset if d['exit'] == 'TRAILING_TP')
    return n, wr, pnl, sl/n*100, tp/n*100, pnl/n

def main():
    db = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row

    rows = db.execute('''
        SELECT p.pnl_sol, p.pnl_percent, p.exit_reason, p.entry_mcap,
               json_extract(p.snapshot_json, '$.candidate.signals.route') as route,
               c.candidate_json
        FROM dry_run_positions p
        LEFT JOIN candidates c ON p.candidate_id = c.id
        WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL
        ORDER BY p.closed_at_ms
    ''').fetchall()

    data = [extract(r) for r in rows]

    base_n, base_wr, base_pnl, base_sl, base_tp, base_avg = analyze(data)
    print(f"BASELINE: {base_n} trades | {base_wr:.1f}% WR | {base_pnl:+.3f} SOL | SL {base_sl:.1f}% | TP {base_tp:.1f}% | avg {base_avg:+.3f} SOL/trade\n")

    filters = [
        # Mcap
        ("mcap < 20K", lambda d: d['entry_mcap'] < 20000),
        ("mcap 20K-30K", lambda d: 20000 <= d['entry_mcap'] < 30000),
        ("mcap 30K-50K", lambda d: 30000 <= d['entry_mcap'] < 50000),
        ("mcap 50K-100K", lambda d: 50000 <= d['entry_mcap'] < 100000),
        ("mcap 100K+", lambda d: d['entry_mcap'] >= 100000),
        # Liquidity
        ("liq >= 3K", lambda d: d['me_liquidityUsd'] >= 3000),
        ("liq >= 5K", lambda d: d['me_liquidityUsd'] >= 5000),
        ("liq >= 8K", lambda d: d['me_liquidityUsd'] >= 8000),
        ("liq >= 10K", lambda d: d['me_liquidityUsd'] >= 10000),
        ("liq >= 15K", lambda d: d['me_liquidityUsd'] >= 15000),
        # Holders
        ("ho >= 30", lambda d: d['ho_count'] >= 30),
        ("ho >= 50", lambda d: d['ho_count'] >= 50),
        ("ho >= 75", lambda d: d['ho_count'] >= 75),
        ("ho >= 100", lambda d: d['ho_count'] >= 100),
        # Max holder
        ("maxHolder < 30%", lambda d: d['ho_maxHolderPercent'] < 30),
        ("maxHolder < 20%", lambda d: d['ho_maxHolderPercent'] < 20),
        ("maxHolder < 15%", lambda d: d['ho_maxHolderPercent'] < 15),
        ("maxHolder < 10%", lambda d: d['ho_maxHolderPercent'] < 10),
        # Top20
        ("top20 < 50%", lambda d: d['ho_top20Percent'] < 50),
        ("top20 < 40%", lambda d: d['ho_top20Percent'] < 40),
        # Bonding curve
        ("bondingCurve >= 80", lambda d: d['ja_bondingCurve'] >= 80),
        ("bondingCurve >= 85", lambda d: d['ja_bondingCurve'] >= 85),
        ("bondingCurve >= 90", lambda d: d['ja_bondingCurve'] >= 90),
        # Organic
        ("organic >= 50", lambda d: d['ja_organicScore'] >= 50),
        ("organic >= 70", lambda d: d['ja_organicScore'] >= 70),
        # Fees
        ("gmgnFees < 10", lambda d: d['me_gmgnTotalFeesSol'] < 10),
        ("gmgnFees < 5", lambda d: d['me_gmgnTotalFeesSol'] < 5),
        ("gmgnFees < 3", lambda d: d['me_gmgnTotalFeesSol'] < 3),
        # Smart degen
        ("smartDegen >= 5", lambda d: d['smart_degen_count'] >= 5),
        ("smartDegen >= 10", lambda d: d['smart_degen_count'] >= 10),
        # Bot
        ("botDegen < 5", lambda d: d['bot_degen_count'] < 5),
        ("botDegen < 10", lambda d: d['bot_degen_count'] < 10),
        # Trending
        ("NOT trending", lambda d: d['si_hasTrending'] == 0),
        # Volume
        ("volume >= 10K", lambda d: d['me_trendingVolumeUsd'] >= 10000),
        ("volume >= 30K", lambda d: d['me_trendingVolumeUsd'] >= 30000),
        # Route exclusions
        ("NOT trending route", lambda d: d['route'] != 'trending'),
        ("NOT trending + NOT dual_source", lambda d: d['route'] not in ['trending', 'dual_source']),
        ("only pumpportal + pregrad", lambda d: d['route'] in ['pumpportal_graduated', 'pumpfun_pregrad']),
        # Combos
        ("liq>=5K + ho>=50", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50),
        ("liq>=5K + ho>=50 + maxHolder<15%", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 15),
        ("liq>=5K + ho>=50 + bondingCurve>=85", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ja_bondingCurve'] >= 85),
        ("NOT trending + bondingCurve>=80", lambda d: d['si_hasTrending'] == 0 and d['ja_bondingCurve'] >= 80),
        ("NOT trending + bondingCurve>=80 + ho>=50", lambda d: d['si_hasTrending'] == 0 and d['ja_bondingCurve'] >= 80 and d['ho_count'] >= 50),
        ("bondingCurve>=85 + ho>=50", lambda d: d['ja_bondingCurve'] >= 85 and d['ho_count'] >= 50),
        ("bondingCurve>=85 + maxHolder<15%", lambda d: d['ja_bondingCurve'] >= 85 and d['ho_maxHolderPercent'] < 15),
        ("liq>=3K + ho>=50 + maxHolder<20%", lambda d: d['me_liquidityUsd'] >= 3000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 20),
        ("liq>=5K + ho>=50 + maxHolder<20% + bondingCurve>=85", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 20 and d['ja_bondingCurve'] >= 85),
        ("liq>=5K + ho>=50 + maxHolder<20% + NOT trending", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 20 and d['si_hasTrending'] == 0),
        ("liq>=8K + ho>=50 + maxHolder<15%", lambda d: d['me_liquidityUsd'] >= 8000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 15),
        ("liq>=10K + ho>=30 + maxHolder<20%", lambda d: d['me_liquidityUsd'] >= 10000 and d['ho_count'] >= 30 and d['ho_maxHolderPercent'] < 20),
        ("liq>=3K + ho>=30 + maxHolder<30%", lambda d: d['me_liquidityUsd'] >= 3000 and d['ho_count'] >= 30 and d['ho_maxHolderPercent'] < 30),
        # gmgnFees combos
        ("gmgnFees<10 + liq>=5K", lambda d: d['me_gmgnTotalFeesSol'] < 10 and d['me_liquidityUsd'] >= 5000),
        ("gmgnFees<5 + liq>=5K", lambda d: d['me_gmgnTotalFeesSol'] < 5 and d['me_liquidityUsd'] >= 5000),
        ("gmgnFees<10 + ho>=50", lambda d: d['me_gmgnTotalFeesSol'] < 10 and d['ho_count'] >= 50),
        # mcap + combo
        ("mcap 20K-100K + liq>=5K", lambda d: 20000 <= d['entry_mcap'] < 100000 and d['me_liquidityUsd'] >= 5000),
        ("mcap 20K-100K + liq>=5K + ho>=50", lambda d: 20000 <= d['entry_mcap'] < 100000 and d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50),
        ("mcap 20K-100K + liq>=5K + maxHolder<20%", lambda d: 20000 <= d['entry_mcap'] < 100000 and d['me_liquidityUsd'] >= 5000 and d['ho_maxHolderPercent'] < 20),
    ]

    results = []
    for label, fn in filters:
        subset = [d for d in data if fn(d)]
        r = analyze(subset)
        if r is None: continue
        n, wr, pnl, sl, tp, avg = r
        pnl_delta = pnl - base_pnl
        wr_delta = wr - base_wr
        sl_delta = sl - base_sl
        results.append((label, n, wr, pnl, sl, tp, avg, pnl_delta, wr_delta, sl_delta, n/base_n*100))

    results.sort(key=lambda x: x[7], reverse=True)

    print(f"{'Filter':56s} | {'N':>5s} | {'WR':>6s} | {'PnL':>9s} | {'ΔPnL':>8s} | {'SL':>6s} | {'ΔSL':>6s} | {'TP':>6s} | {'%keep':>5s}")
    print("-" * 120)

    for label, n, wr, pnl, sl, tp, avg, pnl_delta, wr_delta, sl_delta, pct_keep in results[:30]:
        print(f"{label:56s} | {n:5d} | {wr:5.1f}% | {pnl:+8.3f} | {pnl_delta:+7.3f} | SL {sl:4.1f}% | {sl_delta:+5.1f}% | TP {tp:4.1f}% | {pct_keep:4.0f}%")

    print(f"\n--- Per-route breakdown of TOP filters ---")
    # Show top 3 general filters, broken down by route
    for rank, (label, fn) in enumerate(filters[:3]):
        label, n, wr, pnl, sl, tp, avg, pnl_delta, wr_delta, sl_delta, pct_keep = results[rank]
        subset = [d for d in data if fn(d)]
        routes = {}
        for d in subset:
            rt = d['route']
            if rt not in routes:
                routes[rt] = {'trades': 0, 'pnl': 0, 'wr': 0}
            routes[rt]['trades'] += 1
            routes[rt]['pnl'] += d['pnl_sol']
            if d['pnl_sol'] > 0:
                routes[rt]['wr'] += 1
        print(f"\n  [{label}] — {n} trades, {wr:.1f}% WR, {pnl:+.3f} SOL")
        for rt, s in sorted(routes.items(), key=lambda x: x[1]['pnl'], reverse=True):
            print(f"    {rt:30s} | {s['trades']:4d} trades | {s['wr']/s['trades']*100:5.1f}% WR | {s['pnl']:+.3f} SOL")

if __name__ == '__main__':
    main()