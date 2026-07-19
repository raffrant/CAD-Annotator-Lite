import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { collectFeatures, validateGeometryDocument } from "../lib/geometry-contract.mjs";
import { buildDimensionLedger } from "../lib/dimension-ledger.mjs";

test("validates and de-duplicates a positioned multi-item assembly", async () => {
  const document = JSON.parse(await readFile(new URL("./fixtures/merged-items.json", import.meta.url), "utf8"));
  const features = collectFeatures(document);
  const validation = validateGeometryDocument(document);
  assert.equal(features.length, 3);
  assert.equal(validation.valid, true);
  assert.equal(validation.featureCount, 3);
  assert.equal(validation.solidCount, 3);
  assert.deepEqual(validation.skippedItemIds, []);
});

test("rejects invalid dimensions and ambiguous base recipes before Python", () => {
  const validation = validateGeometryDocument({
    items: [{ id: "I-1" }],
    features: [
      { id: "F-1", itemId: "I-1", operation: "box", parameters: { length: 100, width: -2, height: 10 } },
      { id: "F-2", itemId: "I-1", operation: "cylinder", parameters: { radius: 4, height: 20 } },
    ],
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /width must be a positive number/i);
  assert.match(validation.errors.join(" "), /exactly one base recipe/i);
});

test("validates the dimension-solved three-hole tray bracket", () => {
  const parameters = {
    width:75, depth:40, height:40, wallThickness:10, baseThickness:10,
    holeDiameter:12, backHoleCenters:[[15,25],[50,25]], sideHoleCenters:[[25,25]],
    innerRadius:3, chamferSize:3,
  };
  const document = { items:[{id:"I-1"}], features:[{id:"F-1",itemId:"I-1",operation:"tray_bracket",parameters}] };
  assert.equal(validateGeometryDocument(document).valid, true);
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.innerRadius = 10;
  unsafe.features[0].parameters.backHoleCenters[0] = [2, 25];
  const validation = validateGeometryDocument(unsafe);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /innerRadius must be smaller/i);
  assert.match(validation.errors.join(" "), /falls outside the back wall/i);
});

test("preserves upper, body, and lower corner layers as three solids", () => {
  const items = [
    {id:"I-BODY",transform:{position:[0,0,18],rotation:[0,0,0]}},
    {id:"I-TOP",transform:{position:[0,0,2382],rotation:[0,0,0]}},
    {id:"I-BOTTOM",transform:{position:[0,0,0],rotation:[0,0,0]}},
  ];
  const features = [
    {id:"F-BODY",itemId:"I-BODY",operation:"corner_guard",parameters:{height:2364,leftWing:2380,rightWing:1510,thickness:18}},
    {id:"F-TOP",itemId:"I-TOP",operation:"corner_cap",parameters:{leftWing:2380,rightWing:1510,returnDepth:60,thickness:18}},
    {id:"F-BOTTOM",itemId:"I-BOTTOM",operation:"corner_cap",parameters:{leftWing:2380,rightWing:1510,returnDepth:84,thickness:18}},
  ];
  const validation = validateGeometryDocument({items,features});
  assert.equal(validation.valid, true);
  assert.equal(validation.solidCount, 3);
});

test("validates a reinforced gusset bracket and all three through-holes", () => {
  const parameters = {
    baseLength:100, baseWidth:80, baseThickness:10,
    uprightHeight:100, uprightThickness:10,
    uprightHoleDiameter:36, uprightHoleCenter:[40,64],
    baseHoleDiameter:12, baseHoleCenters:[[58,24],[58,56]],
    gussetLength:65, gussetHeight:82, gussetThickness:8, edgeRadius:15,
  };
  const document = {items:[{id:"I-1"}],features:[{id:"F-1",itemId:"I-1",operation:"gusset_bracket",parameters}]};
  assert.equal(validateGeometryDocument(document).valid, true);
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.uprightHoleCenter = [2, 99];
  unsafe.features[0].parameters.baseHoleCenters[0] = [99, 2];
  const validation = validateGeometryDocument(unsafe);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /upright hole falls outside/i);
  assert.match(validation.errors.join(" "), /base hole center.*falls outside/i);
});

