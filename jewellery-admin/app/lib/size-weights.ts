export type SizeWeightRow = {
  size: string;
  netGoldWeight: number;
  grossWeight: number;
};

export function parseSizeWeights(raw: string | null | undefined): SizeWeightRow[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        size: String(item.size ?? item.label ?? "").trim(),
        netGoldWeight: Number(item.netGoldWeight) || 0,
        grossWeight: Number(item.grossWeight) || 0,
      }))
      .filter((item) => item.size);
  } catch {
    return [];
  }
}

export function serializeSizeWeights(rows: SizeWeightRow[]) {
  return JSON.stringify(
    rows.map((row) => ({
      size: String(row.size || "").trim(),
      netGoldWeight: Number(row.netGoldWeight) || 0,
      grossWeight: Number(row.grossWeight) || 0,
    })).filter((row) => row.size),
  );
}

export function unionSizes(variants: Array<{ sizeWeights?: SizeWeightRow[] }>) {
  const seen = new Set<string>();
  const sizes: string[] = [];
  for (const variant of variants) {
    for (const row of variant.sizeWeights || []) {
      if (!row.size || seen.has(row.size)) continue;
      seen.add(row.size);
      sizes.push(row.size);
    }
  }
  return sizes.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

export function emptySizeRow(size: string, net = 0, gross = 0): SizeWeightRow {
  return {
    size: String(size).trim(),
    netGoldWeight: Number(net) || 0,
    grossWeight: Number(gross) || 0,
  };
}
