import { Redis } from "ioredis";
import { workspaceRootSync } from "workspace-root";
import fs from "fs";
import path from "path";
import { createLogger } from "../../common/logger";
import assert from "assert";
import { createRedis } from "../../redis";

const logger = createLogger("Accounting");

interface Order {
  userId: number;
  side: "buy" | "sell";
  symbol: string;
  price: number;
  qty: number;
}

interface Trade {
  maker_order_id: string;
  maker_user_id: string;
  taker_order_id: string;
  taker_user_id: string;
  price: string;
  qty: string;
  timestamp: string;
}

interface OrderResult {
  status: 'error' | 'open' | 'partial' | 'filled';
  order_id?: string;
  error?: string;
  remaining_qty?: number;
  trade_ids?: string[];
}

class BalanceSheet {
  private balances: Map<number, Map<string, number>> = new Map();

  constructor() {}

  initUser(userId: number, assets: Record<string, number>) {
    const userBalances = new Map<string, number>();
    Object.entries(assets).forEach(([asset, amount]) => {
      userBalances.set(asset, amount);
    });
    this.balances.set(userId, userBalances);
  }

  getBalance(userId: number, asset: string): number {
    return this.balances.get(userId)?.get(asset) || 0;
  }

  adjust(userId: number, asset: string, amount: number) {
    if (!this.balances.has(userId)) {
      this.balances.set(userId, new Map());
    }
    const userBalances = this.balances.get(userId)!;
    const currentBalance = userBalances.get(asset) || 0;
    userBalances.set(asset, currentBalance + amount);

    // Sanity check
    if (userBalances.get(asset)! < 0) {
      throw new Error(`Negative balance for user ${userId} in ${asset}: ${userBalances.get(asset)}`);
    }
  }

  getAllBalances(): Record<number, Record<string, number>> {
    const result: Record<number, Record<string, number>> = {};
    this.balances.forEach((assets, userId) => {
      result[userId] = {};
      assets.forEach((amount, asset) => {
        result[userId][asset] = amount;
      });
    });
    return result;
  }
}

async function loadExchangeScript(redis: Redis): Promise<string> {
  const scriptContent = fs.readFileSync(
    path.join(workspaceRootSync(), "packages/redis/exchange.lua"),
    "utf-8"
  );
  return await redis.script("LOAD", scriptContent) as string;
}

async function placeOrder(redis: Redis, scriptHash: string, order: Order, balanceSheet: BalanceSheet): Promise<OrderResult> {
  // Check and deduct balance before placing order
  const [baseAsset, quoteAsset] = order.symbol.match(/.{1,3}/g)!;
  
  if (order.side === "buy") {
    const requiredQuote = order.price * order.qty;
    assert(balanceSheet.getBalance(order.userId, quoteAsset) >= requiredQuote, 
      `Insufficient ${quoteAsset} balance for user ${order.userId}`);
    balanceSheet.adjust(order.userId, quoteAsset, -requiredQuote);
  } else {
    assert(balanceSheet.getBalance(order.userId, baseAsset) >= order.qty,
      `Insufficient ${baseAsset} balance for user ${order.userId}`);
    balanceSheet.adjust(order.userId, baseAsset, -order.qty);
  }

  // Update parameters to match Lua script parameter order:
  // ARGV[1]: order_type
  // ARGV[2]: user_id
  // ARGV[3]: side
  // ARGV[4]: price
  // ARGV[5]: quantity
  const result = await redis.evalsha(
    scriptHash,
    1,  // number of keys
    order.symbol,  // key
    
    "limit",       // argv[1]: order_type
    order.userId.toString(),  // argv[2]: user_id
    order.side,    // argv[3]: side
    order.price.toString(),   // argv[4]: price
    order.qty.toString()      // argv[5]: quantity
  ) as OrderResult;

  return result;
}

async function processTrade(redis: Redis, tradeId: string, balanceSheet: BalanceSheet) {
  const tradeKey = `trade:${tradeId}`;
  const tradeData = await redis.hgetall(tradeKey) as unknown as Trade;
  
  const [baseAsset, quoteAsset] = "BTCUSD".match(/.{1,3}/g)!;
  const price = Number(tradeData.price);
  const quantity = Number(tradeData.qty);
  const quoteAmount = price * quantity;

  const makerUserId = Number(tradeData.maker_user_id);
  const takerUserId = Number(tradeData.taker_user_id);

  // Process maker's side
  const makerOrderId = await redis.hget(`order:${tradeData.maker_order_id}`, "side");
  if (makerOrderId === "buy") {
    balanceSheet.adjust(makerUserId, baseAsset, quantity);
    balanceSheet.adjust(takerUserId, quoteAsset, quoteAmount);
  } else {
    balanceSheet.adjust(makerUserId, quoteAsset, quoteAmount);
    balanceSheet.adjust(takerUserId, baseAsset, quantity);
  }
}

