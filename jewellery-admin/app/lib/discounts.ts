export type DiscountTarget = "making" | "wastage" | "diamond";
export type DiscountValueType = "percent" | "flat";

export type DiscountLine = {
  key: string;
  target: DiscountTarget;
  type: DiscountValueType;
  value: number;
};

export type CatalogDiscountRule = {
  id: string;
  name: string;
  code: string;
  isCoupon: boolean;
  targets: DiscountTarget[];
  valueType: DiscountValueType;
  value: number;
  collectionIds: string[];
  productIds: string[];
  applyAll: boolean;
  status: string;
};

const TARGETS: DiscountTarget[] = ["making", "wastage", "diamond"];

function asTarget(value: string): DiscountTarget | null {
  return TARGETS.includes(value as DiscountTarget) ? (value as DiscountTarget) : null;
}

export function emptyDiscountLine(target: DiscountTarget = "making"): DiscountLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    target,
    type: "percent",
    value: 0,
  };
}

export function parseDiscountLines(raw: string | null | undefined): DiscountLine[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const target = asTarget(String(item.target || ""));
        if (!target) return null;
        return {
          key: String(item.key || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
          target,
          type: String(item.type || "percent") === "flat" ? "flat" : "percent",
          value: Number(item.value) || 0,
        } satisfies DiscountLine;
      })
      .filter((item): item is DiscountLine => Boolean(item));
  } catch {
    return [];
  }
}

export function serializeDiscountLines(lines: DiscountLine[]) {
  return JSON.stringify(
    lines.map((line) => ({
      target: line.target,
      type: line.type,
      value: Number(line.value) || 0,
    })),
  );
}

export function parseStringIdList(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function parseDiscountTargets(raw: string | null | undefined): DiscountTarget[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return ["making"];
    const targets = parsed
      .map((item) => asTarget(String(item)))
      .filter((item): item is DiscountTarget => Boolean(item));
    return targets.length ? targets : ["making"];
  } catch {
    return ["making"];
  }
}

export function applyAmountDiscount(amount: number, lines: DiscountLine[], target: DiscountTarget) {
  let next = Math.max(0, Number(amount) || 0);
  for (const line of lines.filter((item) => item.target === target && Number(item.value) > 0)) {
    if (line.type === "percent") {
      next -= next * (Number(line.value) / 100);
    } else {
      next -= Number(line.value) || 0;
    }
  }
  return Math.max(0, next);
}

export function catalogRuleToLines(rule: CatalogDiscountRule): DiscountLine[] {
  if (rule.status !== "Active" || rule.isCoupon) return [];
  return rule.targets.map((target) => ({
    key: `${rule.id}-${target}`,
    target,
    type: rule.valueType === "flat" ? "flat" : "percent",
    value: Number(rule.value) || 0,
  }));
}

export function matchingCatalogDiscounts(
  rules: CatalogDiscountRule[],
  productId: string | null,
  collectionIds: string[],
) {
  return rules.filter((rule) => {
    if (rule.status !== "Active" || rule.isCoupon) return false;
    if (rule.applyAll) return true;
    if (productId && rule.productIds.includes(productId)) return true;
    return rule.collectionIds.some((id) => collectionIds.includes(id));
  });
}

export function mergedDiscountLines(
  productLines: DiscountLine[],
  rules: CatalogDiscountRule[],
  productId: string | null,
  collectionIds: string[],
) {
  const catalog = matchingCatalogDiscounts(rules, productId, collectionIds).flatMap(catalogRuleToLines);
  return [...catalog, ...productLines];
}
