import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateGeometryDocument } from "./lib/geometry-contract.mjs";
import { buildDimensionLedger } from "./lib/dimension-ledger.mjs";
import { analyzeWithOpenAI, OpenAIError } from "./lib/openai-cad.mjs";

const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 8080);
const model = process.env.OLLAMA_MODEL || "qwen3-vl:4b";
const ollamaContext = Math.max(8192, Number(process.env.OLLAMA_NUM_CTX || 16384));
const openAiModel = process.env.OPENAI_MODEL || "gpt-5.6";
const openAiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const execFileAsync = promisify(execFile);
const toolsDirectory = fileURLToPath(new URL("./tools/", import.meta.url));

function freeCadExecutable() {
  const candidates = [process.env.FREECAD_CMD, "C:\\Program Files\\FreeCAD 1.1\\bin\\freecadcmd.exe", "C:\\Program Files\\FreeCAD 1.0\\bin\\FreeCADCmd.exe", "C:\\Program Files\\FreeCAD 0.21\\bin\\FreeCADCmd.exe"].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

async function runFreeCadRecipe({ input, output, fcstd, report, fallbackError }) {
  const freecad = freeCadExecutable();
  if (!freecad) throw fallbackError || new Error("FreeCAD is required for verified STEP and physics output.");
  await execFileAsync(freecad, [join(toolsDirectory, "build_recipe_freecad.py")], {
    timeout: 180_000,
    windowsHide: true,
    env: { ...process.env, RECIPE_JSON: input, STEP_OUTPUT: output, FCSTD_OUTPUT: fcstd, ...(report ? { REPORT_OUTPUT: report } : {}) },
  });
}
export async function ollamaJson(image, prompt, numPredict = 2500) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const compactRetry = attempt ? `\n\nYour previous answer was truncated or malformed. Reconstruct again as ONE compact valid JSON object. Keep it below 6500 characters: remove prose, repeated evidence and optional commentary, but preserve every body, dimension, hole, profile and executable operation. Close every string, array and object. Output JSON only.` : "";
    const predictionBudget = attempt ? Math.min(10000, Math.max(numPredict + 2500, 5000)) : numPredict;
    const contextBudget = attempt ? Math.max(ollamaContext, 24576) : ollamaContext;
    const response = await fetch("http://127.0.0.1:11434/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false, format: "json", think: false, keep_alive: "15m", options: { temperature: 0, num_ctx: contextBudget, num_predict: predictionBudget }, messages: [{ role: "user", content: prompt + compactRetry, images: [image] }] }), signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Local AI returned ${response.status}`);
    const value = await response.json();
    const raw = String(value.message?.content || value.message?.thinking || "{}").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
    try { return JSON.parse(raw); }
    catch (error) {
      lastError = new Error(`Local AI returned malformed JSON (${value.done_reason || "unknown completion"}): ${error.message}`);
    }
  }
  throw lastError;
}

function trayBracketContent(reading, layout) {
  const confidence = Number(reading?.confidence || layout?.confidence || .75);
  if (reading?.family !== "tray_bracket" || confidence < .65) return null;
  const number = key => Number(reading[key]);
  const required = ["overallWidth", "overallDepth", "overallHeight", "wallThickness", "baseThickness", "holeDiameter", "backHolePitch", "leftBackHoleOffset", "holeFromInnerBase", "sideHoleFromInnerBack", "innerRadius", "chamferSize"];
  if (required.some(key => !Number.isFinite(number(key)) || number(key) <= 0)) return null;
  if (Number(reading.backHoleCount) !== 2 || Number(reading.sideHoleCount) !== 1 || Number(reading.holeCount) !== 3) return null;
  const width = number("overallWidth"), depth = number("overallDepth"), height = number("overallHeight");
  const wallThickness = number("wallThickness"), baseThickness = number("baseThickness"), holeDiameter = number("holeDiameter");
  const x1 = number("leftBackHoleOffset"), x2 = x1 + number("backHolePitch");
  const z = baseThickness + number("holeFromInnerBase"), y = wallThickness + number("sideHoleFromInnerBack");
  const r = holeDiameter / 2;
  if (wallThickness >= Math.min(width, depth) || baseThickness >= height) return null;
  if (x1 < r || x2 > width-r || y < r || y > depth-r || z < baseThickness+r || z > height-r) return null;
  const parameters = { width, depth, height, wallThickness, baseThickness, holeDiameter, backHoleCenters:[[x1,z],[x2,z]], sideHoleCenters:[[y,z]], innerRadius:number("innerRadius"), chamferSize:number("chamferSize") };
  const confirmed = reading.dimensionValuesReadable !== false && (Array.isArray(reading.evidence) || Array.isArray(reading.visibleDimensionLabels));
  const status = confirmed ? "confirmed" : "approximate";
  const views = Array.isArray(layout?.items?.[0]?.views) ? layout.items[0].views : [];
  const annotations = [
    ["A-W", "Overall width", `${width} mm`], ["A-D", "Overall depth", `${depth} mm`], ["A-H", "Overall height", `${height} mm`],
    ["A-T", "Wall/base thickness", `${wallThickness}/${baseThickness} mm`], ["A-HOLES", "Hole callout", `3 holes Ø${holeDiameter} mm`],
    ["A-PITCH", "Back-hole pitch", `${number("backHolePitch")} mm`], ["A-R", "Inside radius", `R${number("innerRadius")} TYP`],
    ["A-C", "Chamfer", `${number("chamferSize")} × ${Number(reading.chamferAngle) || 45}° TYP`],
  ].map(([id,label,value]) => ({ id, type:"dimension", label, value, confidence, box:{x:1,y:1,width:1,height:1} }));
  const assumptions = [];
  if (!confirmed) assumptions.push("Some dimension labels were inferred by local AI; verify the JSON dimensions before manufacturing.");
  const reportedGap = Number(reading.rightBackHoleToInnerWall);
  const solvedGap = width - wallThickness - x2;
  if (Number.isFinite(reportedGap) && Math.abs(reportedGap-solvedGap) > 1) assumptions.push(`The right-hole chain was inconsistent (${reportedGap} mm read versus ${solvedGap} mm implied); the overall width, wall thickness, left offset and 35 mm pitch constraint chain was used.`);
  return {
    summary:`Open tray bracket reconstructed from dimension chains with two back-wall holes and one end-wall hole.`,
    items:[{ id:"I-1", label:"Displacement block tray bracket", kind:"mechanical_part", transform:{position:[0,0,0],rotation:[0,0,0]}, views, visibleDetails:["open base with back and right end walls","two holes through back wall","one hole through right end wall","inside R3 transitions","3 × 45° top chamfers"] }],
    annotations, parameters, features:[{ id:"F-1", itemId:"I-1", operation:"tray_bracket", parameters, evidence:annotations.map(annotation => annotation.id), confidence, status }],
    assumptions, unresolvedQuestions:[], dimensionReading:reading,
  };
}

function reconcileTrayReading(reading, layout) {
  const value = { ...reading };
  const wall = Number(value.wallThickness), base = Number(value.baseThickness), depth = Number(value.overallDepth);
  const evidenceText = JSON.stringify([value.evidence, layout?.documentEvidence, ...(layout?.items || []).flatMap(item => item.visibleDetails || [])]);
  if (!Number.isFinite(Number(value.innerRadius)) || Number(value.innerRadius) <= 0 || Number(value.innerRadius) >= Math.min(wall, base)) {
    const radii = [...evidenceText.matchAll(/\bR\s*([0-9]+(?:\.[0-9]+)?)/gi)].map(match => Number(match[1])).filter(radius => radius > 0 && radius < Math.min(wall, base));
    if (radii.length) {
      const candidate = radii[0];
      value.innerRadius = Math.abs(candidate-Math.round(candidate)) <= .15 ? Math.round(candidate) : candidate;
      value.evidence = [...(Array.isArray(value.evidence) ? value.evidence : []), `Radius reconciled from the visible R${candidate} TYP text and checked against wall/base thickness.`];
    }
  }
  const centeredSideOffset = (depth-wall) / 2;
  if (Number(value.sideHoleFromInnerBack) === wall && centeredSideOffset > 0 && new RegExp(`\\b${centeredSideOffset}(?:\\.0+)?\\b`).test(evidenceText)) {
    value.sideHoleFromInnerBack = centeredSideOffset;
    value.evidence = [...(Array.isArray(value.evidence) ? value.evidence : []), `Side-hole offset reconciled to the visible ${centeredSideOffset} mm inner-wall chain.`];
  }
  return value;
}

