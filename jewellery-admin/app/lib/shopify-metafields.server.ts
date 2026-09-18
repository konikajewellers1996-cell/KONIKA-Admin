import {
  calculateProductPrice,
  type MakingChargeType,
  type PriceBreakdown,
} from "./pricing";
import { isDiamondStone, parseStonesJson, stoneWeightInGrams } from "./stones";

type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export type MetafieldVariantSource = {
  id?: string;
  shopifyVariantId?: string | null;
  status?: string | null;
  metalColor: string;
  grossWeight: number;
  stoneIncluded: boolean;
  stoneType: string;
  stoneWeight: number;
  wastagePercent: number;
  makingChargeType: string;
  makingChargeValue: number;
  stoneRate: number;
  diamondCount?: number;
  diamondQuality?: { color: string; clarity: string; name: string } | null;
  purity?: { label: string; purityValue: number } | null;
  stonesJson?: string | null;
};

function formatInrAmount(value: number): string {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-IN");
}

function formatWeight(value: number, unit = "g"): string {
  const n = Number(value) || 0;
  if (n <= 0) return "";
  return `${n.toFixed(3)} ${unit}`;
}

function goldRateForVariant(
  baseGoldPricePerGram: number,
  purityValue?: number | null,
): number {
  if (purityValue == null || !Number.isFinite(purityValue)) {
    return baseGoldPricePerGram;
  }
  return (baseGoldPricePerGram / 0.916) * purityValue;
}

export function buildVariantPriceBreakup(
  variant: MetafieldVariantSource,
  baseGoldPricePerGram: number,
): {
  breakdown: PriceBreakdown;
  goldRate: number;
  materialSpecs: { metal_purity: string; metal_color: string };
  stoneSpecs: {
    stone_type: string;
    diamond_clarity: string;
    diamond_color: string;
  } | null;
  pricing: Record<string, string>;
  grossWeightLabel: string;
  netWeightLabel: string;
  diamondWeightLabel: string;
  diamondCountLabel: string;
} {
  const stones = parseStonesJson(variant.stonesJson, variant);
  const goldRate = goldRateForVariant(
    baseGoldPricePerGram,
    variant.purity?.purityValue,
  );
  const breakdown = calculateProductPrice({
    grossWeight: variant.grossWeight,
    stoneWeight: variant.stoneWeight,
    stoneIncluded: variant.stoneIncluded,
    stoneType: variant.stoneType,
    wastagePercent: variant.wastagePercent,
    makingChargeType: variant.makingChargeType as MakingChargeType,
    makingChargeValue: variant.makingChargeValue,
    stoneRate: variant.stoneRate,
    goldPricePerGram: goldRate,
    stones,
  });

  const purityLabel = variant.purity?.label || "22K";
  const metalColor = variant.metalColor || "";
  const stoneType =
    variant.stoneIncluded && variant.stoneType && variant.stoneType !== "None"
      ? variant.stoneType
      : stones.length
        ? stones.map((stone) => stone.stoneType).join(" + ")
        : "";

  const pricing: Record<string, string> = {
    gold_rate: `${formatInrAmount(goldRate)}/g`,
    gold_price: formatInrAmount(breakdown.goldValue),
    stone_price:
      breakdown.stoneCharge > 0 ? formatInrAmount(breakdown.stoneCharge) : "",
    stone_label: stoneType || "Stone",
    stone_discount: "",
    stone_og_price: "",
    making_discount: "",
    making_og_price: "",
    making_price: formatInrAmount(breakdown.makingCharge),
    gst_text: "",
    gst_price: "",
    total_og_price: "",
    total_price: formatInrAmount(breakdown.total),
  };

  const stoneSpecs =
    stoneType
      ? {
          stone_type: stoneType,
          diamond_clarity: variant.diamondQuality?.clarity || "",
          diamond_color: variant.diamondQuality?.color || "",
        }
      : null;

  const stoneWeightGrams = stones.length
    ? stones.reduce((sum, stone) => sum + stoneWeightInGrams(stone), 0)
    : variant.stoneIncluded && isDiamondStone(variant.stoneType)
      ? (Number(variant.stoneWeight) || 0) * 0.2
      : variant.stoneIncluded
        ? Number(variant.stoneWeight) || 0
        : 0;
  const netGold = Math.max((Number(variant.grossWeight) || 0) - stoneWeightGrams, 0);
  const diamondStones = stones.filter((stone) => isDiamondStone(stone.stoneType));
  const diamondCarat = diamondStones.reduce((sum, stone) => sum + (Number(stone.weight) || 0), 0);
  const diamondCount = diamondStones.reduce((sum, stone) => sum + (Number(stone.diamondCount) || 0), 0);

  return {
    breakdown,
    goldRate,
    materialSpecs: {
      metal_purity: purityLabel,
      metal_color: metalColor,
    },
    stoneSpecs,
    pricing,
    grossWeightLabel: formatWeight(variant.grossWeight),
    netWeightLabel: formatWeight(netGold),
    diamondWeightLabel:
      diamondCarat > 0
        ? formatWeight(diamondCarat, "ct")
        : stones.length
          ? ""
          : variant.stoneIncluded && isDiamondStone(variant.stoneType)
            ? formatWeight(variant.stoneWeight, "ct")
            : variant.stoneIncluded
              ? formatWeight(variant.stoneWeight)
              : "",
    diamondCountLabel:
      diamondCount > 0
        ? `${diamondCount} pcs`
        : variant.stoneIncluded && (variant.diamondCount || 0) > 0
          ? `${variant.diamondCount} pcs`
          : "",
  };
}