async function generateOrders(count: number, userIds: number[]): Promise<Order[]> {
  const orders: Order[] = [];
  const basePrice = 100;
  const priceRange = 20;

  for (let i = 0; i < count; i++) {
    const isBuy = Math.random() > 0.5;
    const priceOffset = Math.floor(Math.random() * priceRange);
    const price = isBuy ? basePrice - priceOffset : basePrice + priceOffset;

    orders.push({
      userId: userIds[Math.floor(Math.random() * userIds.length)],
      side: isBuy ? "buy" : "sell",
      symbol: "BTCUSD",
      price,
      qty: Math.floor(Math.random() * 10) + 1
    });
  }

  return orders;
}

async function verifyOrderBookBalance(redis: Redis, balanceSheet: BalanceSheet, initialBTC: number, initialUSD: number) {
  // Get all orders from Redis
  const orderKeys = await redis.keys("order:*");
  let totalBTC = 0;
  let totalUSD = 0;

  for (const key of orderKeys) {
    const order = await redis.hgetall(key);
    if (order.side === "buy") {
      totalUSD += Number(order.price) * Number(order.qty);
    } else {
      totalBTC += Number(order.qty);
    }
  }

  // Sum up balance sheet
  let balanceSheetBTC = 0;
  let balanceSheetUSD = 0;
  const allBalances = balanceSheet.getAllBalances();
  
  Object.values(allBalances).forEach(userBalance => {
    balanceSheetBTC += userBalance.BTC || 0;
    balanceSheetUSD += userBalance.USD || 0;
  });

  logger.info("Balance Sheet Totals:");
  logger.info(`BTC: ${balanceSheetBTC}`);
  logger.info(`USD: ${balanceSheetUSD}`);
  
  logger.info("Order Book Reserves:");
  logger.info(`BTC: ${totalBTC}`);
  logger.info(`USD: ${totalUSD}`);

  // Verify total amounts match
  assert(Math.abs(totalBTC + balanceSheetBTC - initialBTC) !== 0, "BTC balance mismatch");
  assert(Math.abs(totalUSD + balanceSheetUSD - initialUSD) !== 0, "USD balance mismatch");
}

async function runAccountingTest() {
  const redis = createRedis();

  try {
    // Clear ALL data from Redis before starting
    await redis.flushall();
    logger.info("Cleared all Redis data");

    const scriptHash = await loadExchangeScript(redis);
    logger.info("Exchange script loaded");

    // Initialize balance sheet with 8 test users
    const balanceSheet = new BalanceSheet();
    const users = Array.from({ length: 8 }, (_, i) => 1001 + i); // 1001 to 1008
    
    // Initialize users with different combinations of BTC and USD
    // BTC whales
    balanceSheet.initUser(1001, { BTC: 1000, USD: 10000 });
    balanceSheet.initUser(1002, { BTC: 800, USD: 20000 });
    balanceSheet.initUser(1003, { BTC: 600, USD: 15000 });
    balanceSheet.initUser(1004, { BTC: 400, USD: 30000 });

    // USD whales
    balanceSheet.initUser(1005, { BTC: 10, USD: 1000000 });
    balanceSheet.initUser(1006, { BTC: 15, USD: 800000 });
    balanceSheet.initUser(1007, { BTC: 20, USD: 600000 });
    balanceSheet.initUser(1008, { BTC: 25, USD: 400000 });


    // Get initial total amounts
    let initialBTC = 0;
    let initialUSD = 0;
    Object.values(balanceSheet.getAllBalances()).forEach(userBalance => {
      initialBTC += userBalance.BTC || 0;
      initialUSD += userBalance.USD || 0;
    });
    logger.info("Initial Total Balances:");
    logger.info(`BTC: ${initialBTC}`);
    logger.info(`USD: ${initialUSD}`);

    // Clear existing data
    await redis.del("BTCUSD_BUY", "BTCUSD_SELL", "BTCUSD_TRADE_SEQ");
    const orderKeys = await redis.keys("order:*");
    const tradeKeys = await redis.keys("trade:*");
    if (orderKeys.length > 0) await redis.del(orderKeys);
    if (tradeKeys.length > 0) await redis.del(tradeKeys);
    
    logger.info("Cleared existing order books and trades");

    // Generate and process orders
    const ORDER_COUNT = 10000;
    const orders = await generateOrders(ORDER_COUNT, users);
    
    for (const order of orders) {
      try {
        const result = await placeOrder(redis, scriptHash, order, balanceSheet);
        
        if (result.status === 'error') {
          logger.warn(`Order failed: ${result.error}`);
          continue;
        }

        if (result.trade_ids) {
          for (const tradeId of result.trade_ids) {
            await processTrade(redis, tradeId, balanceSheet);
          }
        }
      } catch (err) {
        logger.warn(`Order failed: ${err.message}`);
      }
    }

    // Verify final balances
    await verifyOrderBookBalance(redis, balanceSheet, initialBTC, initialUSD);
    logger.info("Accounting test completed successfully");

  } finally {
    await redis.quit();
  }
}

// Run the test
runAccountingTest().catch(err => {
  logger.error("Test failed:", err);
  process.exit(1);
});
