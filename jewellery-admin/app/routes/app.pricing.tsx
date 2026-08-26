import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatINR } from "../lib/pricing";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const settings = await prisma.appSetting.findUnique({ where: { id: "default" } });
  const productCount = await prisma.product.count();
  const purities = await prisma.purityLevel.findMany({
    orderBy: { karat: "desc" },
  });
  return {
    goldPricePerGram: settings?.goldPricePerGram ?? 6500,
    updatedAt: settings?.updatedAt ? settings.updatedAt.toISOString() : null,
    productCount,
    purities,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "save-rate") {
      const goldPricePerGram = Number(form.get("goldPricePerGram"));
      if (!Number.isFinite(goldPricePerGram) || goldPricePerGram <= 0) {
        return { ok: false, message: "Enter a valid gold price per gram in INR." };
      }

      await prisma.appSetting.upsert({
        where: { id: "default" },
        update: { goldPricePerGram },
        create: { id: "default", goldPricePerGram },
      });

      // Import and trigger background Shopify catalog price sync
      const { runGoldRateSync } = await import("../lib/gold-rate-cron.server");
      runGoldRateSync(goldPricePerGram).catch((err) => {
        console.error("[Pricing Page] Error in manual background gold rate sync:", err);
      });

      return {
        ok: true,
        message: `Gold rate saved at ${formatINR(goldPricePerGram)} / g. Updating product prices on Shopify in the background...`,
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

export default function PricingPage() {
  const { goldPricePerGram, updatedAt, productCount, purities } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  // Filter unique purities by label for clean display
  const uniquePurities = purities.filter(
    (item, index, self) => self.findIndex((p) => p.label === item.label) === index
  );

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Gold rates</div>
          <div className="page-sub">
            Update today&apos;s rate per gram (INR). Use Sync all to push new prices to Shopify.
          </div>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`}>{actionData.message}</div>
      ) : null}

      <div className="panel" style={{ maxWidth: 520 }}>
        <div className="panel-title">Current gold price / gram</div>
        <div
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: 36,
            fontWeight: 500,
            color: "var(--surface-primary-cta)",
            marginBottom: 2,
          }}
        >
          {formatINR(goldPricePerGram)}
        </div>
        {updatedAt ? (
          <div style={{ fontSize: 12, color: "var(--text-gray-500)", marginBottom: 12 }}>
            Last updated: {new Date(updatedAt).toLocaleString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true
            })}
          </div>
        ) : null}
        <div className="page-sub" style={{ marginBottom: 16 }}>
          {productCount} products in catalogue
        </div>

        {uniquePurities.length > 0 ? (
          <div style={{ marginTop: 16, marginBottom: 20, background: "var(--bg-light-white)", border: "1px solid var(--border-color)", padding: 12, borderRadius: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--surface-primary-cta)", marginBottom: 8 }}>Purity rates per gram (INR):</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {uniquePurities.map((purity) => {
                const calculatedRate = (goldPricePerGram / 0.916) * purity.purityValue;
                return (
                  <div key={purity.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, borderBottom: "1px dashed var(--border-color)", paddingBottom: 4 }}>
                    <span style={{ color: "var(--text-gray-500)" }}>Gold ({purity.label})</span>
                    <strong className="mono" style={{ color: "var(--surface-primary-cta)" }}>{formatINR(calculatedRate)}</strong>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <Form method="post">
          <input type="hidden" name="intent" value="save-rate" />
          <div className="field">
            <label>Gold price per gram (₹)</label>
            <input
              className="mono"
              name="goldPricePerGram"
              type="number"
              step="0.01"
              min="1"
              defaultValue={goldPricePerGram}
              required
            />
          </div>
          <button className="btn primary" type="submit" disabled={busy}>
            Save gold rate
          </button>
        </Form>
        <div className="hint" style={{ marginTop: 10 }}>
          Saving the gold rate will automatically update all product prices on Shopify in the background.
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Price formula</div>
        <div className="table-wrap" style={{ border: "none" }}>
          <table className="data">
            <tbody>
              <tr>
                <td>Net gold weight</td>
                <td className="mono">gross − stone (grams)</td>
              </tr>
              <tr>
                <td>Chargeable gold weight</td>
                <td className="mono">net + (net × wastage %)</td>
              </tr>
              <tr>
                <td>Gold value</td>
                <td className="mono">chargeable × gold ₹/g</td>
              </tr>
              <tr>
                <td>Making charges</td>
                <td className="mono">% of gold value or plain ₹ rate</td>
              </tr>
              <tr>
                <td>Stone charges</td>
                <td className="mono">stone weight × stone ₹/g</td>
              </tr>
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td className="mono">
                  <strong>gold + making + stone</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
