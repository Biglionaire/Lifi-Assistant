// scripts/sync-lifi-tokens.ts
import "dotenv/config";
import fs from "node:fs";
import axios from "axios";

const API = "https://li.quest/v1";

// target chain kamu (pakai chainId biar jelas)
const TARGETS = [
  { outKey: "ETH", chainId: 1 },
  { outKey: "BASE", chainId: 8453 },
  { outKey: "ARB", chainId: 42161 },
  { outKey: "POL", chainId: 137 },
  { outKey: "BSC", chainId: 56 },
] as const;

type LifiChain = { id: number; key: string };

function headers() {
  const h: Record<string, string> = { Accept: "application/json" };
  if (process.env.LIFI_API_KEY?.trim()) h["x-lifi-api-key"] = process.env.LIFI_API_KEY.trim();
  return h;
}

async function main() {
  // 1) fetch chains
  const chainsResp = await axios.get<{ chains: LifiChain[] } | LifiChain[]>(
    `${API}/chains`,
    { headers: headers(), timeout: 60_000 }
  );

  const chains: LifiChain[] = Array.isArray(chainsResp.data)
    ? chainsResp.data
    : (chainsResp.data as any).chains;

  const byId = new Map<number, string>();
  for (const c of chains) byId.set(c.id, c.key);

  // 2) resolve LI.FI keys for our target chainIds
  const wanted = TARGETS.map(t => {
    const lifiKey = byId.get(t.chainId);
    if (!lifiKey) throw new Error(`ChainId ${t.chainId} not found in /chains`);
    return { ...t, lifiKey };
  });

  const chainsParam = wanted.map(w => w.lifiKey).join(",");
  const tokensResp = await axios.get(`${API}/tokens?chains=${encodeURIComponent(chainsParam)}`, {
    headers: headers(),
    timeout: 120_000,
  });

  // LI.FI biasanya balikin object keyed by chain key (lowercase)
  const raw = (tokensResp.data?.tokens ?? tokensResp.data) as Record<string, any[]>;

  const tokensByChainKey: Record<string, any[]> = {};
  for (const w of wanted) {
    const k1 = w.lifiKey;
    const candidates = [
      k1,
      k1.toLowerCase(),
      k1.toUpperCase(),
      String(w.chainId),
    ];
    const arr = candidates.map(k => raw?.[k]).find(v => Array.isArray(v));
    if (!arr) {
      throw new Error(
        `Missing tokens for ${w.outKey}. lifiKey=${w.lifiKey}. got keys=${Object.keys(raw ?? {}).slice(0, 20).join(",")}`
      );
    }
    tokensByChainKey[w.outKey] = arr;
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    chains: Object.fromEntries(TARGETS.map(t => [t.outKey, t.chainId])),
    lifiKeys: Object.fromEntries(wanted.map(w => [w.outKey, w.lifiKey])),
    tokensByChainKey,
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/lifi_tokens.json", JSON.stringify(out, null, 2));
  console.log("Saved: data/lifi_tokens.json");

  // quick summary
  for (const t of TARGETS) {
    console.log(`${t.outKey}: ${tokensByChainKey[t.outKey].length} tokens`);
  }
}

main().catch((e) => {
  console.error("sync-lifi-tokens failed:", e?.response?.data ?? e);
  process.exit(1);
});
