import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [metals, purities] = await Promise.all([
    prisma.metalType.findMany({ orderBy: [{ name: "asc" }, { color: "asc" }] }),
    prisma.purityLevel.findMany({
      include: { metal: true },
      orderBy: [{ karat: "asc" }, { label: "asc" }],
    }),
  ]);
  return { metals, purities };
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

    return { ok: false, message: "Unknown action." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
};

export default function MetalsPage() {
  const { metals, purities } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Metals &amp; purity</div>
          <div className="page-sub">
            Yellow / Rose / White Gold with 14K, 18K, 22K for product variants
          </div>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`}>{actionData.message}</div>
      ) : null}

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
  );
}
