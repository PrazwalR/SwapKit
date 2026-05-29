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

for i in {1..500}; do
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" http://127.0.0.1:3030/simulate > /dev/null &
done

wait

END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))

echo "Completed in $DURATION ms."

kill $SERVER_PID

echo "Test done."
