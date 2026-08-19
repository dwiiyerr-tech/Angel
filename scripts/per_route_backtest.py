#!/usr/bin/env python3
"""Per-route backtest: find best filter for each route from enrichment data."""

import sqlite3, json, sys, os

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
    ch = c.get('chart', {}) or {}
    return {
        'pnl_sol': row['pnl_sol'] or 0,
        'pnl_pct': row['pnl_percent'] or 0,
        'exit': row['exit_reason'] or '',
        'entry_mcap': row['entry_mcap'] or 0,
        'route': row['route'] or 'unknown',
        'ja_bondingCurve': ja.get('bondingCurve', 0) or 0,
        'ja_liquidity': ja.get('liquidity', 0) or 0,
        'ja_mcap': ja.get('mcap', 0) or 0,
        'ja_organicScore': ja.get('organicScore', 0) or 0,
        'ja_fees': ja.get('fees', 0) or 0,
        'ho_count': ho.get('count', 0) or 0,
        'ho_maxHolderPercent': ho.get('maxHolderPercent', 0) or 0,
        'ho_top20Percent': ho.get('top20Percent', 0) or 0,
        'me_gmgnTotalFeesSol': me.get('gmgnTotalFeesSol', 0) or 0,
        'me_liquidityUsd': me.get('liquidityUsd', 0) or 0,
        'me_trendingVolumeUsd': me.get('trendingVolumeUsd', 0) or 0,
        'me_marketCapUsd': me.get('marketCapUsd', 0) or 0,
        'si_hasTrending': 1 if si.get('hasTrending') else 0,
        'si_hasGraduated': 1 if si.get('hasGraduated') else 0,
        'ch_distanceFromAth': ch.get('distanceFromAthPercent', 0) or 0,
        'smart_degen_count': te.get('smart_degen_count', 0) or 0,
        'bot_degen_count': te.get('bot_degen_count', 0) or 0,
        'bot_degen_rate': te.get('bot_degen_rate', 0) or 0,
        'rug_ratio': te.get('rug_ratio', 0) or 0,
        'top_10_holder_rate': te.get('top_10_holder_rate', 0) or 0,
        'volume_24h': te.get('volume_24h', 0) or 0,
        'swaps_24h': te.get('swaps_24h', 0) or 0,
        'renowned_count': te.get('renowned_count', 0) or 0,
        'sniper_count': te.get('sniper_count', 0) or 0,
        'total_fee': te.get('total_fee', 0) or 0,
        'fresh_wallet_rate': te.get('fresh_wallet_rate', 0) or 0,
        'dev_team_hold_rate': te.get('dev_team_hold_rate', 0) or 0,
    }

def analyze(subset):
    if len(subset) < 10:
        return None
    n = len(subset)
    wr = sum(1 for d in subset if d['pnl_sol'] > 0) / n * 100
    pnl = sum(d['pnl_sol'] for d in subset)
    sl = sum(1 for d in subset if d['exit'] == 'SL')
    sl_rate = sl / n * 100
    tp = sum(1 for d in subset if d['exit'] == 'TRAILING_TP')
    tp_rate = tp / n * 100
    avg_pnl = pnl / n
    return n, wr, pnl, sl_rate, tp_rate, avg_pnl

