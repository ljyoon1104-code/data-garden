import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const host = "127.0.0.1";
const portArgument = process.argv[2] ?? "4173";
const port = Number(portArgument);
if (!/^\d{1,5}$/.test(portArgument) || port > 65535)
  throw new Error("포트 번호는 0~65535 사이여야 합니다.");

const root = join(await realpath("."), "dist");
const rootIdentity = await lstat(root, { bigint: true });
if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || relative(root, await realpath(root)))
  throw new Error("dist는 정션이나 심볼릭 링크가 아닌 실제 폴더여야 합니다.");

const mounts = new Set(["data", "data-garden", "verification-10"]);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

function requestPath(target) {
  // Check the raw origin-form target before a URL parser can collapse dot or
  // backslash segments. Percent escapes are decoded exactly once.
  const raw = target?.split("?", 1)[0] ?? "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("#") || /%2f|%5c/i.test(raw))
    throw new Error("invalid request target");
  const decoded = decodeURIComponent(raw);
  const parts = decoded.slice(1).split("/");
  const directory = parts.at(-1) === "";
  if (directory) parts.pop();
  for (const part of parts) {
    if (!part || part === "." || part === ".." ||
        /[\\:\x00-\x1f\x7f<>"|?*]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:[. ]|$)/i.test(part))
      throw new Error("invalid path segment");
  }
  const mount = mounts.has(parts[0]) ? parts.shift() : null;
  if (mount && parts.length === 0 && !directory)
    return { redirect: "/" + mount + "/" };
  if (directory) parts.push("index.html");
  return { parts };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function checkedFile(parts) {
  const currentRoot = await lstat(root, { bigint: true });
  if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !sameFile(currentRoot, rootIdentity))
    throw new Error("dist changed");
  let path = root, entry = currentRoot;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    entry = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink() || !(i === parts.length - 1 ? entry.isFile() : entry.isDirectory()))
      throw new Error("not a regular file path");
  }
  const physical = await realpath(path);
  const within = relative(root, physical);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(".." + sep) || relative(path, physical))
    throw new Error("outside or redirected path");
  return { path: physical, entry };
}

function validHost(req) {
  const names = req.headersDistinct.host;
  if (names?.length !== 1) return false;
  const value = names[0].toLowerCase();
  const suffix = ":" + req.socket.localPort;
  return value === host || value === "localhost" || value === host + suffix || value === "localhost" + suffix;
}

const server = createServer(async (req, res) => {
  if (!validHost(req)) {
    res.writeHead(400).end("Invalid Host");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const { parts, redirect } = requestPath(req.url);
    if (redirect) {
      res.writeHead(302, { Location: redirect }).end();
      return;
    }
    const file = await checkedFile(parts);
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0));
    const handle = await open(file.path, flags);
    let body;
    try {
      const opened = await handle.stat({ bigint: true });
      const confirmed = await checkedFile(parts);
      if (!opened.isFile() || !sameFile(file.entry, opened) || !sameFile(confirmed.entry, opened))
        throw new Error("file changed");
      if (req.method === "GET") body = await handle.readFile();
    } finally {
      await handle.close();
    }
    res.writeHead(200, {
      "Content-Type": types[extname(file.path)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.on("error", error => {
  console.error(error.code === "EADDRINUSE"
    ? "포트 " + port + "을 이미 사용 중입니다. 실행 중인 앱을 확인한 뒤 다시 시도하세요."
    : "로컬 서버를 시작하지 못했습니다: " + (error.code ?? error.message));
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const base = "http://" + host + ":" + server.address().port;
  console.log("Production: " + base + "/ and " + base + "/data/");
  if (process.platform === "win32" && process.argv[3] === "--open" && !process.env.DATA_GARDEN_NO_BROWSER) {
    // Open only after this process has successfully bound its own listener.
    const browser = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-Command", "Start-Process -FilePath $env:DATA_GARDEN_URL",
    ], {
      env: { ...process.env, DATA_GARDEN_URL: base + "/data-garden/" },
      windowsHide: true,
      stdio: "ignore",
    });
    const openFailed = () => console.warn("브라우저를 열지 못했습니다. " + base + "/data-garden/ 에 직접 접속하세요.");
    browser.on("error", openFailed);
    browser.on("exit", code => { if (code) openFailed(); });
  }
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