async function metafieldsSet(
  graphql: GraphqlClient,
  metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>,
) {
  if (!metafields.length) return;

  // Shopify caps metafieldsSet at 25 per call
  for (let i = 0; i < metafields.length; i += 25) {
    const chunk = metafields.slice(i, i + 25);
    const response = await graphql(
      `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message code }
        }
      }`,
      { variables: { metafields: chunk } },
    );
    const json = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors?: Array<{ message: string; field?: string[] }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(
        `Metafield sync: ${json.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const userErrors = json.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) {
      throw new Error(
        `Metafield sync: ${userErrors.map((e) => e.message).join("; ")}`,
      );
    }
  }
}

let metafieldDefinitionsReady: Promise<void> | null = null;

async function ensureStorefrontMetafieldDefinitions(graphql: GraphqlClient) {
  if (metafieldDefinitionsReady) return metafieldDefinitionsReady;

  metafieldDefinitionsReady = (async () => {
  const definitions: Array<{
    name: string;
    namespace: string;
    key: string;
    type: string;
    ownerType: "PRODUCT" | "PRODUCTVARIANT";
  }> = [
    { name: "Material Specs", namespace: "custom", key: "material_specs", type: "json", ownerType: "PRODUCT" },
    { name: "Stone Specs", namespace: "custom", key: "stone_specs", type: "json", ownerType: "PRODUCT" },
    { name: "Price Breakup", namespace: "custom", key: "price_breakup", type: "json", ownerType: "PRODUCT" },
    { name: "Amara Earrings Pricing", namespace: "custom", key: "amara_earrings_pricing", type: "json", ownerType: "PRODUCT" },
    { name: "Gross Weight", namespace: "custom", key: "gross_weight", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Metal Net Weight", namespace: "custom", key: "metal_netweight", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Diamond Total Weight", namespace: "custom", key: "diamond_total_weight", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Total Stone Count", namespace: "custom", key: "total_stone_count", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Dimension Width", namespace: "custom", key: "dimension_width", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Dimension Height", namespace: "custom", key: "dimension_height", type: "single_line_text_field", ownerType: "PRODUCT" },
    { name: "Available Sizes", namespace: "custom", key: "available_sizes", type: "json", ownerType: "PRODUCT" },
    { name: "Material Specs", namespace: "custom", key: "material_specs", type: "json", ownerType: "PRODUCTVARIANT" },
    { name: "Stone Specs", namespace: "custom", key: "stone_specs", type: "json", ownerType: "PRODUCTVARIANT" },
    { name: "Price Breakup", namespace: "custom", key: "price_breakup", type: "json", ownerType: "PRODUCTVARIANT" },
    { name: "Amara Earrings Pricing", namespace: "custom", key: "amara_earrings_pricing", type: "json", ownerType: "PRODUCTVARIANT" },
    { name: "Gross Weight", namespace: "custom", key: "gross_weight", type: "single_line_text_field", ownerType: "PRODUCTVARIANT" },
    { name: "Metal Net Weight", namespace: "custom", key: "metal_netweight", type: "single_line_text_field", ownerType: "PRODUCTVARIANT" },
    { name: "Diamond Total Weight", namespace: "custom", key: "diamond_total_weight", type: "single_line_text_field", ownerType: "PRODUCTVARIANT" },
    { name: "Total Stone Count", namespace: "custom", key: "total_stone_count", type: "single_line_text_field", ownerType: "PRODUCTVARIANT" },
  ];

  for (const def of definitions) {
    try {
      await graphql(
        `#graphql
        mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition { id }
            userErrors { field message code }
          }
        }`,
        {
          variables: {
            definition: {
              name: def.name,
              namespace: def.namespace,
              key: def.key,
              type: def.type,
              ownerType: def.ownerType,
              access: {
                storefront: "PUBLIC_READ",
              },
            },
          },
        },
      );
    } catch {
      // Definition may already exist — safe to continue
    }
  }
  })();

  return metafieldDefinitionsReady;
}

/**
 * Push jewellery specs + price breakup to Shopify product + variant metafields
 * so the Online Store theme can render a full PDP without manual Shopify Admin entry.
 */
export async function syncProductJewelleryMetafields(
  graphql: GraphqlClient,
  shopifyProductId: string,
  variants: MetafieldVariantSource[],
  baseGoldPricePerGram: number,
  variantIdMap?: Record<string, string>,
  extras?: {
    width?: string;
    height?: string;
    sizes?: string[];
  },
) {
  await ensureStorefrontMetafieldDefinitions(graphql);
  const active = variants.filter(
    (v) => v.status !== "Draft" && v.status !== "DRAFT",
  );
  const sourceList = (active.length ? active : variants).map((v) => {
    const mappedId =
      v.id && variantIdMap?.[v.id] ? variantIdMap[v.id] : v.shopifyVariantId;
    return { ...v, shopifyVariantId: mappedId || v.shopifyVariantId };
  });

  if (!sourceList.length) return;

  const primary = sourceList[0];
  const primaryBuilt = buildVariantPriceBreakup(primary, baseGoldPricePerGram);

  const productMetafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [
    {
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "material_specs",
      type: "json",
      value: JSON.stringify(primaryBuilt.materialSpecs),
    },
    {
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "price_breakup",
      type: "json",
      value: JSON.stringify(primaryBuilt.pricing),
    },
    // Legacy key used by current theme templates
    {
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "amara_earrings_pricing",
      type: "json",
      value: JSON.stringify(primaryBuilt.pricing),
    },
  ];

  if (primaryBuilt.stoneSpecs) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "stone_specs",
      type: "json",
      value: JSON.stringify(primaryBuilt.stoneSpecs),
    });
  }

  if (primaryBuilt.grossWeightLabel) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "gross_weight",
      type: "single_line_text_field",
      value: primaryBuilt.grossWeightLabel,
    });
  }

  if (primaryBuilt.netWeightLabel) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "metal_netweight",
      type: "single_line_text_field",
      value: primaryBuilt.netWeightLabel,
    });
  }

  if (primaryBuilt.diamondWeightLabel) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "diamond_total_weight",
      type: "single_line_text_field",
      value: primaryBuilt.diamondWeightLabel,
    });
  }

  if (primaryBuilt.diamondCountLabel) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "total_stone_count",
      type: "single_line_text_field",
      value: primaryBuilt.diamondCountLabel,
    });
  }

  const width = String(extras?.width || "").trim();
  const height = String(extras?.height || "").trim();
  const sizes = (extras?.sizes || []).map((s) => String(s).trim()).filter(Boolean);

  if (width) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "dimension_width",
      type: "single_line_text_field",
      value: width,
    });
  }

  if (height) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "dimension_height",
      type: "single_line_text_field",
      value: height,
    });
  }

  if (sizes.length) {
    productMetafields.push({
      ownerId: shopifyProductId,
      namespace: "custom",
      key: "available_sizes",
      type: "json",
      value: JSON.stringify(sizes),
    });
  }

  // Variant-level metafields for live PDP switching
  const variantMetafields: typeof productMetafields = [];
  for (const variant of sourceList) {
    const ownerId = variant.shopifyVariantId;
    if (!ownerId) continue;

    const built = buildVariantPriceBreakup(variant, baseGoldPricePerGram);
    variantMetafields.push(
      {
        ownerId,
        namespace: "custom",
        key: "material_specs",
        type: "json",
        value: JSON.stringify(built.materialSpecs),
      },
      {
        ownerId,
        namespace: "custom",
        key: "price_breakup",
        type: "json",
        value: JSON.stringify(built.pricing),
      },
      {
        ownerId,
        namespace: "custom",
        key: "amara_earrings_pricing",
        type: "json",
        value: JSON.stringify(built.pricing),
      },
    );

    if (built.stoneSpecs) {
      variantMetafields.push({
        ownerId,
        namespace: "custom",
        key: "stone_specs",
        type: "json",
        value: JSON.stringify(built.stoneSpecs),
      });
    }

    if (built.grossWeightLabel) {
      variantMetafields.push({
        ownerId,
        namespace: "custom",
        key: "gross_weight",
        type: "single_line_text_field",
        value: built.grossWeightLabel,
      });
    }

    if (built.netWeightLabel) {
      variantMetafields.push({
        ownerId,
        namespace: "custom",
        key: "metal_netweight",
        type: "single_line_text_field",
        value: built.netWeightLabel,
      });
    }

    if (built.diamondWeightLabel) {
      variantMetafields.push({
        ownerId,
        namespace: "custom",
        key: "diamond_total_weight",
        type: "single_line_text_field",
        value: built.diamondWeightLabel,
      });
    }

    if (built.diamondCountLabel) {
      variantMetafields.push({
        ownerId,
        namespace: "custom",
        key: "total_stone_count",
        type: "single_line_text_field",
        value: built.diamondCountLabel,
      });
    }
  }

  await metafieldsSet(graphql, [...productMetafields, ...variantMetafields]);
}
