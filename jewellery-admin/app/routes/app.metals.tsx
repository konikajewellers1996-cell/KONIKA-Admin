import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [metals, purities, diamondSpecs] = await Promise.all([
    prisma.metalType.findMany({ orderBy: [{ name: "asc" }, { color: "asc" }] }),
    prisma.purityLevel.findMany({
      include: { metal: true },
      orderBy: [{ karat: "asc" }, { label: "asc" }],
    }),
    prisma.diamondSpec.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  return { metals, purities, diamondSpecs };
};

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

    if (intent === "add-diamond-spec") {
      const name = String(form.get("name") || "").trim();
      const cut = String(form.get("cut") || "").trim();
      const caratFrom = Number(form.get("caratFrom"));
      const caratTo = Number(form.get("caratTo"));
      const color = String(form.get("color") || "").trim();
      const clarity = String(form.get("clarity") || "").trim();
      const price = Number(form.get("price"));

      if (!name) {
        return { ok: false, message: "Diamond name is required." };
      }

      const safeCaratFrom = Number.isFinite(caratFrom) && caratFrom > 0 ? caratFrom : null;
      const safeCaratTo = Number.isFinite(caratTo) && caratTo > 0 ? caratTo : null;

      if (!safeCaratFrom && !safeCaratTo) {
        return { ok: false, message: "Set at least one valid carat weight or range." };
      }

      if (safeCaratFrom !== null && safeCaratTo !== null && safeCaratFrom > safeCaratTo) {
        return { ok: false, message: "From weight cannot be greater than To weight." };
      }

      if (!Number.isFinite(price) || price < 0) {
        return { ok: false, message: "Price must be a positive number." };
      }

      await prisma.diamondSpec.create({
        data: {
          name,
          cut: cut || null,
          caratFrom: safeCaratFrom,
          caratTo: safeCaratTo,
          color: color || null,
          clarity: clarity || null,
          price,
        },
      });
      return { ok: true, message: `Diamond specification (${name}) added.` };
    }

    if (intent === "delete-diamond-spec") {
      const id = String(form.get("id") || "");
      const inUse = await prisma.productVariant.count({ where: { diamondSpecId: id } });
      if (inUse > 0) {
        return { ok: false, message: "This diamond spec is used by products. Remove those variants first." };
      }
      await prisma.diamondSpec.delete({ where: { id } });
      return { ok: true, message: "Diamond specification deleted." };
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
  const { metals, purities, diamondSpecs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [activeTab, setActiveTab] = useState("metals");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Metals &amp; purity</div>
          <div className="page-sub">
            Configure metals, purities, and diamond specifications for jewelry items
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "20px", borderBottom: "1px solid var(--stroke-primary)", marginBottom: "20px", paddingBottom: "2px" }}>
        <button
          type="button"
          onClick={() => setActiveTab("metals")}
          style={{
            background: "none",
            border: "none",
            borderBottom: activeTab === "metals" ? "2px solid var(--surface-primary-cta)" : "2px solid transparent",
            color: activeTab === "metals" ? "var(--text-primary-heading)" : "var(--text-secondary-content)",
            padding: "8px 16px",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "14px",
            fontFamily: "inherit"
          }}
        >
          Metals &amp; Purity
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("diamonds")}
          style={{
            background: "none",
            border: "none",
            borderBottom: activeTab === "diamonds" ? "2px solid var(--surface-primary-cta)" : "2px solid transparent",
            color: activeTab === "diamonds" ? "var(--text-primary-heading)" : "var(--text-secondary-content)",
            padding: "8px 16px",
            cursor: "pointer",
            fontWeight: 500,
            fontSize: "14px",
            fontFamily: "inherit"
          }}
        >
          Diamond Specifications
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
      ) : (
        <div className="split-2">
          <div className="panel">
            <div className="panel-title">Add diamond specification</div>
            <Form method="post">
              <input type="hidden" name="intent" value="add-diamond-spec" />
              <div className="field">
                <label>Diamond name</label>
                <input name="name" placeholder="e.g. Premium Round" required />
              </div>
              <div className="field">
                <label>Cut / Shape</label>
                <select name="cut" defaultValue="">
                  <option value="">-- Optional --</option>
                  <option>Round</option>
                  <option>Princess</option>
                  <option>Oval</option>
                  <option>Cushion</option>
                  <option>Emerald</option>
                  <option>Marquise</option>
                  <option>Pear</option>
                  <option>Radiant</option>
                  <option>Heart</option>
                </select>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Carat from</label>
                  <input
                    name="caratFrom"
                    type="number"
                    step="0.001"
                    min="0"
                    placeholder="0.500"
                  />
                </div>
                <div className="field">
                  <label>Carat to</label>
                  <input
                    name="caratTo"
                    type="number"
                    step="0.001"
                    min="0"
                    placeholder="1.000"
                  />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Colour</label>
                  <select name="color" defaultValue="">
                    <option value="">-- Optional --</option>
                    <option>D</option>
                    <option>E</option>
                    <option>F</option>
                    <option>G-H</option>
                    <option>I-J</option>
                    <option>K-M</option>
                  </select>
                </div>
                <div className="field">
                  <label>Clarity</label>
                  <select name="clarity" defaultValue="">
                    <option value="">-- Optional --</option>
                    <option>FL</option>
                    <option>IF</option>
                    <option>VVS1</option>
                    <option>VVS2</option>
                    <option>VS1</option>
                    <option>VS2</option>
                    <option>SI1</option>
                    <option>SI2</option>
                    <option>I1</option>
                  </select>
                </div>
              </div>
              <div className="field">
                <label>Price (₹)</label>
                <input
                  name="price"
                  type="number"
                  step="1"
                  min="0"
                  placeholder="Price of this stone range"
                  required
                />
              </div>
              <button className="btn primary" type="submit" disabled={busy}>
                Add diamond specification
              </button>
            </Form>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Cut</th>
                  <th>Carat Range</th>
                  <th>Colour</th>
                  <th>Clarity</th>
                  <th>Price (₹)</th>
                  <th style={{ textAlign: "right", width: 90 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {diamondSpecs.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">No diamond specifications yet.</div>
                    </td>
                  </tr>
                ) : (
                  diamondSpecs.map((spec) => {
                    const rangeText =
                      spec.caratFrom !== null && spec.caratFrom !== undefined && spec.caratTo !== null && spec.caratTo !== undefined
                        ? `${Number(spec.caratFrom).toFixed(3)} - ${Number(spec.caratTo).toFixed(3)} ct`
                        : spec.caratFrom !== null && spec.caratFrom !== undefined
                          ? `${Number(spec.caratFrom).toFixed(3)} ct`
                          : spec.caratTo !== null && spec.caratTo !== undefined
                            ? `${Number(spec.caratTo).toFixed(3)} ct`
                            : "—";

                    return (
                      <tr key={spec.id}>
                        <td>{spec.name || "Unnamed diamond"}</td>
                        <td>{spec.cut || "—"}</td>
                        <td className="mono">{rangeText}</td>
                        <td>{spec.color || "—"}</td>
                        <td>{spec.clarity || "—"}</td>
                        <td className="mono">{new Intl.NumberFormat("en-IN").format(spec.price)}</td>
                        <td>
                          <Form method="post" className="row-actions">
                            <input type="hidden" name="intent" value="delete-diamond-spec" />
                            <input type="hidden" name="id" value={spec.id} />
                            <button className="btn small danger" type="submit" disabled={busy}>
                              Delete
                            </button>
                          </Form>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
