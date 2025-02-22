import { Redis } from "ioredis";
import { createLogger } from "../../common/logger";
import { createRedis, loadExchangeScript } from "../../redis";
import { Order } from "../../common/types";

const logger = createLogger("Performance");

async function placeOrder(redis: Redis, scriptHash: string, order: Order): Promise<string> {
  return await redis.evalsha(
    scriptHash,
    1,
    order.symbol,
    "limit",
    order.userId,
    order.side,
    Math.floor(order.price),
    Math.floor(order.quantity)
  ) as string;
}

async function generateOrders(count: number): Promise<Order[]> {
  const orders: Order[] = [];
  const basePrice = 200;
  const priceRange = 20;

  for (let i = 0; i < count; i++) {
    const isBuy = Math.random() > 0.5;
    const priceOffset = Math.floor(Math.random() * priceRange);
    const price = isBuy ? basePrice - priceOffset : basePrice + priceOffset;

    orders.push({
      userId: Math.floor(Math.random() * 1000) + 1,
      side: isBuy ? "buy" : "sell",
      symbol: "BTCUSD",
      price,
      quantity: Math.floor(Math.random() * 10) + 1
    });
  }

  return orders;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processOrdersSequentially(orders: Order[], redis: Redis, scriptHash: string): Promise<number> {
  let successfulOrders = 0;
  
  for (const order of orders) {
    try {
      await placeOrder(redis, scriptHash, order);
      successfulOrders++;
      await delay(10); // Wait 100ms between orders
    } catch (err) {
      logger.error(`Order failed: ${err.message}`);
    }
  }
  
  return successfulOrders;
}

describe('Exchange Performance Tests', () => {
  let redis: Redis;
  let scriptHash: string;

  before(async () => {
    redis = createRedis();
    // Flush all Redis data before starting tests
    await redis.flushall();
    
    scriptHash = await loadExchangeScript(redis);
    logger.info("Exchange script loaded");
  });

  after(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    // Clear existing data before each test
    await redis.del("BTCUSD_BUY", "BTCUSD_SELL", "trade_seq:BTCUSD");
    logger.info("Cleared existing order books");
  });

  it('should handle high-volume order processing', async function() {
    // Increase timeout for this test
    this.timeout(300000); // 5 minutes

    const ORDER_COUNT = 200;
    
    // Generate test orders
    const orders = await generateOrders(ORDER_COUNT);
    logger.info(`Generated ${ORDER_COUNT} test orders`);

    // Run the performance test
    const startTime = process.hrtime();

    let successfulOrders = await processOrdersSequentially(orders, redis, scriptHash);

    const [seconds, nanoseconds] = process.hrtime(startTime);
    const totalTimeMs = (seconds * 1000) + (nanoseconds / 1000000);
    const tps = (successfulOrders / totalTimeMs) * 1000;

    logger.info("Performance Test Results:");
    logger.info(`Total orders: ${ORDER_COUNT}`);
    logger.info(`Successful orders: ${successfulOrders}`);
    logger.info(`Total time: ${totalTimeMs.toFixed(2)}ms`);
    logger.info(`TPS: ${tps.toFixed(2)}`);
  });
});
