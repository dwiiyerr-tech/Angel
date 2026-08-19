import sqlite3
conn=sqlite3.connect('/root/Kaiser.charon/charon.sqlite', timeout=30)
cur=conn.cursor()

print("ALL 31 CLOSED TRADES")
cur.execute("""
SELECT symbol, entry_mcap, exit_mcap, pnl_percent, exit_reason,
       (closed_at_ms - opened_at_ms) as hold_ms, high_water_mcap
FROM dry_run_positions ORDER BY closed_at_ms
""")
for sym, entry, exit_m, pnl, reason, hold_ms, hw in cur.fetchall():
    hold_s_min = f"{hold_ms/60000:>6.1f}min" if hold_ms is not None else "   N/A"
    hw_s = f"{hw:>14,.0f}" if hw else "None"
    entry_s = f"{entry:>14,.0f}" if entry is not None else "None"
    exit_s = f"{exit_m:>14,.0f}" if exit_m is not None else "None"
    print(f"{sym:12s} | entry:{entry_s} | exit:{exit_s} | pnl:{pnl:>7.2f}% | {reason:12s} | {hold_s_min} | HW:{hw_s}")

print()
print("1) EXIT REASON ANALYSIS")
cur.execute("""
SELECT exit_reason, COUNT(*), ROUND(AVG(pnl_percent),2), ROUND(MIN(pnl_percent),2),
       ROUND(MAX(pnl_percent),2), SUM(CASE WHEN pnl_percent < 0 THEN 1 ELSE 0 END),
       ROUND(100.0*SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END)/COUNT(*),1)
FROM dry_run_positions GROUP BY exit_reason ORDER BY avg(pnl_percent)
""")
for r in cur.fetchall():
    print(f"{r[0]:12s} | trades:{r[1]} | avg:{r[2]}% | worst:{r[3]}% | best:{r[4]}% | losses:{r[5]} | WR:{r[6]}%")

print()
print("2) ENTRY_MCAP RANGE WIN RATE")
cur.execute("""
SELECT
  CASE
    WHEN entry_mcap IS NULL THEN 'Unknown'
    WHEN entry_mcap < 10000 THEN '<10K'
    WHEN entry_mcap < 50000 THEN '10K-50K'
    WHEN entry_mcap < 100000 THEN '50K-100K'
    WHEN entry_mcap < 500000 THEN '100K-500K'
    ELSE '>500K'
  END as rg, COUNT(*), SUM(CASE WHEN pnl_percent>0 THEN 1 ELSE 0 END),
  ROUND(100.0*SUM(CASE WHEN pnl_percent>0 THEN 1 ELSE 0 END)/COUNT(*),1),
  ROUND(AVG(pnl_percent),2), ROUND(AVG(entry_mcap),0)
FROM dry_run_positions GROUP BY rg ORDER BY AVG(entry_mcap)
""")
for r in cur.fetchall():
    print(f"{r[0]:12s} | trades:{r[1]} | wins:{r[2]} | WR:{r[3]}% | avg_pnl:{r[4]}%")

print()
print("3) GAVE BACK GAINS (peak>entry but closed negative)")
cur.execute("SELECT COUNT(*), SUM(CASE WHEN high_water_mcap>entry_mcap AND pnl_percent<0 THEN 1 ELSE 0 END) FROM dry_run_positions")
tot, gb = cur.fetchone()
print(f"Total: {tot}, Gave-back: {gb}")
cur.execute("""
SELECT symbol, entry_mcap, high_water_mcap, exit_mcap, pnl_percent, exit_reason,
       ROUND(100.0*(high_water_mcap-entry_mcap)/NULLIF(entry_mcap, 0),2) as pg
FROM dry_run_positions WHERE high_water_mcap>entry_mcap AND pnl_percent<0
ORDER BY pg DESC
""")
for r in cur.fetchall():
    print(f"{r[0]:12s} | entry:{r[1]:>10,.0f} | peak:{r[2]:>10,.0f} | exit:{r[3]:>10,.0f} | pnl:{r[4]:>6.2f}% | {r[5]:12s} | peak_gain:{r[6]}%")

print()
print("OVERALL")
cur.execute("SELECT COUNT(*),ROUND(AVG(pnl_percent),2),ROUND(MIN(pnl_percent),2),ROUND(MAX(pnl_percent),2),ROUND(SUM(pnl_sol),4),SUM(CASE WHEN pnl_percent>0 THEN 1 ELSE 0 END) FROM dry_run_positions")
r=cur.fetchone()
wr = 100.0*r[5]/r[0] if r[0] else 0.0
print(f"Trades:{r[0]} AvgPnL:{r[1]}% Worst:{r[2]}% Best:{r[3]}% TotalPnL:{r[4]} SOL Wins:{r[5]} WR:{wr:.1f}%")

print()
print("AVG HOLDING TIME BY EXIT REASON")
cur.execute("SELECT exit_reason, ROUND(AVG(closed_at_ms-opened_at_ms)/60000.0,1), ROUND(MIN(closed_at_ms-opened_at_ms)/60000.0,1), ROUND(MAX(closed_at_ms-opened_at_ms)/60000.0,1) FROM dry_run_positions GROUP BY exit_reason")
for r in cur.fetchall():
    print(f"{r[0]:12s} | avg:{r[1]:>6.1f}min | min:{r[2]:>6.1f}min | max:{r[3]:>6.1f}min")

conn.close()