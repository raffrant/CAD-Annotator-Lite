import { validateGeometryDocument } from "./geometry-contract.mjs";
import { buildDimensionLedger } from "./dimension-ledger.mjs";

const positive = { type: "number", exclusiveMinimum: 0 };
const number = { type: "number" };
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullablePositive = { anyOf: [positive, { type: "null" }] };
const point2 = { type: "array", minItems: 2, maxItems: 2, items: number };
const vector3 = { type: "array", minItems: 3, maxItems: 3, items: number };

const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

function feature(operation, parameterProperties) {
  return object({
    id: { type: "string" },
    itemId: { type: "string" },
    operation: { const: operation },
    parameters: object(parameterProperties),
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    status: { enum: ["confirmed", "approximate"] },
  });
}

const entitySchema = {
  anyOf: [
    object({ id:{type:"string"}, type:{const:"line"}, start:point2, end:point2 }),
    object({ id:{type:"string"}, type:{const:"arc"}, center:point2, radius:positive, startAngle:number, endAngle:number, clockwise:{type:"boolean"} }),
    object({ id:{type:"string"}, type:{const:"circle"}, center:point2, radius:positive }),
    object({ id:{type:"string"}, type:{const:"polyline"}, points:{type:"array",minItems:3,items:point2}, closed:{const:true} }),
  ],
};
const profileSchema = object({id:{type:"string"},entities:{type:"array",minItems:1,maxItems:120,items:entitySchema}});
const constraintSchema = object({
  type:{enum:["horizontal","vertical","coincident","tangent","parallel","perpendicular","equal","distance","radius","diameter","angle","fixed"]},
  refs:{type:"array",minItems:1,maxItems:8,items:{type:"string"}},
  value:number,
},["type","refs"]);
const sketchSchema = object({
  id:{type:"string"}, plane:{enum:["XY","XZ","YZ"]}, origin:vector3,
  profiles:{type:"array",minItems:1,maxItems:40,items:profileSchema},
  constraints:{type:"array",maxItems:160,items:constraintSchema},
});
const treeOperationSchema = {
  anyOf:[
    object({id:{type:"string"},type:{const:"extrude"},sketchId:{type:"string"},outerProfileId:{type:"string"},holeProfileIds:{type:"array",maxItems:40,items:{type:"string"}},distance:positive,symmetric:{type:"boolean"},mode:{enum:["new","add","cut","intersect"]}}),
    object({id:{type:"string"},type:{const:"revolve"},sketchId:{type:"string"},outerProfileId:{type:"string"},holeProfileIds:{type:"array",maxItems:40,items:{type:"string"}},axisOrigin:vector3,axisDirection:vector3,angle:{type:"number",exclusiveMinimum:0,maximum:360},mode:{enum:["new","add","cut","intersect"]}}),
    object({id:{type:"string"},type:{const:"fillet"},radius:positive,edgeSelector:{enum:["all","vertical","horizontal","circular","longest"]},edgeIndices:{type:"array",items:{type:"integer",minimum:1}}},["id","type","radius","edgeSelector"]),
    object({id:{type:"string"},type:{const:"chamfer"},distance:positive,edgeSelector:{enum:["all","vertical","horizontal","circular","longest"]},edgeIndices:{type:"array",items:{type:"integer",minimum:1}}},["id","type","distance","edgeSelector"]),
  ],
};

