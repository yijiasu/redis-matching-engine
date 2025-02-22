export interface Order {
  userId: number;
  side: "buy" | "sell";
  symbol: string;
  price: number;
  quantity: number;
}

export interface Trade {
  maker_order_id: string;
  maker_user_id: string;
  taker_order_id: string;
  taker_user_id: string;
  price: string;
  quantity: string;
  timestamp: string;
}
