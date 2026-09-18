export const DEFAULT_DIAMOND_COLORS = [
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "EF",
  "FG",
  "GH",
  "IJ",
  "D-E",
  "G-H",
  "I-J",
  "K-M",
  "Fancy Yellow",
  "Fancy Pink",
  "Fancy Blue",
  "Cognac/Brown",
  "Black",
];

export const DEFAULT_DIAMOND_CLARITIES = [
  "FL",
  "IF",
  "VVS1",
  "VVS2",
  "VVS",
  "VS1",
  "VS2",
  "VS",
  "SI1",
  "SI2",
  "SI",
  "I1",
  "I2",
  "I3",
  "VVS-VS",
  "VS-SI",
];

export const DEFAULT_DIAMOND_CUTS = [
  "Round",
  "Princess",
  "Oval",
  "Cushion",
  "Emerald",
  "Marquise",
  "Pear",
  "Radiant",
  "Heart",
  "Asscher",
  "Baguette",
  "Trilliant",
];

export type DiamondSlabLike = {
  id?: string;
  centsFrom: number;
  centsTo: number;
  pricePerCarat: number;
  status?: string;
};

export type DiamondQualityLike = {
  id: string;
  name: string;
  color: string;
  clarity: string;
  slabs: DiamondSlabLike[];
};

export type DiamondQuote =
  | {
      ok: true;
      totalCarat: number;
      diamondCount: number;
      averageCarat: number;
      averageCents: number;
      qualityName: string;
      color: string;
      clarity: string;
      slabFrom: number;
      slabTo: number;
      pricePerCarat: number;
      diamondValue: number;
    }
  | {
      ok: false;
      message: string;
      totalCarat: number;
      diamondCount: number;
      averageCarat: number;
      averageCents: number;
      qualityName: string;
    };

export function qualityLabel(color: string, clarity: string) {
  return `${color.trim()} ${clarity.trim()}`.replace(/\s+/g, " ").trim();
}

export function diamondColorSeriesBase(color: string) {
  return String(color || "")
    .trim()
    .replace(/-\d+$/, "");
}

export function nextSuffixedDiamondColor(existingColors: string[], requestedColor: string) {
  const base = diamondColorSeriesBase(requestedColor);
  if (!base) return requestedColor.trim();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const series = existingColors
    .map((item) => String(item || "").trim())
    .filter((item) => item === base || new RegExp(`^${escaped}-\\d+$`).test(item));
  if (!series.length) return base;
  const nums = series.map((item) => {
    if (item === base) return 1;
    const match = item.match(/-(\d+)$/);
    return match ? Number(match[1]) || 1 : 1;
  });
  return `${base}-${Math.max(...nums) + 1}`;
}

export function caratToCents(carat: number) {
  return (Number(carat) || 0) * 100;
}

export function centsToCarat(cents: number) {
  return (Number(cents) || 0) / 100;
}

export function formatCentsRange(from: number, to: number) {
  const fromLabel = from === 1 ? "1 cent" : `${from} cents`;
  const toLabel = to === 100 ? "1 ct" : to === 1 ? "1 cent" : `${to} cents`;
  return `${fromLabel} – ${toLabel}`;
}

export function rangesOverlap(
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
) {
  return aFrom <= bTo && bFrom <= aTo;
}

export function quoteDiamondValue(input: {
  totalCarat: number;
  diamondCount: number;
  quality?: DiamondQualityLike | null;
}): DiamondQuote {
  const totalCarat = Number(input.totalCarat) || 0;
  const diamondCount = Math.max(0, Math.floor(Number(input.diamondCount) || 0));
  const qualityName = input.quality?.name || "";
  const averageCarat = diamondCount > 0 ? totalCarat / diamondCount : 0;
  const averageCents = caratToCents(averageCarat);

  if (!input.quality) {
    return {
      ok: false,
      message: "Select a diamond quality (color + clarity).",
      totalCarat,
      diamondCount,
      averageCarat,
      averageCents,
      qualityName,
    };
  }

  if (!(totalCarat > 0)) {
    return {
      ok: false,
      message: "Enter total diamond carat weight.",
      totalCarat,
      diamondCount,
      averageCarat,
      averageCents,
      qualityName,
    };
  }

  if (!(diamondCount > 0)) {
    return {
      ok: false,
      message: "Enter the number of diamonds.",
      totalCarat,
      diamondCount,
      averageCarat,
      averageCents,
      qualityName,
    };
  }

  const activeSlabs = (input.quality.slabs || []).filter(
    (slab) => (slab.status || "Active") === "Active",
  );
  const slab = activeSlabs.find((item) => {
    const from = Number(item.centsFrom);
    const to = Number(item.centsTo);
    return averageCents + 1e-9 >= from && averageCents - 1e-9 <= to;
  });

  if (!slab) {
    const ranges =
      activeSlabs.length > 0
        ? activeSlabs
            .map(
              (item) =>
                `${item.centsFrom}–${item.centsTo} cents (${centsToCarat(item.centsFrom).toFixed(3)}–${centsToCarat(item.centsTo).toFixed(3)} ct)`,
            )
            .join("; ")
        : "none yet";
    return {
      ok: false,
      message: `Average size is ${averageCents.toFixed(2)} cents (${averageCarat.toFixed(3)} ct/stone). ${input.quality.name} slabs: ${ranges}. Add a slab that covers this size.`,
      totalCarat,
      diamondCount,
      averageCarat,
      averageCents,
      qualityName,
    };
  }

  const pricePerCarat = Number(slab.pricePerCarat) || 0;
  return {
    ok: true,
    totalCarat,
    diamondCount,
    averageCarat,
    averageCents,
    qualityName: input.quality.name,
    color: input.quality.color,
    clarity: input.quality.clarity,
    slabFrom: slab.centsFrom,
    slabTo: slab.centsTo,
    pricePerCarat,
    diamondValue: totalCarat * pricePerCarat,
  };
}

export function parseBulkDiamondRows(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rows: Array<{
    color: string;
    clarity: string;
    centsFrom: number;
    centsTo: number;
    pricePerCarat: number;
  }> = [];

  for (const line of lines) {
    if (/^color/i.test(line)) continue;
    const parts = line.split(/[,\t;]/).map((part) => part.trim());
    if (parts.length < 5) {
      throw new Error(
        `Invalid row "${line}". Use: Color, Clarity, From cent, To cent, Price/Ct`,
      );
    }
    const [color, clarity, fromRaw, toRaw, priceRaw] = parts;
    const centsFrom = Number(fromRaw);
    const centsTo = Number(toRaw);
    const pricePerCarat = Number(String(priceRaw).replace(/[₹,\s]/g, ""));
    if (!color || !clarity) {
      throw new Error(`Color and clarity are required in row "${line}".`);
    }
    if (!Number.isFinite(centsFrom) || !Number.isFinite(centsTo) || centsFrom <= 0 || centsTo <= 0) {
      throw new Error(`Invalid cent range in row "${line}".`);
    }
    if (centsFrom > centsTo) {
      throw new Error(`From-cent must be lower than To-cent in row "${line}".`);
    }
    if (!Number.isFinite(pricePerCarat) || pricePerCarat < 0) {
      throw new Error(`Invalid price in row "${line}".`);
    }
    rows.push({ color, clarity, centsFrom, centsTo, pricePerCarat });
  }

  return rows;
}
