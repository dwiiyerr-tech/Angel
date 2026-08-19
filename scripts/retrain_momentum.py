#!/usr/bin/env python3
"""Train a momentum challenger and deploy it only when it beats the incumbent."""
import json
import os
import pickle
import sqlite3
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.preprocessing import StandardScaler

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.append(str(PROJECT_DIR / "src" / "pipeline"))
from predict_momentum import extract_features  # noqa: E402

DB_PATH = Path(os.getenv("ANGEL_DB_PATH", PROJECT_DIR / "angel.sqlite"))
MODELS_DIR = Path(os.getenv("ANGEL_MODELS_DIR", PROJECT_DIR / "models"))
MODEL_PATH = MODELS_DIR / "momentum_model.pkl"
SCALER_PATH = MODELS_DIR / "momentum_scaler.pkl"
FEATURES_PATH = MODELS_DIR / "momentum_features.json"
METADATA_PATH = MODELS_DIR / "momentum_metadata.json"
STATE_PATH = MODELS_DIR / "momentum_retrain_state.json"
MIN_SAMPLES = 50
MIN_NEW_TRADES = 10
MIN_AUC_GAIN = 0.01
MIN_ABSOLUTE_AUC = 0.55
MIN_ABSOLUTE_F1 = 0.20

FEATURE_COLUMNS = [
    "price_current", "price_1m", "price_5m", "price_1h", "price_velocity_5m",
    "price_acceleration", "volume_1m", "volume_5m", "volume_1h", "buy_volume_1m",
    "sell_volume_1m", "buy_sell_ratio_1m", "volume_5m_ratio", "swaps_1m",
    "swaps_5m", "buys_1m", "sells_1m", "buy_swap_ratio", "market_cap", "liquidity",
    "liquidity_ratio", "holder_count", "smart_degen_count", "sniper_count",
    "smart_holder_ratio", "top_10_holder_rate", "bot_degen_rate", "bundler_rate",
    "rug_ratio", "fresh_wallet_rate", "below_ath_pct", "ath_change_pct",
    "swing_change_pct", "twitter_followers", "twitter_engagement", "twitter_views",
    "engagement_per_follower", "graduated_volume", "trending_volume",
    "token_age_seconds", "creation_to_open"
]


def load_data():
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute("""
            SELECT id, pnl_percent, snapshot_json,
                   COALESCE(closed_at_ms, opened_at_ms) AS outcome_at
            FROM dry_run_positions
            WHERE status = 'closed' AND pnl_percent IS NOT NULL
            ORDER BY outcome_at ASC, id ASC
        """).fetchall()
    samples = []
    for trade_id, pnl, raw, outcome_at in rows:
        try:
            candidate = json.loads(raw or "{}").get("candidate", {})
            features = extract_features(candidate)
            vector = [float(features.get(column, 0.0) or 0.0) for column in FEATURE_COLUMNS]
            if np.all(np.isfinite(vector)):
                samples.append((trade_id, outcome_at, vector, 1 if pnl > 0 else 0))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return samples


def metrics(model, scaler, x_test, y_test):
    scaled = scaler.transform(x_test)
    prediction = model.predict(scaled)
    probability = model.predict_proba(scaled)[:, 1]
    return {
        "accuracy": float(accuracy_score(y_test, prediction)),
        "precision": float(precision_score(y_test, prediction, zero_division=0)),
        "recall": float(recall_score(y_test, prediction, zero_division=0)),
        "f1": float(f1_score(y_test, prediction, zero_division=0)),
        "roc_auc": float(roc_auc_score(y_test, probability)),
    }