def test_filters(data, route_name):
    """Test all reasonable filter combos for a route."""
    baseline = analyze(data)
    if not baseline:
        return []
    
    results = []
    base_n, base_wr, base_pnl, base_sl, base_tp, base_avg = baseline
    
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
        # Holders
        ("ho >= 30", lambda d: d['ho_count'] >= 30),
        ("ho >= 50", lambda d: d['ho_count'] >= 50),
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
        # Smart degen
        ("smartDegen >= 5", lambda d: d['smart_degen_count'] >= 5),
        ("smartDegen >= 10", lambda d: d['smart_degen_count'] >= 10),
        # Bot
        ("botDegen < 5", lambda d: d['bot_degen_count'] < 5),
        ("botDegen < 10", lambda d: d['bot_degen_count'] < 10),
        # Trending
        ("NOT trending", lambda d: d['si_hasTrending'] == 0),
        # Volume
        ("volume >= 30K", lambda d: d['me_trendingVolumeUsd'] >= 30000),
        ("volume >= 50K", lambda d: d['me_trendingVolumeUsd'] >= 50000),
        # Combos
        ("mcap 20K-30K + ho>=50", lambda d: 20000 <= d['entry_mcap'] < 30000 and d['ho_count'] >= 50),
        ("mcap 20K-30K + maxHolder<15%", lambda d: 20000 <= d['entry_mcap'] < 30000 and d['ho_maxHolderPercent'] < 15),
        ("mcap 20K-30K + liq>=5K", lambda d: 20000 <= d['entry_mcap'] < 30000 and d['me_liquidityUsd'] >= 5000),
        ("liq>=5K + ho>=50 + maxHolder<15%", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 15),
        ("liq>=5K + ho>=50 + bondingCurve>=85", lambda d: d['me_liquidityUsd'] >= 5000 and d['ho_count'] >= 50 and d['ja_bondingCurve'] >= 85),
        ("NOT trending + bondingCurve>=80", lambda d: d['si_hasTrending'] == 0 and d['ja_bondingCurve'] >= 80),
        ("NOT trending + bondingCurve>=80 + ho>=50", lambda d: d['si_hasTrending'] == 0 and d['ja_bondingCurve'] >= 80 and d['ho_count'] >= 50),
        ("bondingCurve>=85 + ho>=50", lambda d: d['ja_bondingCurve'] >= 85 and d['ho_count'] >= 50),
        ("bondingCurve>=85 + maxHolder<15%", lambda d: d['ja_bondingCurve'] >= 85 and d['ho_maxHolderPercent'] < 15),
        ("mcap 20K-50K + ho>=50 + maxHolder<20%", lambda d: 20000 <= d['entry_mcap'] < 50000 and d['ho_count'] >= 50 and d['ho_maxHolderPercent'] < 20),
        # SL-specific: try to reduce SL with known rug signals
        ("rug_ratio < 0.01", lambda d: d['rug_ratio'] < 0.01),
        ("botDegen < 5 + maxHolder<20%", lambda d: d['bot_degen_count'] < 5 and d['ho_maxHolderPercent'] < 20),
        ("freshWallet < 0.5", lambda d: d['fresh_wallet_rate'] < 0.5),
        ("smartDegen >= 5 + maxHolder<20%", lambda d: d['smart_degen_count'] >= 5 and d['ho_maxHolderPercent'] < 20),
    ]
    
    for label, fn in filters:
        subset = [d for d in data if fn(d)]
        r = analyze(subset)
        if r is None:
            continue
        n, wr, pnl, sl, tp, avg = r
        pnl_delta = pnl - base_pnl
        wr_delta = wr - base_wr
        sl_delta = sl - base_sl
        results.append((label, n, wr, pnl, sl, tp, avg, pnl_delta, wr_delta, sl_delta, n/base_n*100))
    
    # Sort by PnL delta
    results.sort(key=lambda x: x[7], reverse=True)
    return results, baseline

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
    routes = sorted(set(d['route'] for d in data))
    
    for route in routes:
        route_data = [d for d in data if d['route'] == route]
        if len(route_data) < 10:
            continue
        
        results, baseline = test_filters(route_data, route)
        base_n, base_wr, base_pnl, base_sl, base_tp, base_avg = baseline
        
        print(f"\n{'='*100}")
        print(f"  ROUTE: {route} ({base_n} trades)")
        print(f"  Baseline: {base_wr:.1f}% WR | {base_pnl:+.3f} SOL | SL {base_sl:.1f}% | TP {base_tp:.1f}% | avg {base_avg:+.3f} SOL/trade")
        print(f"{'='*100}")
        print(f"  {'Filter':50s} | {'N':>4s} | {'WR':>6s} | {'PnL':>9s} | {'ΔPnL':>8s} | {'SL':>6s} | {'ΔSL':>6s} | {'TP':>6s} | {'%keep':>5s}")
        print(f"  {'-'*98}")
        
        shown = 0
        for label, n, wr, pnl, sl, tp, avg, pnl_delta, wr_delta, sl_delta, pct_keep in results:
            if shown >= 15:
                break
            if pnl_delta <= 0 and shown >= 5:
                continue  # skip negative after showing top 5
            shown += 1
            print(f"  {label:50s} | {n:4d} | {wr:5.1f}% | {pnl:+8.3f} | {pnl_delta:+7.3f} | SL {sl:4.1f}% | {sl_delta:+5.1f}% | TP {tp:4.1f}% | {pct_keep:4.0f}%")

if __name__ == '__main__':
    main()