import { Redis } from "ioredis";
import { createLogger } from "../common/logger";
import path from "path";
import fs from "fs";
import { workspaceRootSync } from "workspace-root";

const logger = createLogger("Redis");

export function createRedis() {
  return new Redis({
    host: "localhost",
    port: 6379,
  });
}

export async function loadExchangeScript(redis: Redis): Promise<string> {

  // evaluate the initial script to setup the redis database
  const initialScriptContent = fs.readFileSync(path.join(workspaceRootSync(), "packages/redis/initial.lua"), "utf-8");
  const initialResult = await redis.eval(initialScriptContent, 0);

  // ensure return OK, otherwise throw an error
  if (initialResult !== "OK") {
    throw new Error("Failed to setup redis database. Initial script returned: " + initialResult);
  }

  // ensure we load the exchange script and return the SHA-1 hash
  const exchangeScriptContent = fs.readFileSync(path.join(workspaceRootSync(), "packages/redis/exchange.lua"), "utf-8");
  const exchangeScript = await redis.script("LOAD", exchangeScriptContent) as string;
  // console.log(script);
  logger.info(`Loaded exchange script with SHA-1 hash: ${exchangeScript}`);
  // TODO: verify the script SHA-1
  return exchangeScript;
}

