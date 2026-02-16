import axios from "axios";
import fs from "node:fs";
import path from "node:path";

import { createPublicClient, createWalletClient, http, isAddress, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base as baseChain } from "viem/chains";

import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";

// -----------------------------
// Constants / helpers
// -----------------------------
const LIFI_API = "https://li.quest/v1";

// MVP: executor supports Base as SOURCE (so funding + spend happens on Base)
const SOURCE_CHAIN_ID = 8453;

const CHAIN_ALIASES: Record<string, number> = {
  // source
  base: 8453,
  // destinations
  eth: 1,
  ethereum: 1,
  arb: 42161,
  arbitrum: 42161,
  pol: 137,
  polygon: 137,
  matic: 137,
  bsc: 56
};

const CHAIN_ID_TO_KEY: Record<number, string> = {
  1: "ETH",
  8453: "BASE",
  42161: "ARB",
  137: "POL",
  56: "BSC"
};

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

function getHeaders() {
  const h: Record<string, string> = { Accept: "application/json" };
  const k = (process.env.LIFI_API_KEY || "").trim();
  if (k) h["x-lifi-api-key"] = k;
  return h;
}

function normalizeChainId(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x !== "string") return null;
  const s = x.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return CHAIN_ALIASES[s] ?? null;
}

function mustAddress(x: unknown, field: string): string {
  if (typeof x !== "string" || !isAddress(x)) throw new Error(`${field} must be a valid EVM address`);
  return x;
}

function mustString(x: unknown, field: string): string {
  if (typeof x !== "string" || !x.trim()) throw new Error(`${field} must be a non-empty string`);
  return x.trim();
}

function parseCommand(cmd: string) {
  // Supports:
  // bridge 5 USDC from base to arbitrum receiver 0x...
  // optional: toToken ETH | slippage 0.5 | dryRun true
  const s = cmd.trim();

  const m = s.match(/bridge\s+([0-9]*\.?[0-9]+)\s+([^\s]+)\s+from\s+([^\s]+)\s+to\s+([^\s]+)\s+receiver\s+(0x[a-fA-F0-9]{40})(.*)$/i);
  if (!m) throw new Error(`Cannot parse command. Expected: bridge <amount> <token> from <base> to <chain> receiver <0x...>`);
  const amountHuman = m[1];
  const token = m[2];
  const fromChain = m[3];
  const toChain = m[4];
  const receiver = m[5];
  const tail = (m[6] || "").trim();

  let toToken: string | undefined;
  let slippage: number | undefined;
  let dryRun: boolean | undefined;

  const toTokenM = tail.match(/toToken\s+([^\s]+)/i);
  if (toTokenM) toToken = toTokenM[1];

  const slipM = tail.match(/slippage\s+([0-9]*\.?[0-9]+)/i);
  if (slipM) slippage = Number(slipM[1]);

  const dryM = tail.match(/dryRun\s+(true|false)/i);
  if (dryM) dryRun = dryM[1].toLowerCase() === "true";

  return { amountHuman, token, fromChain, toChain, receiver, toToken, slippage, dryRun };
}

type Normalized = {
  amountHuman: string;
  token: string;
  toToken: string;
  fromChainId: number; // must be Base for executor
  toChainId: number;
  receiver: string;
  slippageBps: number; // LI.FI expects decimal fraction; we will pass percent/100
  dryRun: boolean;

  allowBridges?: string[];
  denyBridges?: string[];
  preferBridges?: string[];
  allowExchanges?: string[];
  denyExchanges?: string[];
  preferExchanges?: string[];
  order?: string;
};

function normalizeRequest(req: Record<string, any>): Normalized {
  // Accept either structured fields or a command string
  const fromCommand = typeof req.command === "string" ? parseCommand(req.command) : null;

  const amountHuman = mustString(fromCommand?.amountHuman ?? req.amountHuman, "amountHuman");
  const token = mustString(fromCommand?.token ?? req.token, "token");
  const toToken = mustString(fromCommand?.toToken ?? req.toToken ?? token, "toToken");

  const fromChainId = normalizeChainId(fromCommand?.fromChain ?? req.fromChain ?? "base");
  const toChainId = normalizeChainId(fromCommand?.toChain ?? req.toChain);

  if (!fromChainId) throw new Error("fromChain is invalid");
  if (!toChainId) throw new Error("toChain is invalid");

  // Enforce Base as source for executor MVP
  if (fromChainId !== SOURCE_CHAIN_ID) {
    throw new Error(`Executor MVP only supports source chain Base (8453). Got fromChainId=${fromChainId}`);
  }

  const receiver = mustAddress(fromCommand?.receiver ?? req.receiver, "receiver");

  const slipPct = (fromCommand?.slippage ?? req.slippage);
  const slippagePct = typeof slipPct === "number" && Number.isFinite(slipPct) ? slipPct : 0.5;
  if (slippagePct <= 0 || slippagePct > 50) throw new Error("slippage must be in (0, 50] percent");
  const slippageBps = slippagePct;

  const dry = (fromCommand?.dryRun ?? req.dryRun);
  const dryRun = typeof dry === "boolean" ? dry : false;

  const out: Normalized = {
    amountHuman,
    token,
    toToken,
    fromChainId,
    toChainId,
    receiver,
    slippageBps,
    dryRun
  };

  // Optional LI.FI route filters
  for (const k of ["allowBridges","denyBridges","preferBridges","allowExchanges","denyExchanges","preferExchanges"] as const) {
    if (Array.isArray(req[k]) && req[k].every((x: any) => typeof x === "string")) (out as any)[k] = req[k];
  }
  if (typeof req.order === "string" && req.order.trim()) out.order = req.order.trim();

  return out;
}

