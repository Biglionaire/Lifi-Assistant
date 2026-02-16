import fs from "node:fs";
import path from "node:path";
import { isAddress, erc20Abi, type Address } from "viem";

import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";
import { chainIdOf, CHAIN_ID } from "../_shared/chains.js";
import { parseBridgeCommand } from "../_shared/command.js";
import { parseUnitsDecimal } from "../_shared/amount.js";
import { getToken, getQuote } from "../_shared/lifi.js";
import { getBaseClients, requireExecutorAccount } from "../_shared/evm.js";

// -----------------------------
// Constants
// -----------------------------

// MVP: executor supports Base as SOURCE only
const SOURCE_CHAIN_ID = CHAIN_ID.BASE;

// LI.FI cache chain keys (used by sync token-cache lookup)
const CHAIN_KEY: Record<number, string> = {
  [CHAIN_ID.ETHEREUM]: "ETH",
  [CHAIN_ID.BASE]: "BASE",
  [CHAIN_ID.ARBITRUM]: "ARB",
  [CHAIN_ID.POLYGON]: "POL",
  [CHAIN_ID.BSC]: "BSC",
};

const ALLOWED_DESTINATIONS = [
  CHAIN_ID.ETHEREUM,
  CHAIN_ID.ARBITRUM,
  CHAIN_ID.POLYGON,
  CHAIN_ID.BSC,
];

// -----------------------------
// Normalized request
// -----------------------------

type Normalized = {
  amountHuman: string;
  token: string;
  toToken: string;
  fromChainId: number;
  toChainId: number;
  receiver: string;
  slippagePct: number;
  dryRun: boolean;
  allowBridges?: string[];
  denyBridges?: string[];
  preferBridges?: string[];
  allowExchanges?: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  order?: string;
};

function mustString(x: unknown, field: string): string {
  if (typeof x !== "string" || !x.trim()) throw new Error(`${field} must be a non-empty string`);
  return x.trim();
}

function normalizeRequest(req: Record<string, any>): Normalized {
  let amountHuman: string;
  let token: string;
  let toToken: string;
  let fromChain: string;
  let toChain: string;
  let receiver: string;
  let slippage: number | undefined;
  let dryRun = false;

  if (typeof req.command === "string" && req.command.trim()) {
    const cmd = parseBridgeCommand(req.command);
    amountHuman = cmd.amount;
    token = cmd.token;
    toToken = cmd.toToken ?? cmd.token;
    fromChain = cmd.fromChain;
    toChain = cmd.toChain;
    receiver = cmd.receiver;
    slippage = cmd.slippage;
    dryRun = req.dryRun === true;
  } else {
    amountHuman = mustString(req.amountHuman, "amountHuman");
    token = mustString(req.token, "token");
    toToken = mustString(req.toToken ?? token, "toToken");
    fromChain = String(req.fromChain ?? "base").trim();
    toChain = mustString(req.toChain, "toChain");
    receiver = mustString(req.receiver, "receiver");
    slippage = typeof req.slippage === "number" ? req.slippage : undefined;
    dryRun = req.dryRun === true;
  }

  if (!isAddress(receiver)) throw new Error("receiver must be a valid EVM address");

  const fromChainId = chainIdOf(fromChain);
  const toChainId = chainIdOf(toChain);
  if (!fromChainId) throw new Error(`fromChain is invalid: ${fromChain}`);
  if (!toChainId) throw new Error(`toChain is invalid: ${toChain}`);

  if (fromChainId !== SOURCE_CHAIN_ID) {
    throw new Error(`Executor MVP only supports source chain Base (8453). Got fromChainId=${fromChainId}`);
  }

  const slippagePct = typeof slippage === "number" && Number.isFinite(slippage) ? slippage : 0.5;
  if (slippagePct <= 0 || slippagePct > 50) throw new Error("slippage must be in (0, 50] percent");

  const out: Normalized = {
    amountHuman, token, toToken, fromChainId, toChainId, receiver, slippagePct, dryRun,
  };

  // Optional LI.FI route filters (pass-through from structured req)
  const FILTER_KEYS = ["allowBridges", "denyBridges", "preferBridges", "allowExchanges", "denyExchanges", "preferExchanges"] as const;
  for (const k of FILTER_KEYS) {
    if (Array.isArray(req[k]) && req[k].every((v: any) => typeof v === "string")) (out as any)[k] = req[k];
  }
  if (typeof req.order === "string" && req.order.trim()) out.order = req.order.trim();

  return out;
}