def atomic_pickle(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        pickle.dump(value, handle)
    os.replace(temporary, path)


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def main():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        mode_row = conn.execute("SELECT value FROM settings WHERE key = 'trading_mode'").fetchone()
    trading_mode = mode_row[0] if mode_row else "dry_run"
    if trading_mode != "dry_run":
        print(f"SKIP: model retraining is forbidden while trading_mode={trading_mode}.")
        return 3
    samples = load_data()
    print(f"Loaded {len(samples)} valid closed trades in chronological order.")
    if len(samples) < MIN_SAMPLES:
        print(f"SKIP: need at least {MIN_SAMPLES} valid samples.")
        return 3

    previous = {}
    if STATE_PATH.exists():
        try:
            previous = json.loads(STATE_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            pass
    last_id = int(previous.get("max_trade_id", 0))
    new_count = sum(1 for row in samples if row[0] > last_id)
    if last_id and new_count < MIN_NEW_TRADES:
        print(f"SKIP: only {new_count} new trades since deployment; need {MIN_NEW_TRADES}.")
        return 3

    split = int(len(samples) * 0.8)
    train, test = samples[:split], samples[split:]
    y_train = np.array([row[3] for row in train])
    y_test = np.array([row[3] for row in test])
    if len(np.unique(y_train)) < 2 or len(np.unique(y_test)) < 2:
        print("SKIP: chronological train/test windows both need winners and losers.")
        return 3
    x_train = np.array([row[2] for row in train])
    x_test = np.array([row[2] for row in test])

    scaler = StandardScaler().fit(x_train)
    model = GradientBoostingClassifier(
        n_estimators=200, max_depth=4, min_samples_leaf=5,
        learning_rate=0.05, random_state=42
    ).fit(scaler.transform(x_train), y_train)
    challenger = metrics(model, scaler, x_test, y_test)
    print("Challenger:", json.dumps(challenger, sort_keys=True))

    # Record attempts independently from deployed-model metadata, so a weak
    # challenger is not retrained every week against identical data.
    atomic_json(STATE_PATH, {
        "max_trade_id": max(row[0] for row in samples),
        "sample_count": len(samples),
        "challenger_metrics": challenger,
    })

    incumbent = None
    artifacts_exist = MODEL_PATH.exists() and SCALER_PATH.exists() and FEATURES_PATH.exists()
    incumbent_is_comparable = False
    deployed_metadata = {}
    if METADATA_PATH.exists():
        try:
            deployed_metadata = json.loads(METADATA_PATH.read_text())
            incumbent_is_comparable = deployed_metadata.get("validation") == "chronological_80_20"
        except (OSError, json.JSONDecodeError):
            pass
    if artifacts_exist and incumbent_is_comparable:
        try:
            existing_features = json.loads(FEATURES_PATH.read_text())
            if existing_features == FEATURE_COLUMNS:
                with MODEL_PATH.open("rb") as handle:
                    old_model = pickle.load(handle)
                with SCALER_PATH.open("rb") as handle:
                    old_scaler = pickle.load(handle)
                incumbent = metrics(old_model, old_scaler, x_test, y_test)
                print("Incumbent:", json.dumps(incumbent, sort_keys=True))
        except Exception as error:
            print(f"Incumbent could not be evaluated: {error}")

    if incumbent is None:
        deploy = challenger["roc_auc"] >= MIN_ABSOLUTE_AUC and challenger["f1"] >= MIN_ABSOLUTE_F1
        print(f"Legacy champion is not fairly comparable; using absolute gates AUC>={MIN_ABSOLUTE_AUC}, F1>={MIN_ABSOLUTE_F1}.")
    else:
        deploy = (
            challenger["roc_auc"] >= incumbent["roc_auc"] + MIN_AUC_GAIN
            and challenger["f1"] >= incumbent["f1"] - 0.02
        )
    if not deploy:
        print("SKIP: challenger did not beat champion deployment gates; artifacts unchanged.")
        return 3

    atomic_pickle(MODEL_PATH, model)
    atomic_pickle(SCALER_PATH, scaler)
    atomic_json(FEATURES_PATH, FEATURE_COLUMNS)
    atomic_json(METADATA_PATH, {
        "max_trade_id": max(row[0] for row in samples),
        "max_outcome_at_ms": max(row[1] or 0 for row in samples),
        "sample_count": len(samples),
        "train_count": len(train),
        "test_count": len(test),
        "validation": "chronological_80_20",
        "challenger_metrics": challenger,
        "replaced_incumbent_metrics": incumbent,
    })
    print("DEPLOYED: challenger passed gates and artifacts were atomically replaced.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
