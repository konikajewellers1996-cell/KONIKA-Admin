import * as XLSX from "xlsx";

export type ProductExcelRow = {
  rowNumber: number;
  sku: string;
  name: string;
  description: string;
  gender: string;
  collections: string;
  status: string;
  metalColor: string;
  purityLabel: string;
  grossWeight: number;
  wastagePercent: number;
  makingChargeType: string;
  makingChargeValue: number;
  stoneIncluded: boolean;
  stoneType: string;
  stoneWeight: number;
  stoneRate: number;
  diamondCount: number;
  diamondQuality: string;
  diamondCut: string;
  variantStatus: string;
};

export type ProductExportVariant = {
  sku: string;
  name: string;
  description: string;
  gender: string;
  collections: string;
  status: string;
  metalColor: string;
  purityLabel: string;
  grossWeight: number;
  wastagePercent: number;
  makingChargeType: string;
  makingChargeValue: number;
  stoneIncluded: boolean;
  stoneType: string;
  stoneWeight: number;
  stoneRate: number;
  diamondCount: number;
  diamondQuality: string;
  diamondCut: string;
  variantStatus: string;
};

export type ProductExcelLookups = {
  metals: Array<{ color: string }>;
  purities: Array<{ label: string; metalColor: string }>;
  collections: Array<{ name: string }>;
  diamondQualities: Array<{ name: string }>;
};

function normHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function cellString(value: unknown) {
  return String(value ?? "").trim();
}

