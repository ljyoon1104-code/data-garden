import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";

// Relative assets also work under a GitHub Pages repository subpath.
function offlineBundle() {
  let output = "";
  return {
    name: "data-garden-offline",
    apply: "build" as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      output = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      function files(dir: string): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? files(resolve(dir, entry.name))
            : [resolve(dir, entry.name)],
        );
      }
      const paths = files(output).filter((p) => !p.endsWith("sw.js"));
      const version = createHash("sha256")
        .update(
          paths.map((p) => readFileSync(p)).join("") + new Date().toISOString(),
        )
        .digest("hex")
        .slice(0, 16);
      const urls = paths.map((p) => relative(output, p).replaceAll("\\", "/"));
      writeFileSync(
        resolve(output, "sw.js"),
        `/* data-garden ${version} */
const FILES=${JSON.stringify(urls)};
const ROOT=self.registration.scope;
const PREFIX='data-garden-program:'+encodeURIComponent(new URL(ROOT).pathname)+':';
const CACHE=PREFIX+'${version}';
const URLS=new Set(FILES.map(path=>new URL(path,ROOT).href));
self.addEventListener('install',event=>event.waitUntil((async()=>{
  try { const cache=await caches.open(CACHE);await cache.addAll([...URLS].map(url=>new Request(url,{cache:'reload'}))); }
  catch(error){await caches.delete(CACHE);throw error;}
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  // Old tabs can still need their old hashed Worker files. Keep their caches until a later activation.
  if(clients.filter(c=>c.url.startsWith(ROOT)).length<=1){
    for(const name of await caches.keys())if(name.startsWith(PREFIX)&&name!==CACHE)await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')event.waitUntil(self.skipWaiting());});
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==new URL(ROOT).origin||!url.href.startsWith(ROOT))return;
  if(req.mode==='navigate'&&(url.pathname===new URL(ROOT).pathname||url.pathname===new URL('index.html',ROOT).pathname)){
    event.respondWith(caches.open(CACHE).then(c=>c.match(new URL('index.html',ROOT).href)));return;
  }
  // Only precached build artifacts are read. User files never enter Cache Storage.
  event.respondWith((async()=>{
    const current=await caches.open(CACHE), found=await current.match(req);if(found)return found;
    for(const name of await caches.keys())if(name.startsWith(PREFIX)){const older=await (await caches.open(name)).match(req);if(older)return older;}
    return fetch(req);
  })());
});
`,
      );
    },
  };
}
export default defineConfig({
  plugins: [react(), offlineBundle()],
  base: "./",
});
