# Redis Matching Engine

A high-performance order matching engine implemented in Redis using Lua scripting. This matching engine provides real-time order book management and trade matching capabilities.

## Overview

This matching engine uses Redis as the backend storage and processing engine, implementing a price-time priority matching algorithm for limit orders.

## Data Structures

### Order Book Structure

The order book is implemented using Redis Sorted Sets with the following key patterns:

- Buy orders: `buy_book_{symbol}`
- Sell orders: `sell_book_{symbol}`
- Individual orders: `order:{order_id}`

The score in the sorted sets is a composite of price and timestamp, ensuring both price and time priority.

#### Order Hash Fields
Each order is stored as a Redis Hash with the following fields:
- `price`: The limit price of the order
- `qty`: Remaining quantity
- `side`: "buy" or "sell"
- `user_id`: ID of the user who placed the order
- `timestamp`: Order creation timestamp

### Sequence Management
The engine maintains several sequence counters:
- `order_seq_{symbol}`: Global order sequence (0-99999)
- `buy_seq_{symbol}`: Buy order sequence (0-99)
- `sell_seq_{symbol}`: Sell order sequence (0-99)
- `trade_seq_{symbol}`: Trade sequence (0-99)

## Event Subscriptions

The engine publishes real-time updates through Redis PubSub channels:

### Order Book Updates
- Channel: `orderbook:{symbol}`
- Format: `price1,quantity1|price2,quantity2...\nprice1,quantity1|price2,quantity2...`
  - First line: Bid levels
  - Second line: Ask levels

### Trade Updates
- Channel: `trades:{symbol}`
- Format: `price,quantity,timestamp`

### Subscribe to orderbook updates

```
redis-cli SUBSCRIBE orderbook:BTCUSD
redis-cli SUBSCRIBE trades:BTCUSD
```

### Uploading Script and Inserting Orders

```
# Upload the script
redis-cli SCRIPT LOAD "$(cat exchange.lua)"

# Insert an order

redis-cli EVALSHA <script_sha> 1 BTCUSD limit 1001 buy 50000 10

KEYS:
1. order_symbol

ARGS:
1. order_type (limit, market)
2. user_id (integer)
3. side (buy, sell)
4. price (integer)
5. quantity (integer)

```

### Performance

```

  Exchange Performance Tests
01:36:06 [Redis] INFO: (index.ts:31) Loaded exchange script with SHA-1 hash: 3ffbd0c0f23b62b334b238ab56170ad67681bafd
01:36:06 [Performance] INFO: (performance.ts:53) Exchange script loaded
01:36:06 [Performance] INFO: (performance.ts:64) Cleared existing order books
01:36:06 [Performance] INFO: (performance.ts:75) Generated 20000 test orders
01:36:06 [Performance] INFO: (performance.ts:93) Performance Test Results:
01:36:06 [Performance] INFO: (performance.ts:94) Total orders: 20000
01:36:06 [Performance] INFO: (performance.ts:95) Successful orders: 20000
01:36:06 [Performance] INFO: (performance.ts:96) Total time: 232.14ms
01:36:06 [Performance] INFO: (performance.ts:97) TPS: 86155.99
    ✔ should handle high-volume order processing (235ms)


  1 passing (263ms)
  
```
