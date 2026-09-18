export type StoneRateMode = "flat" | "per_gram";

export type StoneLine = {
  key: string;
  stoneType: string;
  gemstoneTypeId: string;
  weight: number;
  rate: number;
  rateMode: StoneRateMode;
  diamondQualityId: string;
  diamondCount: number;
  diamondCategory: string;
  pricePerCarat: number;
};

export function emptyStoneLine(stoneType = "Diamond"): StoneLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    stoneType,
    gemstoneTypeId: "",
    weight: 0,
    rate: 0,
    rateMode: isDiamondStone(stoneType) ? "per_gram" : "flat",
    diamondQualityId: "",
    diamondCount: 1,
    diamondCategory: "Round",
    pricePerCarat: 0,
  };
}

export function isDiamondStone(stoneType: string) {
  return stoneType.trim().toLowerCase() === "diamond";
}

export function stoneWeightInGrams(stone: Pick<StoneLine, "stoneType" | "weight">) {
  const weight = Number(stone.weight) || 0;
  return isDiamondStone(stone.stoneType) ? weight * 0.2 : weight;
}

export function stoneChargeForLine(
  stone: Pick<StoneLine, "stoneType" | "weight" | "rate" | "rateMode">,
) {
  const weight = Number(stone.weight) || 0;
  const rate = Number(stone.rate) || 0;
  if (isDiamondStone(stone.stoneType)) return rate;
  if (stone.rateMode === "flat") return rate;
  return weight * rate;
}

export function parseStonesJson(
  raw: string | null | undefined,
  fallback?: {
    stoneIncluded?: boolean;
    stoneType?: string;
    stoneWeight?: number;
    stoneRate?: number;
    diamondQualityId?: string | null;
    diamondCount?: number;
    diamondCategory?: string;
    pricePerCarat?: number;
  },
): StoneLine[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .map((item) => ({
          key: String(item.key || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          stoneType: String(item.stoneType || item.type || "Diamond"),
          gemstoneTypeId: String(item.gemstoneTypeId || ""),
          weight: Number(item.weight) || 0,
          rate: Number(item.rate) || 0,
          rateMode: (isDiamondStone(String(item.stoneType || item.type || "Diamond"))
            ? "per_gram"
            : "flat") as StoneRateMode,
          diamondQualityId: String(item.diamondQualityId || ""),
          diamondCount: Number(item.diamondCount) || 1,
          diamondCategory: String(item.diamondCategory || "Round"),
          pricePerCarat: Number(item.pricePerCarat) || 0,
        }))
        .filter((item) => item.stoneType && item.stoneType !== "None");
    }
  } catch {
    // ignore
  }

  if (fallback?.stoneIncluded && fallback.stoneType && fallback.stoneType !== "None") {
    return [
      {
        key: "legacy",
        stoneType: fallback.stoneType,
        gemstoneTypeId: "",
        weight: Number(fallback.stoneWeight) || 0,
        rate: Number(fallback.stoneRate) || 0,
        rateMode: isDiamondStone(fallback.stoneType) ? "per_gram" : "flat",
        diamondQualityId: fallback.diamondQualityId || "",
        diamondCount: Number(fallback.diamondCount) || 1,
        diamondCategory: fallback.diamondCategory || "Round",
        pricePerCarat: Number(fallback.pricePerCarat) || 0,
      },
    ];
  }

  return [];
}

export function serializeStones(stones: StoneLine[]) {
  return JSON.stringify(
    stones.map((stone) => ({
      stoneType: stone.stoneType,
      gemstoneTypeId: stone.gemstoneTypeId,
      weight: Number(stone.weight) || 0,
      rate: Number(stone.rate) || 0,
      rateMode: stone.rateMode === "flat" ? "flat" : "per_gram",
      diamondQualityId: stone.diamondQualityId || "",
      diamondCount: Number(stone.diamondCount) || 1,
      diamondCategory: stone.diamondCategory || "",
      pricePerCarat: Number(stone.pricePerCarat) || 0,
    })),
  );
}

export function stonesToLegacy(stones: StoneLine[]) {
  const active = stones.filter((stone) => stone.stoneType && stone.stoneType !== "None");
  const first = active[0];
  const firstDiamond = active.find((stone) => isDiamondStone(stone.stoneType));
  const totalCharge = active.reduce((sum, stone) => sum + stoneChargeForLine(stone), 0);

  return {
    stoneIncluded: active.length > 0,
    stoneType: active.length > 1 ? active.map((s) => s.stoneType).join(" + ") : first?.stoneType || "None",
    stoneWeight: firstDiamond?.weight || first?.weight || 0,
    stoneRate: totalCharge,
    diamondCategory: firstDiamond?.diamondCategory || "",
    diamondQualityId: firstDiamond?.diamondQualityId || null,
    diamondCount: firstDiamond?.diamondCount || 1,
    pricePerCarat: firstDiamond?.pricePerCarat || 0,
  };
}
