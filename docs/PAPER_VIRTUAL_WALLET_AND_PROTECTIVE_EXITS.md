# PAPER Virtual Wallet and Protective Exits

PAPER now exposes an accounting-only virtual wallet. It never reads, reserves,
or changes the LIVE wallet.

PAPER uses the same strategy sizing, fresh execution check, contract-safety
gate, market allocator, quote lifecycle, and protective-exit engine as LIVE.
The settlement is virtual and therefore does not sign or broadcast.

## Virtual wallet

- `paper_initial_balance_sol` defaults to `10` and can be changed with
  `/setfilter paper_initial_balance_sol <sol>`.
- `virtual equity = initial balance + closed PnL + marked open PnL`.
- `committed` is the remaining open position notional plus its entry fee.
  `size_sol` is reduced when a partial exit settles, so sold cost basis is
  historical accounting only and is not reserved a second time.
- Partial exits therefore release their returned virtual principal back into
  `available`, while realized profit/loss is applied separately.
- `available` is enforced for new PAPER entry reservations; existing positions
  remain open until their normal exit rule fires.
- Open marks are refreshed by the shared position monitor and stored with a
  timestamp so the Telegram and Edge reports show the last known quote.

## Stop-loss and trailing

- Each position stores its own TP, SL, trailing distance, and trailing arm
  threshold.
- The default trailing arm threshold is `+15%`, independent of TP. This avoids
  positions with a distant TP waiting forever before trailing protection starts.
- Static SL has a 90-second entry grace period and may be adjusted by the ATR
  volatility model.
- Once armed, trailing exits on the configured high-water drawdown or the
  configured positive floor. Profit-lock and break-even protections are also
  evaluated by the shared position engine.
- Position messages explicitly show `ARMED` or `wait @ <threshold>`.