function cellNumber(value: unknown) {
  const n = Number(String(value ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function cellBool(value: unknown) {
  const raw = cellString(value).toLowerCase();
  if (!raw) return false;
  return ["1", "y", "yes", "true", "with", "withstone", "stone"].includes(raw);
}

function pick(row: Record<string, unknown>, aliases: string[]) {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    map.set(normHeader(key), value);
  }
  for (const alias of aliases) {
    if (map.has(alias)) return map.get(alias);
  }
  return "";
}

function workbookToArrayBuffer(workbook: XLSX.WorkBook) {
  const binary = XLSX.write(workbook, { bookType: "xlsx", type: "binary" }) as string;
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    view[i] = binary.charCodeAt(i) & 0xff;
  }
  return buffer;
}

function toSheetRow(row: ProductExportVariant) {
  return {
    sku: row.sku,
    name: row.name,
    description: row.description,
    gender: row.gender,
    collections: row.collections,
    status: row.status,
    metalColor: row.metalColor,
    purityLabel: row.purityLabel,
    grossWeight: row.grossWeight,
    wastagePercent: row.wastagePercent,
    makingChargeType: row.makingChargeType,
    makingChargeValue: row.makingChargeValue,
    stoneIncluded: row.stoneIncluded ? "yes" : "no",
    stoneType: row.stoneType,
    stoneWeight: row.stoneWeight,
    stoneRate: row.stoneRate,
    diamondCount: row.diamondCount,
    diamondQuality: row.diamondQuality,
    diamondCut: row.diamondCut,
    variantStatus: row.variantStatus,
  };
}

const SAMPLE_ROWS: ProductExportVariant[] = [
  {
    sku: "RING-001",
    name: "Classic Solitaire Ring",
    description: "22K yellow gold ring",
    gender: "Women",
    collections: "Bridal",
    status: "Active",
    metalColor: "Yellow Gold",
    purityLabel: "22K",
    grossWeight: 4.5,
    wastagePercent: 5,
    makingChargeType: "percent",
    makingChargeValue: 10,
    stoneIncluded: true,
    stoneType: "Diamond",
    stoneWeight: 0.2,
    stoneRate: 0,
    diamondCount: 1,
    diamondQuality: "EF VVS1",
    diamondCut: "Round",
    variantStatus: "Active",
  },
  {
    sku: "RING-001",
    name: "Classic Solitaire Ring",
    description: "22K yellow gold ring",
    gender: "Women",
    collections: "Bridal",
    status: "Active",
    metalColor: "Rose Gold",
    purityLabel: "18K",
    grossWeight: 4.2,
    wastagePercent: 5,
    makingChargeType: "percent",
    makingChargeValue: 10,
    stoneIncluded: true,
    stoneType: "Diamond",
    stoneWeight: 0.2,
    stoneRate: 0,
    diamondCount: 1,
    diamondQuality: "EF VVS1",
    diamondCut: "Round",
    variantStatus: "Active",
  },
  {
    sku: "BAND-002",
    name: "Plain Gold Band",
    description: "Without stone",
    gender: "Unisex",
    collections: "",
    status: "Active",
    metalColor: "Yellow Gold",
    purityLabel: "22K",
    grossWeight: 3.1,
    wastagePercent: 5,
    makingChargeType: "percent",
    makingChargeValue: 12,
    stoneIncluded: false,
    stoneType: "None",
    stoneWeight: 0,
    stoneRate: 0,
    diamondCount: 1,
    diamondQuality: "",
    diamondCut: "",
    variantStatus: "Active",
  },
];

export function parseProductExcel(data: ArrayBuffer | Uint8Array | string): ProductExcelRow[] {
  const workbook =
    typeof data === "string"
      ? XLSX.read(data, { type: "string" })
      : XLSX.read(data, { type: "array" });
  const sheetName =
    workbook.SheetNames.find((name) => /product/i.test(name)) ||
    workbook.SheetNames.find((name) => !/instruction|lookup|metal|purity|collection|diamond/i.test(name)) ||
    workbook.SheetNames[0];
  if (!sheetName) throw new Error("The Excel file has no sheets.");

  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const rows: ProductExcelRow[] = [];
  json.forEach((raw, index) => {
    const sku = cellString(pick(raw, ["sku", "skucode", "designno"]));
    const name = cellString(pick(raw, ["name", "productname", "title"]));
    if (!sku && !name) return;

    rows.push({
      rowNumber: index + 2,
      sku,
      name,
      description: cellString(pick(raw, ["description", "desc"])),
      gender: cellString(pick(raw, ["gender"])) || "Unisex",
      collections: cellString(pick(raw, ["collections", "collection"])),
      status:
        cellString(pick(raw, ["status", "productstatus"])).toLowerCase() === "draft"
          ? "Draft"
          : "Active",
      metalColor: cellString(pick(raw, ["metalcolor", "metal", "colour", "color"])),
      purityLabel: cellString(pick(raw, ["puritylabel", "purity", "karat", "kt"])),
      grossWeight: cellNumber(pick(raw, ["grossweight", "grosswt", "weight", "gross"])),
      wastagePercent: cellNumber(pick(raw, ["wastagepercent", "wastage"])) || 0,
      makingChargeType:
        cellString(pick(raw, ["makingchargetype", "makingtype"])).toLowerCase() === "fixed"
          ? "fixed"
          : "percent",
      makingChargeValue: cellNumber(pick(raw, ["makingchargevalue", "makingcharge", "making"])) || 0,
      stoneIncluded: cellBool(pick(raw, ["stoneincluded", "withstone", "stone"])),
      stoneType: cellString(pick(raw, ["stonetype"])) || "None",
      stoneWeight: cellNumber(pick(raw, ["stoneweight", "caratweight", "totalcarat", "carat"])) || 0,
      stoneRate: cellNumber(pick(raw, ["stonerate", "stoneprice"])) || 0,
      diamondCount: Math.max(1, Math.floor(cellNumber(pick(raw, ["diamondcount", "noofdiamonds", "stones"])) || 1)),
      diamondQuality: cellString(pick(raw, ["diamondquality", "quality"])),
      diamondCut: cellString(pick(raw, ["diamondcut", "cut", "shape"])) || "Round",
      variantStatus:
        cellString(pick(raw, ["variantstatus"])).toLowerCase() === "draft" ? "Draft" : "Active",
    });
  });

  return rows;
}

export function groupProductExcelRows(rows: ProductExcelRow[]) {
  const map = new Map<string, ProductExcelRow[]>();
  for (const row of rows) {
    const key = row.sku.trim().toLowerCase();
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export function buildProductExcel(
  products: ProductExportVariant[],
  lookups: ProductExcelLookups,
) {
  const workbook = XLSX.utils.book_new();
  const rows = (products.length ? products : SAMPLE_ROWS).map(toSheetRow);
  const dataSheet = XLSX.utils.json_to_sheet(rows);
  dataSheet["!cols"] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 28 },
    { wch: 10 },
    { wch: 18 },
    { wch: 10 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(workbook, dataSheet, "Products");

  const help = XLSX.utils.aoa_to_sheet([
    ["Konika product bulk import"],
    ["One Excel row = one colour × purity variant."],
    ["Use the same SKU on multiple rows to create several variants under one product."],
    ["Fill metalColor and purityLabel from the Lookups sheet."],
    ["For diamonds: stoneIncluded=yes, stoneType=Diamond, stoneWeight=total carat, diamondCount=number of stones, diamondQuality=EF VVS1"],
    ["Diamond stone charge is auto-calculated from diamond pricing slabs when quality matches."],
    ["For other stones: stoneType=Ruby/Emerald/etc, stoneWeight in grams, stoneRate = ₹ per gram."],
    ["Collections: comma-separated names, e.g. Bridal, Everyday"],
    ["Duplicate SKUs already in the catalog are skipped. Remaining products still import."],
    [],
    ["Required columns"],
    ["sku", "name", "metalColor", "purityLabel", "grossWeight"],
    [],
    ["Optional columns"],
    [
      "description",
      "gender",
      "collections",
      "status",
      "wastagePercent",
      "makingChargeType",
      "makingChargeValue",
      "stoneIncluded",
      "stoneType",
      "stoneWeight",
      "stoneRate",
      "diamondCount",
      "diamondQuality",
      "diamondCut",
      "variantStatus",
    ],
  ]);
  XLSX.utils.book_append_sheet(workbook, help, "Instructions");

  const metalRows = lookups.metals.map((m) => ({ metalColor: m.color }));
  const purityRows = lookups.purities.map((p) => ({
    metalColor: p.metalColor,
    purityLabel: p.label,
  }));
  const collectionRows = lookups.collections.map((c) => ({ collection: c.name }));
  const diamondRows = lookups.diamondQualities.map((d) => ({ diamondQuality: d.name }));

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(metalRows.length ? metalRows : [{ metalColor: "Yellow Gold" }]),
    "Metals",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      purityRows.length ? purityRows : [{ metalColor: "Yellow Gold", purityLabel: "22K" }],
    ),
    "Purities",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(collectionRows.length ? collectionRows : [{ collection: "Bridal" }]),
    "Collections",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      diamondRows.length ? diamondRows : [{ diamondQuality: "EF VVS1" }],
    ),
    "DiamondQualities",
  );

  return workbookToArrayBuffer(workbook);
}

export function buildProductCsv(products: ProductExportVariant[]) {
  const rows = (products.length ? products : SAMPLE_ROWS).map(toSheetRow);
  const header = Object.keys(rows[0]);
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((key) => {
          const value = String((row as Record<string, unknown>)[key] ?? "");
          if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
          return value;
        })
        .join(","),
    ),
  ];
  return `\uFEFF${lines.join("\r\n")}`;
}
