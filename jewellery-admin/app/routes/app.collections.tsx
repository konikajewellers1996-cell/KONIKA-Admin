import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { deleteCollectionFromShopify, fetchCollectionsFromShopify, syncCollectionToShopify } from "../lib/shopify-catalog.server";
import { readFormFile, uploadImageToShopifyFiles } from "../lib/shopify-files.server";

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
  const collections = await prisma.collection.findMany({
    include: {
      parent: true,
      _count: { select: { products: true } },
    },
    orderBy: { name: "asc" },
  });
  return { collections };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  try {
    if (intent === "import_shopify") {
      const shopifyCollections = await fetchCollectionsFromShopify(admin.graphql);
      let importedCount = 0;
      let updatedCount = 0;

      const shopifyIds = new Set(shopifyCollections.map((c) => c.id));

      for (const fetched of shopifyCollections) {
        const existingByShopifyId = await prisma.collection.findFirst({
          where: { shopifyCollectionId: fetched.id },
        });

        if (existingByShopifyId) {
          if (
            existingByShopifyId.name !== fetched.title ||
            existingByShopifyId.description !== fetched.description ||
            existingByShopifyId.imageUrl !== fetched.imageUrl
          ) {
            await prisma.collection.update({
              where: { id: existingByShopifyId.id },
              data: {
                name: fetched.title,
                description: fetched.description,
                imageUrl: fetched.imageUrl,
              },
            });
            updatedCount++;
          }
        } else {
          const existingByName = await prisma.collection.findFirst({
            where: { name: fetched.title },
          });

          if (existingByName) {
            await prisma.collection.update({
              where: { id: existingByName.id },
              data: {
                shopifyCollectionId: fetched.id,
                description: fetched.description,
                imageUrl: fetched.imageUrl,
              },
            });
            updatedCount++;
          } else {
            await prisma.collection.create({
              data: {
                name: fetched.title,
                description: fetched.description,
                imageUrl: fetched.imageUrl,
                shopifyCollectionId: fetched.id,
              },
            });
            importedCount++;
          }
        }
      }

      // Self-healing: Delete local collections that are linked to Shopify but no longer exist there
      const deletedRes = await prisma.collection.deleteMany({
        where: {
          shopifyCollectionId: {
            notIn: Array.from(shopifyIds),
            not: null,
          },
        },
      });

      let msg = `Successfully fetched collections. Imported ${importedCount} new, updated ${updatedCount} existing.`;
      if (deletedRes.count > 0) {
        msg += ` Cleaned up ${deletedRes.count} collection(s) deleted from Shopify.`;
      }

      return {
        ok: true,
        message: msg,
        clearEdit: true,
      };
    }

    if (intent === "create") {
      const name = String(form.get("name") || "").trim();
      const description = String(form.get("description") || "").trim();
      const parentId = String(form.get("parentId") || "") || null;
      const existingImageUrl = String(form.get("existingImageUrl") || "");

      let imageUrl = existingImageUrl;
      const file = await readFormFile(form, "collectionImage");
      if (file) {
        const uploaded = await uploadImageToShopifyFiles(admin.graphql, file, name);
        imageUrl = uploaded.url;
      }

      if (!name) return { ok: false, message: "Collection name is required." };

      const exists = await prisma.collection.findFirst({ where: { name } });
      if (exists) return { ok: false, message: "Collection already exists." };

      const shopifyCollectionId = await syncCollectionToShopify(
        admin.graphql,
        name,
        null,
        description,
        imageUrl,
      );

      await prisma.collection.create({
        data: { name, description, imageUrl, parentId, shopifyCollectionId },
      });
      return {
        ok: true,
        message: `"${name}" saved and synced to Shopify.`,
        clearEdit: true,
      };
    }

    if (intent === "update") {
      const id = String(form.get("id") || "");
      const name = String(form.get("name") || "").trim();
      const description = String(form.get("description") || "").trim();
      const parentId = String(form.get("parentId") || "") || null;
      const existingImageUrl = String(form.get("existingImageUrl") || "");

      if (!id || !name) return { ok: false, message: "Name is required." };

      const current = await prisma.collection.findUnique({ where: { id } });
      if (!current) return { ok: false, message: "Collection not found." };

      const duplicate = await prisma.collection.findFirst({
        where: { name, NOT: { id } },
      });
      if (duplicate) return { ok: false, message: "Another collection already uses that name." };

      let imageUrl = existingImageUrl;
      const file = await readFormFile(form, "collectionImage");
      if (file) {
        const uploaded = await uploadImageToShopifyFiles(admin.graphql, file, name);
        imageUrl = uploaded.url;
      }

      const shopifyCollectionId = await syncCollectionToShopify(
        admin.graphql,
        name,
        current.shopifyCollectionId,
        description,
        imageUrl,
      );

      await prisma.collection.update({
        where: { id },
        data: { name, description, imageUrl, parentId, shopifyCollectionId },
      });
      return {
        ok: true,
        message: `"${name}" updated and synced to Shopify.`,
        clearEdit: true,
      };
    }

    if (intent === "delete") {
      const id = String(form.get("id") || "");
      const current = await prisma.collection.findUnique({ where: { id } });
      if (!current) return { ok: false, message: "Collection not found." };

      const productCount = await prisma.product.count({
        where: {
          collections: {
            some: { id },
          },
        },
      });
      if (productCount > 0) {
        return {
          ok: false,
          message: "Move or delete products in this collection before deleting it.",
        };
      }

      if (current.shopifyCollectionId) {
        await deleteCollectionFromShopify(admin.graphql, current.shopifyCollectionId);
      }
      await prisma.collection.delete({ where: { id } });
      return { ok: true, message: "Collection deleted from app and Shopify.", clearEdit: true };
    }

    return { ok: false, message: "Unknown action." };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
};