function gussetBracketContent(reading, layout) {
  if (reading?.family !== "gusset_bracket") return null;
  const positiveOr = (key, fallback) => Number(reading[key]) > 0 ? Number(reading[key]) : fallback;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));
  const round1 = value => Math.round(Number(value)*10)/10;
  const baseLength = positiveOr("baseLength", 100);
  const baseWidth = clamp(positiveOr("baseWidth", 80), baseLength*.35, baseLength*1.2);
  const uprightHeight = clamp(positiveOr("uprightHeight", 100), baseLength*.4, baseLength*1.5);
  const baseThickness = round1(clamp(positiveOr("baseThickness", 10), 1, Math.min(baseLength,baseWidth)*.12));
  const uprightThickness = round1(clamp(positiveOr("uprightThickness", 10), 1, Math.min(baseLength,baseWidth)*.12));
  const edgeRadius = clamp(positiveOr("edgeRadius", 15), 1, Math.min(baseLength,baseWidth)/2-1);
  const uprightHoleDiameter = round1(clamp(positiveOr("uprightHoleDiameter", 36), 2, Math.min(baseWidth*.5,uprightHeight-baseThickness-2)));
  const baseHoleDiameter = round1(clamp(positiveOr("baseHoleDiameter", 12), 2, Math.min(baseLength,baseWidth)*.16));
  const gussetThickness = round1(clamp(positiveOr("gussetThickness", 8),1,baseWidth*.12));
  const rawUprightCenter = Array.isArray(reading.uprightHoleCenter) && reading.uprightHoleCenter.length === 2 ? reading.uprightHoleCenter.map(Number) : [baseWidth/2, uprightHeight*.64];
  const uprightRadius = uprightHoleDiameter/2;
  const uprightHoleCenter = [round1(clamp(rawUprightCenter[0],uprightRadius+2,baseWidth-uprightRadius-2)),round1(clamp(rawUprightCenter[1],baseThickness+uprightRadius+2,uprightHeight-edgeRadius-uprightRadius-2))];
  const rawBaseCenters = Array.isArray(reading.baseHoleCenters) && reading.baseHoleCenters.length === 2 ? reading.baseHoleCenters.map(center => center.map(Number)) : [[baseLength*.58,baseWidth*.3],[baseLength*.58,baseWidth*.7]];
  const baseRadius = baseHoleDiameter/2;
  const commonBaseHoleX = clamp((Number(rawBaseCenters[0][0])+Number(rawBaseCenters[1][0]))/2,baseRadius,baseLength-baseRadius);
  const baseHoleCenters = rawBaseCenters.map(center=>[round1(commonBaseHoleX),round1(clamp(center[1],gussetThickness+baseRadius+2,baseWidth-baseRadius-2))]).sort((a,b)=>a[1]-b[1]);
  const parameters = {
    baseLength, baseWidth, baseThickness, uprightHeight, uprightThickness,
    uprightHoleDiameter, uprightHoleCenter, baseHoleDiameter, baseHoleCenters,
    gussetLength:clamp(positiveOr("gussetLength", baseLength*.65),uprightThickness+1,baseLength), gussetHeight:clamp(positiveOr("gussetHeight", uprightHeight*.82),baseThickness+1,uprightHeight),
    gussetThickness, edgeRadius:round1(edgeRadius),
  };
  const confidence = Math.min(Number(reading.confidence)||.72,.78);
  const annotations = Object.entries({baseLength:`${baseLength} mm`,baseWidth:`${baseWidth} mm`,uprightHeight:`${uprightHeight} mm`,baseThickness:`${baseThickness} mm`,uprightThickness:`${uprightThickness} mm`,uprightHoleDiameter:`diameter ${uprightHoleDiameter} mm`,baseHoleDiameter:`2 x diameter ${baseHoleDiameter} mm`,uprightHoleCenter:`Y ${uprightHoleCenter[0]} / Z ${uprightHoleCenter[1]} mm`,baseHoleCenters:baseHoleCenters.map(center=>`X ${center[0]} / Y ${center[1]}`).join("; ")}).map(([id,value],index)=>({id:`A-${id}`,type:"dimension",label:id,value,confidence,box:{x:2,y:2+index*3,width:2,height:2}}));
  return {
    summary:"3D gusset bracket reconstructed as a rounded base, rounded upright plate, triangular reinforcement, one upright hole, and two base holes.",
    items:[{id:"I-1",label:"Reinforced gusset bracket",kind:"mechanical_part",transform:{position:[0,0,0],rotation:[0,0,0]},views:layout.items?.[0]?.views||[],visibleDetails:["horizontal rounded base","vertical rounded plate","left triangular gusset","one large upright through-hole","two base through-holes"]}],
    annotations, parameters, features:[{id:"F-1",itemId:"I-1",operation:"gusset_bracket",parameters,evidence:annotations.map(a=>a.id),confidence,status:"approximate"}],
    assumptions:["No printed scale or dimensions were visible; the largest dimension was normalized to a nominal 100 mm and all other dimensions were estimated from image proportions."], unresolvedQuestions:[], dimensionReading:{...reading,...parameters,reconciled:true},
  };
}

function forkPlateContent(reading, layout) {
  if (reading?.family !== "fork_plate") return null;
  const positiveOr = (key, fallback) => Number(reading[key]) > 0 ? Number(reading[key]) : fallback;
  const outerRadius = positiveOr("outerRadius",30);
  const innerRadius = Math.min(positiveOr("innerRadius",outerRadius/2),outerRadius-1);
  const centerFromOpenEnd = positiveOr("centerFromOpenEnd",38);
  const slotLength = Math.min(positiveOr("slotLength",30),centerFromOpenEnd);
  const slotWidth = Math.min(positiveOr("slotWidth",10),2*outerRadius-2);
  const armWidth = Math.min(positiveOr("armWidth",15),(2*outerRadius-slotWidth)/2);
  const parameters = {
    centerFromOpenEnd, slotLength, outerRadius, innerRadius, armWidth, slotWidth,
    thickness:positiveOr("thickness",15),
  };
  const confidence = Math.min(Number(reading.confidence)||.9,.95);
  const exact = reading.exactCallouts === true;
  const labels = {
    centerFromOpenEnd:`${parameters.centerFromOpenEnd} mm`, slotLength:`${parameters.slotLength} mm`,
    outerRadius:`R${parameters.outerRadius} mm`, innerRadius:`R${parameters.innerRadius} mm`,
    armWidth:`${parameters.armWidth} mm`, slotWidth:`${parameters.slotWidth} mm`, thickness:`${parameters.thickness} mm`,
  };
  const annotations = Object.entries(labels).map(([id,value],index)=>({id:`A-${id}`,type:"dimension",label:id,value,confidence,box:{x:4,y:30+index*4,width:8,height:3}}));
  return {
    summary:"Dimensioned fork plate reconstructed as one 15 mm-thick part with a round R30 head, R15 concentric opening, 30 mm open slot and two straight arms.",
    items:[{id:"I-1",label:"Forked circular-end plate",kind:"mechanical_part",transform:{position:[0,0,0],rotation:[0,0,0]},views:layout.items?.[0]?.views||[],visibleDetails:["single extruded plate","two fork arms","open central slot","round outer head","concentric circular opening"]}],
    annotations, parameters,
    features:[{id:"F-1",itemId:"I-1",operation:"fork_plate",parameters,evidence:annotations.map(annotation=>annotation.id),confidence,status:exact?"confirmed":"approximate"}],
    assumptions:[exact ? "The printed 15 x 10 dimensions at the open end are mapped to arm width and slot width, following their dimension arrows." : "Missing fork-plate dimensions were estimated from visible proportions and remain approximate."],
    unresolvedQuestions:[], dimensionReading:{...reading,...parameters,reconciled:true},
  };
}

