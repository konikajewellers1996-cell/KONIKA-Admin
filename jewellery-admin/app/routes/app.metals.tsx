import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  DEFAULT_DIAMOND_CLARITIES,
  DEFAULT_DIAMOND_COLORS,
  centsToCarat,
  formatCentsRange,
  nextSuffixedDiamondColor,
  qualityLabel,
  rangesOverlap,
} from "../lib/diamond-pricing";
import {
  parseDiamondExcel,
  buildDiamondExcel,
  buildDiamondCsv,
  slabDuplicateKey,
} from "../lib/diamond-excel";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [metals, purities, diamondQualities, gemstones] = await Promise.all([
    prisma.metalType.findMany({ orderBy: [{ name: "asc" }, { color: "asc" }] }),
    prisma.purityLevel.findMany({
      include: { metal: true },
      orderBy: [{ karat: "asc" }, { label: "asc" }],
    }),
    prisma.diamondQuality.findMany({
      include: { slabs: { orderBy: { centsFrom: "asc" } } },
      orderBy: [{ color: "asc" }, { clarity: "asc" }],
    }),
    prisma.gemstoneType.findMany({ orderBy: { name: "asc" } }),
  ]);
  return { metals, purities, diamondQualities, gemstones };
};

function parsePositiveNumber(value: FormDataEntryValue | null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

async function assertNoOverlap(
  qualityId: string,
  centsFrom: number,
  centsTo: number,
  excludeId?: string,
) {
  const slabs = await prisma.diamondPricingSlab.findMany({
    where: { qualityId, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  const overlap = slabs.find((slab) =>
    rangesOverlap(centsFrom, centsTo, slab.centsFrom, slab.centsTo),
  );
  if (overlap) {
    return `This range overlaps ${formatCentsRange(overlap.centsFrom, overlap.centsTo)} for the same quality.`;
  }
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "add-metal") {
      const name = String(form.get("name") || "").trim() || "Gold";
      const color = String(form.get("color") || "").trim();
      if (!color) return { ok: false, message: "Metal colour is required." };
      await prisma.metalType.create({ data: { name, color, status: "Active" } });
      return { ok: true, message: `${color} added.` };
    }

    if (intent === "toggle-metal") {
      const id = String(form.get("id") || "");
      const metal = await prisma.metalType.findUnique({ where: { id } });
      if (!metal) return { ok: false, message: "Metal not found." };
      await prisma.metalType.update({
        where: { id },
        data: { status: metal.status === "Active" ? "Inactive" : "Active" },
      });
      return { ok: true, message: "Metal status updated." };
    }

    if (intent === "delete-metal") {
      const id = String(form.get("id") || "");
      const inUse = await prisma.productVariant.count({ where: { metalId: id } });
      if (inUse > 0) {
        return { ok: false, message: "Metal is used by products. Remove those variants first." };
      }
      await prisma.metalType.delete({ where: { id } });
      return { ok: true, message: "Metal deleted." };
    }

    if (intent === "add-purity") {
      const metalId = String(form.get("metalId") || "");
      const label = String(form.get("label") || "").trim();
      const purityValue = Number(form.get("purityValue"));
      if (!metalId || !label) return { ok: false, message: "Purity label and metal are required." };
      if (!Number.isFinite(purityValue) || purityValue <= 0) {
        return { ok: false, message: "Enter a valid purity value (e.g. 0.916)." };
      }
      await prisma.purityLevel.create({
        data: {
          metalId,
          label,
          karat: Number(label.replace(/[^0-9]/g, "")) || 0,
          purityValue,
        },
      });
      return { ok: true, message: `Purity ${label} added.` };
    }

    if (intent === "delete-purity") {
      const id = String(form.get("id") || "");
      const inUse = await prisma.productVariant.count({ where: { purityId: id } });
      if (inUse > 0) {
        return { ok: false, message: "Purity is used by products. Remove those variants first." };
      }
      await prisma.purityLevel.delete({ where: { id } });
      return { ok: true, message: "Purity deleted." };
    }

    if (intent === "add-gemstone") {
      const name = String(form.get("name") || "").trim();
      const color = String(form.get("color") || "").trim();
      const defaultRate = Number(form.get("defaultRate") || 0);
      if (!name) return { ok: false, message: "Gemstone name is required." };
      const existing = await prisma.gemstoneType.findUnique({ where: { name } });
      if (existing) return { ok: false, message: `${name} already exists.` };
      await prisma.gemstoneType.create({
        data: {
          name,
          color,
          defaultRate: Number.isFinite(defaultRate) ? defaultRate : 0,
          status: "Active",
        },
      });
      return { ok: true, message: `${name} added to gemstone master.` };
    }

    if (intent === "toggle-gemstone") {
      const id = String(form.get("id") || "");
      const gem = await prisma.gemstoneType.findUnique({ where: { id } });
      if (!gem) return { ok: false, message: "Gemstone not found." };
      await prisma.gemstoneType.update({
        where: { id },
        data: { status: gem.status === "Active" ? "Inactive" : "Active" },
      });
      return { ok: true, message: "Gemstone status updated." };
    }

    if (intent === "delete-gemstone") {
      const id = String(form.get("id") || "");
      await prisma.gemstoneType.delete({ where: { id } });
      return { ok: true, message: "Gemstone deleted." };
    }

    if (intent === "add-diamond-quality") {
      const colorRaw = String(form.get("color") || "").trim();
      const customColor = String(form.get("customColor") || "").trim();
      const color = colorRaw === "__custom__" ? customColor : colorRaw;
      const clarityRaw = String(form.get("clarity") || "").trim();
      const customClarity = String(form.get("customClarity") || "").trim();
      const clarity = clarityRaw === "__custom__" ? customClarity : clarityRaw;
      if (!color || !clarity) {
        return { ok: false, message: "Color and clarity are required." };
      }
      const related = await prisma.diamondQuality.findMany({ where: { clarity } });
      const nextColor = nextSuffixedDiamondColor(
        related.map((item) => item.color),
        color,
      );
      const name = qualityLabel(nextColor, clarity);
      await prisma.diamondQuality.create({ data: { color: nextColor, clarity, name } });
      const suffixNote =
        nextColor === color
          ? `${name} added.`
          : `${color} ${clarity} already exists — saved as ${name}.`;
      return { ok: true, message: suffixNote };
    }

    if (intent === "delete-diamond-quality") {
      const id = String(form.get("id") || "");
      const inUse = await prisma.productVariant.count({ where: { diamondQualityId: id } });
      if (inUse > 0) {
        return {
          ok: false,
          message: "This quality is used by products. Saved product rates are kept, but unlink it from variants before deleting.",
        };
      }
      await prisma.diamondQuality.delete({ where: { id } });
      return { ok: true, message: "Diamond quality deleted." };
    }

    if (intent === "add-diamond-slab" || intent === "update-diamond-slab") {
      const qualityId = String(form.get("qualityId") || "");
      const centsFrom = parsePositiveNumber(form.get("centsFrom"));
      const centsTo = parsePositiveNumber(form.get("centsTo"));
      const pricePerCarat = parsePositiveNumber(form.get("pricePerCarat"));
      const status = String(form.get("status") || "Active") === "Inactive" ? "Inactive" : "Active";
      const slabId = String(form.get("id") || "");

      if (!qualityId) return { ok: false, message: "Select a diamond quality." };
      if (!Number.isFinite(centsFrom) || !Number.isFinite(centsTo) || centsFrom < 0 || centsTo < 0) {
        return { ok: false, message: "Enter valid from/to sizes." };
      }
      if (centsFrom > centsTo) {
        return { ok: false, message: "From-cent must be lower than To-cent." };
      }
      if (!Number.isFinite(pricePerCarat) || pricePerCarat < 0) {
        return { ok: false, message: "Price per carat cannot be blank." };
      }

      const overlap = await assertNoOverlap(
        qualityId,
        centsFrom,
        centsTo,
        intent === "update-diamond-slab" ? slabId : undefined,
      );
      if (overlap) return { ok: false, message: overlap };

      if (intent === "update-diamond-slab") {
        if (!slabId) return { ok: false, message: "Missing slab id." };
        await prisma.diamondPricingSlab.update({
          where: { id: slabId },
          data: { qualityId, centsFrom, centsTo, pricePerCarat, status },
        });
        return { ok: true, message: "Pricing slab updated." };
      }

      await prisma.diamondPricingSlab.create({
        data: { qualityId, centsFrom, centsTo, pricePerCarat, status },
      });
      return { ok: true, message: "Pricing slab added." };
    }

    if (intent === "toggle-diamond-slab") {
      const id = String(form.get("id") || "");
      const slab = await prisma.diamondPricingSlab.findUnique({ where: { id } });
      if (!slab) return { ok: false, message: "Slab not found." };
      await prisma.diamondPricingSlab.update({
        where: { id },
        data: { status: slab.status === "Active" ? "Inactive" : "Active" },
      });
      return { ok: true, message: "Slab status updated." };
    }

    if (intent === "delete-diamond-slab") {
      const id = String(form.get("id") || "");
      await prisma.diamondPricingSlab.delete({ where: { id } });
      return { ok: true, message: "Pricing slab deleted." };
    }

    if (intent === "import-diamond-excel") {
      const uploaded = form.get("excelFile");
      if (!(uploaded instanceof File) || uploaded.size === 0) {
        return { ok: false, message: "Choose an Excel file (.xlsx) to import." };
      }

      const fileName = uploaded.name.toLowerCase();
      const rows = fileName.endsWith(".csv")
        ? parseDiamondExcel(await uploaded.text())
        : parseDiamondExcel(new Uint8Array(await uploaded.arrayBuffer()));
      if (!rows.length) {
        return { ok: false, message: "No pricing rows found in the Excel file." };
      }

      const seenInFile = new Set<string>();
      let created = 0;
      let updated = 0;
      let deleted = 0;
      let skipped = 0;

      for (const row of rows) {
        const name = qualityLabel(row.color, row.clarity);
        const key = slabDuplicateKey(row.color, row.clarity, row.centsFrom, row.centsTo);

        if (!row.color || !row.clarity) {
          skipped += 1;
          continue;
        }

        if (row.action !== "delete") {
          if (
            !Number.isFinite(row.centsFrom) ||
            !Number.isFinite(row.centsTo) ||
            row.centsFrom < 0 ||
            row.centsTo < 0 ||
            row.centsFrom > row.centsTo ||
            !Number.isFinite(row.pricePerCarat) ||
            row.pricePerCarat < 0
          ) {
            skipped += 1;
            continue;
          }
        }

        if (row.action === "create" && seenInFile.has(key)) {
          skipped += 1;
          continue;
        }

        if (row.action === "delete") {
          const existing = row.id
            ? await prisma.diamondPricingSlab.findUnique({ where: { id: row.id } })
            : (
                await prisma.diamondQuality.findUnique({
                  where: { color_clarity: { color: row.color, clarity: row.clarity } },
                  include: { slabs: true },
                })
              )?.slabs.find(
                (slab) => slab.centsFrom === row.centsFrom && slab.centsTo === row.centsTo,
              );
          if (!existing) {
            skipped += 1;
            continue;
          }
          await prisma.diamondPricingSlab.delete({ where: { id: existing.id } });
          deleted += 1;
          continue;
        }

        const quality = await prisma.diamondQuality.upsert({
          where: { color_clarity: { color: row.color, clarity: row.clarity } },
          update: { name },
          create: { color: row.color, clarity: row.clarity, name },
        });

        if (row.action === "update") {
          const existing = row.id
            ? await prisma.diamondPricingSlab.findUnique({ where: { id: row.id } })
            : (
                await prisma.diamondPricingSlab.findFirst({
                  where: {
                    qualityId: quality.id,
                    centsFrom: row.centsFrom,
                    centsTo: row.centsTo,
                  },
                })
              );
          if (!existing) {
            skipped += 1;
            continue;
          }
          const overlap = await assertNoOverlap(
            quality.id,
            row.centsFrom,
            row.centsTo,
            existing.id,
          );
          if (overlap) {
            skipped += 1;
            continue;
          }
          await prisma.diamondPricingSlab.update({
            where: { id: existing.id },
            data: {
              qualityId: quality.id,
              centsFrom: row.centsFrom,
              centsTo: row.centsTo,
              pricePerCarat: row.pricePerCarat,
              status: row.status,
            },
          });
          updated += 1;
          seenInFile.add(key);
          continue;
        }

        const exact = await prisma.diamondPricingSlab.findFirst({
          where: {
            qualityId: quality.id,
            centsFrom: row.centsFrom,
            centsTo: row.centsTo,
          },
        });
        if (exact) {
          skipped += 1;
          continue;
        }
        const overlap = await assertNoOverlap(quality.id, row.centsFrom, row.centsTo);
        if (overlap) {
          skipped += 1;
          continue;
        }
        await prisma.diamondPricingSlab.create({
          data: {
            qualityId: quality.id,
            centsFrom: row.centsFrom,
            centsTo: row.centsTo,
            pricePerCarat: row.pricePerCarat,
            status: row.status,
          },
        });
        created += 1;
        seenInFile.add(key);
      }

      return {
        ok: true,
        message: `Excel import finished. Added ${created}, updated ${updated}, deleted ${deleted}, skipped ${skipped} duplicate/invalid row${skipped === 1 ? "" : "s"}.`,
      };
    }

    return { ok: false, message: "Unknown action." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
};

export default function MetalsPage() {
  const { metals, purities, diamondQualities, gemstones } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [activeTab, setActiveTab] = useState("metals");
  const [colorMode, setColorMode] = useState(DEFAULT_DIAMOND_COLORS[7] || "EF");
  const [customColor, setCustomColor] = useState("");
  const [clarityMode, setClarityMode] = useState("VVS1");
  const [customClarity, setCustomClarity] = useState("");
  const [editingSlabId, setEditingSlabId] = useState("");
  const [slabForm, setSlabForm] = useState({
    qualityId: "",
    centsFrom: "",
    centsTo: "",
    pricePerCarat: "",
    status: "Active",
  });

  const existingColors = useMemo(
    () =>
      Array.from(
        new Set(
          diamondQualities
            .map((q) => q.color)
            .filter((c) => c && !DEFAULT_DIAMOND_COLORS.includes(c)),
        ),
      ),
    [diamondQualities],
  );
  const existingClarities = useMemo(
    () =>
      Array.from(
        new Set(
          diamondQualities
            .map((q) => q.clarity)
            .filter((c) => c && !DEFAULT_DIAMOND_CLARITIES.includes(c)),
        ),
      ),
    [diamondQualities],
  );

  const slabRows = diamondQualities.flatMap((quality) =>
    quality.slabs.map((slab) => ({ quality, slab })),
  );

  const downloadSlabs = diamondQualities.flatMap((quality) =>
    quality.slabs.map((slab) => ({
      id: slab.id,
      color: quality.color,
      clarity: quality.clarity,
      centsFrom: slab.centsFrom,
      centsTo: slab.centsTo,
      pricePerCarat: slab.pricePerCarat,
      status: slab.status,
    })),
  );

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadDiamondExcel = () => {
    const buffer = buildDiamondExcel(downloadSlabs);
    triggerDownload(
      new Blob([new Uint8Array(buffer)], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "diamond-pricing.xlsx",
    );
  };

  const downloadDiamondCsv = () => {
    triggerDownload(
      new Blob([buildDiamondCsv(downloadSlabs)], { type: "text/csv;charset=utf-8;" }),
      "diamond-pricing.csv",
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Metals &amp; diamonds</h2>
          <p className="page-sub">
            Configure metals, purities, diamond pricing, and gemstone master.
          </p>
        </div>
      </div>

      <div className="tab-bar" role="tablist" aria-label="Metals or diamond pricing">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "metals"}
          className={`tab-btn ${activeTab === "metals" ? "active" : ""}`}
          onClick={() => setActiveTab("metals")}
        >
          Metals &amp; purity
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "diamonds"}
          className={`tab-btn ${activeTab === "diamonds" ? "active" : ""}`}
          onClick={() => setActiveTab("diamonds")}
        >
          Diamond pricing
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "gemstones"}
          className={`tab-btn ${activeTab === "gemstones" ? "active" : ""}`}
          onClick={() => setActiveTab("gemstones")}
        >
          Gemstones
        </button>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`}>{actionData.message}</div>
      ) : null}

      {activeTab === "metals" ? (
        <>
          <div className="split-2">
            <div className="panel">
              <div className="panel-title">Add metal colour</div>
              <Form method="post">
                <input type="hidden" name="intent" value="add-metal" />
                <div className="field">
                  <label>Metal name</label>
                  <input name="name" defaultValue="Gold" />
                </div>
                <div className="field">
                  <label>Colour</label>
                  <select name="color" defaultValue="Yellow Gold">
                    <option>Yellow Gold</option>
                    <option>Rose Gold</option>
                    <option>White Gold</option>
                    <option>Silver</option>
                  </select>
                </div>
                <button className="btn primary" type="submit" disabled={busy}>
                  Add metal
                </button>
              </Form>
            </div>

            <div className="panel">
              <div className="panel-title">Add purity</div>
              <Form method="post">
                <input type="hidden" name="intent" value="add-purity" />
                <div className="field">
                  <label>Metal colour</label>
                  <select name="metalId" required>
                    {metals.map((metal) => (
                      <option key={metal.id} value={metal.id}>
                        {metal.color}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Label</label>
                    <select name="label" defaultValue="22K">
                      <option>14K</option>
                      <option>18K</option>
                      <option>22K</option>
                      <option>24K</option>
                      <option>925</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Purity value</label>
                    <input
                      name="purityValue"
                      type="number"
                      step="0.001"
                      defaultValue="0.916"
                      required
                    />
                  </div>
                </div>
                <button className="btn primary" type="submit" disabled={busy}>
                  Add purity
                </button>
              </Form>
            </div>
          </div>

          <div className="split-2 metals-tables">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Metal</th>
                    <th>Colour</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right", width: 120 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {metals.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty-state">No metals yet.</div>
                      </td>
                    </tr>
                  ) : (
                    metals.map((metal) => (
                      <tr key={metal.id}>
                        <td>{metal.name}</td>
                        <td>{metal.color}</td>
                        <td>
                          <span className={`badge ${metal.status === "Active" ? "active" : "draft"}`}>
                            <span className="badge-dot" />
                            {metal.status}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions stack">
                            <Form method="post">
                              <input type="hidden" name="intent" value="toggle-metal" />
                              <input type="hidden" name="id" value={metal.id} />
                              <button className="btn small" type="submit" disabled={busy}>
                                {metal.status === "Active" ? "Deactivate" : "Activate"}
                              </button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete-metal" />
                              <input type="hidden" name="id" value={metal.id} />
                              <button className="btn small danger" type="submit" disabled={busy}>
                                Delete
                              </button>
                            </Form>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Metal colour</th>
                    <th>Label</th>
                    <th>Value</th>
                    <th style={{ textAlign: "right", width: 90 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {purities.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty-state">No purity levels yet.</div>
                      </td>
                    </tr>
                  ) : (
                    purities.map((purity) => (
                      <tr key={purity.id}>
                        <td>{purity.metal.color}</td>
                        <td>{purity.label}</td>
                        <td className="mono">{purity.purityValue}</td>
                        <td>
                          <Form method="post" className="row-actions">
                            <input type="hidden" name="intent" value="delete-purity" />
                            <input type="hidden" name="id" value={purity.id} />
                            <button className="btn small danger" type="submit" disabled={busy}>
                              Delete
                            </button>
                          </Form>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : activeTab === "gemstones" ? (
        <>
          <div className="split-2">
            <div className="panel">
              <div className="panel-title">Add gemstone</div>
              <div className="hint" style={{ marginBottom: 12 }}>
                These names appear in the product stones dropdown. You can add several stones on one variant.
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="add-gemstone" />
                <div className="field">
                  <label>Name</label>
                  <input name="name" placeholder="e.g. Ruby" required />
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Colour (optional)</label>
                    <input name="color" placeholder="e.g. Red" />
                  </div>
                  <div className="field">
                    <label>Default rate ₹ / g</label>
                    <input name="defaultRate" type="number" step="0.01" min="0" defaultValue="0" />
                  </div>
                </div>
                <button className="btn primary" type="submit" disabled={busy}>
                  Add gemstone
                </button>
              </Form>
            </div>
            <div className="panel">
              <div className="panel-title">How it works</div>
              <p className="hint">
                Diamond pricing stays on the Diamond tab. Gemstones here are coloured stones, pearls, and other
                materials. While creating a product, pick Diamond or any gemstone from this master, and add more than
                one stone on the same variant.
              </p>
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Colour</th>
                  <th>Default rate</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right", width: 160 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {gemstones.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty">No gemstones yet.</div>
                    </td>
                  </tr>
                ) : (
                  gemstones.map((gem) => (
                    <tr key={gem.id}>
                      <td>{gem.name}</td>
                      <td>{gem.color || "—"}</td>
                      <td className="mono">{gem.defaultRate ? gem.defaultRate : "—"}</td>
                      <td>
                        <span className={`badge ${gem.status === "Active" ? "active" : "draft"}`}>
                          {gem.status}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Form method="post">
                            <input type="hidden" name="intent" value="toggle-gemstone" />
                            <input type="hidden" name="id" value={gem.id} />
                            <button className="btn small" type="submit" disabled={busy}>
                              {gem.status === "Active" ? "Off" : "On"}
                            </button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete-gemstone" />
                            <input type="hidden" name="id" value={gem.id} />
                            <button className="btn small danger" type="submit" disabled={busy}>
                              Delete
                            </button>
                          </Form>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="split-2">
          <div>
            <div className="panel">
              <div className="panel-title">Add diamond quality</div>
              <div className="hint" style={{ marginBottom: 12 }}>
                Quality is Color + Clarity. Adding the same pair again saves as a numbered colour (EF-2, EF-3) so different weight/price groups stay separate. Slabs under one quality still cover size ranges.
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="add-diamond-quality" />
                <div className="field-row">
                  <div className="field">
                    <label>Color</label>
                    <select
                      name="color"
                      value={colorMode}
                      onChange={(e) => setColorMode(e.target.value)}
                    >
                      <optgroup label="Standard">
                        {DEFAULT_DIAMOND_COLORS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </optgroup>
                      {existingColors.length > 0 ? (
                        <optgroup label="Saved custom">
                          {existingColors.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <option value="__custom__">+ Enter custom color…</option>
                    </select>
                    {colorMode === "__custom__" ? (
                      <input
                        name="customColor"
                        style={{ marginTop: 6 }}
                        placeholder="e.g. Champagne"
                        value={customColor}
                        onChange={(e) => setCustomColor(e.target.value)}
                        required
                      />
                    ) : null}
                  </div>
                  <div className="field">
                    <label>Clarity</label>
                    <select
                      name="clarity"
                      value={clarityMode}
                      onChange={(e) => setClarityMode(e.target.value)}
                    >
                      <optgroup label="Standard">
                        {DEFAULT_DIAMOND_CLARITIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </optgroup>
                      {existingClarities.length > 0 ? (
                        <optgroup label="Saved custom">
                          {existingClarities.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                      <option value="__custom__">+ Enter custom clarity…</option>
                    </select>
                    {clarityMode === "__custom__" ? (
                      <input
                        name="customClarity"
                        style={{ marginTop: 6 }}
                        placeholder="e.g. Eye Clean"
                        value={customClarity}
                        onChange={(e) => setCustomClarity(e.target.value)}
                        required
                      />
                    ) : null}
                  </div>
                </div>
                <button className="btn primary" type="submit" disabled={busy}>
                  Add diamond quality
                </button>
              </Form>
            </div>

            <div className="panel" style={{ marginTop: 18 }}>
              <div className="panel-title">
                {editingSlabId ? "Edit pricing slab" : "Add pricing slab"}
              </div>
              <div className="hint" style={{ marginBottom: 12 }}>
                Size is stored in cents (1 ct = 100 cents). A 2.00 ct single diamond is 200 cents, so it will not match a 1–5 cent melee slab.
              </div>
              <Form
                method="post"
                onSubmit={() => {
                  if (!editingSlabId) {
                    setSlabForm((c) => ({ ...c, centsFrom: "", centsTo: "", pricePerCarat: "" }));
                  }
                }}
              >
                <input type="hidden" name="intent" value={editingSlabId ? "update-diamond-slab" : "add-diamond-slab"} />
                {editingSlabId ? <input type="hidden" name="id" value={editingSlabId} /> : null}
                <div className="field">
                  <label>Diamond quality</label>
                  <select
                    name="qualityId"
                    value={slabForm.qualityId}
                    onChange={(e) => setSlabForm((c) => ({ ...c, qualityId: e.target.value }))}
                    required
                  >
                    <option value="">Select quality…</option>
                    {diamondQualities.map((quality) => (
                      <option key={quality.id} value={quality.id}>
                        {quality.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>From (cents)</label>
                    <input
                      name="centsFrom"
                      type="text"
                      inputMode="decimal"
                      placeholder="0.01"
                      value={slabForm.centsFrom}
                      onChange={(e) => setSlabForm((c) => ({ ...c, centsFrom: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="field">
                    <label>To (cents)</label>
                    <input
                      name="centsTo"
                      type="text"
                      inputMode="decimal"
                      placeholder="5"
                      value={slabForm.centsTo}
                      onChange={(e) => setSlabForm((c) => ({ ...c, centsTo: e.target.value }))}
                      required
                    />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>From (ct)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0001"
                      value={
                        slabForm.centsFrom === ""
                          ? ""
                          : Number.isFinite(Number(slabForm.centsFrom))
                            ? String(Number((Number(slabForm.centsFrom) / 100).toPrecision(12)))
                            : ""
                      }
                      onChange={(e) =>
                        setSlabForm((c) => ({
                          ...c,
                          centsFrom:
                            e.target.value === ""
                              ? ""
                              : String(Number(e.target.value) * 100),
                        }))
                      }
                    />
                  </div>
                  <div className="field">
                    <label>To (ct)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0001"
                      value={
                        slabForm.centsTo === ""
                          ? ""
                          : Number.isFinite(Number(slabForm.centsTo))
                            ? String(Number((Number(slabForm.centsTo) / 100).toPrecision(12)))
                            : ""
                      }
                      onChange={(e) =>
                        setSlabForm((c) => ({
                          ...c,
                          centsTo:
                            e.target.value === ""
                              ? ""
                              : String(Number(e.target.value) * 100),
                        }))
                      }
                    />
                  </div>
                </div>
                {slabForm.centsFrom && slabForm.centsTo ? (
                  <div className="hint" style={{ marginBottom: 12 }}>
                    {slabForm.centsFrom}–{slabForm.centsTo} cents ={" "}
                    {centsToCarat(Number(slabForm.centsFrom)).toFixed(3)}–
                    {centsToCarat(Number(slabForm.centsTo)).toFixed(3)} ct
                  </div>
                ) : null}
                <div className="field-row">
                  <div className="field">
                    <label>Price / carat (₹)</label>
                    <input
                      name="pricePerCarat"
                      type="number"
                      step="1"
                      min="0"
                      placeholder="100000"
                      value={slabForm.pricePerCarat}
                      onChange={(e) => setSlabForm((c) => ({ ...c, pricePerCarat: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="field">
                    <label>Status</label>
                    <select
                      name="status"
                      value={slabForm.status}
                      onChange={(e) => setSlabForm((c) => ({ ...c, status: e.target.value }))}
                    >
                      <option>Active</option>
                      <option>Inactive</option>
                    </select>
                  </div>
                </div>
                <div className="row-actions">
                  <button className="btn primary" type="submit" disabled={busy || diamondQualities.length === 0}>
                    {editingSlabId ? "Save slab" : "Add pricing slab"}
                  </button>
                  {editingSlabId ? (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setEditingSlabId("");
                        setSlabForm({
                          qualityId: slabForm.qualityId,
                          centsFrom: "",
                          centsTo: "",
                          pricePerCarat: "",
                          status: "Active",
                        });
                      }}
                    >
                      Cancel edit
                    </button>
                  ) : null}
                </div>
              </Form>
            </div>

            <div className="panel" style={{ marginTop: 18 }}>
              <div className="panel-title">Excel export / import</div>
              <div className="hint" style={{ marginBottom: 12 }}>
                Export the current rate card, edit prices in Excel, then import. Keep the <strong>id</strong> column to update.
                Set <strong>action</strong> to <code>delete</code> to remove a row. Duplicate Color + Clarity + From + To rows are skipped; the rest still import.
              </div>
              <div className="row-actions" style={{ marginBottom: 12 }}>
                <button className="btn" type="button" onClick={downloadDiamondExcel}>
                  Export Excel
                </button>
                <button className="btn" type="button" onClick={downloadDiamondCsv}>
                  Export CSV
                </button>
              </div>
              <Form method="post" encType="multipart/form-data">
                <input type="hidden" name="intent" value="import-diamond-excel" />
                <div className="field">
                  <label>Excel / CSV file</label>
                  <input type="file" name="excelFile" accept=".xlsx,.xls,.csv" required />
                </div>
                <button className="btn primary" type="submit" disabled={busy}>
                  Import Excel
                </button>
              </Form>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Color</th>
                  <th>Clarity</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Size (ct)</th>
                  <th>Price / ct</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right", width: 220 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {diamondQualities.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty-state">No diamond qualities yet. Add EF VVS1 (or any Color + Clarity) first.</div>
                    </td>
                  </tr>
                ) : slabRows.length === 0 ? (
                  diamondQualities.map((quality) => (
                    <tr key={quality.id}>
                      <td>{quality.color}</td>
                      <td>{quality.clarity}</td>
                      <td colSpan={4}>
                        <div className="hint">No slabs yet for {quality.name}.</div>
                      </td>
                      <td>—</td>
                      <td>
                        <Form method="post" className="row-actions">
                          <input type="hidden" name="intent" value="delete-diamond-quality" />
                          <input type="hidden" name="id" value={quality.id} />
                          <button className="btn small danger" type="submit" disabled={busy}>
                            Delete quality
                          </button>
                        </Form>
                      </td>
                    </tr>
                  ))
                ) : (
                  <>
                    {slabRows.map(({ quality, slab }) => (
                      <tr key={slab.id}>
                        <td>{quality.color}</td>
                        <td>{quality.clarity}</td>
                        <td className="mono">{slab.centsFrom} ¢</td>
                        <td className="mono">{slab.centsTo} ¢</td>
                        <td className="mono">
                          {centsToCarat(slab.centsFrom).toFixed(3)}–{centsToCarat(slab.centsTo).toFixed(3)}
                        </td>
                        <td className="mono">
                          {new Intl.NumberFormat("en-IN").format(slab.pricePerCarat)}
                        </td>
                        <td>
                          <span className={`badge ${slab.status === "Active" ? "active" : "draft"}`}>
                            {slab.status}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="btn small"
                              type="button"
                              onClick={() => {
                                setEditingSlabId(slab.id);
                                setSlabForm({
                                  qualityId: quality.id,
                                  centsFrom: String(slab.centsFrom),
                                  centsTo: String(slab.centsTo),
                                  pricePerCarat: String(slab.pricePerCarat),
                                  status: slab.status,
                                });
                              }}
                            >
                              Edit
                            </button>
                            <Form method="post">
                              <input type="hidden" name="intent" value="toggle-diamond-slab" />
                              <input type="hidden" name="id" value={slab.id} />
                              <button className="btn small" type="submit" disabled={busy}>
                                {slab.status === "Active" ? "Off" : "On"}
                              </button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete-diamond-slab" />
                              <input type="hidden" name="id" value={slab.id} />
                              <button className="btn small danger" type="submit" disabled={busy}>
                                Delete
                              </button>
                            </Form>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {diamondQualities
                      .filter((quality) => quality.slabs.length === 0)
                      .map((quality) => (
                        <tr key={`empty-${quality.id}`}>
                          <td>{quality.color}</td>
                          <td>{quality.clarity}</td>
                          <td colSpan={4}>
                            <div className="hint">No slabs yet for {quality.name}.</div>
                          </td>
                          <td>—</td>
                          <td>
                            <Form method="post" className="row-actions">
                              <input type="hidden" name="intent" value="delete-diamond-quality" />
                              <input type="hidden" name="id" value={quality.id} />
                              <button className="btn small danger" type="submit" disabled={busy}>
                                Delete quality
                              </button>
                            </Form>
                          </td>
                        </tr>
                      ))}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
