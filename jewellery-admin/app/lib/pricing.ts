export type MakingChargeType = "percent" | "fixed" | "flat" | "per_gram";
export type PricingMode = "auto" | "manual";
export type RateMode = "flat" | "per_gram";

export type PriceStoneLine = {
  stoneType?: string;
  weight?: number;
  rate?: number;
  rateMode?: RateMode | string;
};

export type PriceInput = {
  grossWeight: number;
  stoneWeight: number;
  stoneIncluded: boolean;
  stoneType?: string;
  wastagePercent: number;
  makingChargeType: MakingChargeType | string;
  makingChargeValue: number;
  stoneRate: number;
  goldPricePerGram: number;
  stones?: PriceStoneLine[];
  otherCharges?: number;
  gstPercent?: number;
  pricingMode?: PricingMode | string;
  manualPrice?: number;
};

export type PriceBreakdown = {
  netGoldWeight: number;
  chargeableGoldWeight: number;
  netGoldValue: number;
  wastageValue: number;
  goldValue: number;
  makingCharge: number;
  stoneCharge: number;
  otherCharges: number;
  gstPercent: number;
  gstValue: number;
  subtotal: number;
  total: number;
};

export function normalizeMakingChargeType(type?: string | null): MakingChargeType {
  const value = String(type || "").toLowerCase();
  if (value === "percent") return "percent";
  if (value === "per_gram" || value === "pergram" || value === "per gram") return "per_gram";
  return "flat";
}

export function normalizePricingMode(mode?: string | null): PricingMode {
  return String(mode || "").toLowerCase() === "manual" ? "manual" : "auto";
}

export function stoneLineCharge(stone: PriceStoneLine) {
  const weight = Number(stone.weight) || 0;
  const rate = Number(stone.rate) || 0;
  const isDiamond = String(stone.stoneType || "").toLowerCase() === "diamond";
  if (isDiamond) return rate;
  if (String(stone.rateMode || "per_gram").toLowerCase() === "flat") return rate;
  return weight * rate;
}

/** All weights in grams. All money in INR. */
export function calculateProductPrice(input: PriceInput): PriceBreakdown {
  const pricingMode = normalizePricingMode(input.pricingMode);
  const gstPercent = Number(input.gstPercent);
  const resolvedGst = Number.isFinite(gstPercent) ? gstPercent : 3;
  const otherCharges = Math.max(0, Number(input.otherCharges) || 0);

  if (pricingMode === "manual") {
    const total = Math.max(0, Number(input.manualPrice) || 0);
    return {
      netGoldWeight: 0,
      chargeableGoldWeight: 0,
      netGoldValue: 0,
      wastageValue: 0,
      goldValue: 0,
      makingCharge: 0,
      stoneCharge: 0,
      otherCharges: 0,
      gstPercent: 0,
      gstValue: 0,
      subtotal: total,
      total,
    };
  }

  const grossWeight = Number(input.grossWeight) || 0;
  const wastagePercent = Number(input.wastagePercent) || 0;
  const goldPricePerGram = Number(input.goldPricePerGram) || 0;
  const makingChargeValue = Number(input.makingChargeValue) || 0;
  const makingType = normalizeMakingChargeType(input.makingChargeType);
  const stoneLines = (input.stones || []).filter(
    (stone) => stone.stoneType && stone.stoneType !== "None",
  );

  let stoneWeightInGrams = 0;
  let stoneCharge = 0;

  if (stoneLines.length) {
    for (const stone of stoneLines) {
      const weight = Number(stone.weight) || 0;
      const isDiamond = String(stone.stoneType).toLowerCase() === "diamond";
      stoneWeightInGrams += isDiamond ? weight * 0.2 : weight;
      stoneCharge += stoneLineCharge(stone);
    }
  } else {
    const stoneWeight = input.stoneIncluded ? Number(input.stoneWeight) || 0 : 0;
    const stoneRate = Number(input.stoneRate) || 0;
    stoneWeightInGrams =
      input.stoneIncluded && input.stoneType === "Diamond"
        ? stoneWeight * 0.2
        : stoneWeight;
    stoneCharge = input.stoneIncluded
      ? input.stoneType === "Diamond"
        ? stoneRate
        : stoneWeight * stoneRate
      : 0;
  }

  const netGoldWeight = Math.max(grossWeight - stoneWeightInGrams, 0);
  const wastageWeight = netGoldWeight * (wastagePercent / 100);
  const chargeableGoldWeight = netGoldWeight + wastageWeight;
  const netGoldValue = netGoldWeight * goldPricePerGram;
  const wastageValue = wastageWeight * goldPricePerGram;
  const goldValue = chargeableGoldWeight * goldPricePerGram;

  let makingCharge = 0;
  if (makingType === "percent") {
    makingCharge = goldValue * (makingChargeValue / 100);
  } else if (makingType === "per_gram") {
    makingCharge = netGoldWeight * makingChargeValue;
  } else {
    makingCharge = makingChargeValue;
  }

  const subtotal = goldValue + makingCharge + stoneCharge + otherCharges;
  const gstValue = subtotal * (resolvedGst / 100);
  const total = subtotal + gstValue;

  return {
    netGoldWeight,
    chargeableGoldWeight,
    netGoldValue,
    wastageValue,
    goldValue,
    makingCharge,
    stoneCharge,
    otherCharges,
    gstPercent: resolvedGst,
    gstValue,
    subtotal,
    total,
  };
}

export function formatINR(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatGrams(value: number): string {
  return `${(Number(value) || 0).toFixed(3)} g`;
}

export function priceToShopifyString(value: number): string {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}
