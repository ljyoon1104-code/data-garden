import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const serverScript = fileURLToPath(new URL("../scripts/serve-production.mjs", import.meta.url));
const workspace = fileURLToPath(new URL("../", import.meta.url));
const testParent = fileURLToPath(new URL("../tmp/", import.meta.url));
const marker = "SYNTHETIC-OUTSIDE-DIST-MARKER";
const innerMarker = "SYNTHETIC-INSIDE-DIST-MARKER";
const linkKinds = {
  directory: process.platform === "win32" ? "junction" : "dir",
} as const;

let workDir: string | undefined;
let tempRoot: string;
let child: ChildProcess | undefined;
let bound: { address: string; family: string; port: number };
let fileLink = false;

// No WHATWG URL, fetch, browser, or curl processes these targets before transmission.
async function rawRequest(target: string, hosts = [`127.0.0.1:${bound.port}`], port = bound.port) {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.setTimeout(4000, () => socket.destroy(new Error(`HTTP timeout: ${target}`)));
    socket.on("error", reject);
    socket.on("data", chunk => chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => socket.write(
      `GET ${target} HTTP/1.0\r\n${hosts.map(host => `Host: ${host}\r\n`).join("")}Connection: close\r\n\r\n`,
      "latin1",
    ));
  });
  const response = bytes.toString("utf8");
  const separator = response.indexOf("\r\n\r\n");
  const status = /^HTTP\/1\.[01] (\d{3}) /.exec(response);
  if (!status || separator < 0) throw new Error(`Invalid HTTP response for ${target}`);
  const headers = new Map(response.slice(0, separator).split("\r\n").slice(1).map(line => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  // The test-only observer echoes the parser's actual IncomingMessage.url.
  expect(headers.get("x-test-request-target")).toBe(Buffer.from(target, "latin1").toString("base64"));
  return { status: Number(status[1]), headers, body: response.slice(separator + 4) };
}

async function openObserver() {
  const observer = join(workDir!, "observe-browser-open.mjs");
  await fs.writeFile(observer, `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { Server } from "node:net";
let listener, address;
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  listener = this;
  this.once("listening", () => { address = this.address(); });
  this.prependListener("request", (request, response) => {
    response.setHeader("X-Test-Request-Target", Buffer.from(request.url, "latin1").toString("base64"));
  });
  return listen.apply(this, args);
};
childProcess.spawn = (command, args, options) => {
  console.log("OPEN_HELPER:" + JSON.stringify({
    command, args, listening: Boolean(listener?.listening), address,
    url: options?.env?.DATA_GARDEN_URL, windowsHide: options?.windowsHide,
  }));
  if (command !== "powershell.exe") throw new Error("Unexpected browser helper");
  const helper = new EventEmitter();
  queueMicrotask(() => helper.emit("exit", 0));
  return helper;
};
syncBuiltinESMExports();
Object.defineProperty(process, "platform", { value: "win32" });`);
  return observer;
}

async function stopOwned(server: ChildProcess) {
  if (server.exitCode === null && server.signalCode === null && server.pid)
    await new Promise<void>(done => { server.once("exit", () => done()); server.kill(); });
}

beforeAll(async () => {
  await fs.mkdir(testParent, { recursive: true });
  tempRoot = await fs.realpath(testParent);
  if (tempRoot !== join(await fs.realpath(workspace), "tmp"))
    throw new Error("Local-server test tmp directory is redirected");
  workDir = await fs.mkdtemp(join(tempRoot, "local-server-test-"));
  const dist = join(workDir, "dist");
  const outside = join(workDir, "outside");
  await Promise.all([
    fs.mkdir(join(dist, "assets"), { recursive: true }),
    fs.mkdir(join(dist, "inside"), { recursive: true }),
    fs.mkdir(outside),
  ]);
  await Promise.all([
    fs.writeFile(join(dist, "index.html"), "<!doctype html><title>Local server fixture</title>"),
    fs.writeFile(join(dist, "assets", "app.js"), "export const ready = true;"),
    fs.writeFile(join(dist, "assets", "style.css"), "body{color:black}"),
    fs.writeFile(join(dist, "assets", "한글 자료.json"), '{"ready":true}'),
    fs.writeFile(join(dist, "inside", "file.txt"), innerMarker),
    fs.writeFile(join(outside, "file.txt"), marker),
    fs.symlink(outside, join(dist, "outside-link"), linkKinds.directory),
    fs.symlink(join(dist, "inside"), join(dist, "inside-link"), linkKinds.directory),
  ]);
  try {
    await fs.symlink(join(outside, "file.txt"), join(dist, "file-link.txt"), "file");
    fileLink = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows junctions need no Developer Mode; native file symlinks can need it.
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
  }

  // Observe the actual socket address, independently of the application's status text.
  const observer = join(workDir, "observe-bind.mjs");
  await fs.writeFile(observer, `import { Server } from "node:net";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => console.log("BOUND:" + JSON.stringify(this.address())));
  this.prependListener("request", (request, response) => {
    response.setHeader("X-Test-Request-Target", Buffer.from(request.url, "latin1").toString("base64"));
  });
  return listen.apply(this, args);
};`);
  const server = spawn(process.execPath, ["--import", pathToFileURL(observer).href, serverScript, "0"], {
    cwd: workDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = server;
  bound = await new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Local server failed to start: ${stderr}`)), 8000);
    server.stderr.on("data", chunk => { stderr += String(chunk); });
    server.stdout.on("data", chunk => {
      stdout += String(chunk);
      const value = /^BOUND:([^\r\n]+)\r?\n/m.exec(stdout);
      if (!value) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(value[1])); }
      catch (error) { reject(error); }
    });
    server.once("error", error => { clearTimeout(timeout); reject(error); });
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Local server exited ${code}: ${stderr}`)); });
  });
}, 12000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null && child.pid) {
    const owned = child;
    await new Promise<void>(done => { owned.once("exit", () => done()); owned.kill(); });
  }
  if (!workDir) return;
  if (await fs.realpath(testParent) !== tempRoot)
    throw new Error("Local-server test tmp directory changed before cleanup");
  const target = await fs.realpath(workDir);
  const rel = relative(tempRoot, target);
  if (!rel.startsWith("local-server-test-") || rel.includes(sep) || target !== resolve(workDir))
    throw new Error("Unexpected local-server test cleanup location");
  // Explicitly unlink junctions before the recursive cleanup of the owned fixture.
  await Promise.all(["outside-link", "inside-link", "file-link.txt"].map(name =>
    fs.unlink(join(target, "dist", name)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }),
  ));
  await fs.rm(target, { recursive: true, force: true });
});

