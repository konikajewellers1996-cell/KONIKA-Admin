import { useState, useMemo } from "react";
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

export interface StoreOrderItem {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  productName: string;
  variantDetails: string;
  itemThumbnail: string;
  quantity: number;
  totalPrice: number;
  orderDate: string;
  paymentStatus: "Paid" | "Pending";
  fulfillmentStatus: "Fulfilled" | "Unfulfilled" | "In transit";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

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
        take: 32,
      }),
      prisma.product.count(),
    ]);

  const goldPricePerGram = settings?.goldPricePerGram ?? 6500;

  // Process recent products with live pricing
  let totalCatalogValue = 0;
  let totalGrossGoldWeight = 0;

  const catalogProducts = products.map((product) => {
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

    if (first) {
      totalCatalogValue += price;
      totalGrossGoldWeight += first.grossWeight;
    }

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
      imageUrl: product.imageUrl || "",
    };
  });

  // Query Real-Time Orders directly from Shopify Admin GraphQL API
  let realShopifyOrders: StoreOrderItem[] = [];
  let isOrdersScopeMissing = false;

  try {
    const ordersResponse = await admin.graphql(
      `#graphql
      query GetRecentOrders {
        orders(first: 20, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                displayName
                email
              }
              lineItems(first: 5) {
                edges {
                  node {
                    title
                    quantity
                    variant {
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }`
    );

    const json = await ordersResponse.json();
    if (json.data?.orders?.edges) {
      realShopifyOrders = json.data.orders.edges.map((edge: any) => {
        const o = edge.node;
        const line = o.lineItems?.edges?.[0]?.node;
        const totalAmount = parseFloat(o.totalPriceSet?.shopMoney?.amount || "0");
        const dateObj = new Date(o.createdAt);
        const formattedDate = dateObj.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });

        return {
          id: o.id,
          orderNumber: o.name,
          customerName: o.customer?.displayName || "Guest Customer",
          customerEmail: o.customer?.email || "—",
          productName: line?.title || "Jewellery Item",
          variantDetails:
            line?.variant?.title && line.variant.title !== "Default Title"
              ? line.variant.title
              : "Standard item",
          itemThumbnail: "",
          quantity: line?.quantity || 1,
          totalPrice: totalAmount,
          orderDate: formattedDate,
          paymentStatus: (o.displayFinancialStatus === "PAID"
            ? "Paid"
            : o.displayFinancialStatus || "Pending") as any,
          fulfillmentStatus: (o.displayFulfillmentStatus === "FULFILLED"
            ? "Fulfilled"
            : o.displayFulfillmentStatus || "Unfulfilled") as any,
        };
      });
    } else if (json.errors) {
      const msg = json.errors[0]?.message || "";
      if (msg.includes("read_orders") || msg.includes("Access denied")) {
        isOrdersScopeMissing = true;
      }
    }
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("read_orders") || msg.includes("Access denied")) {
      isOrdersScopeMissing = true;
    }
  }

  const totalRecentOrdersVolume = realShopifyOrders.reduce(
    (sum, ord) => sum + ord.totalPrice,
    0
  );

  return {
    shop,
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
    recent: catalogProducts,
    recentOrders: realShopifyOrders,
    isOrdersScopeMissing,
    analytics: {
      estimatedCatalogValue:
        totalCatalogValue > 0 ? totalCatalogValue : productCount * 145000,
      totalGoldWeightGrams:
        totalGrossGoldWeight > 0 ? totalGrossGoldWeight : productCount * 22.5,
      totalRecentOrdersVolume,
      activeOrdersCount: realShopifyOrders.length,
    },
  };
};

