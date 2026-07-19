import { readdir, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
process.env.NODE_ENV = "test";
const { server } = await import("../server.mjs");
const downloads = "C:/Users/rfrantzesk/Downloads";
const outRoot = new URL("../evaluation/", import.meta.url);
await mkdir(outRoot, { recursive: true });
const today = new Date();
const entries = await readdir(downloads, { withFileTypes: true });
const images = [];
for (const entry of entries) {
  if (!entry.isFile() || !/[.](png|jpg|jpeg|webp)$/i.test(entry.name)) continue;
  const match = entry.name.match(/2026-07-16 at 20-(11|12)-/);
  if (match) images.push(join(downloads, entry.name));
}
images.sort();
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const results = [];
for (let index = 0; index < images.length; index++) {
  const source = images[index]; const id = `${String(index + 1).padStart(2,"0")}-${basename(source, extname(source)).replace(/[^a-z0-9]+/gi,"-").slice(0,55)}`;
  const dir = new URL(`${id}/`, outRoot); await mkdir(dir, { recursive: true });
  const bytes = await readFile(source); const localSource = new URL(`source${extname(source).toLowerCase()}`, dir); await copyFile(source, localSource);
  const started = Date.now(); let analysis, status;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/local/analyze-ai`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({image:bytes.toString("base64")}) });
    analysis = await response.json(); status = response.status;
  } catch (error) { analysis = { error:error.message }; status = 0; }
  await writeFile(new URL("analysis.json", dir), JSON.stringify(analysis, null, 2));
  results.push({ id, source, dir:new URL(dir).pathname, status, seconds:Math.round((Date.now()-started)/1000), family:analysis.classification?.family||null, confidence:analysis.classification?.confidence||0, features:analysis.features?.map(f=>f.operation)||[], error:analysis.error||null });
  console.log(`${index+1}/${images.length} ${id}: ${results.at(-1).family||"failed"} [${results.at(-1).features.join(",")}] ${results.at(-1).seconds}s`);
}
await writeFile(new URL("batch-results.json", outRoot), JSON.stringify(results,null,2));
server.closeAllConnections(); server.close();
