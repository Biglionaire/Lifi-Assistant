export type BridgeRequest = {
  amount: string;
  token: string;
  fromChain: string;
  toChain: string;
  receiver: string;
  sender?: string;
  toToken?: string;
  slippage?: number;
};

function pick(m: RegExpMatchArray, name: string) {
  // @ts-ignore
  return (m?.groups?.[name] ?? "").trim();
}

export function parseBridgeCommand(text: string): BridgeRequest {
  const input = (text ?? "").trim();

  // supports:
  // bridge 5 USDC from base to arbitrum receiver 0x...
  // bridge 5 usdc from base chain to arbitrum receiver address 0x...
  // bridge 5 USDC from base to arbitrum sender 0x... receiver 0x... slippage 0.5
  const re =
    /^(?<verb>bridge)\s+(?<amount>\d+(?:\.\d+)?)\s+(?<token>[A-Za-z0-9:_\.\-]+)\s+from\s+(?<fromChain>[A-Za-z0-9_\-]+)(?:\s+chain)?\s+to\s+(?<toChain>[A-Za-z0-9_\-]+)(?:\s+chain)?(?:\s+sender\s+(?<sender>0x[a-fA-F0-9]{40}))?(?:\s+receiver(?:\s+address)?\s+(?<receiver>0x[a-fA-F0-9]{40}))?(?:\s+toToken\s+(?<toToken>[A-Za-z0-9:_\.\-]+))?(?:\s+slippage\s+(?<slippage>\d+(?:\.\d+)?))?\s*$/i;

  const m = input.match(re);
  if (!m) throw new Error(`Unrecognized command. Example: bridge 5 USDC from base to arbitrum receiver 0x...`);

  const amount = pick(m, "amount");
  const token = pick(m, "token");
  const fromChain = pick(m, "fromChain");
  const toChain = pick(m, "toChain");
  const sender = pick(m, "sender") || undefined;
  const receiver = pick(m, "receiver") || "";
  const toToken = pick(m, "toToken") || undefined;
  const slippageStr = pick(m, "slippage");
  const slippage = slippageStr ? Number(slippageStr) : undefined;

  if (!receiver) throw new Error("Missing receiver. Example: ... receiver 0xabc...");
  return { amount, token, fromChain, toChain, receiver, sender, toToken, slippage };
}
