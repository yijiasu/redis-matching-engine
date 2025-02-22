-- Redis Lua script for a matching engine

-- KEYS:
-- 1: symbol (e.g., "BTCUSD")
-- 2: order details (HASH: order:{order_id})

-- ARGV:
-- 1: order_type ("limit" or "market")
-- 2: user_id (integer)
-- 3: side ("buy" or "sell")
-- 4: price
-- 5: quantity
-- 6: timestamp (in milliseconds)

-- Add at the top with other global variables
local ORDERBOOK_TIME_THRESHOLD = 50  -- 50ms threshold

-- Get current timestamp
local timetuple = redis.call('TIME')
local timestamp = math.floor(timetuple[1] * 1000 + timetuple[2] / 1000)

-- Log the timestamp
-- redis.log(redis.LOG_NOTICE, "Timestamp: " .. timestamp)

local symbol = KEYS[1]


local order_type = ARGV[1]
local user_id = tonumber(ARGV[2])
local side = ARGV[3]
local price = tonumber(ARGV[4])
local quantity = tonumber(ARGV[5])

local buy_book = "buy_book_" .. symbol
local sell_book = "sell_book_" .. symbol

-- Add new key for trade sequence
local trade_seq_key = "trade_seq_" .. symbol

-- Add new keys for buy and sell order sequences
local buy_seq_key = "buy_seq_" .. symbol
local sell_seq_key = "sell_seq_" .. symbol


-- Use a global order sequence key
local order_seq_key = "order_seq_" .. symbol
local order_seq = redis.call("INCR", order_seq_key)

-- Reset order_seq if it reaches 100000
if order_seq >= 100000 then
    redis.call("SET", order_seq_key, 0)
    order_seq = 0
end

-- Generate order ID using timestamp and sequence
-- Format: timestamp-seq (e.g., 1740220532407-00042)
local order_id = string.format("%.0f-%05d", timestamp, order_seq)


-- Function to create a composite score from price and sequence
local function create_score(price, seq, is_buy)
    -- Mod timestamp with 100000 to keep it manageable (gives us 0-99999)
    -- Then add sequence (0-99) to maintain time priority within same price
    local time_component = (timestamp % 100000) * 100 + seq
    -- Add as a small fraction to maintain price priority
    local fraction = is_buy and (1 - (time_component / 1000000)) or (time_component / 1000000)
    return price + fraction
end

-- Function to publish orderbook updates
local function publish_orderbook()
    local function aggregate_orders(orders, start_index)
        start_index = start_index or 0
        local aggregated = {}
        local price_map = {}
        local current_count = 0
        local batch_size = 100
        
        while current_count < 100 do
            -- Get next batch of orders
            local batch = redis.call("ZRANGE", orders, start_index, start_index + batch_size - 1, "WITHSCORES")
            if #batch == 0 then
                break  -- No more orders
            end
            
            -- Process batch
            for i = 1, #batch, 2 do
                local order_id = batch[i]
                local price = tonumber(redis.call("HGET", "order:" .. order_id, "price"))
                local qty = tonumber(redis.call("HGET", "order:" .. order_id, "qty"))
                
                if price and qty then
                    if not price_map[price] then
                        price_map[price] = qty
                        current_count = current_count + 1
                        table.insert(aggregated, {price = price, qty = qty})
                    else
                        price_map[price] = price_map[price] + qty
                        -- Find and update the quantity in aggregated table
                        for _, entry in ipairs(aggregated) do
                            if entry.price == price then
                                entry.qty = price_map[price]
                                break
                            end
                        end
                    end
                end
            end
            
            start_index = start_index + batch_size
            
            if current_count >= 100 then
                break
            end
            
            if #batch < batch_size * 2 then  -- Each order takes 2 entries in batch
                break  -- No more orders available
            end
        end
        
        return aggregated
    end
    
    -- Get aggregated orders
    local bids = aggregate_orders(buy_book)
    local asks = aggregate_orders(sell_book)
    
    -- Convert to strings
    local bid_strings = {}
    local ask_strings = {}
    
    for _, bid in ipairs(bids) do
        table.insert(bid_strings, bid.price .. "," .. bid.qty)
    end
    
    for _, ask in ipairs(asks) do
        table.insert(ask_strings, ask.price .. "," .. ask.qty)
    end
    
    -- Combine bids and asks with a separator
    local message = table.concat(bid_strings, "|") .. "\n" .. table.concat(ask_strings, "|")
    redis.call("PUBLISH", "orderbook:" .. symbol, message)
end

-- Function to publish a trade event
local function publish_trade(price, qty)
    -- Format as "price,quantity,timestamp"
    local trade_message = price .. "," .. qty .. "," .. timestamp
    redis.call("PUBLISH", "trades:" .. symbol, trade_message)
end

