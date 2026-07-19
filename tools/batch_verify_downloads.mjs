import { basename, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass one or more image paths");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";
const outputDir = process.env.OUTPUT_DIR || "evaluation/download-batch";
await mkdir(outputDir, { recursive:true });
const rows = [];

for (const [index,file] of files.entries()) {
  const slug = `${String(index+1).padStart(2,"0")}-${basename(file).replace(/\.[^.]+$/,"").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").slice(0,70)}`;
  process.stdout.write(`[${index+1}/${files.length}] ${basename(file)}\n`);
  const image = `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
  let analysis;
  try {
    const response = await fetch(`${baseUrl}/api/analyze`, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({image,provider:"ollama",detailed:true})});
    analysis = await response.json();
    await writeFile(join(outputDir,`${slug}.json`),JSON.stringify(analysis,null,2));
    const row = {index:index+1,file,family:analysis.classification?.family||analysis.documentType||"unknown",valid:analysis.geometryValidation?.valid===true,stepEligible:analysis.stepEligible===true,featureOperations:(analysis.features||[]).map(feature=>feature.operation),errors:analysis.geometryValidation?.errors||[],step:null};
    if (response.ok && row.stepEligible) {
      const exported = await fetch(`${baseUrl}/api/export-step`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(analysis)});
      if (exported.ok) {
        row.step = join(outputDir,`${slug}.step`);
        await writeFile(row.step,Buffer.from(await exported.arrayBuffer()));
      } else row.errors.push(`STEP export: ${JSON.stringify(await exported.json())}`);
    }
    rows.push(row);
    process.stdout.write(`  ${row.family} | valid=${row.valid} | step=${Boolean(row.step)} | ${row.featureOperations.join(",")||"no features"}\n`);
  } catch (error) {
    rows.push({index:index+1,file,family:"request_error",valid:false,stepEligible:false,featureOperations:[],errors:[error.message],step:null});
    process.stdout.write(`  request_error | ${error.message}\n`);
  }
}
await writeFile(join(outputDir,"summary.json"),JSON.stringify(rows,null,2));
console.log(JSON.stringify(rows,null,2));
