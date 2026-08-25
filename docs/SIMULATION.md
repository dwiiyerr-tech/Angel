# Shadow-live simulation

The `simulation` trading mode maps internally to `shadow_live`. It may request
and sign a Jupiter transaction in memory, run Solana RPC simulation, and record
the result without broadcasting a transaction.

## Confirmation and fault injection

Use these environment variables for controlled failure tests:

```env
TRADING_MODE=simulation
SIMULATION_CONFIRMATION_STATUS=confirmed
SIMULATION_CONFIRMATION_DELAY_MS=250
SIMULATION_RPC_FAILURE_STAGE=
SIMULATION_RPC_FAILURE_RATE=0
```

`SIMULATION_RPC_FAILURE_STAGE` accepts `order`, `sign`, `rpc`,
`confirmation`, or `all`. A comma-separated list is allowed. The rate is a
decimal probability from `0` to `1` and can inject a failure at any stage.
Any non-confirmed status (`pending`, `timeout`, or `failed`) prevents
the simulated entry from being recorded as an executed shadow-live position.

## Replay price ticks

Set `SIMULATION_TICK_FILE` to a JSON array or JSONL file. Each tick needs a mint,
timestamp, and either price or market cap:

```json
{"mint":"TOKEN_MINT","at_ms":1000,"price_usd":1.00,"mcap_usd":100000}
{"mint":"TOKEN_MINT","at_ms":2000,"price_usd":0.82,"mcap_usd":82000}
```

`SIMULATION_REPLAY_SPEED=1` advances the replay clock in real time. Values such
as `10` play ten milliseconds of tick history per millisecond of wall time;
`0` holds the first tick for deterministic tests. When replay is configured and
the next tick is not available, the monitor waits instead of falling back to
live prices.

Replay ticks are used for `shadow_live` positions only. Dry-run and live modes
keep their normal market-data paths.
