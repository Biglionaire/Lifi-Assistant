import { erc20Abi, type Address } from "viem";
import { getBaseClients } from "./evm.js";

export async function getErc20Balance(token: Address, owner: Address) {
  const { publicClient } = getBaseClients();
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  }) as Promise<bigint>;
}

export async function getAllowance(token: Address, owner: Address, spender: Address) {
  const { publicClient } = getBaseClients();
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  }) as Promise<bigint>;
}

export async function ensureAllowanceExact(token: Address, spender: Address, amount: bigint) {
  const { publicClient, walletClient, account } = getBaseClients();

  const current = await getAllowance(token, account.address, spender);
  if (current >= amount) return { approved: false as const };

  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return { approved: true as const, approveTxHash: hash };
}
