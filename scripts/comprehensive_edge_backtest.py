#!/usr/bin/env python3
"""
Comprehensive edge backtest: extract ALL enrichment fields, sweep single-field thresholds,
test best combos, and verify daily consistency.
"""
import sqlite3, json, sys, os
from datetime import datetime
from collections import Counter, defaultdict
from itertools import combinations

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DB_PATH = os.path.join(PROJECT_ROOT, 'angel.sqlite')

def safe_float(v, default=None):
    """Parse float, return default if None/empty/error."""
    try:
        if v is None: return default
        return float(v)
    except (ValueError, TypeError):
        return default

def safe_int(v, default=None):
    try:
        if v is None: return default
        return int(v)
    except (ValueError, TypeError):
        return default

def extract_features(row):
    """Extract ALL numeric features from candidate_json."""
    cj = json.loads(row['candidate_json']) if row['candidate_json'] else {}
    c = cj.get('candidate', cj)
    
    me = c.get('metrics', {}) or {}
    si = c.get('signals', {}) or {}
    ja = c.get('jupiterAsset', {}) or {}
    au = ja.get('audit', {}) or {}
    ho = c.get('holders', {}) or {}
    fi = c.get('filters', {}) or {}
    ex = c.get('executionRefresh', {}) or {}
    tr = c.get('trending', {}) or {}
    
    feats = {
        # Meta
        'pnl_sol': row['pnl_sol'] or 0,
        'exit': row['exit_reason'] or '',
        'entry_mcap': row['entry_mcap'] or 0,
        'route': row['route'] or 'unknown',
        'day': datetime.fromtimestamp((row['opened_at_ms'] or 0)/1000).strftime('%Y-%m-%d'),
        
        # Metrics
        'me_priceUsd': safe_float(me.get('priceUsd'), 0),
        'me_marketCap': safe_float(me.get('marketCapUsd'), 0),
        'me_liquidity': safe_float(me.get('liquidityUsd'), 0),
        'me_holderCount': safe_int(me.get('holderCount'), 0),
        'me_gmgnTotalFees': safe_float(me.get('gmgnTotalFeesSol'), 0),
        'me_trendingVolume': safe_float(me.get('trendingVolumeUsd'), 0),
        'me_trendingSwaps': safe_int(me.get('trendingSwaps'), 0),
        'me_trendingHotLevel': safe_int(me.get('trendingHotLevel'), 0),
        'me_trendingSmartDegen': safe_int(me.get('trendingSmartDegenCount'), 0),
        
        # Signals
        'si_hasTrending': 1 if si.get('hasTrending') else 0,
        'si_hasGraduated': 1 if si.get('hasGraduated') else 0,
        'si_hasFeeClaim': 1 if si.get('hasFeeClaim') else 0,
        
        # JupiterAsset
        'ja_mcap': safe_float(ja.get('mcap'), 0),
        'ja_fdv': safe_float(ja.get('fdv'), 0),
        'ja_liquidity': safe_float(ja.get('liquidity'), 0),
        'ja_bondingCurve': safe_float(ja.get('bondingCurve'), 0),
        'ja_organicScore': safe_float(ja.get('organicScore'), 0),
        'ja_holderCount': safe_int(ja.get('holderCount'), 0),
        'ja_fees': safe_float(ja.get('fees'), 0),
        'ja_usdPrice': safe_float(ja.get('usdPrice'), 0),
        
        # Audit
        'au_topHoldersPct': safe_float(au.get('topHoldersPercentage'), 0),
        'au_devMigrations': safe_int(au.get('devMigrations'), 0),
        'au_devMints': safe_int(au.get('devMints'), 0),
        'au_botHoldersCount': safe_int(au.get('botHoldersCount'), 0),
        'au_botHoldersPct': safe_float(au.get('botHoldersPercentage'), 0),
        
        # Bundler
        'au_bundlerHoldingPct': safe_float((au.get('bundlerStats') or {}).get('holdingPct'), 0),
        'au_bundlerPercent': safe_float((au.get('bundlerStats') or {}).get('percent'), 0),
        'au_bundlerCount': safe_int((au.get('bundlerStats') or {}).get('count'), 0),
        'au_hasBundler': 1 if au.get('bundlerStats') else 0,
        
        # Stats5m
        's5m_priceChange': safe_float((ja.get('stats5m') or {}).get('priceChange'), 0),
        's5m_buyVol': safe_float((ja.get('stats5m') or {}).get('buyVolume'), 0),
        's5m_sellVol': safe_float((ja.get('stats5m') or {}).get('sellVolume'), 0),
        's5m_numBuys': safe_int((ja.get('stats5m') or {}).get('numBuys'), 0),
        's5m_numSells': safe_int((ja.get('stats5m') or {}).get('numSells'), 0),
        's5m_numTraders': safe_int((ja.get('stats5m') or {}).get('numTraders'), 0),
        's5m_numNetBuyers': safe_int((ja.get('stats5m') or {}).get('numNetBuyers'), 0),
        's5m_holderChange': safe_float((ja.get('stats5m') or {}).get('holderChange'), 0),
        's5m_liquidityChange': safe_float((ja.get('stats5m') or {}).get('liquidityChange'), 0),
        
        # Stats1h
        's1h_priceChange': safe_float((ja.get('stats1h') or {}).get('priceChange'), 0),
        's1h_buyVol': safe_float((ja.get('stats1h') or {}).get('buyVolume'), 0),
        's1h_sellVol': safe_float((ja.get('stats1h') or {}).get('sellVolume'), 0),
        's1h_numBuys': safe_int((ja.get('stats1h') or {}).get('numBuys'), 0),
        's1h_numSells': safe_int((ja.get('stats1h') or {}).get('numSells'), 0),
        's1h_numTraders': safe_int((ja.get('stats1h') or {}).get('numTraders'), 0),
        's1h_numNetBuyers': safe_int((ja.get('stats1h') or {}).get('numNetBuyers'), 0),
        
        # Stats24h
        's24h_priceChange': safe_float((ja.get('stats24h') or {}).get('priceChange'), 0),
        's24h_buyVol': safe_float((ja.get('stats24h') or {}).get('buyVolume'), 0),
        's24h_sellVol': safe_float((ja.get('stats24h') or {}).get('sellVolume'), 0),
        
        # Holders
        'ho_count': safe_int(ho.get('count'), 0),
        'ho_top20Percent': safe_float(ho.get('top20Percent'), 0),
        'ho_maxHolderPercent': safe_float(ho.get('maxHolderPercent'), 0),
        
        # Filters
        'fi_softScore': safe_int(fi.get('softScore'), 0),
        'fi_softThreshold': safe_int(fi.get('softThreshold'), 0),
        
        # Execution refresh
        'ex_marketCap': safe_float(ex.get('marketCapUsd'), 0),
        'ex_priceUsd': safe_float(ex.get('priceUsd'), 0),
        'ex_liquidity': safe_float(ex.get('liquidityUsd'), 0),
        
        # Trending
        'tr_price': safe_float(tr.get('price'), 0),
        'tr_market_cap': safe_float(tr.get('market_cap'), 0),
        'tr_liquidity': safe_float(tr.get('liquidity'), 0),
        'tr_holder_count': safe_int(tr.get('holder_count'), 0),
        'tr_volume': safe_float(tr.get('volume'), 0),
        'tr_swaps': safe_int(tr.get('swaps'), 0),
        'tr_buys': safe_int(tr.get('buys'), 0),
        'tr_sells': safe_int(tr.get('sells'), 0),
        'tr_change5m': safe_float(tr.get('change5m'), 0),
        'tr_totalSupply': safe_int(tr.get('totalSupply'), 0),
        
        # Derived
        'buy_sell_ratio_5m': 0,
        'buy_sell_ratio_1h': 0,
        'net_buyer_ratio_5m': 0,
        'net_buyer_ratio_1h': 0,
    }
    
    # Derived ratios
    if feats['s5m_sellVol'] > 0:
        feats['buy_sell_ratio_5m'] = feats['s5m_buyVol'] / feats['s5m_sellVol']
    if feats['s1h_sellVol'] > 0:
        feats['buy_sell_ratio_1h'] = feats['s1h_buyVol'] / feats['s1h_sellVol']
    if feats['s5m_numTraders'] > 0:
        feats['net_buyer_ratio_5m'] = feats['s5m_numNetBuyers'] / feats['s5m_numTraders']
    if feats['s1h_numTraders'] > 0:
        feats['net_buyer_ratio_1h'] = feats['s1h_numNetBuyers'] / feats['s1h_numTraders']
    
    return feats


