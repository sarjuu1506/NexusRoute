import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envFile = resolve(root, ".env");

try {
  const contents = await readFile(envFile, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(ORS_API_KEY|TOMTOM_API_KEY|GEMINI_API_KEY|PORT|VITE_MAPTILER_API_KEY|MAPTILER_API_KEY)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    await handleApiRequest(request, response);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }

  const relativePath = pathname === "/" ? "dist/index.html" : `dist${decodeURIComponent(pathname)}`;
  const filePath = resolve(root, relativePath);
  if (!filePath.startsWith(`${resolve(root, "dist")}${sep}`) && filePath !== resolve(root, "dist/index.html")) {
    response.writeHead(403).end();
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file.");
    const contents = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch {
    if (extname(pathname)) {
      response.writeHead(404).end();
      return;
    }
    const html = await readFile(resolve(root, "dist/index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  }
});

const port = Number(process.env.PORT) || 4174;
server.listen(port, "127.0.0.1", () => {
  console.log(`Wayfi server listening on http://127.0.0.1:${port}`);
});
