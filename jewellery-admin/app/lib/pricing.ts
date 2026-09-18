import { applyAmountDiscount, type DiscountLine } from "./discounts";

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
  netGoldWeight?: number;
  stoneWeight: number;
  stoneIncluded: boolean;
  stoneType?: string;
  wastagePercent: number;
  wastageType?: MakingChargeType | string;
  makingChargeType: MakingChargeType | string;
  makingChargeValue: number;
  stoneRate: number;
  goldPricePerGram: number;
  stones?: PriceStoneLine[];
  otherCharges?: number;
  gstPercent?: number;
  pricingMode?: PricingMode | string;
  manualPrice?: number;
  discounts?: DiscountLine[];
};

export type PriceBreakdown = {
  netGoldWeight: number;
  chargeableGoldWeight: number;
  netGoldValue: number;
  wastageValue: number;
  goldValue: number;
  makingCharge: number;
  stoneCharge: number;
  diamondCharge: number;
  discountMaking: number;
  discountWastage: number;
  discountDiamond: number;
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
      diamondCharge: 0,
      discountMaking: 0,
      discountWastage: 0,
      discountDiamond: 0,
      otherCharges: 0,
      gstPercent: 0,
      gstValue: 0,
      subtotal: total,
      total,
    };
  }

  const grossWeight = Number(input.grossWeight) || 0;
  const wastageValueInput = Number(input.wastagePercent) || 0;
  const goldPricePerGram = Number(input.goldPricePerGram) || 0;
  const makingChargeValue = Number(input.makingChargeValue) || 0;
  const makingType = normalizeMakingChargeType(input.makingChargeType);
  const wastageType = normalizeMakingChargeType(input.wastageType || "percent");
  const stoneLines = (input.stones || []).filter(
    (stone) => stone.stoneType && stone.stoneType !== "None",
  );

  let stoneWeightInGrams = 0;
  let stoneCharge = 0;
  let diamondCharge = 0;

  if (stoneLines.length) {
    for (const stone of stoneLines) {
      const weight = Number(stone.weight) || 0;
      const isDiamond = String(stone.stoneType).toLowerCase() === "diamond";
      stoneWeightInGrams += isDiamond ? weight * 0.2 : weight;
      const charge = stoneLineCharge(stone);
      stoneCharge += charge;
      if (isDiamond) diamondCharge += charge;
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
    diamondCharge = input.stoneIncluded && input.stoneType === "Diamond" ? stoneCharge : 0;
  }

  const computedNet = Math.max(grossWeight - stoneWeightInGrams, 0);
  const enteredNet = Number(input.netGoldWeight);
  const netGoldWeight =
    Number.isFinite(enteredNet) && enteredNet >= 0 && input.netGoldWeight != null
      ? enteredNet
      : computedNet;
  let extraGoldGrams = 0;
  let wastageValue = 0;
  if (wastageType === "percent") {
    extraGoldGrams = netGoldWeight * (wastageValueInput / 100);
    wastageValue = extraGoldGrams * goldPricePerGram;
  } else if (wastageType === "per_gram") {
    wastageValue = netGoldWeight * wastageValueInput;
  } else {
    wastageValue = wastageValueInput;
  }

  let makingCharge = 0;
  const goldValueBeforeMaking =
    wastageType === "percent"
      ? (netGoldWeight + extraGoldGrams) * goldPricePerGram
      : netGoldWeight * goldPricePerGram;
  if (makingType === "percent") {
    makingCharge = goldValueBeforeMaking * (makingChargeValue / 100);
  } else if (makingType === "per_gram") {
    makingCharge = netGoldWeight * makingChargeValue;
  } else {
    makingCharge = makingChargeValue;
  }

  const discounts = input.discounts || [];
  const makingBefore = makingCharge;
  const wastageBefore = wastageValue;
  const diamondBefore = diamondCharge;
  makingCharge = applyAmountDiscount(makingCharge, discounts, "making");
  wastageValue = applyAmountDiscount(wastageValue, discounts, "wastage");
  const discountedDiamond = applyAmountDiscount(diamondCharge, discounts, "diamond");
  const gemCharge = Math.max(0, stoneCharge - diamondCharge);
  stoneCharge = gemCharge + discountedDiamond;
  if (wastageType === "percent" && wastageBefore > 0) {
    extraGoldGrams = extraGoldGrams * (wastageValue / wastageBefore);
  }

  const chargeableGoldWeight = netGoldWeight + extraGoldGrams;
  const netGoldValue = netGoldWeight * goldPricePerGram;
  const goldValue =
    wastageType === "percent"
      ? chargeableGoldWeight * goldPricePerGram
      : netGoldValue;
  const wastageInGold = wastageType === "percent" ? 0 : wastageValue;
  const subtotal = goldValue + makingCharge + stoneCharge + otherCharges + wastageInGold;
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
    diamondCharge: discountedDiamond,
    discountMaking: Math.max(0, makingBefore - makingCharge),
    discountWastage: Math.max(0, wastageBefore - wastageValue),
    discountDiamond: Math.max(0, diamondBefore - discountedDiamond),
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