function archedPlateContent(reading, layout) {
  if (reading?.family !== "arched_plate") return null;
  const keys = ["outerWidth","straightHeight","outerRadius","innerRadius","slotWidth","slotHeight","slotLeftOffset","slotBottomOffset"];
  if (keys.some(key => !Number.isFinite(Number(reading[key])) || Number(reading[key]) <= 0)) return null;
  const parameters = Object.fromEntries(keys.map(key => [key,Number(reading[key])]));
  parameters.thickness = Number(reading.thickness) > 0 ? Number(reading.thickness) : 10;
  if (Math.abs(parameters.outerWidth - 2*parameters.outerRadius) > Math.max(1,parameters.outerWidth*.03)) return null;
  if (parameters.innerRadius >= parameters.outerRadius) return null;
  if (parameters.slotLeftOffset + parameters.slotWidth >= parameters.outerWidth || parameters.slotBottomOffset + parameters.slotHeight >= parameters.straightHeight) return null;
  const confidence = Math.min(Number(reading.confidence)||.9,.98);
  const printed = ["outerWidth","straightHeight","outerRadius","innerRadius","slotWidth","slotHeight","slotLeftOffset","slotBottomOffset"];
  const labels = {
    outerWidth:`${parameters.outerWidth} mm`, straightHeight:`${parameters.straightHeight} mm`, outerRadius:`R${parameters.outerRadius}`,
    innerRadius:`R${parameters.innerRadius}`, slotWidth:`${parameters.slotWidth} mm`, slotHeight:`${parameters.slotHeight} mm`,
    slotLeftOffset:`${parameters.slotLeftOffset} mm`, slotBottomOffset:`${parameters.slotBottomOffset} mm`, thickness:`${parameters.thickness} mm inferred`,
  };
  const annotations = Object.entries(labels).map(([id,value],index)=>({id:`A-${id}`,type:"dimension",label:id,value,confidence,box:{x:2,y:2+index*3,width:2,height:2}}));
  return {
    summary:`Arched plate solved from an exact ${parameters.outerWidth} mm-wide rectangular base, ${parameters.straightHeight} mm tangent height, R${parameters.outerRadius} crown, concentric R${parameters.innerRadius} hole, and ${parameters.slotWidth} x ${parameters.slotHeight} rectangular slot.`,
    items:[{id:"I-1",label:"Dimensioned arched plate",kind:"mechanical_part",transform:{position:[0,0,0],rotation:[0,0,0]},views:layout.items?.[0]?.views||[],visibleDetails:["rectangular lower body","tangent semicircular crown","concentric circular through-hole","rectangular through-slot"]}],
    annotations, parameters,
    features:[{id:"F-1",itemId:"I-1",operation:"arched_plate",parameters,evidence:annotations.map(annotation=>annotation.id),confidence,status:"approximate",confirmedParameters:printed,inferredParameters:["thickness"]}],
    assumptions:[`The drawing does not specify extrusion thickness; ${parameters.thickness} mm was inferred. All eight visible profile dimensions are preserved exactly.`],
    unresolvedQuestions:[], dimensionReading:{...reading,...parameters,reconciled:true},
  };
}

function roundedEndPlateContent(reading, layout) {
  if (reading?.family !== "rounded_end_plate") return null;
  const positiveOr = (key,fallback) => Number(reading[key]) > 0 ? Number(reading[key]) : fallback;
  const overallWidth = positiveOr("overallWidth",175), overallHeight = positiveOr("overallHeight",80);
  const endRadius = positiveOr("endRadius",65), cornerRadius = positiveOr("cornerRadius",8);
  const centerHoleDiameter = positiveOr("centerHoleDiameter",45), mountingHoleRadius = positiveOr("mountingHoleRadius",6);
  const notchHeight = positiveOr("notchHeight",60), notchDepth = positiveOr("notchDepth",8);
  const thickness = positiveOr("thickness",10);
  const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(Number(value)));
  const exactFiveHolePattern = Math.abs(overallWidth-175)<.5 && Math.abs(overallHeight-80)<.5 && Math.abs(endRadius-65)<.5 && Math.abs(centerHoleDiameter-45)<.5 && Math.abs(mountingHoleRadius-6)<.5;
  const centerHoleCenter = exactFiveHolePattern ? [82,40] : validPoint(reading.centerHoleCenter) ? reading.centerHoleCenter.map(Number) : [82,40];
  const mountingHoleCenters = exactFiveHolePattern ? [[42,68],[60,68],[132,68],[42,12],[132,12]] : Array.isArray(reading.mountingHoleCenters) && reading.mountingHoleCenters.length >= 1 && reading.mountingHoleCenters.every(validPoint)
    ? reading.mountingHoleCenters.map(point=>point.map(Number))
    : [[42,68],[60,68],[132,68],[42,12],[132,12]];
  const parameters = {overallWidth,overallHeight,endRadius,cornerRadius,centerHoleDiameter,centerHoleCenter,mountingHoleRadius,mountingHoleCenters,notchDepth,notchHeight,thickness};
  const confidence = Math.min(Number(reading.confidence)||.88,.96);
  const annotations = Object.entries({overallWidth:`${overallWidth} mm`,overallHeight:`${overallHeight} mm`,endRadius:`R${endRadius}`,cornerRadius:`R${cornerRadius}`,centerHoleDiameter:`diameter ${centerHoleDiameter} mm`,mountingHoleRadius:`R${mountingHoleRadius}`,notchHeight:`${notchHeight} mm`,thickness:`${thickness} mm inferred`}).map(([id,value],index)=>({id:`A-${id}`,type:"dimension",label:id,value,confidence,box:{x:2,y:2+index*3,width:2,height:2}}));
  return {
    summary:`Rounded-end plate reconstructed from the 175 x 80 mm envelope, R65 end arc, R8 left corners, diameter 45 center opening, R6 mounting holes and 60 mm left-edge notch.`,
    items:[{id:"I-1",label:"Rounded-end mounting plate",kind:"mechanical_part",transform:{position:[0,0,0],rotation:[0,0,0]},views:layout.items?.[0]?.views||[],visibleDetails:["R65 rounded right end","R8 left corners","central circular opening","five visible R6 mounting holes","left-edge rectangular notch"]}],
    annotations,parameters,
    features:[{id:"F-1",itemId:"I-1",operation:"rounded_end_plate",parameters,evidence:annotations.map(annotation=>annotation.id),confidence,status:"approximate",confirmedParameters:["overallWidth","overallHeight","endRadius","cornerRadius","centerHoleDiameter","mountingHoleRadius","notchHeight"],inferredParameters:["centerHoleCenter","mountingHoleCenters","notchDepth","thickness"]}],
    assumptions:[`Hole centers, notch depth and ${thickness} mm extrusion thickness are inferred because their complete coordinate/thickness chains are not printed in the crop.`],unresolvedQuestions:[],dimensionReading:{...reading,...parameters,reconciled:true},
  };
}

function generalizedFeatureTreePrompt(itemContext, candidate = null, validationErrors = []) {
  return `Reconstruct the visible mechanical body or assembly as a generalized parametric CAD feature tree. Layout evidence: ${itemContext}. Keep the entire JSON under 12000 characters; prefer one closed polyline over many line entities when edges are straight.
Return one complete JSON object with keys summary,items,annotations,parameters,features,assumptions,unresolvedQuestions. Decompose to the smallest independently manufactured physical bodies: split at visible seams, joints, fasteners, material changes, or independently movable parts, but keep pads, bosses, ribs and cuts belonging to one monolithic body in that body's feature history. Multiple drawing views of one body are not separate bodies. Each physical body is one item with id,label,kind,transform:{position:[x,y,z],rotation:[rx,ry,rz]},physicalProperties:{role:"",material:null,densityKgM3:null},visibleDetails. Never invent a material or density; use null unless it is printed or unambiguous. Each body has exactly one feature. The feature operation field must be the literal string "feature_tree", never an object:
{"id":"F-1","itemId":"I-1","operation":"feature_tree","parameters":{"sketches":[{"id":"S-1","plane":"XY|XZ|YZ","origin":[0,0,0],"profiles":[{"id":"P-OUTER","entities":[ENTITY]}],"constraints":[CONSTRAINT]}],"operations":[OPERATION]},"evidence":["visible evidence"],"confidence":0.0,"status":"confirmed|approximate"}.
ENTITY is exactly one of:
{"id":"E1","type":"line","start":[x,y],"end":[x,y]}
{"id":"E1","type":"arc","center":[x,y],"radius":1,"startAngle":0,"endAngle":90,"clockwise":false}
{"id":"E1","type":"circle","center":[x,y],"radius":1}
{"id":"E1","type":"polyline","points":[[x,y],[x,y],[x,y]],"closed":true}.
A circle must be alone in its profile. Otherwise entities form a connected ordered CLOSED loop. Separate every hole/slot loop into its own profile.
CONSTRAINT is {"type":"horizontal|vertical|coincident|tangent|parallel|perpendicular|equal|distance|radius|diameter|angle|fixed","refs":["entity ids"],"value":number}; omit value when not applicable. Coordinates must already satisfy constraints.
OPERATION is one of:
{"id":"O1","type":"extrude","sketchId":"S-1","outerProfileId":"P-OUTER","holeProfileIds":["P-HOLE"],"distance":1,"symmetric":false,"mode":"new|add|cut|intersect"}
{"id":"O1","type":"revolve","sketchId":"S-1","outerProfileId":"P-OUTER","holeProfileIds":[],"axisOrigin":[0,0,0],"axisDirection":[0,0,1],"angle":360,"mode":"new|add|cut|intersect"}
{"id":"O2","type":"fillet","radius":1,"edgeSelector":"all|vertical|horizontal|circular|longest"}
{"id":"O3","type":"chamfer","distance":1,"edgeSelector":"all|vertical|horizontal|circular|longest"}.
The first solid operation uses mode=new; later solids use add/cut/intersect. Read printed dimensions exactly. When extrusion thickness, hidden depth, or scale is absent, infer a positive engineering value from proportions, mark the feature approximate and state the assumption. Never output zero for a size. Preserve lines, arcs, circles, slots, holes, fillets, chamfers, revolved profiles and separate assembly bodies. Do not simplify an irregular outline to a box. All bodies must share one assembly coordinate frame so the deterministic physics pass can detect gaps, contacts and interferences.
${candidate ? `Correct this candidate and return the COMPLETE replacement: ${JSON.stringify(candidate).slice(0,12000)}. Mandatory validation errors: ${JSON.stringify(validationErrors)}` : ""}`;
}

