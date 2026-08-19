#!/usr/bin/env python3
"""
Underground Wallet Finder v4 — Transaction-based approach
Instead of scanning token holders, scan RECENT TRANSACTIONS
and find wallets that appear across multiple Pump.fun tokens.
"""
import json, time, sqlite3, os, requests, signal
from datetime import datetime
from collections import defaultdict

DEX_BASE = "https://api.dexscreener.com"
DB_PATH = os.path.expanduser("~/.hermes/data/underground_wallets.db")

def rpc(base, method, params):
    try:
        r = requests.post(base, json={"jsonrpc":"2.0","id":1,"method":method,"params":params}, timeout=10)
        if r.status_code == 200: return r.json().get("result")
    except: pass
    return None

def load_env():
    env = {}
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    key = env.get("HELIUS_API_KEY") or env.get("SOLANA_RPC_URL", "").split("api-key=")[-1]
    if not key or "http" in key:
        print("ERROR: Helius API key not found in .env (SOLANA_RPC_URL).")
        exit(1)
    return f"https://mainnet.helius-rpc.com/?api-key={key}"

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for t in ["wallets", "wallet_token_map", "scan_log"]:
        c.execute(f"DROP TABLE IF EXISTS {t}")
    c.execute("""CREATE TABLE wallets (
        address TEXT PRIMARY KEY, tokens_tracked INTEGER DEFAULT 0,
        total_trades INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0, estimated_pnl_sol REAL DEFAULT 0,
        consistency_score REAL DEFAULT 0, is_underground INTEGER DEFAULT 0,
        tags TEXT DEFAULT '', first_seen TEXT, last_seen TEXT, updated_at TEXT
    )""")
    c.execute("""CREATE TABLE wallet_token_map (
        wallet TEXT, token TEXT, token_name TEXT, entry_time INTEGER,
        is_early_buyer INTEGER DEFAULT 0, current_mcap REAL DEFAULT 0,
        PRIMARY KEY (wallet, token)
    )""")
    c.execute("""CREATE TABLE scan_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scan_type TEXT,
        tokens_scanned INTEGER, wallets_found INTEGER, underground_found INTEGER,
        started_at TEXT, completed_at TEXT, duration_seconds INTEGER
    )""")
    conn.commit()
    return conn

def get_tokens():
    """Get trending Pump.fun tokens"""
    tokens = []
    try:
        r = requests.get(f"{DEX_BASE}/token-boosts/top/v1", timeout=10)
        if r.status_code == 200:
            for t in r.json()[:80]:
                if t.get("chainId") == "solana" and t.get("tokenAddress"):
                    tokens.append({"address": t["tokenAddress"], "source": "boost"})
    except: pass
    try:
        r = requests.get(f"{DEX_BASE}/search?q=pump.fun%20solana", timeout=10)
        if r.status_code == 200:
            for p in r.json().get("pairs", [])[:60]:
                if p.get("chainId") == "solana":
                    a = p.get("baseToken", {}).get("address", "")
                    if a:
                        tokens.append({"address": a, "source": "search",
                            "volume_24h": p.get("volume", {}).get("h24", 0),
                            "name": p.get("baseToken", {}).get("name", "")[:40]})
    except: pass
    seen = set()
    u = []
    for t in tokens:
        if t["address"] not in seen:
            seen.add(t["address"])
            u.append(t)
    u.sort(key=lambda x: x.get("volume_24h", 0), reverse=True)
    return u[:50]

