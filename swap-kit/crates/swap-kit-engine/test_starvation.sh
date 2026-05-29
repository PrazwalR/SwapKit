#!/bin/bash
set -e

cargo run --release > server.log 2>&1 &
SERVER_PID=$!
sleep 5

# Start heavy mining requests (prefix "000000" takes a long time)
PAYLOAD_MINE='{"deployer":"0x0000000000000000000000000000000000000001","init_code_hash":"0x0000000000000000000000000000000000000000000000000000000000000001","prefix":"000000","max_iterations":10000000}'

pids=""
for i in {1..20}; do
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD_MINE" http://127.0.0.1:3030/mine > /dev/null &
  pids="$pids $!"
done

# While mining is happening, measure /simulate latency
PAYLOAD_SIM='{"from_token":"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","to_token":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","from_amount":"100000000000000000000","chain_id":1,"protocol":"uniswap-v4","amount_out":"200000000000","slippage_bps":200}'

sleep 1 # let mining start

START=$(date +%s%N)
curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD_SIM" http://127.0.0.1:3030/simulate > /dev/null
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 ))

echo "Simulate latency under load: $DURATION ms."

kill $SERVER_PID
