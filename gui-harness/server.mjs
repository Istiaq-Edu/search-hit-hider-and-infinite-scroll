// Minimal static server for the GUI test harness.
// Serves the repo root so /dist/popup/*.js and /gui-harness/* both resolve.
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join, normalize } from "path";
import { fileURLToPath } from "url";

const root = fileURLToPath(new URL("..", import.meta.url)); // repo root
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(normalize(root))) { res.writeHead(403); res.end(); return; }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404");
  }
}).listen(8327, "127.0.0.1", () => console.log("harness on http://127.0.0.1:8327"));