export const CAD_RESPONSE_SCHEMA = object({
  summary: { type: "string" },
  documentType: { enum: ["mechanical_part_drawing", "mechanical_part_render", "mechanical_assembly", "unknown"] },
  items: {
    type: "array",
    maxItems: 24,
    items: object({
      id: { type: "string" },
      label: { type: "string" },
      kind: { enum: ["mechanical_part", "assembly_component"] },
      transform: object({ position: vector3, rotation: vector3 }),
      physicalProperties: object({ role: { type: "string" }, material: nullableString, densityKgM3: nullablePositive }),
      views: {
        type: "array",
        maxItems: 8,
        items: object({
          view: { enum: ["isometric", "front", "side", "plan", "section", "detail", "unknown"] },
          box: object({ x: number, y: number, width: positive, height: positive }),
        }),
      },
      visibleDetails: { type: "array", maxItems: 20, items: { type: "string" } },
    }),
  },
  annotations: {
    type: "array",
    maxItems: 80,
    items: object({
      id: { type: "string" },
      type: { enum: ["dimension", "tolerance", "datum", "surface", "note", "symbol"] },
      label: { type: "string" },
      value: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      box: object({ x: number, y: number, width: positive, height: positive }),
    }),
  },
  features: {
    type: "array",
    maxItems: 120,
    items: {
      anyOf: [
        feature("rectangle", { width: positive, height: positive }),
        feature("extrude", { distance: positive }),
        feature("pad", { distance: positive }),
        feature("hole", { diameter: positive, center: point2, through: { type: "boolean" } }),
        feature("hole_pattern", { diameter: positive, centers: { type: "array", minItems: 1, items: point2 }, through: { type: "boolean" } }),
        feature("fillet", { radius: positive }),
        feature("fillet_edges", { radius: positive }),
        feature("box", { length: positive, width: positive, height: positive }),
        feature("cylinder", { radius: positive, height: positive }),
        feature("corner_guard", { height: positive, leftWing: positive, rightWing: positive, thickness: positive }),
        feature("corner_cap", { leftWing: positive, rightWing: positive, returnDepth: positive, thickness: positive }),
        feature("direct_transition", { inletWidth: positive, inletHeight: positive, outletWidth: positive, outletHeight: positive, length: positive, thickness: positive, inletFlange: positive, outletFlange: positive, offsetX: number, offsetY: number }),
        feature("tray_bracket", { width: positive, depth: positive, height: positive, wallThickness: positive, baseThickness: positive, holeDiameter: positive, backHoleCenters: { type: "array", minItems: 2, maxItems: 2, items: point2 }, sideHoleCenters: { type: "array", minItems: 1, maxItems: 1, items: point2 }, innerRadius: positive, chamferSize: positive }),
        feature("gusset_bracket", { baseLength: positive, baseWidth: positive, baseThickness: positive, uprightHeight: positive, uprightThickness: positive, uprightHoleDiameter: positive, uprightHoleCenter: point2, baseHoleDiameter: positive, baseHoleCenters: { type: "array", minItems: 2, maxItems: 2, items: point2 }, gussetLength: positive, gussetHeight: positive, gussetThickness: positive, edgeRadius: positive }),
        feature("fork_plate", { centerFromOpenEnd: positive, slotLength: positive, outerRadius: positive, innerRadius: positive, armWidth: positive, slotWidth: positive, thickness: positive }),
        feature("arched_plate", { outerWidth:positive, straightHeight:positive, outerRadius:positive, innerRadius:positive, slotWidth:positive, slotHeight:positive, slotLeftOffset:positive, slotBottomOffset:positive, thickness:positive }),
        feature("rounded_end_plate", { overallWidth:positive, overallHeight:positive, endRadius:positive, cornerRadius:positive, centerHoleDiameter:positive, centerHoleCenter:point2, mountingHoleRadius:positive, mountingHoleCenters:{type:"array",minItems:1,maxItems:20,items:point2}, notchDepth:positive, notchHeight:positive, thickness:positive }),
        feature("feature_tree", { sketches:{type:"array",minItems:1,maxItems:30,items:sketchSchema}, operations:{type:"array",minItems:1,maxItems:80,items:treeOperationSchema} }),
      ],
    },
  },
  assumptions: { type: "array", maxItems: 40, items: { type: "string" } },
  unresolvedQuestions: { type: "array", maxItems: 20, items: { type: "string" } },
  evidence: { type: "array", maxItems: 40, items: { type: "string" } },
});

