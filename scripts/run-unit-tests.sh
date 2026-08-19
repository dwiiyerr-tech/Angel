#!/usr/bin/env bash
set -uo pipefail

test_tmp_dir="$(mktemp -d /tmp/angel-tests-XXXXXX)"
export DB_PATH="$test_tmp_dir/angel.sqlite"
trap 'rm -rf -- "$test_tmp_dir"' EXIT

node --input-type=module --eval "import('./src/db/connection.js').then(({ initDb }) => initDb())" || exit 1

failed=0
passed=0
total=0

for test_file in test/unit/*.js; do
  total=$((total + 1))
  echo
  echo "===== $(basename "$test_file") ====="
  if timeout 60s node "$test_file"; then
    passed=$((passed + 1))
  else
    failed=1
    echo "[unit] FAILED $test_file"
  fi
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

echo
echo "[unit] Clean! Passed $passed/$total test files using an isolated database."
