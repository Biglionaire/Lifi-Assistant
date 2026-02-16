import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";
import { chainIdOf } from "../_shared/chains.js";
import { parseBridgeCommand, type BridgeRequest } from "../_shared/command.js";
import { parseUnitsDecimal } from "../_shared/amount.js";
import { getToken, getQuote } from "../_shared/lifi.js";

function isHexAddress(x: string) {
  return /^0x[a-fA-F0-9]{40}$/.test((x ?? "").trim());
}

function coerceRequest(req: any): BridgeRequest {
  // 1) command string
  if (typeof req === "string") return parseBridgeCommand(req);
  if (typeof req?.command === "string" && req.command.trim()) return parseBridgeCommand(req.command);

  // 2) structured
  const amount = String(req?.amount ?? "").trim();
  const token = String(req?.token ?? "").trim();
  const fromChain = String(req?.fromChain ?? "").trim();
  const toChain = String(req?.toChain ?? "").trim();
  const receiver = String(req?.receiver ?? "").trim();
  const sender = req?.sender ? String(req.sender).trim() : undefined;
  const toToken = req?.toToken ? String(req.toToken).trim() : undefined;
  const slippage = typeof req?.slippage === "number" ? req.slippage : undefined;

  if (!amount || !token || !fromChain || !toChain || !receiver) {
    throw new Error("Missing fields. Provide 'command' OR {amount, token, fromChain, toChain, receiver}.");
  }
  return { amount, token, fromChain, toChain, receiver, sender, toToken, slippage };
}

export function validateRequirements(request: any): ValidationResult {
  try {
    const r = coerceRequest(request);

    const fromId = chainIdOf(r.fromChain);
    const toId = chainIdOf(r.toChain);
    if (!fromId) return { valid: false, reason: `Unsupported fromChain: ${r.fromChain}` };
    if (!toId) return { valid: false, reason: `Unsupported toChain: ${r.toChain}` };
    if (fromId === toId) return { valid: false, reason: "fromChain and toChain must be different" };

    if (!isHexAddress(r.receiver)) return { valid: false, reason: "receiver must be a 0x address" };
    if (r.sender && !isHexAddress(r.sender)) return { valid: false, reason: "sender must be a 0x address" };

    // amount numeric check (string)
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n <= 0) return { valid: false, reason: "amount must be a positive number" };

    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: e?.message ?? "Invalid request" };
  }
}

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const r = coerceRequest(request);

  const fromChainId = chainIdOf(r.fromChain)!;
  const toChainId = chainIdOf(r.toChain)!;

  const sender = r.sender ?? r.receiver; // default sender=receiver (common case)
  const receiver = r.receiver;

  // Resolve token on fromChain (decimals needed to build fromAmount) :contentReference[oaicite:7]{index=7}
  const fromTokenInfo = await getToken(fromChainId, r.token);
  const toTokenQuery = r.toToken ?? r.token;
  const toTokenInfo = await getToken(toChainId, toTokenQuery);

  const fromAmountBI = parseUnitsDecimal(r.amount, fromTokenInfo.decimals);
  const fromAmount = fromAmountBI.toString();

  // Quote + tx request :contentReference[oaicite:8]{index=8}
  const quote = await getQuote({
    fromChain: fromChainId,
    toChain: toChainId,
    fromToken: fromTokenInfo.address,
    toToken: toTokenInfo.address,
    fromAmount,
    fromAddress: sender,
    toAddress: receiver,
    slippage: r.slippage,
  });

  const deliverable = {
    input: {
      amountHuman: r.amount,
      fromChain: r.fromChain,
      toChain: r.toChain,
      sender,
      receiver,
      token: r.token,
      toToken: toTokenQuery,
    },
    resolved: {
      fromChainId,
      toChainId,
      fromToken: fromTokenInfo,
      toToken: toTokenInfo,
      fromAmount,
    },
    quote,
    notes: [
      "LI.FI quote includes transactionRequest ready to sign & send.",
      "If fromToken is ERC20, you may need to approve the spender (see quote.estimate.approvalAddress / approvals workflow).",
    ],
  };

  return { deliverable: JSON.stringify(deliverable, null, 2) };
}
