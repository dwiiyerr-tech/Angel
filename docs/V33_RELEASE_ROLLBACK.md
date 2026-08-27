# Angel v33 Atomic Release Rollback

The in-process performance guard owns configuration rollback. Source-code rollback is deliberately performed outside the bot by a small supervisor so a half-running Node process never rewrites its own checkout.

## Release layout

```text
/opt/angel/
  releases/v32/
  releases/v33/
  current  -> /opt/angel/releases/v33
  previous -> /opt/angel/releases/v32
```

Each release directory must be an immutable deployment containing `package.json`, `index.js`, and `src/app.js`. Stage and verify v32 and v33 before enabling the guard.

Use an absolute `DB_PATH` outside either release directory (for example `/var/lib/angel/angel.db`). Otherwise each release can accidentally open a different database and the rollback request/control history will not follow the active slot.

## Activate slots

```bash
export ANGEL_RELEASE_ROOT=/opt/angel
/opt/angel/releases/v33/scripts/release_manager.sh activate v32
/opt/angel/releases/v33/scripts/release_manager.sh activate v33
/opt/angel/current/scripts/release_manager.sh status
```

`activate` and `rollback` replace symlinks with `rename(2)` semantics via `mv -T`; the visible `current` pointer is never partially written.

## Enable automatic consumption

Copy `deploy/angel-release-guard.service` and `deploy/angel-release-guard.timer` to systemd, make `/etc/angel/angel.env` readable only by the service account, then set:

```text
RELEASE_ROLLBACK_ENABLED=1
ANGEL_RELEASE_VERSION=v33
ANGEL_PARENT_RELEASE_VERSION=v32
ANGEL_RELEASE_ROOT=/opt/angel
```

Enable the timer only after both slots pass `npm run check` and the main `angel.service` starts from `/opt/angel/current`. The guard checks every five minutes. A PAPER performance breach first restores the parent configuration, then inserts one durable release rollback request. The guard swaps the release slot, records completion/failure in SQLite, and asks systemd to restart Angel.

LIVE remains unaffected: automatic performance rollback is deferred outside PAPER, and changing a release or configuration invalidates the prior LIVE approval snapshot.
