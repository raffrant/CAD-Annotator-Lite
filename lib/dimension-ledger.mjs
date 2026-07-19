import { collectFeatures } from "./geometry-contract.mjs";

const anglePattern = /(^|\.)(angle|startAngle|endAngle|rotation)(\.|$)/i;
const countPattern = /(^|\.)(count|rows|columns|instances|edgeIndices)(\.|$)/i;
const coordinatePattern = /(^|\.)(center|centers|start|end|points|origin|position|axisOrigin|axisDirection)(\.|$)/i;

function roleFor(path) {
  if (anglePattern.test(path)) return "angle";
  if (countPattern.test(path)) return "count";
  if (coordinatePattern.test(path)) return "coordinate";
  return "size";
}

function unitFor(role, path) {
  if (role === "angle" || /rotation/i.test(path)) return "deg";
  if (role === "count" || /axisDirection/i.test(path)) return "unitless";
  return "mm";
}

function appendValues(output, value, path, context) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const role = roleFor(path);
    output.push({ ...context, path, name:path.split(".").at(-1), value, unit:unitFor(role,path), role });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length && value.every(entry => typeof entry === "number" && Number.isFinite(entry))) {
      const role = roleFor(path);
      output.push({ ...context, path, name:path.split(".").at(-1), value:[...value], unit:unitFor(role,path), role });
    } else value.forEach((entry,index) => appendValues(output,entry,`${path}[${index}]`,context));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key,entry] of Object.entries(value)) appendValues(output,entry,path ? `${path}.${key}` : key,context);
  }
}

export function buildDimensionLedger(data) {
  const output = [];
  for (const feature of collectFeatures(data)) {
    const start = output.length;
    appendValues(output,feature.parameters || {},"parameters",{
      itemId:feature.itemId || null,
      featureId:feature.id || null,
      operation:typeof feature.operation === "string" ? feature.operation : null,
      source:feature.status === "confirmed" ? "confirmed-from-drawing" : "inferred-from-image",
      confidence:Number.isFinite(Number(feature.confidence)) ? Number(feature.confidence) : null,
      evidence:Array.isArray(feature.evidence) ? feature.evidence : [],
    });
    const confirmed = new Set(Array.isArray(feature.confirmedParameters) ? feature.confirmedParameters : []);
    const inferred = new Set(Array.isArray(feature.inferredParameters) ? feature.inferredParameters : []);
    for (const entry of output.slice(start)) {
      const parameter = entry.path.replace(/^parameters\./,"").match(/^[^.\[]+/)?.[0];
      if (confirmed.has(parameter)) entry.source = "confirmed-from-drawing";
      if (inferred.has(parameter)) entry.source = "inferred-from-image";
    }
  }
  for (const item of Array.isArray(data?.items) ? data.items : []) {
    appendValues(output,item.transform || {},"transform",{
      itemId:item.id || null,
      featureId:null,
      operation:"assembly_transform",
      source:"assembly-placement",
      confidence:null,
      evidence:Array.isArray(item.separationEvidence) ? item.separationEvidence : [],
    });
  }
  return output.map((entry,index) => ({ id:`D-${String(index+1).padStart(4,"0")}`,...entry }));
}
