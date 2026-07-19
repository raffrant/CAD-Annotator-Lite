import { mkdir, readFile, writeFile } from "node:fs/promises";

const source = process.argv[2];
if (!source) throw new Error("Usage: node tools/verify_tray_bracket.mjs drawing.png");
const image = `data:image/png;base64,${(await readFile(source)).toString("base64")}`;
const response = await fetch(`${process.env.BASE_URL || "http://127.0.0.1:8080"}/api/analyze`, {
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({image,provider:"ollama",detailed:true}),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (process.env.OUTPUT_DIR && response.ok) {
  await mkdir(process.env.OUTPUT_DIR, { recursive:true });
  const prefix = process.env.OUTPUT_PREFIX || "tray-bracket";
  await writeFile(`${process.env.OUTPUT_DIR}/${prefix}-geometry.json`, JSON.stringify(result, null, 2));
  const stepResponse = await fetch(`${process.env.BASE_URL || "http://127.0.0.1:8080"}/api/export-step`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(result) });
  if (!stepResponse.ok) throw new Error(`STEP export failed: ${JSON.stringify(await stepResponse.json())}`);
  await writeFile(`${process.env.OUTPUT_DIR}/${prefix}.step`, Buffer.from(await stepResponse.arrayBuffer()));
}
const expectedFamily = process.env.EXPECTED_FAMILY || "tray_bracket";
const validExpected = expectedFamily === "tray_bracket"
  ? result.features?.[0]?.operation === "tray_bracket" && result.geometryValidation?.valid === true
  : expectedFamily === "gusset_bracket"
    ? result.features?.[0]?.operation === "gusset_bracket" && result.geometryValidation?.valid === true
  : expectedFamily === "fork_plate"
    ? result.features?.[0]?.operation === "fork_plate" && result.geometryValidation?.valid === true
  : expectedFamily === "hvac_plan"
    ? result.features?.length === 0 && result.stepEligible === false
    : true;
if (!response.ok || result.classification?.family !== expectedFamily || !validExpected) process.exitCode = 1;
