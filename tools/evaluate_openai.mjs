import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { analyzeWithOpenAI } from "../lib/openai-cad.mjs";

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) throw new Error("Usage: node tools/evaluate_openai.mjs input.png output.json");
const source = resolve(sourceArg);
const target = resolve(targetArg);
const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(source).toLowerCase()];
if (!mime) throw new Error("Input must be PNG, JPG, JPEG, or WEBP.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
const imageDataUrl = `data:${mime};base64,${(await readFile(source)).toString("base64")}`;
const result = await analyzeWithOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  model: process.env.OPENAI_MODEL || "gpt-5.6",
  imageDataUrl,
  detailed: true,
});
await writeFile(target, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ target, valid: result.geometryValidation.valid, features: result.geometryValidation.featureCount, solids: result.geometryValidation.solidCount, model: result.engine.model }));
