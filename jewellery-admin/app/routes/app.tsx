import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Form,
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
    console.log("[Shopify Webhooks] Auto-registered/synced successfully.");
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

export default function App() {
  const { apiKey, goldPricePerGram } = useLoaderData<typeof loader>();
  const location = useLocation();
  const syncFetcher = useFetcher<{ ok: boolean; message: string }>();
  const syncing = syncFetcher.state !== "idle";
  const title = titleMap[location.pathname] ?? "Konika";

  return (
    <AppProvider embedded apiKey={apiKey}>
      <div className="ja-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">K</div>
            <div className="brand-name">Konika</div>
          </div>

          <Link
            to="/app"
            className={`nav-item top ${navActive(location.pathname, location.search, "/app") ? "active" : ""}`}
          >
            Dashboard
          </Link>

          <div className="nav-parent">Products</div>
          <Link
            to="/app/products?view=edit"
            className={`nav-item ${navActive(location.pathname, location.search, "/app/products", "edit") ? "active" : ""}`}
          >
            Add / edit jewelry
          </Link>
          <Link
            to="/app/products?view=catalog"
            className={`nav-item ${navActive(location.pathname, location.search, "/app/products", "catalog") ? "active" : ""}`}
          >
            View catalog
          </Link>

          <div className="nav-parent">Collections</div>
          <Link
            to="/app/collections"
            className={`nav-item ${navActive(location.pathname, location.search, "/app/collections") ? "active" : ""}`}
          >
            View & create
          </Link>

          <div className="nav-parent">Jewelry data</div>
          <Link
            to="/app/pricing"
            className={`nav-item ${navActive(location.pathname, location.search, "/app/pricing") ? "active" : ""}`}
          >
            Gold rates
          </Link>
          <Link
            to="/app/metals"
            className={`nav-item ${navActive(location.pathname, location.search, "/app/metals") ? "active" : ""}`}
          >
            Metals & purity
          </Link>

          <div className="sidebar-foot">
            <Form
              method="post"
              action="/app/sync"
              onSubmit={(event) => {
                event.preventDefault();
                syncFetcher.submit(null, { method: "post", action: "/app/sync" });
              }}
            >
              <button
                type="submit"
                className="btn primary"
                style={{ width: "100%", justifyContent: "center" }}
                disabled={syncing}
              >
                {syncing ? "Syncing…" : "Sync all to Shopify"}
              </button>
            </Form>
            <div style={{ marginTop: 10 }}>
              One button syncs all dashboard changes
            </div>
          </div>
        </aside>

        <div className="main">
          <div className="topbar">
            <div className="topbar-title">{title}</div>
            <div className="rate-ticker">
              <div className="rate-item">
                Gold / gram
                <span className="v">{formatINR(goldPricePerGram)}</span>
              </div>
            </div>
            <div className="topbar-right">
              <button
                type="button"
                className="btn primary"
                disabled={syncing}
                onClick={() =>
                  syncFetcher.submit(null, { method: "post", action: "/app/sync" })
                }
              >
                {syncing ? "Syncing…" : "Sync all to Shopify"}
              </button>
              <div className="avatar">AU</div>
            </div>
          </div>

          {syncFetcher.data?.message ? (
            <div
              className={`flash ${syncFetcher.data.ok ? "ok" : "err"}`}
              style={{ margin: "12px 26px 0" }}
            >
              {syncFetcher.data.message}
            </div>
          ) : null}

          <div className="content">
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