def scan_token_txs(base, token_info, conn):
    """Scan recent transactions for a token, extract all wallets"""
    addr = token_info["address"]
    name = token_info.get("name", addr[:12])
    
    # Get recent transactions
    txs = rpc(base, "getSignaturesForAddress", [addr, {"limit": 50}])
    if not txs: return []
    
    c = conn.cursor()
    wallets = {}
    
    for tx_info in txs[:30]:
        sig = tx_info.get("signature", "")
        bt = tx_info.get("blockTime")
        if not bt: continue
        bt = int(bt)
        
        detail = rpc(base, "getTransaction", [sig, {
            "encoding": "jsonParsed", 
            "maxSupportedTransactionVersion": 0
        }])
        if not detail or detail.get("meta", {}).get("err"): continue
        
        # Get ALL unique wallets from this transaction
        accounts = detail.get("transaction", {}).get("message", {}).get("accountKeys", [])
        post_balances = detail.get("meta", {}).get("postTokenBalances", [])
        
        # Find wallets that received tokens (buyers)
        for pb in post_balances:
            if pb.get("mint") == addr:
                owner = pb.get("owner", "")
                if owner and len(owner) == 44:
                    if owner not in wallets:
                        wallets[owner] = {"first_tx": bt, "tx_count": 0, "name": name}
                    wallets[owner]["tx_count"] += 1
                    wallets[owner]["first_tx"] = min(wallets[owner]["first_tx"], bt)
        
        # Also get signer (the buyer)
        for acc in accounts:
            if isinstance(acc, dict) and acc.get("signer"):
                pubkey = acc.get("pubkey", "")
                if pubkey and len(pubkey) == 44:
                    if pubkey not in wallets:
                        wallets[pubkey] = {"first_tx": bt, "tx_count": 0, "name": name}
                    wallets[pubkey]["tx_count"] += 1
                    wallets[pubkey]["first_tx"] = min(wallets[pubkey]["first_tx"], bt)
    
    # Save to DB
    for w, data in wallets.items():
        c.execute("INSERT OR REPLACE INTO wallet_token_map VALUES (?, ?, ?, ?, ?, 0)",
            (w, addr, name, data["first_tx"], 0))
    conn.commit()
    return wallets

def find_underground(conn):
    """Find wallets that appear across multiple tokens"""
    print("\n[phase3] Finding underground wallets...")
    c = conn.cursor()
    c.execute("SELECT wallet, token, token_name, entry_time FROM wallet_token_map")
    
    wd = defaultdict(lambda: {"tokens": set(), "count": 0, "first": float('inf'), "last": 0, "names": []})
    for w, tok, name, et in c.fetchall():
        d = wd[w]
        d["tokens"].add(tok)
        d["count"] += 1
        if et:
            d["first"] = min(d["first"], et)
            d["last"] = max(d["last"], et)
        if name: d["names"].append(name)
    
    results = []
    for w, d in wd.items():
        n = len(d["tokens"])
        if n < 2: continue  # Must appear in 2+ tokens
        span = max((d["last"] - d["first"]) / 86400, 1.0) if d["first"] < float('inf') and d["last"] > 0 else 1.0
        cons = n / span
        score = n * cons  # tokens × consistency
        results.append({
            "wallet": w, "tokens": n, "entries": d["count"],
            "span": round(span, 1), "cons": round(cons, 2), "score": round(score, 2),
            "first": datetime.fromtimestamp(d["first"]).isoformat()[:10] if d["first"] < float('inf') else "",
            "last": datetime.fromtimestamp(d["last"]).isoformat()[:10] if d["last"] > 0 else "",
            "names": list(set(d["names"]))[:5]
        })
    results.sort(key=lambda x: x["score"], reverse=True)
    print(f"  Underground (2+ tokens): {len(results)}")
    return results

def deep_score(wallet_data, conn):
    """Get current mcap for each token this wallet traded"""
    w = wallet_data["wallet"]
    c = conn.cursor()
    c.execute("SELECT token, token_name FROM wallet_token_map WHERE wallet = ?", (w,))
    trades = []
    for tok, name in c.fetchall():
        try:
            r = requests.get(f"{DEX_BASE}/tokens/v1/solana/{tok}", timeout=8)
            if r.status_code == 200:
                data = r.json()
                if data and len(data) > 0:
                    mcap = float(data[0].get("marketCap") or 0)
                    trades.append({"tok": tok, "name": name, "mcap": mcap})
            time.sleep(0.15)
        except: pass
    
    # Simple PnL estimate: assume average entry at $30K mcap
    pnl = 0; w_count = 0; l_count = 0
    for t in trades:
        if t["mcap"] > 0:
            pct = (t["mcap"] / 30000 - 1) * 100
            if pct > 0: w_count += 1
            else: l_count += 1
            pnl += 0.1 * (pct / 100)
    
    wallet_data["pnl"] = round(pnl, 4)
    wallet_data["wins"] = w_count
    wallet_data["losses"] = l_count
    wallet_data["wr"] = round(w_count / max(w_count + l_count, 1) * 100, 1)
    return wallet_data