describe("Windows production server boundary", () => {
  it("listens on an IPv4 loopback address only", () => {
    expect(bound).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(bound.port).toBeGreaterThan(0);
  });

  it("rejects foreign, missing and duplicate Host headers", async () => {
    const own = `127.0.0.1:${bound.port}`;
    for (const hosts of [[`other.invalid:${bound.port}`], [], [own, own], [own, "other.invalid"]]) {
      const response = await rawRequest("/index.html", hosts);
      expect(response.status).toBe(400);
      expect(response.body).not.toContain("Local server fixture");
    }
  });

  it("serves root and existing mounts, redirects missing slashes, and preserves asset types", async () => {
    for (const mount of ["", "/data", "/data-garden", "/verification-10"]) {
      const entry = await rawRequest(`${mount}/?v=1`);
      expect(entry.status).toBe(200);
      expect(entry.headers.get("content-type")).toMatch(/^text\/html\b/);
      expect(entry.body).toContain("Local server fixture");
      if (mount) {
        const redirect = await rawRequest(mount);
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("location")).toBe(`${mount}/`);
      }
    }
    const js = await rawRequest("/data-garden/assets/app.js?version=2026");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript\b/);
    expect(js.body).toContain("export const ready = true;");
    const css = await rawRequest("/assets/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/^text\/css\b/);
    const utf8 = await rawRequest(`/data/assets/${encodeURIComponent("한글 자료.json")}`);
    expect(utf8.status).toBe(200);
    expect(utf8.headers.get("content-type")).toMatch(/^application\/json\b/);
    expect(utf8.body).toContain('{"ready":true}');
  });

  it.each([
    "/../outside/file.txt",
    "/%2e%2e/outside/file.txt",
    "/..%2foutside%2ffile.txt",
    "/..\\outside\\file.txt",
    "/..%5coutside%5cfile.txt",
    "/.%2E%5Coutside%2Ffile.txt",
    "/data-garden/..\\..%2Foutside/file.txt",
    "/data/%2e%2e%5coutside/file.txt",
    "/%252e%252e%255coutside/file.txt",
    "/..;/outside/file.txt",
    "/assets/../index.html",
    "/assets/%2e%2e/index.html",
    "/assets\\app.js",
    "/assets%5capp.js",
    "/assets/app.js::$DATA",
    "/assets/app.js%3a%3a%24DATA",
    "/index.html.",
    "/index.html%20",
    "/assets./app.js",
    "/NUL",
    "/CON.txt",
    "/COM1.txt",
    "/LPT1",
    "/%00",
    "/%",
  ])("rejects the unnormalized request target %s", async target => {
    const result = await rawRequest(target);
    expect(result.status).toBe(404);
    expect(result.body).not.toContain(marker);
  });

  it("refuses directory links even when the link destination stays inside dist", async () => {
    expect((await rawRequest("/inside/file.txt")).body).toContain(innerMarker);
    for (const [target, content] of [
      ["/outside-link/file.txt", marker],
      ["/data-garden/outside-link/file.txt", marker],
      ["/inside-link/file.txt", innerMarker],
    ]) {
      const result = await rawRequest(target);
      expect(result.status).toBe(404);
      expect(result.body).not.toContain(content);
    }
  });

  it("refuses a file symlink when the host permits creating one", async ({ skip }) => {
    if (!fileLink) skip(true, "This Windows account cannot create file symlinks; junction coverage still runs.");
    const result = await rawRequest("/file-link.txt");
    expect(result.status).toBe(404);
    expect(result.body).not.toContain(marker);
  });

  it("does not start when dist itself is a directory link", async () => {
    const linkedRoot = join(workDir!, "linked-root");
    const linkedDist = join(linkedRoot, "dist");
    await fs.mkdir(linkedRoot);
    await fs.symlink(join(workDir!, "outside"), linkedDist, linkKinds.directory);
    let server: ChildProcess | undefined;
    try {
      expect(await fs.readFile(join(linkedDist, "file.txt"), "utf8")).toBe(marker);
      const owned = spawn(process.execPath, [serverScript, "0"], {
        cwd: linkedRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      server = owned;
      let stdout = "";
      owned.stdout.on("data", chunk => { stdout += String(chunk); });
      owned.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          owned.kill();
          reject(new Error("The linked dist root did not fail startup"));
        }, 4000);
        owned.once("error", error => { clearTimeout(timer); reject(error); });
        owned.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      expect(code).not.toBeNull();
      expect(code).not.toBe(0);
      expect(stdout).not.toContain("Production:");
    } finally {
      if (server && server.exitCode === null && server.signalCode === null && server.pid) {
        const owned = server;
        await new Promise<void>(done => { owned.once("exit", () => done()); owned.kill(); });
      }
      await fs.unlink(linkedDist);
    }
  });

  it("opens the browser once only after its own listener starts, using the bound loopback URL", async () => {
    const observer = await openObserver();
    const env = { ...process.env };
    delete env.DATA_GARDEN_NO_BROWSER;
    const server = spawn(process.execPath, ["--import", pathToFileURL(observer).href, serverScript, "0", "--open"], {
      cwd: workDir,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    server.stderr.on("data", chunk => { stderr += String(chunk); });
    try {
      const helper = await new Promise<{
        command: string; listening: boolean; address: typeof bound; url: string; windowsHide: boolean;
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Browser helper did not start: ${stderr}`)), 4000);
        server.stdout.on("data", chunk => {
          stdout += String(chunk);
          const line = /^OPEN_HELPER:([^\r\n]+)\r?\n/m.exec(stdout);
          if (!line) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(line[1])); }
          catch (error) { reject(error); }
        });
        server.once("error", error => { clearTimeout(timer); reject(error); });
        server.once("exit", code => {
          clearTimeout(timer);
          reject(new Error(`Server exited before browser helper: ${code}: ${stderr}`));
        });
      });
      expect(helper.command).toBe("powershell.exe");
      expect(helper.listening).toBe(true);
      expect(helper.address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
      expect(helper.address.port).toBeGreaterThan(0);
      expect(helper.url).toBe(`http://127.0.0.1:${helper.address.port}/data-garden/`);
      expect(helper.windowsHide).toBe(true);
      const response = await rawRequest("/data-garden/", [`127.0.0.1:${helper.address.port}`], helper.address.port);
      expect(response.status).toBe(200);
      await stopOwned(server);
      expect(stdout.match(/^OPEN_HELPER:/gm)).toHaveLength(1);
    } finally {
      await stopOwned(server);
    }
  });

  it("does not open a browser or interfere with an existing listener when its port is occupied", async () => {
    const before = await rawRequest("/index.html");
    const observer = await openObserver();
    const env = { ...process.env };
    delete env.DATA_GARDEN_NO_BROWSER;
    const server = spawn(process.execPath, ["--import", pathToFileURL(observer).href, serverScript, String(bound.port), "--open"], {
      cwd: workDir,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    server.stdout.on("data", chunk => { stdout += String(chunk); });
    server.stderr.on("data", chunk => { stderr += String(chunk); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Occupied-port startup did not exit")), 4000);
        server.once("error", error => { clearTimeout(timer); reject(error); });
        server.once("exit", code => { clearTimeout(timer); resolve(code); });
      });
      expect(code).toBe(1);
      expect(stdout).not.toContain("Production:");
      expect(stdout).not.toContain("OPEN_HELPER:");
      expect(stderr).toContain(String(bound.port));
      const after = await rawRequest("/index.html");
      expect(after.status).toBe(before.status);
      expect(after.body).toBe(before.body);
      expect(after.headers.get("content-type")).toBe(before.headers.get("content-type"));
    } finally {
      await stopOwned(server);
    }
  });
});