export class OpenAIError extends Error {
  constructor(message, status = 502, code = "openai_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function outputText(value) {
  if (typeof value.output_text === "string") return value.output_text;
  for (const output of value.output || []) {
    for (const content of output.content || []) {
      if (content.type === "refusal") throw new OpenAIError(`OpenAI refused the reconstruction: ${content.refusal || "request refused"}`, 422, "refusal");
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new OpenAIError("OpenAI returned no structured CAD output.");
}

async function requestStructured({ apiKey, baseUrl, model, imageDataUrl, prompt, effort }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300_000);
  timeout.unref?.();
  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { "authorization": `Bearer ${apiKey.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort },
        max_output_tokens: 16000,
        input: [{ role: "user", content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
        ] }],
        text: { format: { type: "json_schema", name: "cad_geometry", strict: true, schema: CAD_RESPONSE_SCHEMA } },
      }),
      signal: controller.signal,
    });
  } finally { clearTimeout(timeout); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = value.error?.message || `HTTP ${response.status}`;
    if (response.status === 429) throw new OpenAIError(`OpenAI API returned 429: ${apiMessage}. Check API billing/credits and rate limits, then retry.`, 429, "rate_limit");
    if (response.status === 401) throw new OpenAIError("OpenAI rejected OPENAI_API_KEY. Replace the key and restart the app.", 401, "authentication");
    throw new OpenAIError(`OpenAI API returned ${response.status}: ${apiMessage}`, response.status, value.error?.code || "api_error");
  }
  if (value.status === "incomplete") throw new OpenAIError(`OpenAI response was incomplete: ${value.incomplete_details?.reason || "unknown reason"}.`);
  try { return { content: JSON.parse(outputText(value)), responseId: value.id, usage: value.usage }; }
  catch (error) {
    if (error instanceof OpenAIError) throw error;
    throw new OpenAIError(`OpenAI returned invalid structured JSON: ${error.message}`);
  }
}

const reconstructionPrompt = visualEvidence => `You are the vision and reconstruction engine for an automated image-to-parametric-CAD system.

Work only from visible image evidence. First separate the smallest independently manufactured physical bodies at seams, joints, fasteners, material changes or motion boundaries, and group multiple views of the same body. Integral pads, bosses, ribs, fillets and cuts remain features of their parent body. Then reconstruct all visible, buildable details with the supported feature vocabulary. Do not collapse an assembly into one box. Do not duplicate one part because it appears in multiple orthographic views. For every item return physicalProperties with a concise role; material and densityKgM3 must be null unless printed or unambiguous in the image.

Supported base recipes per item:
- rectangle followed by extrude/pad; optional holes, hole patterns and fillets
- one box with optional holes, hole patterns and fillets
- one cylinder
- one corner_guard for the central two-wing body
- one corner_cap for each visibly separate horizontal L-shaped upper/lower layer; preserve three visible layers as three transformed items
- one direct_transition for a hollow rectangular tapered transition with end flanges
- one tray_bracket for an open base/back/end-wall bracket; backHoleCenters are [x,z] and sideHoleCenters are [y,z]
- one gusset_bracket for a horizontal base, rounded vertical plate, triangular reinforcing web, one plate hole and two base holes
- one fork_plate for a flat fork/C-shaped plate with a round outer head, concentric inner hole, open slot and two straight arms
- one arched_plate for a flat plate with vertical sides tangent to a semicircular crown, a concentric circular hole and a rectangular through-slot
- one rounded_end_plate for a flat plate with an R end arc, small corner radii, central opening, mounting-hole pattern and left-edge notch
- one feature_tree for any other buildable body. A feature_tree contains solved sketches on XY/XZ/YZ and a sequential operation history.

General feature_tree rules:
- Every sketch profile is a CLOSED loop. Use one circle entity alone, one closed polyline, or a connected ordered chain of line/arc entities.
- Operations reference one outer profile and zero or more hole profiles from the same sketch.
- The first operation is extrude/revolve with mode=new. Later solid operations use add, cut or intersect. Fillet/chamfer follow a solid.
- Arc angles are degrees. Coordinates are already solved numeric values; constraints audit the intended relationships but do not replace coordinates.
- For an undimensioned 2D profile, infer and mark an approximate extrusion distance instead of silently pretending it was printed.

Dimension rules:
1. Transcribe every readable dimension exactly in millimetres and mark it confirmed.
2. If scale is absent, infer positive dimensions from image proportions, set the largest overall dimension to a sensible nominal engineering size, mark every inferred feature approximate, and describe the scale assumption.
3. NEVER use 0 as a placeholder. Every width, height, length, distance, diameter, radius, thickness, wing, return or flange is strictly greater than zero.
4. A coordinate or signed offset may legitimately equal zero. Do not confuse coordinates with sizes.
5. Preserve holes, repeated patterns, separate rails/flanges/panels, thicknesses, offsets and component transforms. Make an evidence string for every visible decision.
6. If a visible feature cannot be represented with the supported vocabulary, keep it in visibleDetails and unresolvedQuestions; never hide it by inventing a box.

All item transforms are in one shared XYZ assembly coordinate system (millimetres and XYZ Euler degrees), enabling deterministic gap/contact/interference checks. Annotation/view boxes are percentages from the image top-left and must have positive width and height. The server will reject invalid or incomplete recipes.

Deterministic browser evidence (supporting evidence only; the image remains authoritative): ${JSON.stringify(visualEvidence || {})}`;

function finalize(content, model, responseId, usage) {
  content.items = Array.isArray(content.items) ? content.items : [];
  content.features = Array.isArray(content.features) ? content.features : [];
  content.annotations = Array.isArray(content.annotations) ? content.annotations : [];
  content.assumptions = Array.isArray(content.assumptions) ? content.assumptions : [];
  content.unresolvedQuestions = Array.isArray(content.unresolvedQuestions) ? content.unresolvedQuestions : [];
  content.parameters = Object.fromEntries(content.features.map(feature => [feature.id, feature.parameters]));
  const validation = validateGeometryDocument(content);
  if (validation.skippedItemIds.length) {
    validation.valid = false;
    validation.errors.push(`Visible items without buildable geometry: ${validation.skippedItemIds.join(", ")}.`);
  }
  content.geometryValidation = validation;
  content.dimensionLedger = buildDimensionLedger(content);
  content.stepEligible = validation.valid;
  content.layout = { documentType: content.documentType, items: content.items, documentEvidence: content.evidence || [] };
  content.classification = { family: content.documentType, confidence: content.features.length ? Math.min(...content.features.map(feature => Number(feature.confidence) || 0)) : 0, evidence: content.evidence || [] };
  content.engine = { kind: "hosted", provider: "openai", model, externalApiUsed: true, responseId, usage };
  return content;
}

export async function analyzeWithOpenAI({ apiKey, baseUrl = "https://api.openai.com/v1", model, imageDataUrl, visualEvidence, detailed = false }) {
  if (!apiKey) throw new OpenAIError("OPENAI_API_KEY is not configured.", 503, "not_configured");
  const first = await requestStructured({ apiKey, baseUrl, model, imageDataUrl, prompt: reconstructionPrompt(visualEvidence), effort: detailed ? "high" : "medium" });
  let result = finalize(first.content, model, first.responseId, first.usage);
  const requiresRepair = !result.geometryValidation.valid;
  if (detailed || requiresRepair) {
    const reviewPrompt = `${reconstructionPrompt(visualEvidence)}\n\nThis is an independent verification and correction pass. Compare the candidate below against the image line by line and component by component. Return the COMPLETE corrected document, not a patch. Validation errors are mandatory to fix. Do not delete a visible detail just to make validation pass.\n\nCandidate: ${JSON.stringify(first.content)}\n\nValidation errors: ${JSON.stringify(result.geometryValidation.errors)}`;
    const reviewed = await requestStructured({ apiKey, baseUrl, model, imageDataUrl, prompt: reviewPrompt, effort: "high" });
    result = finalize(reviewed.content, model, reviewed.responseId, reviewed.usage);
    result.engine.verificationPass = true;
  }
  return result;
}
