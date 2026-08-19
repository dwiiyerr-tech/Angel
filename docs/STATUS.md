# CHARON STATUS - Auto-updated
# Last updated: 2026-05-30 02:00 CST

## Config
- Mcap: 50K-100K
- SL: -15%
- TP: trailing 15%
- Token age max: 30m
- Min holders: 300
- Min liquidity: $5000

## Performance (50K-100K range)
- Trades: 34
- Win rate: 50.0%
- Avg PnL: +1.55%
- Total PnL: +52.63 SOL

## Projected with SL -15%
- Net PnL: +257 SOL
- Avg PnL: +7.56%

## Key Findings
1. 30K-50K NOT profitable (-0.29% avg, 41.7% WR) - excluded
2. 50K-100K is sweet spot (50% WR, +1.55% avg)
3. SL -25% too deep, -15% saves ~400 SOL in losses
4. Ponyin methodology blocks bad entries (bundler >0.4, 3 red candles, volume collapse)

## Monitoring
- Silent monitor: every 15min (alerts only on problems)
- Signal monitor: every 30min (alerts only on problems)
- Daily optimizer: 8am
- Monday report: 10am

## Auto-restart
- monitor.sh checks process every 15min
- Auto-restarts if Charon dies