// -----------------------------
// Token cache (sync, for requestAdditionalFunds only)
// executeJob calls LI.FI /token async for fresh data.
// -----------------------------

function loadTokenCache(): any | null {
  const p = (process.env.LIFI_TOKEN_CACHE_PATH || "data/lifi_tokens.json").trim();
  const abs = path.resolve(process.cwd(), p);
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function resolveTokenFromCache(chainId: number, token: string): { address: string; decimals: number } | null {
  const cache = loadTokenCache();
  if (!cache?.tokensByChainKey) return null;

  const key = CHAIN_KEY[chainId];
  if (!key) return null;

  const list = cache.tokensByChainKey[key];
  if (!Array.isArray(list)) return null;

  const t = token.trim();
  const isAddr = /^0x[a-fA-F0-9]{40}$/.test(t);

  const found = isAddr
    ? list.find((x: any) => typeof x?.address === "string" && x.address.toLowerCase() === t.toLowerCase())
    : list.find((x: any) => typeof x?.symbol === "string" && x.symbol.toUpperCase() === t.toUpperCase());

  if (!found?.address || typeof found.decimals !== "number") return null;
  if (!isAddress(found.address)) return null;

  return { address: found.address, decimals: found.decimals };
}

// -----------------------------
// ACP Offering handlers
// -----------------------------

export function validateRequirements(request: Record<string, any>): ValidationResult {
  try {
    const n = normalizeRequest(request);

    if (!ALLOWED_DESTINATIONS.includes(n.toChainId)) {
      return { valid: false, reason: `Unsupported destination chainId=${n.toChainId}. Allowed: ETH(1), ARB(42161), POL(137), BSC(56)` };
    }

    const a = Number(n.amountHuman);
    if (!Number.isFinite(a) || a <= 0) return { valid: false, reason: "amountHuman must be a positive number" };

    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: e?.message ?? "Validation failed" };
  }
}

export function requestPayment(request: Record<string, any>): string {
  const n = normalizeRequest(request);
  const toKey = CHAIN_KEY[n.toChainId] ?? String(n.toChainId);

  return [
    `I will execute a LI.FI route from Base -> ${toKey} as the seller executor.`,
    `Before execution, please transfer the required funds (fromToken on Base) to the executor wallet when prompted.`,
    `Command: bridge ${n.amountHuman} ${n.token} from base to ${toKey.toLowerCase()} receiver ${n.receiver}`,
    `Note: If you set toToken != token, LI.FI may include an on-chain swap step (DEX aggregator).`,
  ].join("\n");
}

export function requestAdditionalFunds(request: Record<string, any>) {
  const n = normalizeRequest(request);

  const account = requireExecutorAccount();
  const recipient = account.address;

  const fromTok = resolveTokenFromCache(SOURCE_CHAIN_ID, n.token);
  if (!fromTok) {
    throw new Error(
      `Token ${n.token} not found in token cache for Base. ` +
      `Run token sync to generate data/lifi_tokens.json (LIFI_TOKEN_CACHE_PATH).`
    );
  }

  const amountUnits = parseUnitsDecimal(n.amountHuman, fromTok.decimals);
  if (amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount too large for ACP payableDetail.amount (must fit JS number).");
  }

  return {
    content: `Transfer ${n.amountHuman} ${n.token} on Base to executor ${recipient} so I can broadcast the LI.FI transaction.`,
    amount: Number(amountUnits),
    tokenAddress: fromTok.address,
    recipient,
  };
}

