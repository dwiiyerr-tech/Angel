const sqlite3 = require('better-sqlite3');
const db = new sqlite3('/root/Kaiser.charon/charon.sqlite');
const logs = db.prepare("SELECT * FROM decision_logs WHERE event_type='dry_run_position_create_failed' LIMIT 5;").all();
console.log(JSON.stringify(logs, null, 2));