type EditingCollection = {
  id: string;
  name: string;
  description: string;
  parentId: string;
  imageUrl: string;
};

export default function CollectionsPage() {
  const { collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [editing, setEditing] = useState<EditingCollection | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    if (actionData && "clearEdit" in actionData && actionData.clearEdit && actionData.ok) {
      setEditing(null);
      setName("");
      setDescription("");
      setParentId("");
      setImageUrl("");
    }
  }, [actionData]);

  const startCreate = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setParentId("");
    setImageUrl("");
  };

  const startEdit = (collection: any) => {
    setEditing({
      id: collection.id,
      name: collection.name,
      description: collection.description || "",
      parentId: collection.parentId || "",
      imageUrl: collection.imageUrl || "",
    });
    setName(collection.name);
    setDescription(collection.description || "");
    setParentId(collection.parentId || "");
    setImageUrl(collection.imageUrl || "");
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-title">Collections</div>
          <div className="page-sub">
            Create or edit collections here, then use Sync all to Shopify to push everything
          </div>
        </div>
        <div className="head-actions" style={{ display: "flex", gap: 8 }}>
          <Form method="post" style={{ display: "inline" }}>
            <input type="hidden" name="intent" value="import_shopify" />
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "Fetching..." : "Fetch from Shopify"}
            </button>
          </Form>
          <button type="button" className="btn" onClick={startCreate}>
            New collection
          </button>
        </div>
      </div>

      {actionData?.message ? (
        <div className={`flash ${actionData.ok ? "ok" : "err"}`}>{actionData.message}</div>
      ) : null}

      <div className="split-2">
        <div className="panel">
          <div className="panel-title">
            {editing ? "Edit collection" : "Create collection"}
          </div>
          {editing ? (
            <div className="hint" style={{ marginBottom: 12 }}>
              Editing <strong>{editing.name}</strong>
            </div>
          ) : null}
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value={editing ? "update" : "create"} />
            {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
            <div className="field">
              <label>Collection name</label>
              <input
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Bridal Collection"
                required
              />
            </div>
            <div className="field">
              <label>Parent Collection (Optional)</label>
              <select
                name="parentId"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">No parent (Is Main Collection)</option>
                {collections
                  .filter((c) => c.id !== editing?.id && !c.parentId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>Collection Image</label>
              {imageUrl ? (
                <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                  <img
                    src={imageUrl}
                    alt="Collection Thumbnail"
                    style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border-color)" }}
                  />
                  <button type="button" className="btn small" onClick={() => setImageUrl("")}>
                    Remove Image
                  </button>
                  <input type="hidden" name="existingImageUrl" value={imageUrl} />
                </div>
              ) : (
                <input type="file" name="collectionImage" accept="image/*" />
              )}
            </div>
            <div className="field">
              <label>Description</label>
              <textarea
                name="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Collection description..."
                style={{ minHeight: 80, resize: "vertical" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
                {editing ? "Save collection" : "Create collection"}
              </button>
              {editing ? (
                <button type="button" className="btn" onClick={startCreate}>
                  Cancel edit
                </button>
              ) : null}
            </div>
          </Form>
        </div>

        <div>
          <div className="coll-grid" style={{ marginBottom: 16 }}>
            {collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className="coll-card"
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  borderColor: editing?.id === collection.id ? "var(--gold)" : undefined,
                }}
                onClick={() => startEdit(collection)}
              >
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  {collection.imageUrl ? (
                    <img
                      src={collection.imageUrl}
                      alt=""
                      style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                    />
                  ) : (
                    <div className="coll-icon" style={{ flexShrink: 0 }}>{initials(collection.name)}</div>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="coll-name" style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                      {collection.name}
                    </div>
                    <div className="coll-count">
                      {collection._count.products} product
                      {collection._count.products === 1 ? "" : "s"}
                      {" · "}
                      {collection.parent ? `Sub of ${collection.parent.name}` : "Main Collection"}
                    </div>
                    <div className="hint" style={{ marginTop: 2 }}>
                      {collection.shopifyCollectionId ? "On Shopify" : "Local only"}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Products</th>
                  <th>Shopify</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {collections.length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty-state">No collections yet. Create one above.</div>
                    </td>
                  </tr>
                ) : (
                  collections.map((collection) => (
                    <tr key={collection.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          {collection.imageUrl ? (
                            <img
                              src={collection.imageUrl}
                              alt=""
                              style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4 }}
                            />
                          ) : null}
                          <div>
                            <strong>{collection.name}</strong>
                            {collection.parent ? (
                              <div className="hint" style={{ fontSize: "0.8em" }}>
                                Sub-collection of <strong>{collection.parent.name}</strong>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td>{collection._count.products}</td>
                      <td>
                        <span
                          className={`badge ${collection.shopifyCollectionId ? "active" : "draft"}`}
                        >
                          <span className="badge-dot" />
                          {collection.shopifyCollectionId ? "On Shopify" : "Local only"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn small"
                            onClick={() => startEdit(collection)}
                          >
                            Edit
                          </button>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="id" value={collection.id} />
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
        </div>
      </div>
    </>
  );
}
