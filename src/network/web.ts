import { parseHTML } from "linkedom";
import { fetchPublic, publicUrl } from "./http.ts";
import { requiredText } from "../errors.ts";
import type { SearchHit } from "../mcp/manager.ts";

export function pageText(html: string, url: string) {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() ?? url;
  document.querySelectorAll("script,style,noscript,svg,iframe,nav,footer,header").forEach((node) => node.remove());
  const root = document.querySelector("main,article,[role=main]") ?? document.body;
  root.querySelectorAll("p,div,li,h1,h2,h3,h4,br,tr,section").forEach((node) => node.append("\n"));
  const content = root.textContent?.replace(/[\t ]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim() ?? "";
  const links = Array.from(root.querySelectorAll("a[href]")).flatMap((node) => {
    try { return [{ title: node.textContent?.trim().slice(0, 200) || "Link", url: publicUrl(new URL(node.getAttribute("href")!, url).href).href }]; } catch { return []; }
  }).slice(0, 40);
  return { title, content: content.slice(0, 30000), truncated: content.length > 30000, links };
}

export async function readWebpage(url: string, signal?: AbortSignal) {
  const result = await fetchPublic(url, { signal });
  if (/text\/html|application\/xhtml/i.test(result.contentType)) return { url: result.url, ...pageText(result.text, result.url) };
  if (!/text\/|application\/(json|xml)/i.test(result.contentType)) throw new Error("This URL is not a readable text page. Open it in the workspace browser.");
  return { url: result.url, title: result.url, content: result.text.slice(0, 30000), truncated: result.text.length > 30000, links: [] };
}

export function bingResults(html: string, limit: number): SearchHit[] {
  const { document } = parseHTML(html);
  const hits: SearchHit[] = [];
  for (const row of document.querySelectorAll("li.b_algo")) {
    const anchor = row.querySelector("h2 a");
    if (!anchor) continue;
    try {
      let url = new URL(anchor.getAttribute("href")!, "https://www.bing.com");
      if (url.hostname.endsWith("bing.com") && url.pathname === "/ck/a") {
        const encoded = url.searchParams.get("u");
        if (!encoded?.startsWith("a1")) continue;
        url = new URL(Buffer.from(encoded.slice(2), "base64url").toString());
      }
      publicUrl(url.href);
      hits.push({ title: anchor.textContent?.trim().slice(0, 500) || url.hostname, url: url.href, snippet: row.querySelector(".b_caption p,p")?.textContent?.trim().slice(0, 2000) ?? "" });
    } catch { continue; }
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function publicSearch(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const q = requiredText(query, "Search query", 2000);
  const result = await fetchPublic(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US`, { signal });
  const hits = bingResults(result.text, limit);
  if (!hits.length) throw new Error("The search engine returned no readable results. Try another query, configure SearXNG in Settings, or use the workspace browser.");
  return hits;
}
