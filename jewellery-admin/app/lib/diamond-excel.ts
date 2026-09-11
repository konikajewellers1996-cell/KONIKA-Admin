import * as XLSX from "xlsx";

export type DiamondExcelAction = "create" | "update" | "delete";

export type DiamondExcelRow = {
  rowNumber: number;
  id: string;
  color: string;
  clarity: string;
  centsFrom: number;
  centsTo: number;
  pricePerCarat: number;
  status: "Active" | "Inactive";
  action: DiamondExcelAction;
};

export type DiamondExportSlab = {
  id: string;
  color: string;
  clarity: string;
  centsFrom: number;
  centsTo: number;
  pricePerCarat: number;
  status: string;
};

export function slabDuplicateKey(
  color: string,
  clarity: string,
  centsFrom: number,
  centsTo: number,
) {
  return `${color.trim().toLowerCase()}|${clarity.trim().toLowerCase()}|${centsFrom}|${centsTo}`;
}

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

export function parseDiamondExcel(data: ArrayBuffer | Uint8Array | string): DiamondExcelRow[] {
  const workbook =
    typeof data === "string"
      ? XLSX.read(data, { type: "string" })
      : XLSX.read(data, { type: "array" });
  const sheetName =
    workbook.SheetNames.find((name) => !/instruction/i.test(name)) ||
    workbook.SheetNames[0];
  if (!sheetName) throw new Error("The Excel file has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const rows: DiamondExcelRow[] = [];
  json.forEach((raw, index) => {
    const color = cellString(pick(raw, ["color", "colour"]));
    const clarity = cellString(pick(raw, ["clarity"]));
    if (!color && !clarity) return;

    const actionRaw = cellString(
      pick(raw, ["action", "intent"]),
    ).toLowerCase();
    const action: DiamondExcelAction =
      actionRaw === "delete" || actionRaw === "remove"
        ? "delete"
        : actionRaw === "update" || actionRaw === "edit"
          ? "update"
          : actionRaw === "create" || actionRaw === "add"
            ? "create"
            : cellString(pick(raw, ["id", "slabid"]))
              ? "update"
              : "create";

    rows.push({
      rowNumber: index + 2,
      id: cellString(pick(raw, ["id", "slabid"])),
      color,
      clarity,
      centsFrom: (() => {
        const cents = cellNumber(pick(raw, ["fromcent", "fromcents", "centsfrom", "from"]));
        if (Number.isFinite(cents) && cents > 0) return cents;
        const carat = cellNumber(pick(raw, ["fromct", "fromcarat", "mincarat"]));
        return Number.isFinite(carat) ? carat * 100 : NaN;
      })(),
      centsTo: (() => {
        const cents = cellNumber(pick(raw, ["tocent", "tocents", "centsto", "to"]));
        if (Number.isFinite(cents) && cents > 0) return cents;
        const carat = cellNumber(pick(raw, ["toct", "tocarat", "maxcarat"]));
        return Number.isFinite(carat) ? carat * 100 : NaN;
      })(),
      pricePerCarat: cellNumber(
        pick(raw, ["pricepercarat", "priceperct", "price", "pricect"]),
      ),
      status:
        cellString(pick(raw, ["status"])).toLowerCase() === "inactive"
          ? "Inactive"
          : "Active",
      action,
    });
  });

  return rows;
}

export function buildDiamondExcel(slabs: DiamondExportSlab[]) {
  const workbook = XLSX.utils.book_new();
  const rows =
    slabs.length > 0
      ? slabs.map((slab) => ({
          id: slab.id,
          color: slab.color,
          clarity: slab.clarity,
          fromCent: slab.centsFrom,
          toCent: slab.centsTo,
          fromCt: Number((slab.centsFrom / 100).toFixed(4)),
          toCt: Number((slab.centsTo / 100).toFixed(4)),
          pricePerCarat: slab.pricePerCarat,
          status: slab.status,
          action: "update",
        }))
      : [
          {
            id: "",
            color: "EF",
            clarity: "VVS1",
            fromCent: 1,
            toCent: 5,
            fromCt: 0.01,
            toCt: 0.05,
            pricePerCarat: 100000,
            status: "Active",
            action: "create",
          },
        ];

  const dataSheet = XLSX.utils.json_to_sheet(rows);
  dataSheet["!cols"] = [
    { wch: 28 },
    { wch: 10 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(workbook, dataSheet, "Diamond Pricing");

  const help = XLSX.utils.aoa_to_sheet([
    ["Diamond pricing Excel"],
    ["Keep id to update an existing slab. Leave id blank to add a new slab."],
    ["Set action to delete to remove a slab."],
    ["Duplicates (same Color + Clarity + From + To) are skipped; remaining rows still import."],
    ["Overlapping cent ranges for the same quality are also skipped."],
    [],
    ["Columns", "id", "color", "clarity", "fromCent", "toCent", "fromCt", "toCt", "pricePerCarat", "status", "action"],
    ["1 carat = 100 cents. fromCt/toCt are optional; fromCent/toCent are used when present."],
    ["action values", "create", "update", "delete"],
  ]);
  XLSX.utils.book_append_sheet(workbook, help, "Instructions");

  return workbookToArrayBuffer(workbook);
}

export function buildDiamondCsv(slabs: DiamondExportSlab[]) {
  const header = [
    "id",
    "color",
    "clarity",
    "fromCent",
    "toCent",
    "fromCt",
    "toCt",
    "pricePerCarat",
    "status",
    "action",
  ];
  const rows =
    slabs.length > 0
      ? slabs
      : [
          {
            id: "",
            color: "EF",
            clarity: "VVS1",
            centsFrom: 1,
            centsTo: 5,
            pricePerCarat: 100000,
            status: "Active",
          },
        ];
  const lines = [
    header.join(","),
    ...rows.map((slab) =>
      [
        slab.id,
        slab.color,
        slab.clarity,
        slab.centsFrom,
        slab.centsTo,
        Number((slab.centsFrom / 100).toFixed(4)),
        Number((slab.centsTo / 100).toFixed(4)),
        slab.pricePerCarat,
        slab.status,
        slabs.length > 0 ? "update" : "create",
      ].join(","),
    ),
  ];
  return `\uFEFF${lines.join("\r\n")}`;
}
