#!/usr/bin/env python3
"""
Full enrichment feature analysis for Angel dry-run positions.
Extracts 70+ features from candidates.candidate_json across 6 enrichment sources,
ranks by effect size, and tests filter combinations.

Usage:
    python3 scripts/full-enrichment-analysis.py
    python3 scripts/full-enrichment-analysis.py --days 30
    python3 scripts/full-enrichment-analysis.py --output /tmp/angel_features.csv

Output: ranked feature list + top filter combos + daily consistency table.
"""

import sqlite3, json, csv, sys, os
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
DB_PATH = os.path.join(PROJECT_ROOT, 'angel.sqlite')

def safe_num(d, *keys, default=0):
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k)
        else:
            return default
    return d if d is not None else default

def extract_features(rows):
    """Extract all numeric features from candidate_json."""
    features = []
    for r in rows:
        cj = json.loads(r['candidate_json']) if r['candidate_json'] else {}
        te = cj.get('trenchesEntry', {}) or {}
        ja = cj.get('jupiterAsset', {}) or {}
        ch = cj.get('chart', {}) or {}
        ho = cj.get('holders', {}) or {}
        si = cj.get('signals', {}) or {}
        me = cj.get('metrics', {}) or {}
        gw = cj.get('savedWalletExposure', {}) or {}

        f = {'pnl_sol': r['pnl_sol'] or 0, 'pnl_pct': r['pnl_percent'] or 0,
             'exit_reason': r['exit_reason'] or '', 'entry_mcap': r['entry_mcap'] or 0}

        # trenchesEntry numeric
        for k in ['bot_degen_count','bot_degen_rate','bundler_mhr','bundler_trader_amount_rate',
                  'buys_24h','sells_24h','swaps_24h','net_buy_24h',
                  'creator_balance_rate','creator_created_count','creator_created_open_count',
                  'creator_created_open_ratio','dev_team_hold_rate','entrapment_ratio',
                  'fresh_wallet_rate','holder_count','liquidity','market_cap','usd_market_cap',
                  'priority_fee','rat_trader_amount_rate','rug_ratio',
                  'smart_degen_count','sniper_count','suspected_insider_hold_rate',
                  'top_10_holder_rate','top70_sniper_hold_rate',
                  'total_fee','trade_fee','tip_fee','volume_24h',
                  'visiting_count','x_user_follower','private_vault_hold_rate',
                  'new_wallet_volume','renowned_count']:
            f[f'te_{k}'] = safe_num(te, k)

        # trenchesEntry bool
        for k in ['cto_flag','has_at_least_one_social','is_wash_trading','is_token_live',
                  'renounced_mint','renounced_freeze_account','dexscr_ad','dexscr_trending_bar',
                  'offchain','twitter_is_tweet']:
            f[f'te_{k}'] = 1 if te.get(k) else 0

        # jupiterAsset
        for k in ['bondingCurve','fdv','fees','holderCount','liquidity','mcap','organicScore','totalSupply']:
            f[f'ja_{k}'] = safe_num(ja, k)

        # chart
        for k in ['belowRangeHighPercent','distanceFromAthPercent']:
            f[f'ch_{k}'] = safe_num(ch, k)
        f['ch_topBlastRisk'] = 1 if ch.get('topBlastRisk') else 0

        # holders
        f['ho_count'] = safe_num(ho, 'count')
        f['ho_maxHolderPercent'] = safe_num(ho, 'maxHolderPercent')
        f['ho_top20Percent'] = safe_num(ho, 'top20Percent')

        # signals
        f['si_hasFeeClaim'] = 1 if si.get('hasFeeClaim') else 0
        f['si_hasGraduated'] = 1 if si.get('hasGraduated') else 0
        f['si_hasTrending'] = 1 if si.get('hasTrending') else 0

        # metrics
        f['me_gmgnTotalFeesSol'] = safe_num(me, 'gmgnTotalFeesSol')
        f['me_trendingVolumeUsd'] = safe_num(me, 'trendingVolumeUsd')
        f['me_trendingSwaps'] = safe_num(me, 'trendingSwaps')
        f['me_trendingHotLevel'] = safe_num(me, 'trendingHotLevel')
        f['me_trendingSmartDegenCount'] = safe_num(me, 'trendingSmartDegenCount')
        f['me_graduatedVolumeUsd'] = safe_num(me, 'graduatedVolumeUsd')
        f['me_liquidityUsd'] = safe_num(me, 'liquidityUsd')
        f['me_marketCapUsd'] = safe_num(me, 'marketCapUsd')
        f['me_holderCount'] = safe_num(me, 'holderCount')

        # savedWalletExposure
        f['sw_holderCount'] = safe_num(gw, 'holderCount')

        features.append(f)

    return features