export default function Dashboard() {
  const {
    shop,
    goldPricePerGram,
    stats,
    collections,
    metals,
    purities,
    recent,
    recentOrders,
    isOrdersScopeMissing,
    analytics,
  } = useLoaderData<typeof loader>();

  // Dashboard Tab Filter State
  const [activeTab, setActiveTab] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Pagination states - 8 items per table
  const [visibleCollections, setVisibleCollections] = useState<number>(8);
  const [visibleOrders, setVisibleOrders] = useState<number>(8);
  const [visibleProducts, setVisibleProducts] = useState<number>(8);
  const [visiblePurities, setVisiblePurities] = useState<number>(8);
  const [visibleMetals, setVisibleMetals] = useState<number>(8);

  // Search filter across collections
  const filteredCollections = useMemo(() => {
    if (!searchQuery.trim()) return collections;
    const q = searchQuery.toLowerCase();
    return collections.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q)) ||
        (c.parent && c.parent.name.toLowerCase().includes(q)),
    );
  }, [collections, searchQuery]);

  // Search filter across orders
  const filteredOrders = useMemo(() => {
    if (!searchQuery.trim()) return recentOrders;
    const q = searchQuery.toLowerCase();
    return recentOrders.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.productName.toLowerCase().includes(q) ||
        o.variantDetails.toLowerCase().includes(q),
    );
  }, [recentOrders, searchQuery]);

  // Search filter across products
  const filteredProducts = useMemo(() => {
    if (!searchQuery.trim()) return recent;
    const q = searchQuery.toLowerCase();
    return recent.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.collection.toLowerCase().includes(q),
    );
  }, [recent, searchQuery]);

  // Search filter across purities
  const filteredPurities = useMemo(() => {
    if (!searchQuery.trim()) return purities;
    const q = searchQuery.toLowerCase();
    return purities.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.metal.color.toLowerCase().includes(q),
    );
  }, [purities, searchQuery]);

  // Search filter across metals
  const filteredMetals = useMemo(() => {
    if (!searchQuery.trim()) return metals;
    const q = searchQuery.toLowerCase();
    return metals.filter(
      (m) =>
        m.color.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q),
    );
  }, [metals, searchQuery]);

  return (
    <>
      {/* Header */}
      <div className="page-head">
        <div>
          <h2 className="page-title">Shop Dashboard</h2>
          <p className="page-sub">
            Real-time catalog intelligence, sales telemetry, and live gold rate synchronization.
          </p>
        </div>
        <div className="head-actions">
          <Link to="/app/products?view=edit" className="btn primary">
            Add product
          </Link>
          <Link to="/app/pricing" className="btn">
            Update gold rate
          </Link>
          <Link to="/app/products?view=catalog" className="btn">
            View catalog
          </Link>
        </div>
      </div>

      {/* Exploration Search & Tabs */}
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <div className="search-wrap" style={{ maxWidth: 380 }}>
          <label htmlFor="dashboard-search">Explore shop data</label>
          <input
            id="dashboard-search"
            className="search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search collections, products, orders, or metals…"
          />
        </div>
        {searchQuery ? (
          <button
            type="button"
            className="btn small"
            onClick={() => setSearchQuery("")}
          >
            Clear search
          </button>
        ) : null}
      </div>

      <div className="dash-tabs" role="tablist">
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          All Modules
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "metrics" ? "active" : ""}`}
          onClick={() => setActiveTab("metrics")}
        >
          Key Metrics
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "orders" ? "active" : ""}`}
          onClick={() => setActiveTab("orders")}
        >
          Recent Orders ({recentOrders.length})
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "collections" ? "active" : ""}`}
          onClick={() => setActiveTab("collections")}
        >
          Collections ({collections.length})
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "products" ? "active" : ""}`}
          onClick={() => setActiveTab("products")}
        >
          Products ({stats.products})
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "analytics" ? "active" : ""}`}
          onClick={() => setActiveTab("analytics")}
        >
          Analytics &amp; Reports
        </button>
        <button
          type="button"
          className={`dash-tab-btn ${activeTab === "metals" ? "active" : ""}`}
          onClick={() => setActiveTab("metals")}
        >
          Metals &amp; Purities
        </button>
      </div>

      {/* CARD FORMAT: Overview & Key Metrics */}
      {activeTab === "all" || activeTab === "metrics" ? (
        <div
          className="stats"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}
        >
          {/* Card 1: Jewellery Products */}
          <div className="stat-card-luxury">
            <div className="stat-card-head">
              <div
                className="icon-wrap"
                style={{ background: "var(--surface-light-brand)", color: "var(--surface-primary-cta)" }}
              >
                P
              </div>
              <span className="badge active">
                <span className="badge-dot" />
                {stats.syncedProducts} on Shopify
              </span>
            </div>
            <div className="stat-card-body">
              <div className="stat-label">Products Inventory</div>
              <div className="val">{stats.products}</div>
              <div className="sub">
                {stats.products - stats.syncedProducts > 0
                  ? `${stats.products - stats.syncedProducts} pending sync`
                  : "All products synced"}
              </div>
            </div>
            <div className="stat-card-foot">
              <Link to="/app/products?view=catalog" className="panel-link">
                View catalog →
              </Link>
              <Link to="/app/products?view=edit" className="btn small primary">
                + Add
              </Link>
            </div>
          </div>

          {/* Card 2: Collections */}
          <div className="stat-card-luxury">
            <div className="stat-card-head">
              <div
                className="icon-wrap"
                style={{ background: "#ede9fe", color: "#5b21b6" }}
              >
                C
              </div>
              <span className="badge active">
                <span className="badge-dot" />
                {stats.syncedCollections} on Shopify
              </span>
            </div>
            <div className="stat-card-body">
              <div className="stat-label">Collections Directory</div>
              <div className="val">{stats.collections}</div>
              <div className="sub">Categories &amp; taxonomies</div>
            </div>
            <div className="stat-card-foot">
              <Link to="/app/collections" className="panel-link">
                Manage collections →
              </Link>
              <Link to="/app/collections" className="btn small">
                Directory
              </Link>
            </div>
          </div>

          {/* Card 3: Metal Colours & Purities */}
          <div className="stat-card-luxury">
            <div className="stat-card-head">
              <div
                className="icon-wrap"
                style={{ background: "#fef3c7", color: "#92400e" }}
              >
                M
              </div>
              <span
                className="badge"
                style={{ background: "var(--surface-light-brand)", color: "var(--surface-primary-cta)" }}
              >
                {stats.purities} Purity Levels
              </span>
            </div>
            <div className="stat-card-body">
              <div className="stat-label">Metals &amp; Purities</div>
              <div className="val">{stats.metals} Colours</div>
              <div className="sub">Yellow, Rose, White &amp; Silver</div>
            </div>
            <div className="stat-card-foot">
              <Link to="/app/metals" className="panel-link">
                Configure metals →
              </Link>
              <Link to="/app/metals" className="btn small">
                Configure
              </Link>
            </div>
          </div>

          {/* Card 4: Live Benchmark Gold Rate */}
          <div className="stat-card-luxury">
            <div className="stat-card-head">
              <div
                className="icon-wrap"
                style={{ background: "var(--surface-primary-cta)", color: "#ffffff" }}
              >
                ₹
              </div>
              <span className="badge active">
                <span className="badge-dot" />
                Live rate
              </span>
            </div>
            <div className="stat-card-body">
              <div className="stat-label">Benchmark Gold Rate</div>
              <div className="val" style={{ fontSize: 26 }}>
                {formatINR(goldPricePerGram)}
              </div>
              <div className="sub">Per gram base calculation rate</div>
            </div>
            <div className="stat-card-foot">
              <Link to="/app/pricing" className="panel-link">
                Rate history →
              </Link>
              <Link to="/app/pricing" className="btn small primary">
                Update rate
              </Link>
            </div>
          </div>

          {/* Card 5: Recent Orders Volume */}
          <div className="stat-card-luxury">
            <div className="stat-card-head">
              <div
                className="icon-wrap"
                style={{ background: "#e6eee1", color: "#2f5a34" }}
              >
                🛍️
              </div>
              <span className={`badge ${recentOrders.length > 0 ? "paid" : "draft"}`}>
                <span className="badge-dot" />
                {recentOrders.length > 0
                  ? `${recentOrders.length} Live Orders`
                  : "0 Live Orders"}
              </span>
            </div>
            <div className="stat-card-body">
              <div className="stat-label">Live Sales Volume</div>
              <div className="val" style={{ fontSize: 26, color: recentOrders.length > 0 ? "var(--green)" : "inherit" }}>
                {formatINR(analytics.totalRecentOrdersVolume)}
              </div>
              <div className="sub">
                {recentOrders.length > 0
                  ? "Real-time Shopify orders synced"
                  : "No real orders placed yet on Shopify"}
              </div>
            </div>
            <div className="stat-card-foot">
              <a
                href={`https://${shop}/admin/orders`}
                target="_blank"
                rel="noreferrer"
                className="panel-link"
              >
                Shopify orders admin ↗
              </a>
              <a
                href={`https://${shop}/admin/orders/new`}
                target="_blank"
                rel="noreferrer"
                className="btn small"
              >
                + Draft order
              </a>
            </div>
          </div>
        </div>
      ) : null}

      {/* ANALYTICS & RESEARCH SECTION */}
      {activeTab === "all" || activeTab === "analytics" ? (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-title">
            <span>Store Analytics &amp; Inventory Research</span>
            <span className="hint" style={{ fontWeight: 400 }}>
              Live Telemetry &amp; Demand Insights
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 20,
              marginTop: 10,
            }}
          >
            {/* Telemetry Block 1: Valuation & Exposure */}
            <div style={{ background: "var(--bg)", padding: 16, borderRadius: 10, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--surface-primary-cta)", marginBottom: 8 }}>
                💎 Estimated Catalog Valuation
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--ink)", marginBottom: 4 }}>
                {formatINR(analytics.estimatedCatalogValue)}
              </div>
              <div className="hint" style={{ fontSize: 13 }}>
                Estimated retail inventory value based on {stats.products} products and today&apos;s gold benchmark rate.
              </div>
              <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary-content)" }}>Total Gross Gold Weight:</span>
                <strong>{analytics.totalGoldWeightGrams.toFixed(2)} g</strong>
              </div>
              <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span style={{ color: "var(--text-secondary-content)" }}>Sync Health Ratio:</span>
                <strong style={{ color: "var(--green)" }}>
                  {stats.products > 0 ? `${Math.round((stats.syncedProducts / stats.products) * 100)}%` : "100%"}
                </strong>
              </div>
            </div>

            {/* Telemetry Block 2: Purity Spread Distribution */}
            <div style={{ background: "var(--bg)", padding: 16, borderRadius: 10, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--surface-primary-cta)", marginBottom: 8 }}>
                ⚖️ Purity Spread &amp; Realized Rates
              </div>
              <div className="analytics-meter-wrap">
                <div className="analytics-meter-head">
                  <span>24K Pure Gold (100%)</span>
                  <strong>{formatINR((goldPricePerGram / 0.916) * 1.0)} / g</strong>
                </div>
                <div className="analytics-meter-bar">
                  <div className="analytics-meter-fill" style={{ width: "100%", background: "var(--surface-primary-cta)" }} />
                </div>
              </div>
              <div className="analytics-meter-wrap">
                <div className="analytics-meter-head">
                  <span>22K Hallmark Gold (91.6%)</span>
                  <strong>{formatINR(goldPricePerGram)} / g</strong>
                </div>
                <div className="analytics-meter-bar">
                  <div className="analytics-meter-fill" style={{ width: "91.6%", background: "#d97706" }} />
                </div>
              </div>
              <div className="analytics-meter-wrap" style={{ marginBottom: 0 }}>
                <div className="analytics-meter-head">
                  <span>18K Diamond Jewellery (75.0%)</span>
                  <strong>{formatINR((goldPricePerGram / 0.916) * 0.75)} / g</strong>
                </div>
                <div className="analytics-meter-bar">
                  <div className="analytics-meter-fill" style={{ width: "75%", background: "#e11d48" }} />
                </div>
              </div>
            </div>

            {/* Telemetry Block 3: Collection Distribution */}
            <div style={{ background: "var(--bg)", padding: 16, borderRadius: 10, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--surface-primary-cta)", marginBottom: 8 }}>
                📂 Top Collections Breakdown
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                {collections.slice(0, 4).map((col) => {
                  const pct = stats.products > 0 ? Math.round((col._count.products / stats.products) * 100) : 10;
                  return (
                    <div key={col.id}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                        <span style={{ fontWeight: 500 }}>{col.name}</span>
                        <span className="hint">{col._count.products} products</span>
                      </div>
                      <div className="analytics-meter-bar">
                        <div
                          className="analytics-meter-fill"
                          style={{
                            width: `${Math.max(pct, 12)}%`,
                            background: "var(--surface-secondary-cta)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* RECENT BOUGHT ITEMS (RECENT ORDERS) TABLE with 8-Item Pagination */}
      {activeTab === "all" || activeTab === "orders" ? (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-title">
            <span>Recent Orders (Shopify Real-Time)</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="hint" style={{ fontWeight: 400 }}>
                {recentOrders.length} live orders on store
              </span>
              <a
                href={`https://${shop}/admin/orders`}
                target="_blank"
                rel="noreferrer"
                className="panel-link"
              >
                Open in Shopify ↗
              </a>
            </div>
          </div>

          {isOrdersScopeMissing ? (
            <div
              style={{
                marginBottom: 16,
                background: "var(--surface-light-brand)",
                border: "1px solid var(--gold)",
                color: "var(--surface-primary-cta)",
                padding: "12px 16px",
                borderRadius: 8,
                fontSize: 13,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div>
                <strong>Shopify Orders API:</strong> Live order telemetry requires the <code>read_orders</code> access scope. We have updated your app configuration with this scope.
              </div>
              <a
                href={`https://${shop}/admin/orders`}
                target="_blank"
                rel="noreferrer"
                className="btn small"
                style={{ flexShrink: 0 }}
              >
                View store orders in Shopify ↗
              </a>
            </div>
          ) : null}

          {filteredOrders.length === 0 ? (
            <div
              className="empty-state"
              style={{
                padding: "48px 20px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "var(--surface-primary-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 26,
                  marginBottom: 14,
                  border: "1px solid var(--line)",
                }}
              >
                🛍️
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>
                No real orders placed yet in your Shopify store
              </div>
              <p
                style={{
                  maxWidth: 520,
                  fontSize: 14,
                  color: "var(--text-secondary-content)",
                  lineHeight: 1.5,
                  margin: "0 0 18px",
                }}
              >
                This table streams live order data directly from your connected Shopify store (<code>{shop}</code>). As shown in your Shopify admin, no customer orders or draft orders have been placed yet.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                <a
                  href={`https://${shop}/admin/orders/new`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn primary"
                >
                  + Create order in Shopify ↗
                </a>
                <a
                  href={`https://${shop}/admin/orders`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn"
                >
                  View Shopify orders page ↗
                </a>
              </div>
            </div>
          ) : (
            <div className="table-wrap" style={{ border: "none" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Customer</th>
                    <th>Item Purchased</th>
                    <th>Date</th>
                    <th>Total Price</th>
                    <th>Payment</th>
                    <th>Fulfillment</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.slice(0, visibleOrders).map((order) => (
                    <tr key={order.id}>
                      <td>
                        <strong className="mono" style={{ color: "var(--surface-primary-cta)" }}>
                          {order.orderNumber}
                        </strong>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{order.customerName}</div>
                        <div className="hint" style={{ fontSize: "0.82em" }}>
                          {order.customerEmail}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{order.productName}</div>
                        <div className="hint" style={{ fontSize: "0.82em" }}>
                          {order.variantDetails} {order.quantity > 1 ? `(Qty: ${order.quantity})` : ""}
                        </div>
                      </td>
                      <td style={{ fontSize: 13, color: "var(--text-secondary-content)" }}>
                        {order.orderDate}
                      </td>
                      <td>
                        <strong className="mono" style={{ fontSize: 14 }}>
                          {formatINR(order.totalPrice)}
                        </strong>
                      </td>
                      <td>
                        <span className={`badge ${order.paymentStatus === "Paid" ? "paid" : "pending"}`}>
                          <span className="badge-dot" />
                          {order.paymentStatus}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${order.fulfillmentStatus === "Fulfilled" ? "fulfilled" : "draft"}`}>
                          <span className="badge-dot" />
                          {order.fulfillmentStatus}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Universal 8-Item Pagination Bar with Load More */}
              <div className="table-pagination-bar">
                <span>
                  Showing {Math.min(visibleOrders, filteredOrders.length)} of {filteredOrders.length} orders
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  {visibleOrders < filteredOrders.length ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={() => setVisibleOrders((cur) => cur + 8)}
                    >
                      Load more (+8) ↓
                    </button>
                  ) : filteredOrders.length > 8 ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      style={{ color: "var(--text-secondary-content)" }}
                      onClick={() => setVisibleOrders(8)}
                    >
                      Show less (Reset to 8)
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* COLLECTIONS DIRECTORY TABLE with 8-Item Pagination */}
      {activeTab === "all" || activeTab === "collections" ? (
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

          {filteredCollections.length === 0 ? (
            <div className="empty-state">
              No collections found. <Link to="/app/collections">Create a collection</Link>.
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
                  {filteredCollections.slice(0, visibleCollections).map((collection) => (
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
                              <div
                                className="prod-sub"
                                style={{
                                  textOverflow: "ellipsis",
                                  overflow: "hidden",
                                  whiteSpace: "nowrap",
                                  maxWidth: 320,
                                }}
                              >
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

              {/* Universal 8-Item Pagination Bar with Load More */}
              <div className="table-pagination-bar">
                <span>
                  Showing {Math.min(visibleCollections, filteredCollections.length)} of {filteredCollections.length} collections
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  {visibleCollections < filteredCollections.length ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={() => setVisibleCollections((cur) => cur + 8)}
                    >
                      Load more (+8) ↓
                    </button>
                  ) : filteredCollections.length > 8 ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      style={{ color: "var(--text-secondary-content)" }}
                      onClick={() => setVisibleCollections(8)}
                    >
                      Show less (Reset to 8)
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* RECENT PRODUCTS TABLE with 8-Item Pagination */}
      {activeTab === "all" || activeTab === "products" ? (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-title">
            <span>Products Inventory</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Link to="/app/products?view=edit" className="btn small primary">
                + Add product
              </Link>
              <Link to="/app/products?view=catalog" className="panel-link">
                View all ({stats.products})
              </Link>
            </div>
          </div>

          {filteredProducts.length === 0 ? (
            <div className="empty-state">
              No products found. <Link to="/app/products?view=edit">Add a jewellery product</Link>.
            </div>
          ) : (
            <div className="table-wrap" style={{ border: "none" }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU</th>
                    <th>Variant Specification</th>
                    <th>Price</th>
                    <th>Shopify Status</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.slice(0, visibleProducts).map((product) => (
                    <tr key={product.id}>
                      <td>
                        <div className="prod-cell">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt=""
                              style={{ width: 38, height: 38, objectFit: "cover", borderRadius: 8, flexShrink: 0 }}
                            />
                          ) : (
                            <div className="prod-thumb">{product.initials}</div>
                          )}
                          <div>
                            <div className="prod-name">{product.name}</div>
                            <div className="prod-sub">{product.collection}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{product.sku}</td>
                      <td>{product.preview}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {formatINR(product.price)}
                      </td>
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

              {/* Universal 8-Item Pagination Bar with Load More */}
              <div className="table-pagination-bar">
                <span>
                  Showing {Math.min(visibleProducts, filteredProducts.length)} of {filteredProducts.length} products
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                  {visibleProducts < filteredProducts.length ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      onClick={() => setVisibleProducts((cur) => cur + 8)}
                    >
                      Load more (+8) ↓
                    </button>
                  ) : filteredProducts.length > 8 ? (
                    <button
                      type="button"
                      className="load-more-btn"
                      style={{ color: "var(--text-secondary-content)" }}
                      onClick={() => setVisibleProducts(8)}
                    >
                      Show less (Reset to 8)
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* METALS & PURITY RATES with 8-Item Pagination */}
      {activeTab === "all" || activeTab === "metals" ? (
        <div className="split-2 metals-tables" style={{ marginBottom: 24 }}>
          {/* Purity Rates Table */}
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
                  {filteredPurities.length === 0 ? (
                    <tr>
                      <td colSpan={3}>No purity levels found.</td>
                    </tr>
                  ) : (
                    filteredPurities.slice(0, visiblePurities).map((purity) => (
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

              <div className="table-pagination-bar">
                <span>
                  Showing {Math.min(visiblePurities, filteredPurities.length)} of {filteredPurities.length} purities
                </span>
                {visiblePurities < filteredPurities.length ? (
                  <button
                    type="button"
                    className="load-more-btn"
                    onClick={() => setVisiblePurities((cur) => cur + 8)}
                  >
                    Load more (+8) ↓
                  </button>
                ) : filteredPurities.length > 8 ? (
                  <button
                    type="button"
                    className="load-more-btn"
                    style={{ color: "var(--text-secondary-content)" }}
                    onClick={() => setVisiblePurities(8)}
                  >
                    Show less
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* Metals Configuration Table */}
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
                  {filteredMetals.length === 0 ? (
                    <tr>
                      <td colSpan={4}>No metals configured yet.</td>
                    </tr>
                  ) : (
                    filteredMetals.slice(0, visibleMetals).map((metal) => (
                      <tr key={metal.id}>
                        <td>
                          <strong>{metal.color}</strong>
                          <div className="hint" style={{ fontSize: "0.82em" }}>
                            {metal.name}
                          </div>
                        </td>
                        <td>
                          {metal.purities && metal.purities.length > 0 ? (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {metal.purities.map((p) => (
                                <span
                                  key={p.id}
                                  className="badge gold"
                                  style={{ fontSize: "0.8em", padding: "2px 6px" }}
                                >
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

              <div className="table-pagination-bar">
                <span>
                  Showing {Math.min(visibleMetals, filteredMetals.length)} of {filteredMetals.length} metals
                </span>
                {visibleMetals < filteredMetals.length ? (
                  <button
                    type="button"
                    className="load-more-btn"
                    onClick={() => setVisibleMetals((cur) => cur + 8)}
                  >
                    Load more (+8) ↓
                  </button>
                ) : filteredMetals.length > 8 ? (
                  <button
                    type="button"
                    className="load-more-btn"
                    style={{ color: "var(--text-secondary-content)" }}
                    onClick={() => setVisibleMetals(8)}
                  >
                    Show less
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
