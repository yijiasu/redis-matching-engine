-- Redis Lua script for initial setup
-- This script should be only executed once when the redis server is started

-- Write the timestamp of service start to redis
local timetuple = redis.call('TIME')
local timestamp = math.floor(timetuple[1] * 1000 + timetuple[2] / 1000)
redis.call("SET", "service_start_time", timestamp)

-- Initialize the order book. Remove all existing orders
redis.call("DEL", "order:*")

-- Initialize the trade sequence. Remove all existing trade sequences
redis.call("DEL", "trade:*")

-- Return OK
return "OK"