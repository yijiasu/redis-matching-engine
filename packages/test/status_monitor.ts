import * as blessed from "blessed";
import Redis from "ioredis";
import moment from "moment";

interface Order {
  price: number;
  quantity: number;
}

interface Trade {
  price: number;
  quantity: number;
  timestamp: number;
}

class OrderBookMonitor {
  private screen: blessed.Widgets.Screen;
  private orderBookBox: blessed.Widgets.BoxElement;
  private sellOrdersBox: blessed.Widgets.BoxElement;
  private buyOrdersBox: blessed.Widgets.BoxElement;
  private tradesBox: blessed.Widgets.BoxElement;
  private redis: Redis;

  constructor() {
    this.redis = new Redis();
    this.initializeScreen();
    this.subscribeToChannels();
  }

  private initializeScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Order Book Monitor",
    });

    // Create main order book box (left column)
    this.orderBookBox = blessed.box({
      width: "50%",
      height: "100%",
      left: 0,
      top: 0,
      border: {
        type: "line",
      },
      style: {
        border: {
          fg: "white",
        },
      },
    });

    // Create sell orders box (upper panel)
    this.sellOrdersBox = blessed.box({
      parent: this.orderBookBox,
      width: "100%-2",
      height: "50%-1",
      top: 0,
      left: 0,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      content: "{bold}Price     Quantity{/bold}\n",
      style: {
        fg: "red",
      },
    });

    // Create buy orders box (lower panel)
    this.buyOrdersBox = blessed.box({
      parent: this.orderBookBox,
      width: "100%-2",
      height: "50%-1",
      top: "50%",
      left: 0,
      tags: true,
      content: "{bold}Price     Quantity{/bold}\n",
      style: {
        fg: "green",
      },
    });

    // Create trades box (right column)
    this.tradesBox = blessed.box({
      width: "50%",
      height: "100%",
      right: 0,
      top: 0,
      border: {
        type: "line",
      },
      tags: true,
      content: "{bold}Price     Amount    Time{/bold}\n",
      style: {
        border: {
          fg: "white",
        },
      },
    });

    // Add boxes to screen
    this.screen.append(this.orderBookBox);
    this.screen.append(this.tradesBox);

    // Quit on Escape, q, or Control-C
    this.screen.key(["escape", "q", "C-c"], () => process.exit(0));
  }

  private subscribeToChannels() {
    this.redis.subscribe("orderbook:BTCUSD", "trades:BTCUSD");

    this.redis.on("message", (channel: string, message: string) => {
      if (channel === "orderbook:BTCUSD") {
        this.updateOrderBook(message);
      } else if (channel === "trades:BTCUSD") {
        this.updateTrades(message);
      }
      this.screen.render();
    });
  }

  private updateOrderBook(message: string) {
    const [bidsStr, asksStr] = message.split("\n");

    // Process sell orders (asks)
    const asks: Order[] = asksStr.split("|").map(order => {
      const [price, qty] = order.split(",");
      return { price: parseInt(price), quantity: parseInt(qty) };
    }).sort((a, b) => b.price - a.price);
    

    // Process buy orders (bids)
    const bids: Order[] = bidsStr.split("|").map(order => {
      const [price, qty] = order.split(",");
      return { price: parseInt(price), quantity: parseInt(qty) };
    }).sort((a, b) => b.price - a.price);

    // Update sell orders display
    let sellContent = "{bold}Price     Quantity{/bold}\n";
    asks.forEach(order => {
      sellContent += `${order.price.toString().padEnd(9)} ${order.quantity}\n`;
    });
    this.sellOrdersBox.setContent(sellContent);
    this.sellOrdersBox.setScrollPerc(100); // Scroll to bottom

    // Update buy orders display
    let buyContent = "{bold}Price     Quantity{/bold}\n";
    // Take only the first N bids to fit in the box (approximately 20 lines)
    bids.forEach(order => {
      buyContent += `${order.price.toString().padEnd(9)} ${order.quantity}\n`;
    });
    this.buyOrdersBox.setContent(buyContent);
  }

  private updateTrades(message: string) {
    const [price, quantity, timestamp] = message.split(",").map(Number);
    const timeStr = moment(timestamp).format("HH:mm:ss");

    const currentContent = this.tradesBox.getContent();
    const lines = currentContent.split("\n");

    // Keep header and add new trade at the top
    const newContent = [
      lines[0],
      `${price.toString().padEnd(9)} ${quantity
        .toString()
        .padEnd(9)} ${timeStr}`,
      ...lines.slice(1, 50), // Keep last 50 trades (plus header)
    ].join("\n");

    this.tradesBox.setContent(newContent);
  }

  public start() {
    this.screen.render();
  }
}

// Start the monitor
const monitor = new OrderBookMonitor();
monitor.start();