def analyze(subset):
    """Return (n, wr, pnl, sl_rate, tp_rate, avg_pnl)."""
    if len(subset) < 10:
        return None
    n = len(subset)
    wr = sum(1 for d in subset if d['pnl_sol'] > 0) / n * 100
    pnl = sum(d['pnl_sol'] for d in subset)
    sl = sum(1 for d in subset if d['exit'] == 'SL')
    tp = sum(1 for d in subset if d['exit'] == 'TRAILING_TP')
    return n, wr, pnl, sl/n*100, tp/n*100, pnl/n


def daily_consistency(data, fn, label):
    """Check if filter holds daily."""
    days = defaultdict(list)
    for d in data:
        days[d['day']].append(d)
    
    results = []
    for day in sorted(days):
        day_data = [d for d in days[day] if fn(d)]
        all_base = analyze(days[day])
        day_filtered = analyze(day_data)
        if all_base is None or day_filtered is None:
            continue
        base_n, base_wr, base_pnl, _, _, _ = all_base
        n, wr, pnl, sl, tp, _ = day_filtered
        base_pnl_per = base_pnl / base_n if base_n > 0 else 0
        pnl_per = pnl / n if n > 0 else 0
        results.append({
            'day': day,
            'n': n,
            'wr': wr,
            'pnl': pnl,
            'pnl_per': pnl_per,
            'base_pnl_per': base_pnl_per,
            'base_n': base_n,
            'delta_per': pnl_per - base_pnl_per,
        })
    
    # Count positive days
    pos_days = sum(1 for r in results if r['delta_per'] > 0)
    neg_days = sum(1 for r in results if r['delta_per'] < 0)
    total_days = len(results)
    
    return results, pos_days, neg_days, total_days


