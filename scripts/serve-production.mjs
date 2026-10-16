import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist"),
  port = Number(process.argv[2] || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (path === "/data") {
      res.writeHead(302, { Location: "/data/" }).end();
      return;
    }
    if (path.startsWith("/data/")) path = path.slice(5);
    if (path.endsWith("/")) path += "index.html";
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + "\\") && !file.startsWith(root + "/"))
      throw new Error("outside root");
    if (!(await stat(file)).isFile()) throw new Error("not file");
    res.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Production: http://127.0.0.1:${port}/ and http://127.0.0.1:${port}/data/`,
  ),
);
process.on("SIGINT", () => server.close(() => process.exit(0)));
