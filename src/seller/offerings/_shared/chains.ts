export type SupportedChain =
  | "ETHEREUM"
  | "BASE"
  | "ARBITRUM"
  | "POLYGON"
  | "BSC";

export const CHAIN_ID: Record<SupportedChain, number> = {
  ETHEREUM: 1,
  BASE: 8453,
  ARBITRUM: 42161,
  POLYGON: 137,
  BSC: 56,
};

const ALIASES: Record<string, SupportedChain> = {
  ethereum: "ETHEREUM",
  eth: "ETHEREUM",
  mainnet: "ETHEREUM",

  base: "BASE",

  arbitrum: "ARBITRUM",
  arb: "ARBITRUM",
  "arbitrum-one": "ARBITRUM",

  polygon: "POLYGON",
  pol: "POLYGON",
  matic: "POLYGON",

  bsc: "BSC",
  binance: "BSC",
  "binance-smart-chain": "BSC",
};

export function normalizeChain(input: string): SupportedChain | null {
  const key = (input ?? "").trim().toLowerCase();
  return ALIASES[key] ?? null;
}

export function chainIdOf(input: string): number | null {
  const c = normalizeChain(input);
  return c ? CHAIN_ID[c] : null;
}
