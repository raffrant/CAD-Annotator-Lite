import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWithOpenAI, CAD_RESPONSE_SCHEMA, OpenAIError } from "../lib/openai-cad.mjs";

test("hosted schema forbids zero sizes but permits zero coordinates", () => {
  const variants = CAD_RESPONSE_SCHEMA.properties.features.items.anyOf;
  const byOperation = Object.fromEntries(variants.map(variant => [variant.properties.operation.const, variant]));
  for (const [operation, keys] of Object.entries({
    box: ["length", "width", "height"],
    cylinder: ["radius", "height"],
    corner_guard: ["height", "leftWing", "rightWing", "thickness"],
    corner_cap: ["leftWing", "rightWing", "returnDepth", "thickness"],
    gusset_bracket: ["baseLength", "baseWidth", "baseThickness", "uprightHeight", "uprightThickness", "uprightHoleDiameter", "baseHoleDiameter", "gussetLength", "gussetHeight", "gussetThickness", "edgeRadius"],
    fork_plate: ["centerFromOpenEnd", "slotLength", "outerRadius", "innerRadius", "armWidth", "slotWidth", "thickness"],
    direct_transition: ["inletWidth", "inletHeight", "outletWidth", "outletHeight", "length", "thickness", "inletFlange", "outletFlange"],
  })) {
    for (const key of keys) assert.equal(byOperation[operation].properties.parameters.properties[key].exclusiveMinimum, 0);
  }
  assert.equal(byOperation.direct_transition.properties.parameters.properties.offsetX.exclusiveMinimum, undefined);
  assert.equal(byOperation.direct_transition.properties.parameters.properties.offsetY.exclusiveMinimum, undefined);
  const tree = byOperation.feature_tree.properties.parameters.properties;
  assert.equal(tree.sketches.items.properties.plane.enum.includes("XZ"),true);
  const entityTypes = tree.sketches.items.properties.profiles.items.properties.entities.items.anyOf.map(value=>value.properties.type.const);
  assert.deepEqual(entityTypes,["line","arc","circle","polyline"]);
  const operationTypes = tree.operations.items.anyOf.map(value=>value.properties.type.const);
  assert.deepEqual(operationTypes,["extrude","revolve","fillet","chamfer"]);
});

test("hosted analyzer preserves OpenAI 429 instead of converting it to 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      analyzeWithOpenAI({ apiKey: "test", model: "test", imageDataUrl: "data:image/png;base64,AA==" }),
      error => error instanceof OpenAIError && error.status === 429 && /billing\/credits/i.test(error.message),
    );
  } finally { globalThis.fetch = originalFetch; }
});

test("hosted structured result passes the same geometry contract used by STEP", async () => {
  const originalFetch = globalThis.fetch;
  const content = {
    summary: "Two-wing corner guard",
    documentType: "mechanical_part_render",
    items: [{ id: "I-1", label: "Corner guard", kind: "mechanical_part", transform: { position: [0, 0, 0], rotation: [0, 0, 0] }, views: [{ view: "isometric", box: { x: 1, y: 1, width: 98, height: 98 } }], visibleDetails: ["two wings", "top and bottom returns"] }],
    annotations: [],
    features: [{ id: "F-1", itemId: "I-1", operation: "corner_guard", parameters: { height: 2400, leftWing: 2380, rightWing: 1510, thickness: 18 }, evidence: ["visible seam and paired borders"], confidence: .8, status: "approximate" }],
    assumptions: ["No printed scale; 2400 mm nominal height."],
    unresolvedQuestions: [],
    evidence: ["Three long vertical boundaries."],
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "resp_test", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(content) }] }], usage: { total_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await analyzeWithOpenAI({ apiKey: "test", model: "test", imageDataUrl: "data:image/png;base64,AA==" });
    assert.equal(result.geometryValidation.valid, true);
    assert.equal(result.stepEligible, true);
    assert.equal(result.engine.kind, "hosted");
    assert.equal(result.engine.externalApiUsed, true);
  } finally { globalThis.fetch = originalFetch; }
});
