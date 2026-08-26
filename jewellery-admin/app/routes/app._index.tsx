import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { calculateProductPrice, formatGrams, formatINR } from "../lib/pricing";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [settings, collections, metals, purities, products, productCount] =
    await Promise.all([
      prisma.appSetting.findUnique({ where: { id: "default" } }),
      prisma.collection.findMany({
        include: { _count: { select: { products: true } } },
        orderBy: { name: "asc" },
      }),
      prisma.metalType.findMany({ orderBy: { color: "asc" } }),
      prisma.purityLevel.findMany({
        include: { metal: true },
        orderBy: [{ karat: "desc" }, { label: "asc" }],
      }),
      prisma.product.findMany({
        include: {
          collection: true,
          variants: { include: { metal: true, purity: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
      prisma.product.count(),
    ]);

  const goldPricePerGram = settings?.goldPricePerGram ?? 6500;

  const recent = products.map((product) => {
    const first = product.variants[0];
    const price = first
      ? calculateProductPrice({
          grossWeight: first.grossWeight,
          stoneWeight: first.stoneWeight,
          stoneIncluded: first.stoneIncluded,
          stoneType: first.stoneType,
          wastagePercent: first.wastagePercent,
          makingChargeType: first.makingChargeType as "percent" | "fixed",
          makingChargeValue: first.makingChargeValue,
          stoneRate: first.stoneRate,
          goldPricePerGram,
        }).total
      : 0;

    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      collection: product.collection?.name ?? "—",
      synced: Boolean(product.shopifyProductId),
      price,
      preview: first
        ? `${first.metalColor} · ${first.purity.label} · ${formatGrams(first.grossWeight)}`
        : "No variants",
      initials: initials(product.name),
    };
  });

  return {
    goldPricePerGram,
    stats: {
      products: productCount,
      collections: collections.length,
      metals: metals.length,
      purities: purities.length,
      syncedProducts: await prisma.product.count({
        where: { shopifyProductId: { not: null } },
      }),
      syncedCollections: await prisma.collection.count({
        where: { shopifyCollectionId: { not: null } },
      }),
    },
    collections,
    metals,
    purities,
    recent,
  };
};

export default function Dashboard() {
  const { goldPricePerGram, stats, collections, metals, purities, recent } =
    useLoaderData<typeof loader>();

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Welcome back</div>
          <div className="page-sub">
            Catalog overview · prices in INR · syncs to Shopify Admin
          </div>
        </div>
        <div className="head-actions">
          <Link to="/app/products" className="btn primary">
            Add jewelry
          </Link>
        </div>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="stat-label">Total products</div>
          <div className="stat-value">{stats.products}</div>
          <div className="prod-sub">{stats.syncedProducts} synced to Shopify</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Collections</div>
          <div className="stat-value">{stats.collections}</div>
          <div className="prod-sub">{stats.syncedCollections} synced to Shopify</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Metal colours</div>
          <div className="stat-value">{stats.metals}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Purity levels</div>
          <div className="stat-value">{stats.purities}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Today&apos;s gold rate</div>
        <div className="table-wrap" style={{ border: "none" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Metal colour</th>
                <th>Purity</th>
                <th>Rate / gram (INR)</th>
              </tr>
            </thead>
            <tbody>
              {purities.length === 0 ? (
                <tr>
                  <td colSpan={3}>Go to Metals &amp; purity to add levels.</td>
                </tr>
              ) : (
                purities.slice(0, 6).map((purity) => (
                  <tr key={purity.id}>
                    <td>{purity.metal.color}</td>
                    <td>{purity.label}</td>
                    <td className="mono">{formatINR((goldPricePerGram / 0.916) * purity.purityValue)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="/app/pricing" className="btn">
            Update gold rate
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Collections</div>
        <div className="coll-grid">
          {collections.map((collection) => (
            <Link key={collection.id} to="/app/collections" className="coll-card">
              <div className="coll-icon">{initials(collection.name)}</div>
              <div className="coll-name">{collection.name}</div>
              <div className="coll-count">
                {collection._count.products} product
                {collection._count.products === 1 ? "" : "s"}
                {" · "}
                {collection.shopifyCollectionId ? "Synced" : "Not synced"}
              </div>
            </Link>
          ))}
          <Link to="/app/collections" className="coll-card coll-card-new">
            <div className="coll-icon">+</div>
            <div className="coll-name">New collection</div>
            <div className="coll-count">Create collections</div>
          </Link>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Recently added products</div>
        {recent.length === 0 ? (
          <div className="empty-state">
            No products yet.{" "}
            <Link to="/app/products">Add your first jewellery piece</Link>.
          </div>
        ) : (
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>SKU</th>
                  <th>Variant</th>
                  <th>Price</th>
                  <th>Shopify</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div className="prod-cell">
                        <div className="prod-thumb">{product.initials}</div>
                        <div>
                          <div className="prod-name">{product.name}</div>
                          <div className="prod-sub">{product.collection}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono">{product.sku}</td>
                    <td>{product.preview}</td>
                    <td className="mono">{formatINR(product.price)}</td>
                    <td>
                      <span className={`badge ${product.synced ? "active" : "draft"}`}>
                        <span className="badge-dot" />
                        {product.synced ? "Synced" : "Not synced"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {metals.length > 0 ? (
        <div className="panel">
          <div className="panel-title">Active metal colours</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {metals.map((metal) => (
              <span key={metal.id} className="badge gold">
                {metal.color}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