-- Modify record_trade to use the new function
local function record_trade(maker_order_id, taker_order_id, price, qty)
    local trade_seq = redis.call("INCR", trade_seq_key)
    
    -- Reset trade_seq if it reaches 100
    if trade_seq >= 100 then
        redis.call("SET", trade_seq_key, 0)
        trade_seq = 0
    end
    
    -- Create trade_id by multiplying timestamp by 100 and adding sequence
    local trade_id = (timestamp * 100) + trade_seq
    local trade_key = "trade:" .. string.format("%.0f", trade_id)
    
    -- Get maker user_id from the maker order
    local maker_user_id = redis.call("HGET", "order:" .. maker_order_id, "user_id")
    
    redis.call("HSET", trade_key,
        "maker_order_id", maker_order_id,
        "maker_user_id", maker_user_id,
        "taker_order_id", taker_order_id,
        "taker_user_id", user_id,
        "price", price,
        "qty", qty,
        "timestamp", timestamp
    )
    
    -- Use the new publish_trade function
    publish_trade(price, qty)
    
    return trade_id
end

local function match_with_book(remaining_qty, order_book, is_buy_order)
    local match_result = "open"
    local initial_qty = remaining_qty
    local trade_ids = {}
    local zrange_func = is_buy_order and "ZRANGE" or "ZREVRANGE"
    local opposite_book = is_buy_order and sell_book or buy_book
    
    while remaining_qty > 0 do
        local best_order = redis.call(zrange_func, opposite_book, 0, 0, "WITHSCORES")
        
        if #best_order == 0 then
            break
        end
        
        local match_order_id = best_order[1]
        local best_price = tonumber(redis.call("HGET", "order:" .. match_order_id, "price"))
        
        if is_buy_order then
            if price < best_price then
                break
            end
        else
            if price > best_price then
                break
            end
        end
        
        local match_qty = tonumber(redis.call("HGET", "order:" .. match_order_id, "qty"))
        local trade_qty = math.min(remaining_qty, match_qty)
        
        local trade_id = record_trade(match_order_id, order_id, best_price, trade_qty)
        table.insert(trade_ids, trade_id)
        
        if match_qty > remaining_qty then
            redis.call("HSET", "order:" .. match_order_id, "qty", match_qty - remaining_qty)
            remaining_qty = 0
            match_result = "filled"
        else
            redis.call("DEL", "order:" .. match_order_id)
            redis.call("ZREM", opposite_book, match_order_id)
            remaining_qty = remaining_qty - match_qty
        end
    end
    
    if remaining_qty == 0 then
        match_result = "filled"
    elseif remaining_qty < initial_qty then
        match_result = "partial"
    end
    
    return remaining_qty, match_result, trade_ids
end

-- Function to validate order inputs
local function validate_order()
    if not order_type or (order_type ~= "limit" and order_type ~= "market") then
        return "invalid_order_type"
    end
    if not side or (side ~= "buy" and side ~= "sell") then
        return "invalid_side"
    end
    if not price or price <= 0 then
        return "invalid_price"
    end
    if not quantity or quantity <= 0 then
        return "invalid_quantity"
    end
    return nil -- Return nil if validation passes
end

-- Function to get and manage sequence numbers
local function get_sequence_number(side)
    -- This seq reset every 100 orders
    
    local seq_key = side == "buy" and buy_seq_key or sell_seq_key
    local seq = redis.call("INCR", seq_key)
    
    -- Add reset logic for sequence numbers
    if seq >= 100 then
        redis.call("SET", seq_key, 0)
        seq = 0
    end
    
    return seq
end

-- Function to create a new order with remaining quantity
local function create_remaining_order(remaining_qty, seq)
    if order_type == "limit" and remaining_qty > 0 then
        redis.call("HSET", "order:" .. order_id,
            "price", price,
            "qty", remaining_qty,
            "side", side,
            "user_id", user_id,
            "timestamp", timestamp
        )
        local score = create_score(price, seq, side == "buy")
        if side == "buy" then
            redis.call("ZADD", buy_book, score, order_id)
        else
            redis.call("ZADD", sell_book, score, order_id)
        end
    elseif order_type == "market" then
        -- throw err not implemented
        error("market orders not implemented")
    end
end


-- Function to match orders
local function match_orders()
    -- Validate inputs first
    local validation_error = validate_order()
    if validation_error then
        return { 
            status = "error",
            error = validation_error
        }
    end
    
    local remaining_qty = quantity
    local match_result
    local trade_ids
    
    local seq = get_sequence_number(side)
    
    remaining_qty, match_result, trade_ids = match_with_book(
        remaining_qty,
        buy_book,
        side == "buy"
    )

    create_remaining_order(remaining_qty, seq)

    -- Get last publish time from Redis
    local last_publish_time = tonumber(redis.call("GET", "last_publish_time:" .. symbol)) or 0

    -- Publish only if enough time has elapsed since last publish
    if (timestamp - last_publish_time) >= ORDERBOOK_TIME_THRESHOLD then
        redis.log(redis.LOG_NOTICE, "Publishing orderbook")
        redis.log(redis.LOG_NOTICE, "Timestamp: " .. timestamp)
        redis.log(redis.LOG_NOTICE, "Last publish time: " .. last_publish_time)
        redis.log(redis.LOG_NOTICE, "Orderbook time threshold: " .. ORDERBOOK_TIME_THRESHOLD)
        publish_orderbook()
        redis.call("SET", "last_publish_time:" .. symbol, timestamp)
    end

    -- Return result as a table
    local result = {
        status = match_result,
        order_id = order_id,
        remaining_qty = (match_result == "partial") and remaining_qty or nil,
        trade_ids = (#trade_ids > 0) and trade_ids or nil
    }
    
    return result
end

return match_orders()