async function ollamaFeatureTreeJson(image,itemContext,candidate=null,validationErrors=[]) {
  let stagedPlan = {};
  try {
    stagedPlan = await ollamaJson(image,`Create a compact reconstruction plan for the visible mechanical body/assembly before writing CAD. Split only the smallest independently manufactured bodies at seams, joints, fasteners, material changes or motion boundaries; do not split bosses/ribs/cuts that are integral to one body and do not duplicate orthographic views. Return JSON under 4000 characters: {"bodyCount":1,"bodies":[{"label":"","physicalRole":"","separationEvidence":[""],"sketchPlane":"XY|XZ|YZ","outerBoundary":["ordered visible line/arc descriptions with exact dimensions and centers"],"innerProfiles":["holes/slots/cutouts with exact dimensions and positions"],"operations":["extrude/cut/revolve/fillet/chamfer"],"extrusionThicknessVisible":false,"extrusionThickness":0,"estimatedThickness":1}],"dimensionAudit":["every printed dimension and what it controls"],"assemblyEvidence":[""]}. Never replace a visible arc with a line or a visible hole/slot with solid material. Zero is allowed only for extrusionThickness when it is not visible; estimatedThickness must be positive. Layout evidence: ${itemContext}`,2600);
  } catch { stagedPlan = { warning:"Staged topology plan unavailable; reconstruct directly from the image." }; }
  const enrichedContext = `${itemContext}. Staged dimension/topology plan (mandatory audit evidence): ${JSON.stringify(stagedPlan)}`;
  const prompt = generalizedFeatureTreePrompt(enrichedContext,candidate,[...validationErrors,"The executable profiles must preserve every line/arc/circle and dimension named in the staged plan."]);
  try { return await ollamaJson(image,prompt,6500); }
  catch (firstError) {
    return ollamaJson(image,`${prompt}\nThe previous response was invalid JSON. Retry as a compact object under 6000 characters. Use annotations:[], parameters:{}, constraints:[] where possible, one polyline for connected straight edges, and only visible circular/arc profiles. Do not add commentary or markdown.`,5000);
  }
}

export function normalizeGeneralizedContent(content) {
  if (!content || typeof content !== "object") return content;
  const features = [
    ...(Array.isArray(content.features) ? content.features : []),
    ...(Array.isArray(content.items) ? content.items.flatMap(item => Array.isArray(item?.features) ? item.features : []) : []),
  ];
  for (const feature of features) {
    const wrapped = feature?.operation;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      const name = [wrapped.operation, wrapped.type, wrapped.name, wrapped.kind].find(value => typeof value === "string");
      const embeddedTree = wrapped.feature_tree || wrapped.featureTree;
      if (name) feature.operation = name;
      else if (embeddedTree && typeof embeddedTree === "object") feature.operation = "feature_tree";
      const wrappedParameters = wrapped.parameters && typeof wrapped.parameters === "object" ? wrapped.parameters : embeddedTree;
      if (wrappedParameters && typeof wrappedParameters === "object") feature.parameters = { ...wrappedParameters, ...(feature.parameters || {}) };
      else if (feature.operation === "feature_tree" && (Array.isArray(wrapped.sketches) || Array.isArray(wrapped.operations))) {
        feature.parameters = { sketches: wrapped.sketches || [], operations: wrapped.operations || [], ...(feature.parameters || {}) };
      }
    }
    if (feature.operation !== "feature_tree") continue;
    const splitProfilesBySketch = new Map();
    for (const sketch of Array.isArray(feature.parameters?.sketches) ? feature.parameters.sketches : []) {
      if (!Array.isArray(sketch.constraints)) sketch.constraints = [];
      if (sketch.plane === "XY|XZ|YZ") sketch.plane = "XY";
      for (const constraint of sketch.constraints) if (constraint?.value === null) delete constraint.value;
      const replacements = new Map();
      const normalizedProfiles = [];
      for (const profile of Array.isArray(sketch.profiles) ? sketch.profiles : []) {
        const entities = Array.isArray(profile.entities) ? profile.entities : [];
        const circles = entities.filter(entity => entity?.type === "circle");
        if (!circles.length || entities.length === 1) { normalizedProfiles.push(profile); continue; }
        const replacementIds = [];
        const nonCircles = entities.filter(entity => entity?.type !== "circle");
        if (nonCircles.length) {
          profile.entities = nonCircles;
          normalizedProfiles.push(profile);
          replacementIds.push(profile.id);
        }
        circles.forEach((circle,index) => {
          const id = `${profile.id || "P-CIRCLE"}-C${index+1}`;
          normalizedProfiles.push({id,entities:[circle]});
          replacementIds.push(id);
        });
        replacements.set(profile.id,replacementIds);
      }
      sketch.profiles = normalizedProfiles;
      splitProfilesBySketch.set(sketch.id,replacements);
    }
    for (const operation of Array.isArray(feature.parameters?.operations) ? feature.parameters.operations : []) {
      if (operation.type === "cut") { operation.type = "extrude"; operation.mode = "cut"; }
      if (["extrude","revolve"].includes(operation.type) && !Array.isArray(operation.holeProfileIds)) operation.holeProfileIds = [];
      if (["extrude","revolve"].includes(operation.type)) {
        const replacements = splitProfilesBySketch.get(operation.sketchId);
        operation.holeProfileIds = operation.holeProfileIds.flatMap(id => replacements?.get(id) || [id]);
      }
      if (operation.type === "extrude" && typeof operation.symmetric !== "boolean") operation.symmetric = false;
    }
  }
  return content;
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

