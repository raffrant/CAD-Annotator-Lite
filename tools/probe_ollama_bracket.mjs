import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const source = resolve(process.argv[2] || "");
if (!source) throw new Error("Usage: node tools/probe_ollama_bracket.mjs drawing.png");
const image = (await readFile(source)).toString("base64");
const model = process.env.OLLAMA_MODEL || "qwen3-vl:4b";
const prompt = `Read this mechanical drawing sheet, using all orthographic views and the isometric view as evidence for ONE part. Decide whether it is an open rectangular tray bracket made from three thick perpendicular panels: a horizontal base, a vertical back panel, and a vertical right end panel. Read printed dimensions instead of estimating them. Return JSON only:
{"family":"tray_bracket|other","overallWidth":0,"overallDepth":0,"overallHeight":0,"wallThickness":0,"baseThickness":0,"holeDiameter":0,"backHoleCount":0,"sideHoleCount":0,"backHolePitch":0,"leftBackHoleOffset":0,"rightBackHoleToInnerWall":0,"holeFromInnerBase":0,"sideHoleFromInnerBack":0,"innerRadius":0,"chamferSize":0,"chamferAngle":0,"holeCount":0,"evidence":[""]}.
Read each printed dimension chain carefully; do not invent center coordinates. Distances named "inner" start after the 10 mm wall/base. Zero is forbidden for every size. The drawing may state 3 HOLES diameter 12, overall 75 by 40 by 40, wall/base thickness 10, 35 hole pitch, 15 offsets, R3 typical, and 3x45 degree chamfers; use those only if visibly confirmed. Count which visible wall contains each hole: the long back wall has two and the right end wall has one.`;
const response = await fetch("http://127.0.0.1:11434/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, stream: false, format: "json", think: false, options: { temperature: 0, num_predict: 1800 }, messages: [{ role: "user", content: prompt, images: [image] }] }),
});
if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
const value = await response.json();
console.log(value.message?.content || value.message?.thinking || "{}");
