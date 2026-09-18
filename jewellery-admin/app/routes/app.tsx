import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Link,
  Outlet,
  useFetcher,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate, registerWebhooks } from "../shopify.server";
import { ensureAppSeed } from "../lib/seed.server";
import prisma from "../db.server";
import { formatINR } from "../lib/pricing";
import "../styles/dashboard.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await ensureAppSeed();

  try {
    await registerWebhooks({ session });
  } catch (err) {
    console.error("[Shopify Webhooks] Auto-registration failed:", err);
  }

  const settings = await prisma.appSetting.findUnique({ where: { id: "default" } });

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    goldPricePerGram: settings?.goldPricePerGram ?? 6500,
  };
};

const titleMap: Record<string, string> = {
  "/app": "Dashboard",
  "/app/products": "Products",
  "/app/collections": "Collections",
  "/app/metals": "Metals & purity",
  "/app/pricing": "Gold rates",
  "/app/discounts": "Discounts",
};

function navActive(pathname: string, search: string, to: string, view?: string) {
  if (to === "/app") return pathname === "/app" || pathname === "/app/";
  if (to === "/app/products" && view) {
    if (pathname !== "/app/products") return false;
    const params = new URLSearchParams(search);
    const current = params.get("view") || "edit";
    return current === view;
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavLink({
  to,
  label,
  active,
  onNavigate,
}: {
  to: string;
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      to={to}
      className={`nav-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      {label}
    </Link>
  );
}

export default function App() {
  const { apiKey, goldPricePerGram } = useLoaderData<typeof loader>();
  const location = useLocation();
  const syncFetcher = useFetcher<{ ok: boolean; message: string }>();
  const syncing = syncFetcher.state !== "idle";
  const title = titleMap[location.pathname] ?? "Konika";
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const syncAll = () =>
    syncFetcher.submit(null, { method: "post", action: "/app/sync" });

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className={`ja-shell ${navOpen ? "nav-open" : ""}`}>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {navOpen ? (
          <button type="button" className="overlay" aria-label="Close menu" onClick={closeNav} />
        ) : null}

        <aside className="sidebar" aria-label="Admin navigation">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              K
            </div>
            <div className="brand-copy">
              <div className="brand-name">Konika</div>
              <div className="brand-tag">Jewellery admin</div>
            </div>
          </div>

          <nav>
            <NavLink
              to="/app"
              label="Dashboard"
              active={navActive(location.pathname, location.search, "/app")}
              onNavigate={closeNav}
            />

            <div className="nav-section">
              <div className="nav-parent">Catalog</div>
              <NavLink
                to="/app/products?view=catalog"
                label="Products"
                active={navActive(location.pathname, location.search, "/app/products", "catalog")}
                onNavigate={closeNav}
              />
              <NavLink
                to="/app/products?view=edit"
                label="Add product"
                active={navActive(location.pathname, location.search, "/app/products", "edit")}
                onNavigate={closeNav}
              />
              <NavLink
                to="/app/collections"
                label="Collections"
                active={navActive(location.pathname, location.search, "/app/collections")}
                onNavigate={closeNav}
              />
            </div>

            <div className="nav-section">
              <div className="nav-parent">Pricing</div>
              <NavLink
                to="/app/pricing"
                label="Gold rates"
                active={navActive(location.pathname, location.search, "/app/pricing")}
                onNavigate={closeNav}
              />
              <NavLink
                to="/app/discounts"
                label="Discounts"
                active={navActive(location.pathname, location.search, "/app/discounts")}
                onNavigate={closeNav}
              />
              <NavLink
                to="/app/metals"
                label="Metals & diamonds"
                active={navActive(location.pathname, location.search, "/app/metals")}
                onNavigate={closeNav}
              />
            </div>
          </nav>

          <div className="sidebar-foot">
            <button type="button" className="btn primary" style={{ width: "100%" }} disabled={syncing} onClick={syncAll}>
              {syncing ? "Syncing…" : "Sync to Shopify"}
            </button>
            Bulk push all products &amp; collections. Single product saves sync automatically.
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button
              type="button"
              className="menu-toggle"
              aria-label="Open navigation"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((open) => !open)}
            >
              ☰
            </button>
            <h1 className="topbar-title">{title}</h1>
            <div className="rate-ticker">
              <div className="rate-item">
                <span>Gold / gram</span>
                <span className="v">{formatINR(goldPricePerGram)}</span>
              </div>
            </div>
            <div className="topbar-right">
              <button type="button" className="btn primary" disabled={syncing} onClick={syncAll}>
                {syncing ? "Syncing…" : "Sync to Shopify"}
              </button>
              <div className="avatar" aria-hidden="true">
                AU
              </div>
            </div>
          </header>

          {syncFetcher.data?.message ? (
            <div
              className={`flash ${syncFetcher.data.ok ? "ok" : "err"}`}
              style={{ margin: "12px 28px 0" }}
              role="status"
            >
              {syncFetcher.data.message}
            </div>
          ) : null}

          <div className="content" id="main-content" tabIndex={-1}>
            <Outlet />
          </div>
        </div>
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
