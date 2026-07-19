import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
delete process.env.OPENAI_API_KEY;
process.env.AI_PROVIDER = "ollama";
const { server, normalizeGeneralizedContent, ollamaJson, isUnderconstrainedAutomotiveReference } = await import("../server.mjs");

test("blocks unscaled automotive reference crops before fake 3D generation", () => {
  const reference = {documentType:"mechanical_part_render",multipleNamedOrthographicViews:false,items:[{label:"Car door",visibleDetails:["door handle","window frame","side mirror","body panel seam","wheel arch"]}]};
  assert.equal(isUnderconstrainedAutomotiveReference(reference),true);
  assert.equal(isUnderconstrainedAutomotiveReference({...reference,documentType:"mechanical_part_drawing",multipleNamedOrthographicViews:true}),true);
  assert.equal(isUnderconstrainedAutomotiveReference({...reference,documentEvidence:["overall width 1200 mm"]}),false);
});

test("retries length-truncated Ollama JSON with more output space", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const value = requests.length === 1
      ? {message:{content:'{"summary":"unfinished'},done_reason:"length"}
      : {message:{content:'{"summary":"complete"}'},done_reason:"stop"};
    return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
  };
  try {
    assert.deepEqual(await ollamaJson("base64-image","return JSON",100),{summary:"complete"});
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.length,2);
  assert.equal(requests[0].options.num_ctx >= 16384,true);
  assert.equal(requests[1].options.num_ctx >= requests[0].options.num_ctx,true);
  assert.equal(requests[1].options.num_ctx >= 24576,true);
  assert.equal(requests[1].options.num_predict,5000);
  assert.match(requests[1].messages[0].content,/previous answer was truncated/i);
});

test("normalizes Ollama operation objects into the geometry contract", () => {
  const sketches = [{id:"S-1",plane:"XY|XZ|YZ",origin:[0,0,0],profiles:[{id:"P-INNER",entities:[{id:"E-1",type:"polyline",points:[[0,0],[10,0],[10,10],[0,10]],closed:true},{id:"E-5",type:"circle",center:[5,5],radius:2}]}],constraints:[{type:"fixed",refs:["E-1"],value:null}]}];
  const operations = [{id:"O-1",type:"extrude",sketchId:"S-1",outerProfileId:"P-1",holeProfileIds:["P-INNER"],distance:10,mode:"new"}];
  const content = { items:[{id:"I-1",features:[{
    id:"F-1", itemId:"I-1",
    operation:{type:"feature_tree",parameters:{sketches,operations}},
  }]}] };
  normalizeGeneralizedContent(content);
  const feature = content.items[0].features[0];
  assert.equal(feature.operation,"feature_tree");
  assert.equal(feature.parameters.sketches[0].plane,"XY");
  assert.equal("value" in feature.parameters.sketches[0].constraints[0],false);
  assert.deepEqual(feature.parameters.sketches[0].profiles.map(profile => profile.id),["P-INNER","P-INNER-C1"]);
  assert.deepEqual(feature.parameters.operations[0].holeProfileIds,["P-INNER","P-INNER-C1"]);
  assert.equal(feature.parameters.sketches,sketches);
  assert.equal(feature.parameters.operations[0].symmetric,false);
});

test("serves health, validates analysis input, and rejects invalid geometry", async (context) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(health.mode, "offline");
  assert.equal(health.model, "qwen3-vl:4b");
  assert.equal(health.defaultProvider, "ollama");
  const response = await fetch(`${base}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /missing base64 image/i);
  const nonBuildable = await fetch(`${base}/local/export-step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentType: "architectural_plan", stepEligible: false, items: [], features: [] }),
  });
  assert.equal(nonBuildable.status, 422);
  assert.match((await nonBuildable.json()).error, /no buildable geometry features/i);
  const invalidGeometry = await fetch(`${base}/local/export-step`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ id: "I-1" }], features: [{ id: "F-1", itemId: "I-1", operation: "box", parameters: { length: 10, width: 0, height: 2 } }] }),
  });
  assert.equal(invalidGeometry.status, 422);
  assert.match((await invalidGeometry.json()).error, /geometry validation failed.*width must be a positive number/i);
  if (health.freecadReady) {
    const fixture = await readFile(new URL("./fixtures/physics-assembly.json", import.meta.url), "utf8");
    const checked = await fetch(`${base}/api/physics-check`, { method:"POST", headers:{"content-type":"application/json"}, body:fixture });
    assert.equal(checked.status,200);
    const report = await checked.json();
    assert.equal(report.valid,true);
    assert.equal(report.bodyCount,3);
    assert.equal(report.stepSolidCount,3);
    assert.equal(report.massComplete,false);
    assert.deepEqual(report.unknownDensityItemIds,["I-TOUCH"]);
    assert.equal(report.relations.find(value => value.itemA === "I-STEEL" && value.itemB === "I-TOUCH").relation,"contact");
    assert.equal(report.relations.find(value => value.itemA === "I-TOUCH" && value.itemB === "I-OVERLAP").relation,"interference");
  }
});