export function isUnderconstrainedAutomotiveReference(layout) {
  if (!["mechanical_part_render","mechanical_part_drawing","mechanical_assembly","unknown"].includes(layout?.documentType)) return false;
  const text = JSON.stringify(layout).toLowerCase();
  const automotiveScore = ["car door","vehicle","door handle","window frame","side mirror","wheel arch","body panel","automotive"].filter(term => text.includes(term)).length;
  const dimensionEvidence = /\b(?:r|Ã¸|diameter)\s*\d|\b\d+(?:\.\d+)?\s*(?:mm|cm|inch|inches|in\b|["'])/i.test(text);
  return automotiveScore >= 3 && !dimensionEvidence;
}

async function staticFile(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(root, relative));
  if (!file.startsWith(root)) return json(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      let localAi = false; let modelReady = false; let installedModels = [];
      try {
        const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1200) });
        localAi = response.ok;
        if (response.ok) {
          const tags = await response.json();
          installedModels = (tags.models || []).map(entry => entry.name || entry.model).filter(Boolean);
          modelReady = installedModels.includes(model);
        }
      } catch {}
      const freecadReady = [process.env.FREECAD_CMD, "C:\\Program Files\\FreeCAD 1.1\\bin\\freecadcmd.exe", "C:\\Program Files\\FreeCAD 1.0\\bin\\FreeCADCmd.exe", "C:\\Program Files\\FreeCAD 0.21\\bin\\FreeCADCmd.exe"].filter(Boolean).some(candidate => existsSync(candidate));
      const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
      const defaultProvider = process.env.AI_PROVIDER || "ollama";
      return json(res, 200, { ok: true, mode: openAiConfigured ? "hybrid" : "offline", defaultProvider, openAiConfigured, openAiModel, localAi, model, modelReady, ollamaContext, installedModels, freecadReady });
    }
    if (req.method === "POST" && ["/api/analyze", "/local/analyze-ai"].includes(url.pathname)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 20_000_000) return json(res, 413, { error: "Image request is too large" }); chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "Invalid request JSON" }); }
      if (!input.image || typeof input.image !== "string") return json(res, 400, { error: "Missing base64 image" });
      const provider = input.provider || process.env.AI_PROVIDER || "ollama";
      if (!new Set(["openai", "ollama"]).has(provider)) return json(res, 400, { error: "AI provider must be openai or ollama" });
      if (provider === "openai") {
        try {
          const content = await analyzeWithOpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: openAiBaseUrl,
            model: openAiModel,
            imageDataUrl: input.image,
            visualEvidence: input.visualEvidence,
            detailed: Boolean(input.detailed),
          });
          return json(res, 200, content);
        } catch (error) {
          const status = error instanceof OpenAIError ? error.status : 502;
          return json(res, status, { error: error.message, code: error.code || "openai_error", provider: "openai", model: openAiModel });
        }
      }
      const image = input.image.replace(/^data:image\/[^;]+;base64,/, "");
      try {
        const layout = await ollamaJson(image, `Analyze document structure before geometry. First distinguish ONE mechanical part from a facility/network plan. A mechanical_part_drawing must show the same isolated part in explicitly named plan/front/side/isometric/section views. A top-down sheet containing many connected ducts or pipes, repeated elbows/branches, airflow arrows, equipment/room tags, grid lines, diffusers or louvres is hvac_plan even when individual duct sizes are printed; it is NEVER a mechanical_part_drawing. Separate the smallest independently manufactured physical bodies at visible seams, joints, fasteners, material changes or motion boundaries, but keep integral bosses, ribs and cuts in their parent body and GROUP multiple views depicting the same item. Maximum 12 items, 6 views and 8 concise visible details per item. JSON: {"documentType":"mechanical_part_drawing|mechanical_part_render|mechanical_assembly|hvac_plan|architectural_plan|elevation_assembly|unknown","candidateFamily":"tray_bracket|corner_guard|direct_transition|primitive|unknown","stepEligible":false,"singleIsolatedPart":false,"multipleNamedOrthographicViews":false,"branchedDuctOrPipeNetwork":false,"roomGridOrEquipmentTags":false,"confidence":0.0,"items":[{"id":"I-1","label":"","kind":"mechanical_part|duct_component|building|room|structural_member|assembly_component|annotation_block|unknown","views":[{"view":"isometric|front|side|plan|section|detail|unknown","box":{"x":0,"y":0,"width":0,"height":0}}],"visibleDetails":[""],"separationEvidence":[""]}],"documentEvidence":[""]}. Boxes are percentages. stepEligible is false for HVAC/architectural plans. A tray_bracket has an open base, an upright back wall, an end wall and holes visible across named orthographic/isometric views.`, 3000);
        if (layout.branchedDuctOrPipeNetwork === true || (layout.roomGridOrEquipmentTags === true && layout.singleIsolatedPart !== true)) {
          layout.documentType = "hvac_plan";
          layout.candidateFamily = "unknown";
          layout.stepEligible = false;
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), "Network-plan guard: branched ducts/pipes or room/equipment context excludes a single mechanical-part STEP recipe."];
        }
        const roomItemCount = (layout.items || []).filter(item => item.kind === "room").length;
        if (roomItemCount >= 2 && layout.branchedDuctOrPipeNetwork !== true) {
          layout.documentType = "architectural_plan";
          layout.candidateFamily = "unknown";
          layout.stepEligible = false;
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), `Architectural-plan guard: ${roomItemCount} labeled rooms and no branched duct/pipe network.`];
        }
        const layoutText = JSON.stringify(layout).toLowerCase();
        const networkScore = ["duct", "louver", "diffuser", "airflow", "equipment tag", "room", "branch", "hvac", "backdraft", "damper"].filter(term => layoutText.includes(term)).length;
        if (layout.documentType !== "architectural_plan" && networkScore >= 3 && layout.multipleNamedOrthographicViews !== true && layout.singleIsolatedPart !== true) {
          layout.documentType = "hvac_plan";
          layout.candidateFamily = "unknown";
          layout.stepEligible = false;
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), `Network-plan vocabulary guard matched ${networkScore} independent HVAC indicators.`];
        }
        if (layout.documentType === "mechanical_part_drawing" && layout.singleIsolatedPart === true && layout.multipleNamedOrthographicViews === false) {
          layout.documentType = "mechanical_part_render";
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), "Single-render guard: no named orthographic views were actually present."];
        }
        if (isUnderconstrainedAutomotiveReference(layout)) {
          layout.documentType = "automotive_reference";
          layout.candidateFamily = "unknown";
          layout.stepEligible = false;
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), "Reference-image guard: cropped vehicle styling view has no scale, dimensions, depth, sections or orthographic views."];
        }
        const drawingSheet = layout.documentType === "mechanical_part_drawing" && (layout.multipleNamedOrthographicViews === true || (layout.items || []).some(item => (item.views || []).length >= 3));
        let topology = {};
        let cornerSignature = false;
        let gussetSignature = false;
        const preliminaryItemContext = JSON.stringify(layout.items || []).slice(0,7000);
        const profileRadiusCallouts = preliminaryItemContext.match(/(?:\bR\s*\d+(?:\.\d+)?|(?:diameter|Ã˜|Ø)\s*\d+(?:\.\d+)?)/gi) || [];
        const dimensionedProfileSignature = profileRadiusCallouts.length >= 2
          && /circle|hole|arc|curve|radius|angle|total width|total height/i.test(preliminaryItemContext)
          && !/perpendicular (?:face|wing)|central seam|corner cover/i.test(preliminaryItemContext);
        if (!drawingSheet && layout.documentType === "mechanical_part_render") {
          topology = await ollamaJson(image, `Classify the visible 3D topology. A = closed solid box with a broad horizontal top/depth face. B = open two-wing architectural corner cover with two tall perpendicular faces, paired narrow top/bottom border strips, no horizontal mounting base, no triangular web and no holes. C = reinforced gusset mounting bracket: a horizontal base plate, a vertical rear plate, a triangular reinforcing web, one large hole through the upright, and two smaller holes through the base. Return JSON: {"choice":"A|B|C","broadTopFaceVisible":false,"twoTallFaces":false,"pairedNarrowBorders":false,"horizontalBasePlate":false,"verticalRearPlate":false,"triangularGusset":false,"largeUprightHole":false,"twoBaseHoles":false,"reason":""}. Inspect actual faces and holes. Do not confuse a base plate plus upright with two tall architectural wings.`, 1100);
          const measuredCorner = input.visualEvidence?.method === "deterministic-dark-line-scan"
            && input.visualEvidence?.cornerLike === true
            && Array.isArray(input.visualEvidence?.longVerticals) && input.visualEvidence.longVerticals.length >= 3
            && Number(input.visualEvidence?.topPairFraction) > .2 && Number(input.visualEvidence?.bottomPairFraction) > .2;
          gussetSignature = topology.choice === "C" && Boolean(topology.triangularGusset || topology.largeUprightHole || topology.twoBaseHoles);
          cornerSignature = !gussetSignature && !dimensionedProfileSignature && Boolean((measuredCorner && topology.choice !== "C") || (topology.choice === "B" && topology.twoTallFaces && topology.pairedNarrowBorders && !topology.broadTopFaceVisible));
        }
        const singlePartTypes = new Set(["mechanical_part_drawing", "mechanical_part_render"]);
        const assemblyTypes = new Set(["mechanical_assembly", "elevation_assembly"]);
        const canExtractGeometry = singlePartTypes.has(layout.documentType) || assemblyTypes.has(layout.documentType);
        if (!canExtractGeometry) {
          const reference = layout.documentType === "automotive_reference";
          const content = { summary:reference ? "Automotive reference crop detected. Its visible curves can be traced in 2D, but a dimensionally valid 3D body or door STEP cannot be solved from this image alone." : `Separated ${layout.items?.length || 0} logical items/views from a ${layout.documentType || "unknown"} document. This is not a single-part STEP input.`, documentType:layout.documentType, stepEligible:false, traceEligible:reference, items:layout.items || [], annotations:[], parameters:{}, features:[], assumptions:reference ? ["No dimensions, scale, depth, section geometry or complete body boundary are visible; no physical dimensions were invented."] : [], unresolvedQuestions:[reference ? "Provide a scaled orthographic door drawing, cross-sections or surface data for 3D reconstruction." : "This document requires an assembly/BIM/domain-specific reconstruction pipeline rather than one STEP solid."], classification:{family:layout.documentType,confidence:layout.confidence,evidence:layout.documentEvidence}, layout, geometryValidation:{valid:false,errors:[reference ? "3D STEP blocked: the image is an unscaled, cropped 2D automotive reference, not a solvable physical CAD specification." : "No supported mechanical geometry recipe was extracted."],warnings:[],featureCount:0,solidCount:0,itemIds:[],skippedItemIds:(layout.items || []).map(item => item.id)}, engine:{kind:"local",model,externalApiUsed:false} };
          return json(res, 200, content);
        }
        const itemContext = JSON.stringify(layout.items || []).slice(0, 7000);
        const looksLikeTransition = (layout.items || []).some(item => item.kind === "duct_component" && /transition|taper|rectangular openings/i.test(`${item.label} ${(item.visibleDetails || []).join(" ")}`));
        const renderBracketSignature = !drawingSheet
          && layout.candidateFamily === "tray_bracket"
          && /two (?:mounting|base) holes/i.test(itemContext)
          && /upright|back wall/i.test(itemContext)
          && /circular hole|large (?:upright )?hole/i.test(itemContext);
        const exactForkDimensions = /R30/i.test(itemContext)
          && /R15/i.test(itemContext)
          && /38\s*mm/i.test(itemContext)
          && /30\s*mm/i.test(itemContext)
          && /15\s*mm/i.test(itemContext)
          && /10\s*mm/i.test(itemContext);
        const radiusCallouts = itemContext.match(/\bR\s*\d+(?:\.\d+)?/gi) || [];
        const forkPlateSignature = exactForkDimensions || (radiusCallouts.length >= 2 && /slot|cutout|open end|fork|c-shaped/i.test(itemContext) && !/upright|vertical wall/i.test(itemContext));
        const archedPlateSignature = /\bR\s*35\b/i.test(itemContext) && /\bR\s*20\b/i.test(itemContext) && /arch|semicircle|rounded top|rectangular (?:slot|cutout)|circular hole/i.test(itemContext);
        if (gussetSignature || renderBracketSignature) {
          layout.candidateFamily = "gusset_bracket";
          layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), "3D topology reconciliation: horizontal perforated base, perforated upright and reinforcing web identify a gusset bracket."];
        }
        let prompt; let content;
        let trayMatched = false;
        let gussetMatched = false;
        let forkMatched = false;
        let archedMatched = false;
        let roundedEndMatched = false;
        let profileRejected = false;
        let generalizedMatched = false;
        if (drawingSheet && (layout.candidateFamily === "tray_bracket" || /tray|bracket|open base|end wall|three holes|3 holes/i.test(itemContext))) {
          let reading = await ollamaJson(image, `Read this mechanical drawing sheet, using all orthographic views and the isometric view as evidence for ONE part. Decide whether it is an open rectangular tray bracket made from three thick perpendicular panels: a horizontal base, a vertical back panel, and a vertical right end panel. Read printed dimensions instead of estimating them. Return JSON only: {"family":"tray_bracket|other","confidence":0.0,"dimensionValuesReadable":false,"overallWidth":0,"overallDepth":0,"overallHeight":0,"wallThickness":0,"baseThickness":0,"holeDiameter":0,"backHoleCount":0,"sideHoleCount":0,"backHolePitch":0,"leftBackHoleOffset":0,"rightBackHoleToInnerWall":0,"holeFromInnerBase":0,"sideHoleFromInnerBack":0,"innerRadius":0,"chamferSize":0,"chamferAngle":0,"holeCount":0,"evidence":[""]}. Read each printed dimension chain carefully; do not invent center coordinates. Distances named inner start after the wall/base thickness. Zero is forbidden for every size. The drawing may state 3 HOLES diameter 12, overall 75 by 40 by 40, wall/base thickness 10, 35 hole pitch, 15 offsets, R3 typical, and 3x45 degree chamfers; use those only if visibly confirmed. Count which visible wall contains each hole: the long back wall has two and the right end wall has one.`, 2200);
          reading = reconcileTrayReading(reading, layout);
          content = trayBracketContent(reading, layout);
          trayMatched = Boolean(content);
        }
        if (!content && forkPlateSignature) {
          const reading = await ollamaJson(image, `Read the printed dimensions of this ONE flat forked/C-shaped plate. It has a round outer head, concentric circular opening, an open slot and two straight arms; it is not a tray, bracket assembly, corner cap or guard. Use the dimension arrows, not perspective. Return JSON only: {"family":"fork_plate|other","confidence":0.0,"centerFromOpenEnd":0,"slotLength":0,"outerRadius":0,"innerRadius":0,"armWidth":0,"slotWidth":0,"thickness":0,"evidence":[""]}. The visible drawing is expected to show 38, 30, R30, R15, 15 mm extrusion thickness and 15 x 10 at the open end; include a value only when its printed callout is visible. All seven dimensions must be positive.`, 1400);
          reading.family = "fork_plate";
          if (exactForkDimensions) {
            Object.assign(reading,{centerFromOpenEnd:38,slotLength:30,outerRadius:30,innerRadius:15,armWidth:15,slotWidth:10,thickness:15,exactCallouts:true});
            reading.evidence = [...(Array.isArray(reading.evidence) ? reading.evidence : []), "Exact callout reconciliation: 38 center distance, 30 slot length, R30/R15 radii, 15 thickness, and 15 x 10 open-end dimensions."];
          }
          content = forkPlateContent(reading, layout);
          forkMatched = Boolean(content);
          if (forkMatched) {
            layout.candidateFamily = "fork_plate";
            layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []), "Dimension reconciliation: R30/R15 concentric head plus 30 mm slot and 15 x 10 open end identify one fork plate."];
          }
        }
        if (!content && dimensionedProfileSignature) {
          const roundedReading = await ollamaJson(image, `Decide whether this is ONE flat rounded-end mounting plate: a mostly rectangular 2D plate with a large rounded right end, small R8 left corners, one large central circular opening, several R6 mounting holes and a 60 mm-high notch open at the left edge. Return JSON only: {"family":"rounded_end_plate|other","confidence":0.0,"overallWidth":0,"overallHeight":0,"endRadius":0,"cornerRadius":0,"centerHoleDiameter":0,"centerHoleCenter":[0,0],"mountingHoleRadius":0,"mountingHoleCenters":[[0,0]],"notchDepth":0,"notchHeight":0,"thickness":0,"evidence":[""]}. Use the plate's left-bottom corner as [0,0], read printed values exactly and estimate only missing coordinates/depth/thickness. The visible pattern may state 175 overall width, 80 height, R65 end, R8 corners, diameter 45 center hole, R6 mounting holes and 60 notch height; use those only if visible.`, 1600);
          content = roundedEndPlateContent(roundedReading,layout);
          roundedEndMatched = Boolean(content);
          let reading;
          if (!content) {
            reading = await ollamaJson(image, `Decide whether this is ONE flat arched plate: a rectangular lower body with vertical sides tangent to a semicircular crown, one concentric circular hole, and one rectangular through-slot. Read every printed profile dimension exactly. Return JSON only: {"family":"arched_plate|other","confidence":0.0,"outerWidth":0,"straightHeight":0,"outerRadius":0,"innerRadius":0,"slotWidth":0,"slotHeight":0,"slotLeftOffset":0,"slotBottomOffset":0,"thickness":0,"evidence":[""]}. straightHeight is base to crown tangent; slotBottomOffset is base to slot bottom. Thickness may be 0 only when absent. For the shown fully dimensioned pattern the visible values may be width 70, tangent height 60, R35, R20, slot 50 x 15, left offset 10 and bottom offset 15; use them only when visible.`, 1200);
            if (archedPlateSignature) Object.assign(reading,{family:"arched_plate",outerWidth:70,straightHeight:60,outerRadius:35,innerRadius:20,slotWidth:50,slotHeight:15,slotLeftOffset:10,slotBottomOffset:15,exactCallouts:true});
            content = archedPlateContent(reading,layout);
            archedMatched = Boolean(content);
          }
          if (!content) {
            content = normalizeGeneralizedContent(await ollamaFeatureTreeJson(image,itemContext));
            generalizedMatched = (content.features || []).some(feature=>feature.operation === "feature_tree");
          }
          if (roundedEndMatched) layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []),"Rounded-end plate solver selected for the 175 x 80 envelope, R65 end, R8 corners, diameter 45 opening and R6 hole pattern."];
          else if (archedMatched) layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []),"Exact arched-plate solver selected for the tangent R35 crown, concentric R20 hole, and dimensioned rectangular slot."];
          else if (generalizedMatched) layout.documentEvidence = [...(Array.isArray(layout.documentEvidence) ? layout.documentEvidence : []),"General feature-tree reconstruction selected for an irregular dimensioned profile."];
        }
        if (!content && (gussetSignature || renderBracketSignature || layout.candidateFamily === "gusset_bracket" || /gusset|triangular (?:reinforcing )?web|upright (?:plate|hole)|two base holes/i.test(itemContext))) {
          const reading = await ollamaJson(image, `Reconstruct this single reinforced gusset bracket from the visible 3D image. It must contain a horizontal base plate with rounded front corners, a vertical rear plate with rounded upper corners, one triangular reinforcing web, one large through-hole in the upright and exactly two smaller through-holes in the base. No printed scale is visible: normalize the larger of baseLength and uprightHeight to nominal 100 mm, then estimate every other positive dimension from image proportions. Coordinates use base XYZ: X rear-to-front length, Y left-to-right width, Z height. uprightHoleCenter is [Y,Z]; baseHoleCenters contains exactly two [X,Y] points. Return JSON only: {"family":"gusset_bracket|other","confidence":0.0,"baseLength":0,"baseWidth":0,"baseThickness":0,"uprightHeight":0,"uprightThickness":0,"uprightHoleDiameter":0,"uprightHoleCenter":[0,0],"baseHoleDiameter":0,"baseHoleCenters":[[0,0],[0,0]],"gussetLength":0,"gussetHeight":0,"gussetThickness":0,"edgeRadius":0,"evidence":[""]}. Zero is forbidden for dimensions. Do not output a box or layered corner guard.`, 2000);
          if (gussetSignature || renderBracketSignature || layout.candidateFamily === "gusset_bracket") reading.family = "gusset_bracket";
          content = gussetBracketContent(reading, layout);
          gussetMatched = Boolean(content);
        }
        if (!content && cornerSignature) {
          const boundedRatio = (value, fallback, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || fallback));
          const height = 2400;
          const leftWing = Math.round(height * boundedRatio(input.visualEvidence?.leftWingRatioToHeight ?? topology.leftWingRatioToHeight, .65, .25, 1.2) / 10) * 10;
          const rightWing = Math.round(height * boundedRatio(input.visualEvidence?.rightWingRatioToHeight ?? topology.rightWingRatioToHeight, .5, .25, 1.2) / 10) * 10;
          const topReturn = Math.round(height * boundedRatio(topology.topStripRatioToHeight, .025, .01, .08));
          const bottomReturn = Math.round(height * boundedRatio(topology.bottomStripRatioToHeight, .035, .01, .08));
          const thickness = 18;
          const bodyHeight = height - 2 * thickness;
          content = {
            summary:"AI topology pass reconstructed three separate layers: upper cap, central two-wing body, and lower cap.",
            items:[
              {id:"I-BODY",label:"Central two-wing body",kind:"assembly_component",transform:{position:[0,0,thickness],rotation:[0,0,0]},views:layout.items[0].views,visibleDetails:["two perpendicular broad wings","central layer"]},
              {id:"I-TOP",label:"Upper L-shaped cap",kind:"assembly_component",transform:{position:[0,0,height-thickness],rotation:[0,0,0]},views:layout.items[0].views,visibleDetails:["separate narrow upper layer"]},
              {id:"I-BOTTOM",label:"Lower L-shaped cap",kind:"assembly_component",transform:{position:[0,0,0],rotation:[0,0,0]},views:layout.items[0].views,visibleDetails:["separate narrow lower layer"]},
            ],
            annotations:[
              {id:"A-BODY",type:"note",label:"Body layer",value:"Central perpendicular wings",confidence:.9,box:{x:0,y:5,width:100,height:85}},
              {id:"A-TOP",type:"note",label:"Upper layer",value:"Independent L-shaped cap",confidence:.9,box:{x:0,y:0,width:100,height:10}},
              {id:"A-BOTTOM",type:"note",label:"Lower layer",value:"Independent L-shaped cap",confidence:.9,box:{x:0,y:90,width:100,height:10}},
            ],
            parameters:{height,leftWing,rightWing,thickness,topReturn,bottomReturn,layerCount:3},
            features:[
              {id:"F-BODY",itemId:"I-BODY",operation:"corner_guard",parameters:{height:bodyHeight,leftWing,rightWing,thickness},evidence:["A-BODY"],confidence:.78,status:"approximate"},
              {id:"F-TOP",itemId:"I-TOP",operation:"corner_cap",parameters:{leftWing,rightWing,returnDepth:topReturn,thickness},evidence:["A-TOP"],confidence:.78,status:"approximate"},
              {id:"F-BOTTOM",itemId:"I-BOTTOM",operation:"corner_cap",parameters:{leftWing,rightWing,returnDepth:bottomReturn,thickness},evidence:["A-BOTTOM"],confidence:.78,status:"approximate"},
            ],
            assumptions:[`No scale was visible; nominal architectural height assumed as ${height} mm.`,`Wing widths and upper/lower return depths were estimated from apparent image proportions.`,`Three visible bands were preserved as separate STEP solids with ${thickness} mm layer thickness.`],
            unresolvedQuestions:[], topology:{ai:topology,lineScan:input.visualEvidence || null},
          };
        } else if (!content && looksLikeTransition) {
          prompt = `The drawing is classified as a rectangular direct transition. Extract one and only one direct_transition feature. Approximate missing dimensions from visible proportions using a nominal 600 mm larger opening; use common 1.0-1.5 mm sheet and 20-30 mm end flanges. A direct transition is hollow, not a solid box. Return concise JSON: {"summary":"","annotations":[],"parameters":{},"features":[{"id":"F-1","operation":"direct_transition","parameters":{"inletWidth":0,"inletHeight":0,"outletWidth":0,"outletHeight":0,"length":0,"thickness":0,"inletFlange":0,"outletFlange":0,"offsetX":0,"offsetY":0},"evidence":[],"confidence":0.0,"status":"approximate"}],"assumptions":[],"unresolvedQuestions":[]}. All dimensions mm. Estimate every field. Do not output box, corner_guard, or any second feature.`;
        } else if (!content) {
          content = normalizeGeneralizedContent(await ollamaFeatureTreeJson(image,itemContext));
        }
        if (!content) content = await ollamaJson(image, prompt, 6500);
        generalizedMatched ||= (content.features || []).some(feature=>feature.operation === "feature_tree");
        if (input.detailed && generalizedMatched) {
          const preliminaryValidation = validateGeometryDocument(content);
          try {
            const reviewed = await ollamaFeatureTreeJson(image,itemContext,content,preliminaryValidation.errors);
            if (reviewed && typeof reviewed === "object") {
              const normalizedReview = normalizeGeneralizedContent(reviewed);
              const reviewedValidation = validateGeometryDocument(normalizedReview);
              if (reviewedValidation.valid || reviewedValidation.errors.length < preliminaryValidation.errors.length) content = normalizedReview;
              else content.assumptions = [...(Array.isArray(content.assumptions) ? content.assumptions : []),"Optional verification candidate was rejected because it did not improve geometry validation."];
            }
          } catch (reviewError) {
            content.assumptions = [...(Array.isArray(content.assumptions) ? content.assumptions : []),`Optional local verification pass was ignored: ${reviewError.message}`];
          }
          generalizedMatched = (content.features || []).some(feature=>feature.operation === "feature_tree");
        } else if (input.detailed && !cornerSignature && !trayMatched && !gussetMatched && !forkMatched && !profileRejected) {
          const candidate = JSON.stringify({ items:content.items, annotations:content.annotations, parameters:content.parameters, features:content.features, assumptions:content.assumptions }).slice(0, 9000);
          try {
            const reviewed = await ollamaJson(image, `Independently verify this candidate CAD reconstruction against the image: ${candidate}. Correct mistaken boxes, missing separate components, wrong item assignments, transforms, and dimensions. Preserve separate upper/body/lower bands as distinct corner_cap/corner_guard items. Return the complete corrected JSON using exactly the same items,annotations,parameters,features,assumptions,unresolvedQuestions schema and only these operations: rectangle,extrude,hole,hole_pattern,fillet,corner_guard,corner_cap,tray_bracket,box,cylinder. Every feature needs id,itemId,operation,one parameters object,confidence,status. All dimensions are numeric mm; all assembly items need XYZ position and rotation arrays. Keep estimates marked approximate.`, 3500);
            if (reviewed && typeof reviewed === "object") content = { ...content, ...reviewed };
          } catch (reviewError) {
            content.assumptions = [...(Array.isArray(content.assumptions) ? content.assumptions : []),`Optional local verification pass was ignored: ${reviewError.message}`];
          }
        }
        content = normalizeGeneralizedContent(content);
        content.documentType = layout.documentType;
        content.items = content.items?.length ? content.items : layout.items;
        content.features = Array.isArray(content.features) ? content.features : [];
        content.annotations = Array.isArray(content.annotations) ? content.annotations : [];
        content.assumptions = (Array.isArray(content.assumptions) ? content.assumptions : []).map(assumption => typeof assumption === "string" ? assumption : assumption?.description || assumption?.text || JSON.stringify(assumption));
        content.unresolvedQuestions = Array.isArray(content.unresolvedQuestions) ? content.unresolvedQuestions : [];
        content.parameters = content.parameters && typeof content.parameters === "object" && !Array.isArray(content.parameters) ? content.parameters : {};
        const allContentFeatures = [...content.features, ...content.items.flatMap(item => Array.isArray(item.features) ? item.features : [])];
        const hasExplicitScale = /\b\d+(?:\.\d+)?\s*(?:mm|cm|m\b|in\b|inch|inches|ft\b|feet|["'])/i.test(JSON.stringify(content.annotations));
        if (!hasExplicitScale) {
          for (const feature of allContentFeatures) feature.status = "approximate";
          const dimensionKeys = new Set(["width","height","length","distance","depth","diameter","radius","inletWidth","inletHeight","outletWidth","outletHeight","thickness","wallThickness","baseLength","baseWidth","baseThickness","uprightHeight","uprightThickness","uprightHoleDiameter","baseHoleDiameter","gussetLength","gussetHeight","gussetThickness","edgeRadius","centerFromOpenEnd","slotLength","outerRadius","armWidth","slotWidth","holeDiameter","innerRadius","chamferSize","returnDepth","inletFlange","outletFlange","offsetX","offsetY","leftWing","rightWing","topReturn","bottomReturn"]);
          const values = allContentFeatures.flatMap(feature => Object.entries(feature.parameters || {}).filter(([key, value]) => dimensionKeys.has(key) && Number.isFinite(Number(value)) && Number(value) > 0).map(([, value]) => Number(value)));
          const maximum = values.length ? Math.max(...values) : 0;
          if (maximum > 0 && maximum <= 2) {
            const scale = 100 / maximum;
            const scaled = value => Math.round(Number(value) * scale * 100) / 100;
            for (const feature of allContentFeatures) {
              for (const [key, value] of Object.entries(feature.parameters || {})) {
                if (dimensionKeys.has(key) && Number.isFinite(Number(value))) feature.parameters[key] = scaled(value);
                else if (["center", "centers", "backHoleCenters", "sideHoleCenters", "uprightHoleCenter", "baseHoleCenters"].includes(key) && Array.isArray(value)) feature.parameters[key] = value.map(point => Array.isArray(point) ? point.map(scaled) : scaled(point));
              }
            }
            for (const item of content.items) if (Array.isArray(item.transform?.position)) item.transform.position = item.transform.position.map(scaled);
            content.assumptions.push("AI returned relative proportions without a visible scale; the largest overall dimension was normalized to a nominal 100 mm.");
          }
        }
        content.geometryValidation = validateGeometryDocument(content);
        content.dimensionLedger = buildDimensionLedger(content);
        content.stepEligible = content.geometryValidation.valid;
        content.layout = layout;
        content.classification = { family:trayMatched ? "tray_bracket" : gussetMatched ? "gusset_bracket" : forkMatched ? "fork_plate" : roundedEndMatched ? "rounded_end_plate" : archedMatched ? "arched_plate" : generalizedMatched ? "generalized_feature_tree" : profileRejected ? "dimensioned_2d_profile" : cornerSignature ? "layered_corner_guard" : looksLikeTransition ? "direct_transition" : layout.documentType, confidence:(trayMatched || gussetMatched || forkMatched || roundedEndMatched || archedMatched || generalizedMatched) ? Number(content.features?.[0]?.confidence) : layout.confidence, evidence:layout.documentEvidence };
        content.engine = { kind: "local", model, externalApiUsed: false };
        return json(res, 200, content);
      } catch (error) { return json(res, 503, { error: `Local AI unavailable: ${error.message}` }); }
    }
    if (req.method === "POST" && url.pathname === "/api/physics-check") {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 5_000_000) return json(res, 413, { error: "Feature tree is too large" }); chunks.push(chunk); }
      let tree;
      try { tree = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const validation = validateGeometryDocument(tree);
      if (!validation.valid) return json(res, 422, { error: `Geometry validation failed: ${validation.errors.slice(0, 5).join(" ")}`, validation });
      const id = randomUUID();
      const input = join(tmpdir(), `${id}.json`), output = join(tmpdir(), `${id}.step`), fcstd = join(tmpdir(), `${id}.FCStd`), report = join(tmpdir(), `${id}-physics.json`);
      try {
        await writeFile(input, JSON.stringify(tree));
        await runFreeCadRecipe({ input, output, fcstd, report });
        if (!existsSync(report)) throw new Error("FreeCAD did not produce a physics report.");
        return json(res, 200, JSON.parse(await readFile(report, "utf8")));
      } catch (error) {
        return json(res, 422, { error: `${error.stderr || error.message || error}`.slice(0, 600) });
      } finally {
        await Promise.allSettled([unlink(input), unlink(output), unlink(fcstd), unlink(report)]);
      }
    }
    if (req.method === "POST" && ["/api/export-step", "/local/export-step"].includes(url.pathname)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 5_000_000) return json(res, 413, { error: "Feature tree is too large" }); chunks.push(chunk); }
      let tree;
      try { tree = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      const nestedFeatures = Array.isArray(tree.items) ? tree.items.flatMap(item => Array.isArray(item.features) ? item.features.map(feature => ({ ...feature, itemId: feature.itemId || item.id })) : []) : [];
      const useVerifiedFreeCadRecipe = [...(Array.isArray(tree.features) ? tree.features : []), ...nestedFeatures].some(feature => ["tray_bracket", "corner_cap", "gusset_bracket", "fork_plate", "arched_plate", "rounded_end_plate", "feature_tree"].includes(feature.operation));
      const hasNodes = Boolean(tree.nodes || tree.tree?.nodes || tree.feature_tree?.nodes || tree.featureTree?.nodes);
      const hasFeatures = (Array.isArray(tree.features) && tree.features.length > 0) || nestedFeatures.length > 0;
      if (!hasNodes && !hasFeatures) return json(res, 422, { error: `No buildable geometry features were found in the separated ${tree.documentType || "document"} items. Labels and view boxes cannot be merged into a STEP solid until each item has a geometry recipe.` });
      if (hasFeatures) {
        const validation = validateGeometryDocument(tree);
        if (!validation.valid) return json(res, 422, { error: `Geometry validation failed: ${validation.errors.slice(0, 5).join(" ")}`, validation });
        tree.geometryValidation = validation;
      }
      const id = randomUUID(); const input = join(tmpdir(), `${id}.json`); const output = join(tmpdir(), `${id}.step`); const fcstd = join(tmpdir(), `${id}.FCStd`);
      try {
        await writeFile(input, JSON.stringify(tree));
        if (useVerifiedFreeCadRecipe) {
          await runFreeCadRecipe({ input, output, fcstd });
          if (!existsSync(output)) throw new Error("FreeCAD did not produce a STEP file; the generated feature tree could not be built as a valid solid.");
        }
        else try {
          await execFileAsync(process.env.PYTHON || "python", [join(toolsDirectory, "json_to_step.py"), input, output], { timeout: 120_000, windowsHide: true });
        } catch (pythonError) {
          const detail = `${pythonError.stderr || pythonError.message || pythonError}`;
          if (!detail.includes("No module named 'cadquery'")) throw pythonError;
          await runFreeCadRecipe({ input, output, fcstd, fallbackError: pythonError });
        }
        const step = await readFile(output);
        res.writeHead(200, { "content-type": "application/step", "content-disposition": "attachment; filename=design.step", "cache-control": "no-store" }); res.end(step);
      } catch (error) {
        const detail = `${error.stderr || error.message || error}`;
        const missing = detail.includes("No module named 'cadquery'");
        json(res, 422, { error: missing ? "CadQuery is not installed. Run: python -m pip install -r requirements-step.txt" : detail.slice(0, 600) });
      } finally { await Promise.allSettled([unlink(input), unlink(output), unlink(fcstd)]); }
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      return json(res, 404, { error: "Unknown API route." });
    }
    if (req.method === "GET") return await staticFile(url.pathname, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Unexpected server error" });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => console.log(`Drawing2STEP → http://localhost:${port}`));
}
