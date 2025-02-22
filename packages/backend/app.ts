import { createLogger } from "../common/logger";
import yargs, { command } from "yargs";
import { hideBin } from 'yargs/helpers';

import { Redis } from "ioredis";
import { workspaceRootSync } from "workspace-root";
import fs from "fs";
import path from "path";
import { loadExchangeScript, createRedis } from "../redis";


const logger = createLogger("Default");

type GlobalState = typeof globalState;
const globalState = {
  scriptHash: ""
};

interface Order {
  userId: number;
  side: "buy" | "sell";
  symbol: string;
  price: number; // only integer
  qty: number; // only integer
}

interface OrderResult {
  status: 'open' | 'partial' | 'filled';
  orderId: string;
  remainingQty?: number;
  tradeIds?: string[];
}


// local order_type = ARGV[1]
// local side = ARGV[2]
// local price = tonumber(ARGV[3])
// local quantity = tonumber(ARGV[4])

async function parseOrderResult(result: string): Promise<OrderResult> {
  const parts = result.split(',');
  const [status, orderId, ...args] = parts;
  
  if (status === 'open') {
    return { status: 'open', orderId };
  } else if (status === 'partial') {
    const [remainingQty, ...tradeIds] = args;
    return { 
      status: 'partial', 
      orderId,
      remainingQty: Number(remainingQty),
      tradeIds 
    };
  } else { // filled
    return { 
      status: 'filled', 
      orderId,
      tradeIds: args 
    };
  }
}

async function placeOrder(redis: Redis, globalState: GlobalState, order: Order) {
  const nOrder = { ...order, price: Math.floor(order.price), qty: Math.floor(order.qty) };
  const result = await redis.evalsha(
    globalState.scriptHash,
    1,
    nOrder.symbol,
    "limit",
    nOrder.userId,
    nOrder.side,
    nOrder.price,
    nOrder.qty
  );

  const orderResult = await parseOrderResult(result as string);
  
  // Log the order execution details
  logger.info(`Order ${orderResult.orderId} ${orderResult.status.toUpperCase()}`);
  if (orderResult.status === 'open') {
    logger.info(`Placed in orderbook: ${nOrder.side.toUpperCase()} ${nOrder.qty}@${nOrder.price}`);
  } else if (orderResult.status === 'partial') {
    logger.info(`Executed: ${nOrder.qty - orderResult.remainingQty}@${nOrder.price}`);
    logger.info(`Remaining: ${orderResult.remainingQty}@${nOrder.price}`);
    logger.info(`Trade IDs: ${orderResult.tradeIds.join(', ')}`);
  } else { // filled
    logger.info(`Fully executed: ${nOrder.qty}@${nOrder.price}`);
    logger.info(`Trade IDs: ${orderResult.tradeIds.join(', ')}`);
  }
}


async function setup() {
  const redis = createRedis();
  globalState.scriptHash = await loadExchangeScript(redis);
  return { redis, globalState };
}

async function teardown(redis: Redis) {
  await redis.quit();
}

async function main() {
  const logger = createLogger("Bootstrap");
  const { op, args } = useMenu();

  logger.info(`Starting with runmode: ${op}`);
  logger.info(`ARGS: ${JSON.stringify(args)}`);
  const { redis, globalState } = await setup();

  if (op === "serve") {
    // start web server
  }
  else if (op.startsWith("orderbook:")) {
    const subcmd = op.split(":")[1];
    switch (subcmd) {
      case "list":
        break;
      case "buy": {
        const [userId, symbol, price, quantity] = args as Array<string>;
        await placeOrder(redis, globalState, { userId: Number(userId), symbol, side: "buy", price: Number(price), qty: Number(quantity) });
        logger.info(`Order Placed: BUY >>> ${symbol}; PRICE = ${price}; QTY = ${quantity}`);
        break;
      }
      case "sell": {
        const [userId, symbol, price, quantity] = args as Array<string>;
        await placeOrder(redis, globalState, { userId: Number(userId), symbol, side: "sell", price: Number(price), qty: Number(quantity) });
        logger.info(`Order Placed: SELL >>> ${symbol}; PRICE = ${price}; QTY = ${quantity}`);
        break;
      }
      case "cancel":
        break;
      default:
        throw new Error(`Invalid subcommand: ${subcmd}`);
    }
  }

  await teardown(redis);

}


function useMenu() {
  const { _: command, func, args } = yargs
  .command({
    command: 'serve',
    describe: 'Start the server',
    builder: yargs => 
      yargs.option('port', {
        alias: 'p',
        type: 'number',
        description: 'Port to listen for WebAPI',
        default: 3030
      }),
    handler: () => {}
  })

  // START TEMPORARY COMMANDS
  .command({
    command: 'load-script',
    describe: 'Load the exchange script',
    handler: async () => {
      const redis = createRedis();
      globalState.scriptHash = await loadExchangeScript(redis);
    }
  })
  // END TEMPORARY COMMANDS

  .command({
    command: 'orderbook [func] [args...]', 
    describe: 'Orderbook Control',    
    builder: {
      func: {
        demand: true,
        type: 'string',
        description: 'Orderbook function to execute',
        choices: ['list', 'buy', 'sell', 'cancel']
      }
    },
    handler: argv => {}})
    .demandCommand(1, 'You need to specify a command')
    .help().parseSync(hideBin(process.argv));

  if (command.length !== 1) {
    throw new Error("Invalid command length");
  }

  const op = [command[0], func].filter(e => !!e).join(":")
  return { op, args }
}

main();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});