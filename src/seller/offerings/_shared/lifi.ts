import axios, { type AxiosError } from "axios";

const API = "https://li.quest/v1";

function headers() {
  const h: Record<string, string> = { Accept: "application/json" };
  if (process.env.LIFI_API_KEY?.trim()) h["x-lifi-api-key"] = process.env.LIFI_API_KEY.trim();
  return h;
}

// IMPORTANT: jangan pernah print axios error object mentah (bisa kebawa header)
function safeErr(e: unknown) {
  const ae = e as AxiosError<any>;
  const status = ae?.response?.status;
  const data = ae?.response?.data;
  const msg = typeof data === "string" ? data : JSON.stringify(data ?? {});
  return new Error(`LI.FI API error${status ? " " + status : ""}: ${msg}`);
}

export async function lifiGet<T>(path: string, params: Record<string, any>) {
  try {
    const r = await axios.get<T>(`${API}${path}`, { params, headers: headers(), timeout: 60_000 });
    return r.data;
  } catch (e) {
    throw safeErr(e);
  }
}

export async function getToken(chainId: number, token: string) {
  // /token?chain=...&token=... (token bisa symbol atau address)
  return lifiGet<any>("/token", { chain: chainId, token });
}

export async function getQuote(params: Record<string, any>) {
  return lifiGet<any>("/quote", params);
}

export async function getStatus(params: Record<string, any>) {
  // /status?txHash=... (+optional fromChain, toChain, bridge)
  // status: NOT_FOUND / PENDING / DONE / FAILED :contentReference[oaicite:3]{index=3}
  return lifiGet<any>("/status", params);
}
