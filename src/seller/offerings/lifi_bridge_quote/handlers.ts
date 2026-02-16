/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseAgentCommand } from "../_shared/command.js";
import { getChainId, getToken, getQuote, parseUnitsDecimal } from "../_shared/lifi.js";

export async function validateRequirements(requirements: any) {
  try {
    if (!requirements?.command || typeof requirements.command !== "string") {
      return { valid: false, errors: ["requirements.command must be a string"] };
    }
    parseAgentCommand(requirements.command);
    return { valid: true, errors: [] };
  } catch (e: any) {
    return { valid: false, errors: [String(e?.message ?? e)] };
  }
}

export async function executeJob(requirements: any) {
  const parsed = parseAgentCommand(requirements.command);

  if (parsed.kind === "swap") {
    const chainId = await getChainId(parsed.chain);
    const fromTok = await getToken(chainId, parsed.tokenIn);
    const toTok = await getToken(chainId, parsed.tokenOut);

    const fromAmount = parseUnitsDecimal(parsed.amount, Number(fromTok.decimals));
    const fromAddress = parsed.sender ?? parsed.receiver; // fallback
    const quote = await getQuote({
      fromChainId: chainId,
      toChainId: chainId,
      fromToken: fromTok.address,
      toToken: toTok.address,
      fromAmount,
      fromAddress,
      toAddress: parsed.receiver,
      slippage: parsed.slippage,
      order: parsed.order,
    });

    return {
      deliverable: JSON.stringify(
        {
          mode: "quote_only",
          parsed,
          lifi: {
            quoteId: quote.id,
            tool: quote.tool,
            estimate: quote.estimate,
            transactionRequest: quote.transactionRequest,
          },
          next: "Buyer should sign & broadcast transactionRequest on source chain.",
        },
        null,
        2
      ),
    };
  }

  // bridge
  const fromChainId = await getChainId(parsed.fromChain);
  const toChainId = await getChainId(parsed.toChain);

  const fromTok = await getToken(fromChainId, parsed.tokenIn);
  const toTok = await getToken(toChainId, parsed.tokenOut);

  const fromAmount = parseUnitsDecimal(parsed.amount, Number(fromTok.decimals));
  const fromAddress = parsed.sender ?? parsed.receiver; // fallback
  const quote = await getQuote({
    fromChainId,
    toChainId,
    fromToken: fromTok.address,
    toToken: toTok.address,
    fromAmount,
    fromAddress,
    toAddress: parsed.receiver,
    slippage: parsed.slippage,
    order: parsed.order,
  });

  return {
    deliverable: JSON.stringify(
      {
        mode: "quote_only",
        parsed,
        lifi: {
          quoteId: quote.id,
          tool: quote.tool,
          estimate: quote.estimate,
          includedSteps: quote.includedSteps,
          transactionRequest: quote.transactionRequest,
        },
        next: "Buyer should sign & broadcast transactionRequest on source chain. After broadcast, check /status with txHash.",
      },
      null,
      2
    ),
  };
}
