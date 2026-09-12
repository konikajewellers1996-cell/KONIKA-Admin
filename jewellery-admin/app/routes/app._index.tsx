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
        include: {
          parent: true,
          _count: { select: { products: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.metalType.findMany({
        include: { purities: true },
        orderBy: { color: "asc" },
      }),
      prisma.purityLevel.findMany({
        include: { metal: true },
        orderBy: [{ karat: "desc" }, { label: "asc" }],
      }),
      prisma.product.findMany({
        include: {
          collections: true,
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
      collection: product.collections.map((c) => c.name).join(", ") || "—",
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
          <h2 className="page-title">Welcome back</h2>
          <p className="page-sub">
            Today&apos;s catalog snapshot. Prices use the live gold rate and sync to Shopify.
          </p>
        </div>
        <div className="head-actions">
          <Link to="/app/products?view=edit" className="btn primary">
            Add product
          </Link>
          <Link to="/app/products?view=catalog" className="btn">
            View products
          </Link>
        </div>
      </div>

      {/* Overview & Key Metrics Table */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-title">
          <span>Overview &amp; Key Metrics</span>
          <span className="hint" style={{ fontWeight: 400 }}>System Summary</span>
        </div>
        <div className="table-wrap" style={{ border: "none" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th>Quantity / Rate</th>
                <th>Shopify Integration</th>
                <th style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="coll-icon" style={{ width: 32, height: 32, fontSize: 13 }}>P</div>
                    <div>
                      <strong>Jewellery Products</strong>
                      <div className="hint" style={{ fontSize: "0.82em" }}>Complete catalog inventory</div>
                    </div>
                  </div>
                </td>
                <td>
                  <strong style={{ fontSize: 16 }}>{stats.products}</strong>
                  <span className="hint" style={{ marginLeft: 6 }}>total products</span>
                </td>
                <td>
                  <span className="badge active">
                    <span className="badge-dot" />
                    {stats.syncedProducts} synced to Shopify
                  </span>
                  {stats.products > stats.syncedProducts ? (
                    <span className="hint" style={{ marginLeft: 6 }}>
                      ({stats.products - stats.syncedProducts} local only)
                    </span>
                  ) : null}
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                    <Link to="/app/products?view=catalog" className="btn small">
                      View catalog
                    </Link>
                    <Link to="/app/products?view=edit" className="btn small primary">
                      + Add
                    </Link>
                  </div>
                </td>
              </tr>

              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="coll-icon" style={{ width: 32, height: 32, fontSize: 13 }}>C</div>
                    <div>
                      <strong>Collections</strong>
                      <div className="hint" style={{ fontSize: "0.82em" }}>Categories &amp; taxonomies</div>
                    </div>
                  </div>
                </td>
                <td>
                  <strong style={{ fontSize: 16 }}>{stats.collections}</strong>
                  <span className="hint" style={{ marginLeft: 6 }}>collections</span>
                </td>
                <td>
                  <span className="badge active">
                    <span className="badge-dot" />
                    {stats.syncedCollections} synced to Shopify
                  </span>
                  {stats.collections > stats.syncedCollections ? (
                    <span className="hint" style={{ marginLeft: 6 }}>
                      ({stats.collections - stats.syncedCollections} local only)
                    </span>
                  ) : null}
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                    <Link to="/app/collections" className="btn small">
                      Manage collections
                    </Link>
                  </div>
                </td>
              </tr>

              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="coll-icon" style={{ width: 32, height: 32, fontSize: 13 }}>M</div>
                    <div>
                      <strong>Metals &amp; Purities</strong>
                      <div className="hint" style={{ fontSize: "0.82em" }}>Color varieties &amp; karat levels</div>
                    </div>
                  </div>
                </td>
                <td>
                  <strong style={{ fontSize: 16 }}>{stats.metals}</strong>
                  <span className="hint" style={{ marginLeft: 6 }}>colours</span>
                  <span style={{ margin: "0 6px", color: "var(--stroke-secondary)" }}>·</span>
                  <strong style={{ fontSize: 16 }}>{stats.purities}</strong>
                  <span className="hint" style={{ marginLeft: 6 }}>purity levels</span>
                </td>
                <td>
                  <span className="badge" style={{ background: "var(--surface-light-brand)", color: "var(--surface-primary-cta)" }}>
                    {metals.length} Active Configurations
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                    <Link to="/app/metals" className="btn small">
                      Manage metals
                    </Link>
                  </div>
                </td>
              </tr>

              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="coll-icon" style={{ width: 32, height: 32, fontSize: 13, background: "var(--surface-secondary-cta)" }}>₹</div>
                    <div>
                      <strong>Benchmark Gold Rate</strong>
                      <div className="hint" style={{ fontSize: "0.82em" }}>Active rate per gram used across catalog</div>
                    </div>
                  </div>
                </td>
                <td>
                  <strong className="mono" style={{ fontSize: 18, color: "var(--surface-primary-cta)" }}>
                    {formatINR(goldPricePerGram)}
                  </strong>
                  <span className="hint" style={{ marginLeft: 4 }}>/ gram</span>
                </td>
                <td>
                  <span className="badge active">
                    <span className="badge-dot" />
                    Live benchmark
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                    <Link to="/app/pricing" className="btn small primary">
                      Update rate
                    </Link>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Collections Table */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-title">
          <span>Collections Directory</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Link to="/app/collections" className="btn small primary">
              + New collection
            </Link>
            <Link to="/app/collections" className="panel-link">
              Manage all
            </Link>
          </div>
        </div>
        {collections.length === 0 ? (
          <div className="empty-state">
            No collections created yet.{" "}
            <Link to="/app/collections">Create your first collection</Link>.
          </div>
        ) : (
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Hierarchy</th>
                  <th>Products Count</th>
                  <th>Shopify Status</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {collections.map((collection) => (
                  <tr key={collection.id}>
                    <td>
                      <div className="prod-cell">
                        {collection.imageUrl ? (
                          <img
                            src={collection.imageUrl}
                            alt=""
                            style={{
                              width: 38,
                              height: 38,
                              objectFit: "cover",
                              borderRadius: 8,
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div className="coll-icon" style={{ width: 38, height: 38, fontSize: 14, flexShrink: 0 }}>
                            {initials(collection.name)}
                          </div>
                        )}
                        <div>
                          <div className="prod-name">{collection.name}</div>
                          {collection.description ? (
                            <div className="prod-sub" style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", maxWidth: 300 }}>
                              {collection.description}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      {collection.parent ? (
                        <span className="hint">
                          Sub-collection of <strong>{collection.parent.name}</strong>
                        </span>
                      ) : (
                        <span className="badge" style={{ background: "var(--bg)", border: "1px solid var(--line)" }}>
                          Main Collection
                        </span>
                      )}
                    </td>
                    <td>
                      <strong>{collection._count.products}</strong>{" "}
                      <span className="hint">product{collection._count.products === 1 ? "" : "s"}</span>
                    </td>
                    <td>
                      <span className={`badge ${collection.shopifyCollectionId ? "active" : "draft"}`}>
                        <span className="badge-dot" />
                        {collection.shopifyCollectionId ? "Synced" : "Local only"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link to="/app/collections" className="btn small">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Products Table */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-title">
          <span>Recent Products</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Link to="/app/products?view=edit" className="btn small primary">
              + Add product
            </Link>
            <Link to="/app/products?view=catalog" className="panel-link">
              View all
            </Link>
          </div>
        </div>
        {recent.length === 0 ? (
          <div className="empty-state">
            No products yet.{" "}
            <Link to="/app/products?view=edit">Add your first jewellery piece</Link>.
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
                  <th>Shopify Status</th>
                  <th style={{ textAlign: "right" }}>Action</th>
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
                    <td style={{ textAlign: "right" }}>
                      <Link to={`/app/products?view=edit&id=${product.id}`} className="btn small">
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Split section: Purity Rates Table & Metals Configuration Table */}
      <div className="split-2 metals-tables" style={{ marginBottom: 24 }}>
        <div className="panel">
          <div className="panel-title">
            <span>Purity Rates (Live Calculations)</span>
            <Link to="/app/pricing" className="panel-link">
              Update rate
            </Link>
          </div>
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
                  purities.slice(0, 8).map((purity) => (
                    <tr key={purity.id}>
                      <td>{purity.metal.color}</td>
                      <td>
                        <strong>{purity.label}</strong>
                        <span className="hint" style={{ marginLeft: 6, fontSize: "0.85em" }}>
                          ({(purity.purityValue * 100).toFixed(1)}%)
                        </span>
                      </td>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {formatINR((goldPricePerGram / 0.916) * purity.purityValue)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <span>Metal Configurations</span>
            <Link to="/app/metals" className="panel-link">
              Manage
            </Link>
          </div>
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Metal Colour</th>
                  <th>Purities Configured</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {metals.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No metals configured yet.</td>
                  </tr>
                ) : (
                  metals.map((metal) => (
                    <tr key={metal.id}>
                      <td>
                        <strong>{metal.color}</strong>
                        <div className="hint" style={{ fontSize: "0.82em" }}>{metal.name}</div>
                      </td>
                      <td>
                        {metal.purities && metal.purities.length > 0 ? (
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {metal.purities.map((p) => (
                              <span key={p.id} className="badge gold" style={{ fontSize: "0.8em", padding: "2px 6px" }}>
                                {p.label}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="hint">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${metal.status === "Active" ? "active" : "draft"}`}>
                          <span className="badge-dot" />
                          {metal.status}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link to="/app/metals" className="btn small">
                          Edit
                        </Link>
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