test("validates a dimensioned fork plate and rejects impossible radii", () => {
  const parameters = {centerFromOpenEnd:38,slotLength:30,outerRadius:30,innerRadius:15,armWidth:15,slotWidth:10,thickness:15};
  const document = {items:[{id:"I-1"}],features:[{id:"F-1",itemId:"I-1",operation:"fork_plate",parameters}]};
  assert.equal(validateGeometryDocument(document).valid, true);
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.innerRadius = 30;
  unsafe.features[0].parameters.slotLength = 40;
  const validation = validateGeometryDocument(unsafe);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /innerRadius must be smaller/i);
  assert.match(validation.errors.join(" "), /slotLength must not exceed/i);
});

test("validates generalized sketches, constraints, operations and assemblies", async () => {
  const document = JSON.parse(await readFile(new URL("./fixtures/general-feature-tree.json",import.meta.url),"utf8"));
  const validation = validateGeometryDocument(document);
  assert.equal(validation.valid,true,validation.errors.join(" "));
  assert.equal(validation.solidCount,3);
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.operations[0].distance = 0;
  unsafe.features[1].parameters.operations[0].axisDirection = [0,0,0];
  unsafe.features[2].parameters.sketches[0].profiles[0].entities[0].end = [-15,-10];
  const rejected = validateGeometryDocument(unsafe);
  assert.equal(rejected.valid,false);
  assert.match(rejected.errors.join(" "),/extrusion distance must be positive/i);
  assert.match(rejected.errors.join(" "),/non-zero 3D axis/i);
  assert.match(rejected.errors.join(" "),/line endpoints must differ/i);
});

test("validates known physical properties without inventing missing density", () => {
  const document = {
    items:[{id:"I-1",physicalProperties:{role:"bracket",material:"steel",densityKgM3:7850}}],
    features:[{id:"F-1",itemId:"I-1",operation:"box",parameters:{length:10,width:10,height:10}}],
  };
  assert.equal(validateGeometryDocument(document).valid,true);
  document.items[0].physicalProperties.densityKgM3 = 0;
  const rejected = validateGeometryDocument(document);
  assert.equal(rejected.valid,false);
  assert.match(rejected.errors.join(" "),/densityKgM3 must be a positive number/i);
});

test("produces a complete typed ledger from executable dimensions and placement", () => {
  const document = {
    items:[{id:"I-1",transform:{position:[10,0,0],rotation:[0,0,90]}}],
    features:[{id:"F-1",itemId:"I-1",operation:"hole",status:"confirmed",confidence:.95,parameters:{diameter:12,center:[20,30],through:true}}],
  };
  const ledger = buildDimensionLedger(document);
  assert.equal(ledger.find(entry => entry.path === "parameters.diameter").unit,"mm");
  assert.equal(ledger.find(entry => entry.path === "parameters.diameter").source,"confirmed-from-drawing");
  assert.equal(ledger.find(entry => entry.path === "parameters.center").role,"coordinate");
  assert.equal(ledger.find(entry => entry.path === "transform.rotation").unit,"deg");
  assert.equal(ledger.some(entry => entry.path.endsWith("through")),false);
});

test("validates the exactly dimensioned R35/R20 arched plate", async () => {
  const document = JSON.parse(await readFile(new URL("./fixtures/arched-plate.json",import.meta.url),"utf8"));
  const validation = validateGeometryDocument(document);
  assert.equal(validation.valid,true,validation.errors.join(" "));
  const ledger = buildDimensionLedger(document);
  assert.equal(ledger.find(entry => entry.name === "outerRadius").source,"confirmed-from-drawing");
  assert.equal(ledger.find(entry => entry.name === "thickness").source,"inferred-from-image");
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.slotWidth = 65;
  assert.match(validateGeometryDocument(unsafe).errors.join(" "),/slot must stay inside/i);
});

test("validates the 175 mm R65 rounded-end plate with independent circular cuts", async () => {
  const document = JSON.parse(await readFile(new URL("./fixtures/rounded-end-plate.json",import.meta.url),"utf8"));
  const validation = validateGeometryDocument(document);
  assert.equal(validation.valid,true,validation.errors.join(" "));
  assert.equal(buildDimensionLedger(document).find(entry=>entry.name === "endRadius").source,"confirmed-from-drawing");
  const unsafe = structuredClone(document);
  unsafe.features[0].parameters.endRadius = 30;
  assert.match(validateGeometryDocument(unsafe).errors.join(" "),/endRadius must reach/i);
});