export async function executeJob(request: Record<string, any>): Promise<ExecuteJobResult> {
  const n = normalizeRequest(request);
  const { publicClient, walletClient, account } = getBaseClients();

  // Fetch token metadata fresh from LI.FI
  const fromToken = await getToken(n.fromChainId, n.token);
  const toToken = await getToken(n.toChainId, n.toToken);

  const fromAmount = parseUnitsDecimal(n.amountHuman, fromToken.decimals);

  // Ensure executor has balance (funded via ACP requiredFunds step)
  const bal = await publicClient.readContract({
    address: fromToken.address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  }) as bigint;

  if (bal < fromAmount) {
    throw new Error(
      `Insufficient ${fromToken.symbol} balance on executor. ` +
      `Need=${fromAmount.toString()} have=${bal.toString()}. ` +
      `Make sure the buyer transferred funds to executor during ACP payment step.`
    );
  }

  // Build LI.FI quote params
  const quoteParams: Record<string, any> = {
    fromChain: n.fromChainId,
    toChain: n.toChainId,
    fromToken: fromToken.address,
    toToken: toToken.address,
    fromAmount: fromAmount.toString(),
    fromAddress: account.address,
    toAddress: n.receiver,
    slippage: (n.slippagePct / 100).toString(), // LI.FI expects fraction e.g. 0.005 for 0.5%
    integrator: "virtuals-acp",
  };

  const FILTER_KEYS = ["allowBridges", "denyBridges", "preferBridges", "allowExchanges", "denyExchanges", "preferExchanges"] as const;
  for (const k of FILTER_KEYS) {
    if ((n as any)[k]?.length) quoteParams[k] = (n as any)[k].join(",");
  }
  if (n.order) quoteParams.order = n.order;

  const quote = await getQuote(quoteParams);

  // Dry-run: return quote only, no broadcast
  if (n.dryRun) {
    return {
      deliverable: JSON.stringify({
        ok: true,
        mode: "dryRun",
        executor: account.address,
        input: { amountHuman: n.amountHuman, token: n.token, toToken: n.toToken, fromChain: "base", toChainId: n.toChainId, receiver: n.receiver, slippagePct: n.slippagePct },
        lifi: { tool: quote?.tool, quoteId: quote?.id },
        quote,
      }, null, 2),
    };
  }

  // Collect spender addresses needing allowance
  const spenders = new Set<string>();
  if (quote?.estimate?.approvalAddress && isAddress(quote.estimate.approvalAddress)) {
    spenders.add(quote.estimate.approvalAddress.toLowerCase());
  }
  if (Array.isArray(quote?.includedSteps)) {
    for (const step of quote.includedSteps) {
      const a = step?.estimate?.approvalAddress;
      if (a && isAddress(a)) spenders.add(a.toLowerCase());
    }
  }

  // Approve spenders if needed
  const approveTxs: string[] = [];
  const allowanceReport: Record<string, string> = {};
  const MAX_UINT = (2n ** 256n) - 1n;

  for (const s of spenders) {
    const allowance = await publicClient.readContract({
      address: fromToken.address as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, s as Address],
    }) as bigint;

    allowanceReport[s] = allowance.toString();

    if (allowance >= fromAmount) continue;

    const approveTx = await walletClient.writeContract({
      address: fromToken.address as Address,
      abi: erc20Abi,
      functionName: "approve",
      args: [s as Address, MAX_UINT],
    });

    approveTxs.push(approveTx);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // Broadcast LI.FI transaction
  const tr = quote?.transactionRequest;
  if (!tr?.to || !tr?.data) throw new Error("LI.FI quote missing transactionRequest");

  const txHash = await walletClient.sendTransaction({
    to: tr.to as Address,
    data: tr.data as `0x${string}`,
    value: tr.value ? BigInt(tr.value) : 0n,
    gas: tr.gasLimit ? BigInt(tr.gasLimit) : undefined,
    gasPrice: tr.gasPrice ? BigInt(tr.gasPrice) : undefined,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const toChainKey = CHAIN_KEY[n.toChainId] ?? String(n.toChainId);

  return {
    deliverable: JSON.stringify({
      ok: true,
      mode: "executed",
      executor: account.address,
      input: { amountHuman: n.amountHuman, token: n.token, toToken: n.toToken, fromChain: "base", toChain: toChainKey, receiver: n.receiver, dryRun: false },
      resolved: { fromChainId: n.fromChainId, toChainId: n.toChainId, fromToken, toToken, fromAmount: fromAmount.toString(), slippage: n.slippagePct / 100 },
      approvals: { spenders: Array.from(spenders), allowanceReport, approveTxs },
      lifi: { tool: quote?.tool, quoteId: quote?.id },
      tx: { hash: txHash, status: receipt.status, blockNumber: receipt.blockNumber?.toString() },
      note: "Destination arrival can be pending; use LI.FI /status?txHash=... to track cross-chain completion.",
    }, null, 2),
  };
}
