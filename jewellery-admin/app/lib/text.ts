/** Convert stored HTML / entity-escaped text into plain text for admin forms. */
export function htmlToPlainText(value: string | null | undefined): string {
  if (!value) return "";

  let text = String(value);

  // Decode entities repeatedly (handles &amp;lt; / &amp;amp;gt; chains from re-syncs)
  for (let i = 0; i < 8; i += 1) {
    const next = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    if (next === text) break;
    text = next;
  }

  text = text
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<\/\s*div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Normalize image URLs so CDN query variants still count as the same asset. */
export function normalizeImageUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw.split("?")[0].split("#")[0];
  }
}
