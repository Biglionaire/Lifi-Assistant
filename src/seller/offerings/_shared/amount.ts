export function parseUnitsDecimal(amountStr: string, decimals: number): bigint {
  const s = (amountStr ?? "").trim();
  if (!s) throw new Error("amount is empty");

  const neg = s.startsWith("-");
  if (neg) throw new Error("amount must be positive");

  const [wholeRaw, fracRaw = ""] = s.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  const frac = fracRaw.replace(/0+$/, "");

  if (!/^\d+$/.test(whole)) throw new Error("amount invalid");
  if (frac && !/^\d+$/.test(frac)) throw new Error("amount invalid");

  if (frac.length > decimals) {
    throw new Error(`too many decimal places (max ${decimals})`);
  }

  const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = (whole + paddedFrac).replace(/^0+(?=\d)/, "") || "0";
  return BigInt(combined);
}
