export type MakingChargeType = "percent" | "fixed";

export type PriceInput = {
  grossWeight: number;
  stoneWeight: number;
  stoneIncluded: boolean;
  stoneType?: string;
  wastagePercent: number;
  makingChargeType: MakingChargeType;
  makingChargeValue: number;
  stoneRate: number;
  goldPricePerGram: number;
};

export type PriceBreakdown = {
  netGoldWeight: number;
  chargeableGoldWeight: number;
  goldValue: number;
  makingCharge: number;
  stoneCharge: number;
  total: number;
};

/** All weights in grams. All money in INR. */
export function calculateProductPrice(input: PriceInput): PriceBreakdown {
  const grossWeight = Number(input.grossWeight) || 0;
  const stoneWeight = input.stoneIncluded ? Number(input.stoneWeight) || 0 : 0;
  const wastagePercent = Number(input.wastagePercent) || 0;
  const goldPricePerGram = Number(input.goldPricePerGram) || 0;
  const makingChargeValue = Number(input.makingChargeValue) || 0;
  const stoneRate = Number(input.stoneRate) || 0;

  // For Diamonds, stoneWeight is stored as carat weight, which we convert to grams (1 ct = 0.2 g)
  // for subtracting from gold gross weight.
  const stoneWeightInGrams = input.stoneIncluded && input.stoneType === "Diamond"
    ? stoneWeight * 0.2
    : stoneWeight;

  const netGoldWeight = Math.max(grossWeight - stoneWeightInGrams, 0);
  const chargeableGoldWeight = netGoldWeight + netGoldWeight * (wastagePercent / 100);
  const goldValue = chargeableGoldWeight * goldPricePerGram;
  const makingCharge =
    input.makingChargeType === "percent"
      ? goldValue * (makingChargeValue / 100)
      : makingChargeValue;

  // For Diamonds, stoneRate is stored as the total price of the specified stone.
  // For other stones, stoneCharge = weight in grams * rate per gram.
  const stoneCharge = input.stoneIncluded
    ? (input.stoneType === "Diamond" ? stoneRate : stoneWeight * stoneRate)
    : 0;

  const total = goldValue + makingCharge + stoneCharge;

  return {
    netGoldWeight,
    chargeableGoldWeight,
    goldValue,
    makingCharge,
    stoneCharge,
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
