type GraphqlClient = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export type UploadedShopifyFile = {
  fileId: string;
  url: string;
};

async function gql<T>(
  graphql: GraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  context = "Shopify Files",
): Promise<T> {
  const response = await graphql(query, variables ? { variables } : undefined);
  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`${context}: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  if (!json.data) throw new Error(`${context}: empty response`);
  return json.data;
}

function assertNoUserErrors(
  errors: Array<{ message: string }> | undefined,
  context: string,
) {
  if (errors?.length) {
    throw new Error(`${context}: ${errors.map((e) => e.message).join(", ")}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileUrl(
  graphql: GraphqlClient,
  fileId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const data = await gql<{
      node: {
        id: string;
        fileStatus?: string;
        image?: { url?: string } | null;
        preview?: { image?: { url?: string } | null } | null;
      } | null;
    }>(
      graphql,
      `#graphql
      query fileStatus($id: ID!) {
        node(id: $id) {
          ... on MediaImage {
            id
            fileStatus
            image { url }
            preview { image { url } }
          }
          ... on GenericFile {
            id
            fileStatus
            preview { image { url } }
          }
        }
      }`,
      { id: fileId },
      "File status",
    );

    const url = data.node?.image?.url || data.node?.preview?.image?.url;
    if (url) return url;
    if (data.node?.fileStatus === "FAILED") {
      throw new Error("Shopify file processing failed");
    }
    await sleep(700);
  }
  throw new Error("Timed out waiting for Shopify file URL");
}

/**
 * Upload an image into Shopify Files (Content → Files), return file GID + CDN URL.
 */
export async function uploadImageToShopifyFiles(
  graphql: GraphqlClient,
  file: File | Blob,
  alt = "Jewellery image",
  filenameHint?: string,
): Promise<UploadedShopifyFile> {
  const filename =
    (file instanceof File && file.name) ||
    filenameHint ||
    `jewellery-${Date.now()}.jpg`;

  // Re-wrap bytes so staged upload always gets a real Blob with a filename.
  const buffer = await file.arrayBuffer();
  const mimeType = file.type || "image/jpeg";
  if (!mimeType.startsWith("image/")) {
    throw new Error("Only image files are allowed");
  }
  const uploadBlob = new Blob([buffer], { type: mimeType });
  const fileSize = String(uploadBlob.size);

  if (!uploadBlob.size) {
    throw new Error("Empty image file");
  }

  const staged = await gql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }> | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    graphql,
    `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "FILE",
          fileSize,
        },
      ],
    },
    "Staged upload",
  );

  assertNoUserErrors(staged.stagedUploadsCreate.userErrors, "Staged upload");
  const target = staged.stagedUploadsCreate.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("Staged upload: no target returned");
  }

  const body = new FormData();
  for (const param of target.parameters) {
    body.append(param.name, param.value);
  }
  body.append("file", uploadBlob, filename);

  const uploadResponse = await fetch(target.url, {
    method: "POST",
    body,
  });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Upload to Shopify storage failed (${uploadResponse.status}): ${text}`);
  }

  const created = await gql<{
    fileCreate: {
      files: Array<{ id: string; fileStatus?: string }> | null;
      userErrors: Array<{ message: string }>;
    };
  }>(
    graphql,
    `#graphql
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          alt
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      files: [
        {
          alt,
          contentType: "IMAGE",
          originalSource: target.resourceUrl,
        },
      ],
    },
    "File create",
  );

  assertNoUserErrors(created.fileCreate.userErrors, "File create");
  const fileNode = created.fileCreate.files?.[0];
  if (!fileNode?.id) {
    throw new Error("File create: no file id returned");
  }

  const url = await waitForFileUrl(graphql, fileNode.id);
  return { fileId: fileNode.id, url };
}

export async function readFormFile(form: FormData, key: string): Promise<File | Blob | null> {
  const value = form.get(key);
  if (!value || typeof value === "string") return null;

  // Undici/Remix File may not pass `instanceof Blob` across realms.
  const candidate = value as { size?: number; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer !== "function") return null;
  if (!candidate.size || candidate.size <= 0) return null;
  return value as Blob;
}