def main():
    db = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    
    rows = db.execute('''
        SELECT p.pnl_sol, p.pnl_percent, p.exit_reason, p.entry_mcap, p.opened_at_ms, p.closed_at_ms,
               json_extract(p.snapshot_json, '$.candidate.signals.route') as route,
               c.candidate_json
        FROM dry_run_positions p
        LEFT JOIN candidates c ON p.candidate_id = c.id
        WHERE p.status = 'closed' AND c.candidate_json IS NOT NULL
        ORDER BY p.closed_at_ms
    ''').fetchall()
    
    data = [extract_features(r) for r in rows]
    base_n, base_wr, base_pnl, base_sl, base_tp, base_avg = analyze(data)
    
    print(f"BASELINE: {base_n} trades | {base_wr:.1f}% WR | {base_pnl:+.3f} SOL | SL {base_sl:.1f}% | TP {base_tp:.1f}% | avg {base_avg:+.3f} SOL/trade")
    print(f"Days: {len(set(d['day'] for d in data))}")
    print()
    
    # ─── PHASE 1: Single-field threshold sweep ───
    print("=" * 100)
    print("PHASE 1: SINGLE-FIELD THRESHOLD SWEEP (top 30 by PnL delta)")
    print("=" * 100)
    
    fields = [
        ('me_liquidity', [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000]),
        ('me_marketCap', [10000, 20000, 30000, 50000, 80000, 100000, 150000]),
        ('me_holderCount', [10, 20, 30, 50, 75, 100, 150]),
        ('me_gmgnTotalFees', [1, 3, 5, 10, 20, 50]),
        ('me_trendingVolume', [10000, 30000, 50000, 100000]),
        ('ja_bondingCurve', [50, 60, 70, 80, 85, 90, 95]),
        ('ja_organicScore', [30, 50, 70, 90]),
        ('ja_fees', [0.5, 1, 3, 5, 10]),
        ('au_topHoldersPct', [5, 10, 15, 20, 30, 50]),
        ('au_devMigrations', [3, 5, 10, 15]),
        ('au_botHoldersPct', [10, 20, 30, 50, 80]),
        ('au_hasBundler', [0.5]),
        ('ho_count', [10, 20, 30, 50, 75, 100, 150]),
        ('ho_maxHolderPercent', [5, 10, 15, 20, 30, 50]),
        ('ho_top20Percent', [20, 30, 40, 50, 60, 80]),
        ('s5m_priceChange', [-20, -10, 0, 10, 20, 50]),
        ('s5m_numNetBuyers', [-10, 0, 10, 20, 50]),
        ('s5m_numTraders', [10, 20, 50, 100, 200]),
        ('s1h_priceChange', [-50, -20, 0, 20, 50, 100]),
        ('s1h_numNetBuyers', [-50, -10, 0, 10, 50, 100]),
        ('s1h_numTraders', [50, 100, 200, 500]),
        ('buy_sell_ratio_5m', [0.5, 0.8, 1.0, 1.2, 1.5, 2.0]),
        ('buy_sell_ratio_1h', [0.5, 0.8, 1.0, 1.2, 1.5, 2.0]),
        ('net_buyer_ratio_5m', [-0.2, 0, 0.2, 0.4, 0.6]),
        ('net_buyer_ratio_1h', [-0.2, 0, 0.2, 0.4, 0.6]),
        ('fi_softScore', [30, 40, 50, 60, 70, 80]),
        ('tr_volume', [10000, 30000, 50000, 100000]),
        ('tr_change5m', [-10, -5, 0, 5, 10, 20]),
    ]
    
    all_results = []
    
    for field_name, thresholds in fields:
        for thresh in thresholds:
            # For hasBundler: threshold search doesn't apply
            if field_name == 'au_hasBundler':
                fn = lambda d, f=field_name: d[f] == 0  # hasBundler = 0
                label = f"{field_name} = 0"
            else:
                fn = lambda d, f=field_name, t=thresh: d[f] >= t
                label = f"{field_name} >= {thresh}"
            
            subset = [d for d in data if fn(d)]
            r = analyze(subset)
            if r is None:
                continue
            n, wr, pnl, sl, tp, avg = r
            pnl_delta = pnl - base_pnl
            wr_delta = wr - base_wr
            
            # Daily consistency
            if pnl_delta > 0:
                daily_r, pos_d, neg_d, tot_d = daily_consistency(data, fn, label)
                if tot_d < 3:
                    continue
                consistency = pos_d / tot_d * 100
            else:
                consistency = 0
            
            all_results.append({
                'label': label,
                'field': field_name,
                'thresh': thresh,
                'n': n, 'wr': wr, 'pnl': pnl, 'sl': sl, 'tp': tp,
                'pnl_delta': pnl_delta, 'wr_delta': wr_delta,
                'pct_keep': n/base_n*100,
                'consistency': consistency,
                'fn': fn,
            })
    
    # Sort by PnL delta
    all_results.sort(key=lambda x: x['pnl_delta'], reverse=True)
    
    print(f"{'Filter':50s} | {'N':>4s} | {'WR':>6s} | {'PnL':>9s} | {'ΔPnL':>8s} | {'SL':>6s} | {'%keep':>5s} | {'Daily':>6s}")
    print("-" * 105)
    
    for r in all_results[:30]:
        print(f"{r['label']:50s} | {r['n']:4d} | {r['wr']:5.1f}% | {r['pnl']:+8.3f} | {r['pnl_delta']:+7.3f} | SL {r['sl']:4.1f}% | {r['pct_keep']:4.0f}% | {r['consistency']:5.0f}%")
    
    # ─── PHASE 2: Best combos from top-10 single fields ───
    print("\n" + "=" * 100)
    print("PHASE 2: BEST COMBOS (top 10 single fields, pairs only)")
    print("=" * 100)
    
    top10 = all_results[:10]
    combo_results = []
    
    for i, r1 in enumerate(top10):
        for r2 in top10[i+1:]:
            fn1 = r1['fn']
            fn2 = r2['fn']
            label = f"{r1['label']} & {r2['label']}"
            fn = lambda d, f1=fn1, f2=fn2: f1(d) and f2(d)
            
            subset = [d for d in data if fn(d)]
            r = analyze(subset)
            if r is None:
                continue
            n, wr, pnl, sl, tp, avg = r
            pnl_delta = pnl - base_pnl
            
            if pnl_delta > 0:
                daily_r, pos_d, neg_d, tot_d = daily_consistency(data, fn, label)
                consistency = pos_d / tot_d * 100 if tot_d >= 3 else 0
            else:
                consistency = 0
            
            combo_results.append({
                'label': label,
                'n': n, 'wr': wr, 'pnl': pnl, 'sl': sl, 'tp': tp,
                'pnl_delta': pnl_delta, 'pct_keep': n/base_n*100,
                'consistency': consistency,
            })
    
    combo_results.sort(key=lambda x: x['pnl_delta'], reverse=True)
    
    print(f"{'Filter':80s} | {'N':>4s} | {'WR':>6s} | {'PnL':>9s} | {'ΔPnL':>8s} | {'SL':>6s} | {'%keep':>5s} | {'Daily':>6s}")
    print("-" * 135)
    
    for r in combo_results[:20]:
        print(f"{r['label']:80s} | {r['n']:4d} | {r['wr']:5.1f}% | {r['pnl']:+8.3f} | {r['pnl_delta']:+7.3f} | SL {r['sl']:4.1f}% | {r['pct_keep']:4.0f}% | {r['consistency']:5.0f}%")
    
    # ─── PHASE 3: Daily consistency of top 5 filters ───
    print("\n" + "=" * 100)
    print("PHASE 3: DAILY CONSISTENCY — TOP 5 FILTERS")
    print("=" * 100)
    
    top_filters = all_results[:3]  # single-field top 3
    # Add top 3 combos with fn reconstructed
    for cr in combo_results[:3]:
        # Reconstruct fn from label
        label = cr['label']
        parts = label.split(' & ')
        fn1 = next((r['fn'] for r in all_results if r['label'] == parts[0]), None)
        fn2 = next((r['fn'] for r in all_results if r['label'] == parts[1]), None)
        if fn1 and fn2:
            cr['fn'] = lambda d, f1=fn1, f2=fn2: f1(d) and f2(d)
            top_filters.append(cr)
    
    for rank, f in enumerate(top_filters):
        daily_r, pos_d, neg_d, tot_d = daily_consistency(data, f['fn'], f['label'])
        print(f"\n  [{rank+1}] {f['label']}")
        print(f"      Overall: {f['n']} trades, {f['wr']:.1f}% WR, {f['pnl']:+.3f} SOL")
        print(f"      Daily consistency: {pos_d}/{tot_d} days positive ({pos_d/tot_d*100:.0f}%)")
        print(f"      {'Day':12s} | {'Base N':>6s} | {'Filt N':>6s} | {'Base/t':>8s} | {'Filt/t':>8s} | {'Delta/t':>8s} | {'WR':>6s}")
        print(f"      {'-'*65}")
        for d in daily_r:
            print(f"      {d['day']:12s} | {d['base_n']:6d} | {d['n']:6d} | {d['base_pnl_per']:+7.4f} | {d['pnl_per']:+7.4f} | {d['delta_per']:+7.4f} | {d['wr']:5.1f}%")
    
    # ─── PHASE 4: Per-route edge ───
    print("\n" + "=" * 100)
    print("PHASE 4: PER-ROUTE EDGE")
    print("=" * 100)
    
    routes = defaultdict(list)
    for d in data:
        routes[d['route']].append(d)
    
    for route in sorted(routes, key=lambda r: len(routes[r]), reverse=True):
        route_data = routes[route]
        if len(route_data) < 10:
            continue
        base_r = analyze(route_data)
        if base_r is None:
            continue
        
        # Find best single field for this route
        best_pnl = 0
        best_label = ""
        best_r = None
        
        for field_name, thresholds in fields:
            for thresh in thresholds:
                fn = lambda d, f=field_name, t=thresh: d[f] >= t
                subset = [d for d in route_data if fn(d)]
                r = analyze(subset)
                if r is None:
                    continue
                n, wr, pnl, sl, tp, avg = r
                pnl_delta = pnl - base_r[2]
                if pnl_delta > best_pnl:
                    best_pnl = pnl_delta
                    best_label = f"{field_name} >= {thresh}"
                    best_r = r
        
        print(f"\n  {route} ({base_r[0]} trades, {base_r[1]:.1f}% WR, {base_r[2]:+.3f} SOL)")
        if best_r:
            print(f"    Best: {best_label} → {best_r[0]} trades, {best_r[1]:.1f}% WR, {best_r[2]:+.3f} SOL (+{best_pnl:+.3f})")
        else:
            print(f"    No filter improves PnL")


if __name__ == '__main__':
    main()