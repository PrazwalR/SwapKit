#!/bin/bash
set -e

echo "Building and starting server..."
cargo run --release > server.log 2>&1 &
SERVER_PID=$!

echo "Server PID: $SERVER_PID"

# Wait for server to start
sleep 5

echo "Testing /simulate endpoint with 500 parallel requests..."

PAYLOAD='{"from_token":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","to_token":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","from_amount":"100000000000000000000","chain_id":1,"protocol":"uniswap-v4","amount_out":"200000000000","slippage_bps":200}'

START=$(date +%s%N)

pids=""
for i in {1..500}; do
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" http://127.0.0.1:3030/simulate > /dev/null &
  pids="$pids $!"
done

for pid in $pids; do
  wait $pid
done

END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))

echo "Completed 500 simulate requests in $DURATION ms."

echo "Testing /mine endpoint with 20 parallel requests to test CPU starvation..."
PAYLOAD_MINE='{"deployer":"0x0000000000000000000000000000000000000001","init_code_hash":"0x0000000000000000000000000000000000000000000000000000000000000001","prefix":"00","max_iterations":1000000}'

START=$(date +%s%N)
pids=""
for i in {1..20}; do
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD_MINE" http://127.0.0.1:3030/mine > /dev/null &
  pids="$pids $!"
done

for pid in $pids; do
  wait $pid
done

END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))
echo "Completed 20 mine requests in $DURATION ms."

kill $SERVER_PID

echo "Test done."