def compute_effect_sizes(features):
    """Rank features by effect size (win_avg - loss_avg) / std_dev."""
    wins = [f for f in features if f['pnl_sol'] > 0]
    losses = [f for f in features if f['pnl_sol'] <= 0]

    rankings = []
    for key in features[0].keys():
        if key in ('pnl_sol', 'pnl_pct', 'exit_reason', 'entry_mcap'):
            continue

        w_vals = [f[key] for f in wins]
        l_vals = [f[key] for f in losses]
        all_vals = w_vals + l_vals

        w_avg = sum(w_vals) / len(w_vals) if w_vals else 0
        l_avg = sum(l_vals) / len(l_vals) if l_vals else 0
        mean = sum(all_vals) / len(all_vals)
        std = (sum((v - mean)**2 for v in all_vals) / len(all_vals)) ** 0.5

        effect_size = (w_avg - l_avg) / std if std > 0 else 0
        rankings.append((key, effect_size, w_avg, l_avg, w_avg - l_avg))

    rankings.sort(key=lambda x: abs(x[1]), reverse=True)
    return rankings

def analyze_filter(subset, total):
    if not subset:
        return len(subset), 0, 0, 0
    w = sum(1 for t in subset if t['pnl_sol'] > 0)
    wr = w/len(subset)*100
    pnl = sum(t['pnl_sol'] for t in subset)
    pct = len(subset)/total*100
    return len(subset), wr, pnl, pct

def main():
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row

    rows = db.execute('''
        SELECT p.pnl_sol, p.pnl_percent, p.closed_at_ms, p.exit_reason, p.entry_mcap,
               c.candidate_json
        FROM dry_run_positions p
        LEFT JOIN candidates c ON p.candidate_id = c.id
        WHERE p.status = 'closed'
        ORDER BY p.closed_at_ms
    ''').fetchall()

    print(f"Total closed positions: {len(rows)}")

    features = extract_features(rows)
    wins = [f for f in features if f['pnl_sol'] > 0]
    total_pnl = sum(f['pnl_sol'] for f in features)

    print(f"Wins: {len(wins)}, Losses: {len(features) - len(wins)}")
    print(f"Win rate: {len(wins)/len(features)*100:.1f}%")
    print(f"Total PnL: {total_pnl:+.4f} SOL")
    print(f"Avg Win: {sum(f['pnl_sol'] for f in wins)/max(1,len(wins)):+.4f} SOL")
    print(f"Avg Loss: {sum(f['pnl_sol'] for f in features if f['pnl_sol']<=0)/max(1,len(features)-len(wins)):+.4f} SOL")

    # Effect size ranking
    print("\n=== TOP 30 FEATURES (by effect size) ===\n")
    rankings = compute_effect_sizes(features)
    print(f"{'Feature':40s} | {'Effect':>8s} | {'Win Avg':>12s} | {'Loss Avg':>12s} | {'Diff':>12s}")
    print("-" * 100)
    for key, es, wa, la, diff in rankings[:30]:
        print(f"{key:40s} | {es:>+8.3f} | {wa:>12.4f} | {la:>12.4f} | {diff:>+12.4f}")

    # Test filter combos
    print("\n=== FILTER COMBINATIONS ===\n")
    combos = [
        ("ja_mcap $30K-$100K", lambda t: 30000 <= t['ja_mcap'] < 100000),
        ("ja_mcap $20K-$30K (sweet spot)", lambda t: 20000 <= t['ja_mcap'] < 30000),
        ("ja_mcap $30K-$100K + gmgnFees<10", lambda t: 30000 <= t['ja_mcap'] < 100000 and t['me_gmgnTotalFeesSol'] < 10),
        ("NOT trending + ja_mcap >= 30K", lambda t: t['si_hasTrending'] == 0 and t['ja_mcap'] >= 30000),
        ("NOT trending + bondingCurve>=80", lambda t: t['si_hasTrending'] == 0 and t['ja_bondingCurve'] >= 80),
        ("bondingCurve>=90 + gmgnFees<10 + maxHolderPct<30", lambda t: t['ja_bondingCurve'] >= 90 and t['me_gmgnTotalFeesSol'] < 10 and t['ho_maxHolderPercent'] < 30),
        ("mcap $20K-$30K + ho_count>=50", lambda t: 20000 <= t['ja_mcap'] < 30000 and t['ho_count'] >= 50),
        ("mcap $20K-$30K + maxHolderPct<30", lambda t: 20000 <= t['ja_mcap'] < 30000 and t['ho_maxHolderPercent'] < 30),
        ("mcap $20K-$30K + NOT trending", lambda t: 20000 <= t['ja_mcap'] < 30000 and t['si_hasTrending'] == 0),
        ("bondingCurve>=85 + ho_count>=50", lambda t: t['ja_bondingCurve'] >= 85 and t['ho_count'] >= 50),
    ]

    print(f"{'Filter':60s} | {'Trades':>6s} | {'WR':>6s} | {'PnL SOL':>10s} | {'%Pass':>6s}")
    print("-" * 100)
    for label, fn in combos:
        subset = [f for f in features if fn(f)]
        n, wr, pnl, pct = analyze_filter(subset, len(features))
        print(f"{label:60s} | {n:6d} | {wr:5.1f}% | {pnl:+10.4f} | {pct:5.1f}%")

    # Export CSV
    if '--output' in sys.argv:
        idx = sys.argv.index('--output') + 1
        path = sys.argv[idx] if idx < len(sys.argv) else '/tmp/angel_features.csv'
        with open(path, 'w', newline='') as fh:
            w = csv.DictWriter(fh, fieldnames=features[0].keys())
            w.writeheader()
            w.writerows(features)
        print(f"\nExported {len(features)} rows to {path}")

if __name__ == '__main__':
    main()