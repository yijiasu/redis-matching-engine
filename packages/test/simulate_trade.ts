import { Redis } from "ioredis";
import { createRedis, loadExchangeScript } from "../redis";
import { Order } from "../common/types";

interface SimulationConfig {
    baseFrequencyMs: number;    // Base delay between orders
    volatility: number;         // For Brownian motion
    spreadRange: number;        // Max price difference from market price
    traderCount: number;        // Number of simultaneous traders
    priceUpdateMs: number;      // Interval for price updates
}

class TradeSimulator {
    private redis: Redis;
    private scriptHash: string;
    private referencePrice: number;
    private currentPrice: number;
    private lastUpdateTime: number;
    private config: SimulationConfig;
    private running: boolean = false;
    private priceUpdateInterval: NodeJS.Timeout | null = null;
    private refPriceUpdateInterval: NodeJS.Timeout | null = null;

    constructor(config: SimulationConfig) {
        this.config = config;
        this.lastUpdateTime = Date.now();
    }

    async initialize() {
        this.redis = createRedis();
        await this.redis.flushall();
        this.scriptHash = await loadExchangeScript(this.redis);
        this.referencePrice = await this.fetchBitcoinPrice();
        this.currentPrice = this.referencePrice;
        console.log(`Initial reference price: ${this.referencePrice}`);
    }

    private async fetchBitcoinPrice(): Promise<number> {
        try {
            const response = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
            const data = await response.json();
            return Math.floor(Number(data.data.amount));
        } catch (error) {
            console.error('Error fetching Bitcoin price:', error);
            return 50000; // Fallback price if API fails
        }
    }

    private updatePrice() {
        const elapsed = (Date.now() - this.lastUpdateTime) / 1000;
        const randomWalk = Math.random() - 0.5;
        // Brownian motion formula
        const priceChange = this.config.volatility * randomWalk * Math.sqrt(elapsed);
        this.currentPrice = Math.max(1, Math.floor(this.currentPrice + priceChange));
        this.lastUpdateTime = Date.now();
        
        // Add price logging
        console.log(`Current simulated price: ${this.currentPrice}`);
    }

    private async placeOrder(order: Order) {
        try {
            await this.redis.evalsha(
                this.scriptHash,
                1,
                order.symbol,
                "limit",
                order.userId,
                order.side,
                Math.floor(order.price),
                Math.floor(order.quantity)
            );
        } catch (error) {
            console.error('Error placing order:', error);
        }
    }

    private generateOrder(): Order {
        const userId = Math.floor(Math.random() * 9000) + 1000; // 1000-9999
        const isBuy = Math.random() > 0.5;
        const priceVariation = Math.floor(Math.random() * this.config.spreadRange);
        
        // Occasionally place market-crossing orders (10% chance)
        const crossesMarket = Math.random() < 0.10;
        
        let price = this.currentPrice;
        if (crossesMarket) {
            price += isBuy ? priceVariation : -priceVariation;
        } else {
            price += isBuy ? -priceVariation : priceVariation;
        }

        return {
            userId,
            side: isBuy ? "buy" : "sell",
            symbol: "BTCUSD",
            price: Math.max(1, Math.floor(price)),
            quantity: Math.floor(Math.random() * 5) + 1 // 1-5 units
        };
    }

    private async simulateTrader() {
        while (this.running) {
            const order = this.generateOrder();
            await this.placeOrder(order);
            
            // Random delay based on base frequency
            const delay = this.config.baseFrequencyMs * (0.5 + Math.random());
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    async start() {
        this.running = true;
        console.log('Starting trade simulation...');

        // Start price updates
        this.priceUpdateInterval = setInterval(() => {
            this.updatePrice();
        }, this.config.priceUpdateMs);

        // Start reference price updates every 5 seconds
        this.refPriceUpdateInterval = setInterval(async () => {
            this.referencePrice = await this.fetchBitcoinPrice();
            console.log(`Updated reference price: ${this.referencePrice}`);
            // Gradually move current price towards reference price
            this.currentPrice = Math.floor(
                this.currentPrice * 0.50 + this.referencePrice * 0.50
            );
        }, 3000);

        // Start multiple traders
        const traders = Array(this.config.traderCount).fill(null).map(() => 
            this.simulateTrader()
        );

        // Handle shutdown
        process.on('SIGINT', async () => {
            console.log('Stopping simulation...');
            this.running = false;
            if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);
            if (this.refPriceUpdateInterval) clearInterval(this.refPriceUpdateInterval);
            await this.redis.quit();
            process.exit();
        });

        await Promise.all(traders);
    }
}

// Start the simulation
async function main() {
    const config: SimulationConfig = {
        baseFrequencyMs: 1000,    // Average 1 second between orders per trader
        volatility: 2,            // Price can change by up to 2 points per second
        spreadRange: 10,          // Orders can be up to 10 points away from market price
        traderCount: 50,          // 5 simultaneous traders
        priceUpdateMs: 100        // Update price every 100ms
    };

    const simulator = new TradeSimulator(config);
    await simulator.initialize();
    await simulator.start();
}

main().catch(console.error);