def main():
    start = time.time()
    helius = load_env()
    print("=" * 60)
    print("UNDERGROUND WALLET FINDER v4")
    print(f"Started: {datetime.now().isoformat()}")
    print("=" * 60)
    
    conn = init_db()
    tokens = get_tokens()
    if not tokens:
        print("No tokens.")
        return
    
    print(f"\n[phase2] Scanning {len(tokens)} tokens for wallet activity...")
    total_wallets = 0
    for i, tok in enumerate(tokens):
        name = tok.get("name", tok["address"][:12])
        print(f"  [{i+1}/{len(tokens)}] {name[:20]}...", end=" ", flush=True)
        try:
            wallets = scan_token_txs(helius, tok, conn)
            total_wallets += len(wallets)
            print(f"-> {len(wallets)} wallets (total: {total_wallets})")
        except Exception as e:
            print(f"-> ERR: {e}")
        if (i + 1) % 10 == 0:
            print(f"  --- {i+1}/{len(tokens)} ({time.time()-start:.0f}s) ---")
    
    underground = find_underground(conn)
    
    print(f"\n[phase4] Deep scoring top {min(len(underground), 20)}...")
    final = []
    for i, uw in enumerate(underground[:20]):
        print(f"  [{i+1}] {uw['wallet'][:16]}... ({uw['tokens']} tok)", end=" ", flush=True)
        try:
            e = deep_score(uw, conn)
            final.append(e)
            print(f"PnL={e['pnl']:.3f} WR={e['wr']}%")
        except Exception as e:
            print(f"ERR: {e}")
            final.append(uw)
    
    # Save
    print(f"\n[phase5] Saving...")
    c = conn.cursor()
    now = datetime.now().isoformat()
    for r in final:
        c.execute("""INSERT OR REPLACE INTO wallets 
            (address, tokens_tracked, total_trades, wins, losses, win_rate,
             estimated_pnl_sol, consistency_score, is_underground, tags, 
             first_seen, last_seen, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)""",
            (r["wallet"], r["tokens"], r.get("entries", 0),
             r.get("wins", 0), r.get("losses", 0), r.get("wr", 0),
             r.get("pnl", 0), r.get("cons", 0),
             json.dumps(r.get("names", [])),
             r.get("first", ""), r.get("last", ""), now))
    dur = int(time.time() - start)
    c.execute("INSERT INTO scan_log VALUES (NULL,?,?,?,?,?,?,?)",
        ("v4", len(tokens), len(underground), len(final),
         datetime.fromtimestamp(start).isoformat(), now, dur))
    conn.commit()

    # Auto-populate Charon main DB saved_wallets table
    charon_db_path = os.path.expanduser("~/Kaiser.charon/charon.sqlite")
    if os.path.exists(charon_db_path):
        try:
            charon_conn = sqlite3.connect(charon_db_path)
            charon_c = charon_conn.cursor()
            now_ms = int(time.time() * 1000)
            added_count = 0
            for i, r in enumerate(final):
                addr = r["wallet"]
                label = f"whale_{addr[:6]}_{addr[-4:]}"
                try:
                    charon_c.execute("INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)",
                                     (label, addr, now_ms))
                    added_count += 1
                except Exception as ex:
                    pass
            charon_conn.commit()
            charon_conn.close()
            print(f"[phase5] Successfully synced {added_count} smart wallets into Charon charon.sqlite!")
        except Exception as e:
            print(f"[phase5] Error syncing to Charon DB: {e}")
    
    print(f"\n{'='*60}")
    print("TOP UNDERGROUND WALLETS")
    print(f"{'='*60}")
    for i, r in enumerate(final[:15]):
        print(f"\n#{i+1}: {r['wallet']}")
        print(f"  Tokens: {r['tokens']} | Entries: {r.get('entries',0)}")
        print(f"  Score: {r.get('score',0)} | Consistency: {r.get('cons',0)}")
        print(f"  PnL: {r.get('pnl',0):.3f} SOL | WR: {r.get('wr',0)}%")
        print(f"  {r.get('first','')} -> {r.get('last','')}")
        if r.get("names"): print(f"  Tokens: {', '.join(r['names'][:3])}")
    print(f"\nDB: {DB_PATH}")
    print(f"Duration: {dur}s | Done: {datetime.now().isoformat()}")
    print(f"{'='*60}")
    conn.close()

if __name__ == "__main__":
    main()
