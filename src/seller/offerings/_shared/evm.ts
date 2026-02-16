import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

export const BASE_RPC_URL = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";

export function requireExecutorAccount() {
  const pk = process.env.EXECUTOR_PRIVATE_KEY?.trim();
  if (!pk) throw new Error("Missing EXECUTOR_PRIVATE_KEY in .env");
  return privateKeyToAccount(pk as Hex);
}

export function getBaseClients() {
  const account = requireExecutorAccount();
  const transport = http(BASE_RPC_URL, { timeout: 30_000 });

  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, transport, account });

  return { publicClient, walletClient, account };
}