// Token cache is only used for requestAdditionalFunds (sync).
// executeJob will call LI.FI /token (async) to avoid stale cache.
function loadTokenCache(): any | null {
  const p = (process.env.LIFI_TOKEN_CACHE_PATH || "data/lifi_tokens.json").trim();
  const abs = path.resolve(process.cwd(), p);
  try {
    const raw = fs.readFileSync(abs, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveTokenFromCache(chainId: number, token: string): { address: string; decimals: number; symbol?: string; name?: string } | null {
  const cache = loadTokenCache();
  if (!cache?.tokensByChainKey) return null;

  const key = CHAIN_ID_TO_KEY[chainId];
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

  return { address: found.address, decimals: found.decimals, symbol: found.symbol, name: found.name };
}

async function fetchToken(chainId: number, token: string) {
  const r = await axios.get(`${LIFI_API}/token`, {
    headers: getHeaders(),
    timeout: 30_000,
    params: { chain: chainId, token }
  });
  return r.data as { address: string; chainId: number; symbol: string; decimals: number; name?: string; priceUSD?: string; coinKey?: string; logoURI?: string };
}

async function fetchQuote(params: any) {
  const r = await axios.get(`${LIFI_API}/quote`, {
    headers: getHeaders(),
    timeout: 60_000,
    params
  });
  return r.data;
}

// -----------------------------
// ACP Offering handlers
// -----------------------------

export function validateRequirements(request: Record<string, any>): ValidationResult {
  try {
    const n = normalizeRequest(request);

    // Minimal destination allowlist (MVP)
    if (![1, 42161, 137, 56].includes(n.toChainId)) {
      return { valid: false, reason: `Unsupported destination chainId=${n.toChainId}. Allowed: ETH(1), ARB(42161), POL(137), BSC(56)` };
    }

    // amount sanity (string -> number-ish)
    const a = Number(n.amountHuman);
    if (!Number.isFinite(a) || a <= 0) return { valid: false, reason: "amountHuman must be a positive number string" };

    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: e?.message ?? "Validation failed" };
  }
}

export function requestPayment(request: Record<string, any>): string {
  // Human message shown to buyer
  const n = normalizeRequest(request);
  const toKey = CHAIN_ID_TO_KEY[n.toChainId] ?? String(n.toChainId);

  return [
    `I will execute a LI.FI route from Base -> ${toKey} as the seller executor.`,
    `Before execution, please transfer the required funds (fromToken on Base) to the executor wallet when prompted.`,
    `Command: bridge ${n.amountHuman} ${n.token} from base to ${toKey.toLowerCase()} receiver ${n.receiver}`,
    `Note: If you set toToken != token, LI.FI may include an on-chain swap step (DEX aggregator).`
  ].join("\n");
}

export function requestAdditionalFunds(request: Record<string, any>) {
  // MUST be sync. This instructs ACP what token + amount buyer should transfer to seller/executor.
  const n = normalizeRequest(request);

  const pk = (process.env.EXECUTOR_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("EXECUTOR_PRIVATE_KEY is missing");
  const account = privateKeyToAccount(pk as `0x${string}`);
  const recipient = account.address;

  // Resolve token address/decimals on Base from cache (sync).
  const fromTok = resolveTokenFromCache(SOURCE_CHAIN_ID, n.token);
  if (!fromTok) {
    throw new Error(`Token ${n.token} not found in token cache for Base. Run token sync to generate data/lifi_tokens.json (LIFI_TOKEN_CACHE_PATH).`);
  }

  const amountUnits = parseUnits(n.amountHuman, fromTok.decimals); // bigint
  if (amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount too large for ACP payableDetail.amount (must fit JS number).");
  }

  return {
    content: `Transfer ${n.amountHuman} ${n.token} on Base to executor ${recipient} so I can broadcast the LI.FI transaction.`,
    amount: Number(amountUnits),
    tokenAddress: fromTok.address,
    recipient
  };
}

export async function executeJob(request: Record<string, any>): Promise<ExecuteJobResult> {
  const n = normalizeRequest(request);

  const pk = (process.env.EXECUTOR_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("EXECUTOR_PRIVATE_KEY is missing");
  const account = privateKeyToAccount(pk as `0x${string}`);

  const rpc = (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim();

  const publicClient = createPublicClient({
    chain: baseChain,
    transport: http(rpc)
  });

  const walletClient = createWalletClient({
    account,
    chain: baseChain,
    transport: http(rpc)
  });

  // Fetch token metadata fresh from LI.FI
  const fromToken = await fetchToken(n.fromChainId, n.token);
  const toToken = await fetchToken(n.toChainId, n.toToken);

  const fromAmount = parseUnits(n.amountHuman, fromToken.decimals);

  // Ensure executor has balance (should be funded via ACP requiredFunds)
  const bal = await publicClient.readContract({
    address: fromToken.address as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [account.address]
  });

  if (bal < fromAmount) {
    throw new Error(
      `Insufficient ${fromToken.symbol} balance on executor. Need=${fromAmount.toString()} have=${bal.toString()}. ` +
      `Make sure the buyer transferred funds to executor during ACP payment step.`
    );
  }

  // Build LI.FI quote params
  const quoteParams: any = {
    fromChain: n.fromChainId,
    toChain: n.toChainId,
    fromToken: fromToken.address,
    toToken: toToken.address,
    fromAmount: fromAmount.toString(),
    fromAddress: account.address,
    toAddress: n.receiver,
    slippage: (n.slippageBps / 100).toString(), // LI.FI expects fraction, e.g. 0.005 for 0.5%
    integrator: "virtuals-acp"
  };

  // Optional route filters (pass-through)
  for (const k of ["allowBridges","denyBridges","preferBridges","allowExchanges","denyExchanges","preferExchanges"] as const) {
    if ((n as any)[k]?.length) quoteParams[k] = (n as any)[k].join(",");
  }
  if (n.order) quoteParams.order = n.order;

  const quote = await fetchQuote(quoteParams);

  // Dry-run: return quote + txRequest only
  if (n.dryRun) {
    return {
      // @ts-expect-error runtime accepts arbitrary JSON
      deliverable: {
        ok: true,
        mode: "dryRun",
        executor: account.address,
        input: {
          amountHuman: n.amountHuman,
          token: n.token,
          toToken: n.toToken,
          fromChain: "base",
          toChainId: n.toChainId,
          receiver: n.receiver,
          slippagePct: n.slippageBps
        },
        lifi: {
          tool: quote?.tool,
          quoteId: quote?.id
        },
        quote
      } as any
    };
  }

  // Collect spender addresses needing allowance
  const spenders = new Set<string>();
  if (quote?.estimate?.approvalAddress && isAddress(quote.estimate.approvalAddress)) spenders.add(quote.estimate.approvalAddress.toLowerCase());
  if (Array.isArray(quote?.includedSteps)) {
    for (const step of quote.includedSteps) {
      const a = step?.estimate?.approvalAddress;
      if (a && isAddress(a)) spenders.add(a.toLowerCase());
    }
  }

  // Approve spenders if needed
  const approveTxs: string[] = [];
  const allowanceReport: Record<string, string> = {};

  const MAX = (2n ** 256n) - 1n;

  for (const s of spenders) {
    const allowance = await publicClient.readContract({
      address: fromToken.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, s as `0x${string}`]
    });

    allowanceReport[s] = allowance.toString();

    if (allowance >= fromAmount) continue;

    const txHash = await walletClient.writeContract({
      address: fromToken.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [s as `0x${string}`, MAX]
    });

    approveTxs.push(txHash);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  // Broadcast LI.FI tx (use quote-provided gas/gasPrice if present to reduce estimateGas failures)
  const tr = quote?.transactionRequest;
  if (!tr?.to || !tr?.data) throw new Error("LI.FI quote missing transactionRequest");

  const txHash = await walletClient.sendTransaction({
    to: tr.to as `0x${string}`,
    data: tr.data as `0x${string}`,
    value: tr.value ? BigInt(tr.value) : 0n,
    gas: tr.gasLimit ? BigInt(tr.gasLimit) : undefined,
    gasPrice: tr.gasPrice ? BigInt(tr.gasPrice) : undefined
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  // @ts-expect-error runtime accepts arbitrary JSON
  return {
    deliverable: {
      ok: true,
      mode: "executed",
      executor: account.address,
      input: {
        amountHuman: n.amountHuman,
        token: n.token,
        toToken: n.toToken,
        fromChain: "base",
        toChain: CHAIN_ID_TO_KEY[n.toChainId] ?? String(n.toChainId),
        receiver: n.receiver,
        dryRun: false
      },
      resolved: {
        fromChainId: n.fromChainId,
        toChainId: n.toChainId,
        fromToken,
        toToken,
        fromAmount: fromAmount.toString(),
        slippage: n.slippageBps / 100
      },
      approvals: {
        spenders: Array.from(spenders),
        allowanceReport,
        approveTxs
      },
      lifi: {
        tool: quote?.tool,
        quoteId: quote?.id
      },
      tx: {
        hash: txHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber?.toString()
      },
      note: "Destination arrival can be pending; use LI.FI /status?txHash=... to track cross-chain completion."
    } as any
  };
}
