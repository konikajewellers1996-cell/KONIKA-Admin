import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { AmountField } from "../lib/amount-field";
import { SearchChipPicker, type PickerItem } from "../lib/search-chip-picker";
import {
  parseDiscountTargets,
  parseStringIdList,
  type DiscountTarget,
  type DiscountValueType,
} from "../lib/discounts";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [rules, collections, products] = await Promise.all([
    prisma.discountRule.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.collection.findMany({ orderBy: { name: "asc" } }),
    prisma.product.findMany({
      select: { id: true, name: true, sku: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return {
    rules: rules.map((rule) => ({
      ...rule,
      targets: parseDiscountTargets(rule.targets),
      collectionIds: parseStringIdList(rule.collectionIds),
      productIds: parseStringIdList(rule.productIds),
    })),
    collections,
    products,
  };
};

function parseTargetsFromForm(form: FormData): DiscountTarget[] {
  const values = form.getAll("targets").map(String);
  const allowed: DiscountTarget[] = ["making", "wastage", "diamond"];
  return values.filter((item): item is DiscountTarget =>
    allowed.includes(item as DiscountTarget),
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "create-discount") {
      const name = String(form.get("name") || "").trim();
      const isCoupon = String(form.get("isCoupon") || "") === "true";
      const code = String(form.get("code") || "").trim().toUpperCase();
      const valueType: DiscountValueType =
        String(form.get("valueType") || "percent") === "flat" ? "flat" : "percent";
      const value = Number(form.get("value") || 0);
      const applyAll = String(form.get("applyAll") || "") === "true";
      const targets = parseTargetsFromForm(form);
      const collectionIds = form.getAll("collectionIds").map(String).filter(Boolean);
      const productIds = form.getAll("productIds").map(String).filter(Boolean);

      if (!name) return { ok: false, message: "Discount name is required." };
      if (!targets.length) {
        return { ok: false, message: "Choose making, wastage, and/or diamond." };
      }
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, message: "Enter a discount value." };
      }
      if (isCoupon && !code) {
        return { ok: false, message: "Coupon code is required for a coupon." };
      }
      if (!isCoupon && !applyAll && !collectionIds.length && !productIds.length) {
        return {
          ok: false,
          message: "Choose collections, products, or apply to all catalog items.",
        };
      }

      await prisma.discountRule.create({
        data: {
          name,
          isCoupon,
          code: isCoupon ? code : "",
          targets: JSON.stringify(targets),
          valueType,
          value,
          applyAll: isCoupon ? false : applyAll,
          collectionIds: JSON.stringify(isCoupon ? collectionIds : applyAll ? [] : collectionIds),
          productIds: JSON.stringify(isCoupon ? productIds : applyAll ? [] : productIds),
          status: "Active",
        },
      });
      return {
        ok: true,
        message: isCoupon ? `Coupon ${code} saved.` : `"${name}" discount saved.`,
      };
    }

    if (intent === "toggle-discount") {
      const id = String(form.get("id") || "");
      const current = await prisma.discountRule.findUnique({ where: { id } });
      if (!current) return { ok: false, message: "Discount not found." };
      await prisma.discountRule.update({
        where: { id },
        data: { status: current.status === "Active" ? "Inactive" : "Active" },
      });
      return { ok: true, message: "Discount status updated." };
    }

    if (intent === "delete-discount") {
      const id = String(form.get("id") || "");
      await prisma.discountRule.delete({ where: { id } });
      return { ok: true, message: "Discount deleted." };
    }

    return { ok: false, message: "Unknown action." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Could not save discount.",
    };
  }
};

export default function DiscountsPage() {
  const { rules, collections, products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [isCoupon, setIsCoupon] = useState(false);
  const [valueType, setValueType] = useState<DiscountValueType>("percent");
  const [value, setValue] = useState(0);
  const [applyAll, setApplyAll] = useState(false);
  const [selectedCollections, setSelectedCollections] = useState<PickerItem[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<PickerItem[]>([]);
  const pickerDisabled = !isCoupon && applyAll;

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">Discounts</h2>
          <p className="page-sub">
            Reduce making, wastage, or diamond charges on selected collections and products.
            Coupons are stored with a code for checkout / billing use.
          </p>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`} role="status">
          {actionData.message}
        </div>
      ) : null}

      <div className="split-2">
        <div className="panel">
          <div className="panel-title">Create discount</div>
          <Form method="post">
            <input type="hidden" name="intent" value="create-discount" />
            <input type="hidden" name="isCoupon" value={String(isCoupon)} />
            <input type="hidden" name="valueType" value={valueType} />
            <input type="hidden" name="applyAll" value={String(applyAll)} />
            <div className="field">
              <label>Name</label>
              <input name="name" placeholder="Wedding making offer" required />
            </div>
            <div className="field">
              <label>Type</label>
              <div className="radio-inline">
                <label>
                  <input
                    type="radio"
                    checked={!isCoupon}
                    onChange={() => setIsCoupon(false)}
                  />
                  Automatic
                </label>
                <label>
                  <input
                    type="radio"
                    checked={isCoupon}
                    onChange={() => setIsCoupon(true)}
                  />
                  Coupon code
                </label>
              </div>
            </div>
            {isCoupon ? (
              <div className="field">
                <label>Coupon code</label>
                <input name="code" className="mono" placeholder="KONIKA10" />
              </div>
            ) : null}
            <div className="field">
              <label>Apply on</label>
              <div className="radio-inline" style={{ flexWrap: "wrap" }}>
                <label>
                  <input type="checkbox" name="targets" value="making" defaultChecked />
                  Making
                </label>
                <label>
                  <input type="checkbox" name="targets" value="wastage" />
                  Wastage
                </label>
                <label>
                  <input type="checkbox" name="targets" value="diamond" />
                  Diamond
                </label>
              </div>
            </div>
            <div className="field">
              <label>Discount value</label>
              <AmountField
                value={value}
                onValueChange={setValue}
                mode={valueType}
                onModeChange={(mode) => setValueType(mode === "flat" ? "flat" : "percent")}
                modes={["percent", "flat"]}
              />
              <input type="hidden" name="value" value={value} />
            </div>
            {!isCoupon ? (
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={applyAll}
                    onChange={(event) => setApplyAll(event.target.checked)}
                  />{" "}
                  Apply to all products
                </label>
              </div>
            ) : null}
            <div className="field">
              <label>Collections</label>
              <SearchChipPicker
                name="collectionIds"
                disabled={pickerDisabled}
                placeholder="Search collections to add…"
                items={collections.map((collection) => ({
                  id: collection.id,
                  label: collection.name,
                }))}
                selected={selectedCollections}
                onChange={setSelectedCollections}
                hint="Search and click to add. You can add as many collections as you need."
              />
            </div>
            <div className="field">
              <label>Products</label>
              <SearchChipPicker
                name="productIds"
                disabled={pickerDisabled}
                placeholder="Search products by name or SKU…"
                items={products.map((product) => ({
                  id: product.id,
                  label: `${product.sku} — ${product.name}`,
                }))}
                selected={selectedProducts}
                onChange={setSelectedProducts}
                hint="Search and click to add. You can add as many products as you need."
              />
            </div>
            <button className="btn primary" type="submit" disabled={busy}>
              Save discount
            </button>
          </Form>
        </div>

        <div className="panel">
          <div className="panel-title">Saved discounts</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>On</th>
                  <th>Value</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="empty-state">No discounts yet.</div>
                    </td>
                  </tr>
                ) : (
                  rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <strong>{rule.name}</strong>
                        {rule.isCoupon ? (
                          <div className="hint">Coupon {rule.code}</div>
                        ) : (
                          <div className="hint">Automatic</div>
                        )}
                      </td>
                      <td>{rule.targets.join(", ")}</td>
                      <td className="mono">
                        {rule.valueType === "percent" ? `${rule.value}%` : `₹${rule.value}`}
                      </td>
                      <td>
                        {rule.applyAll
                          ? "All products"
                          : `${rule.collectionIds.length} coll · ${rule.productIds.length} products`}
                      </td>
                      <td>
                        <span className={`pill ${rule.status === "Active" ? "ok" : ""}`}>
                          {rule.status}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <Form method="post">
                            <input type="hidden" name="intent" value="toggle-discount" />
                            <input type="hidden" name="id" value={rule.id} />
                            <button className="btn small" type="submit">
                              {rule.status === "Active" ? "Off" : "On"}
                            </button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete-discount" />
                            <input type="hidden" name="id" value={rule.id} />
                            <button className="btn small danger" type="submit">
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
        </div>
      </div>
    </>
  );
}
