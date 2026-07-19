export const SUPPORTED_OPERATIONS = new Set([
  "rectangle", "extrude", "pad", "hole", "hole_pattern", "fillet", "fillet_edges",
  "corner_guard", "corner_cap", "direct_transition", "tray_bracket", "gusset_bracket", "fork_plate", "arched_plate", "rounded_end_plate", "feature_tree", "box", "cylinder",
]);

const isNumber = value => Number.isFinite(Number(value));
const positive = value => isNumber(value) && Number(value) > 0;
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(isNumber);
const SKETCH_PLANES = new Set(["XY", "XZ", "YZ"]);
const CONSTRAINT_TYPES = new Set(["horizontal", "vertical", "coincident", "tangent", "parallel", "perpendicular", "equal", "distance", "radius", "diameter", "angle", "fixed"]);

function validateFeatureTree(params, label, errors) {
  const sketches = params.sketches, operations = params.operations;
  if (!Array.isArray(sketches) || !sketches.length) errors.push(`${label}: feature_tree needs one or more sketches.`);
  if (!Array.isArray(operations) || !operations.length) errors.push(`${label}: feature_tree needs one or more operations.`);
  if (!Array.isArray(sketches) || !Array.isArray(operations)) return;
  const sketchIds = new Set(), profileIds = new Map();
  for (const [sketchIndex, sketch] of sketches.entries()) {
    const sketchLabel = `${label} sketch ${sketch?.id || sketchIndex + 1}`;
    if (!sketch?.id || sketchIds.has(sketch.id)) errors.push(`${sketchLabel}: id must be present and unique.`);
    else sketchIds.add(sketch.id);
    if (!SKETCH_PLANES.has(sketch?.plane)) errors.push(`${sketchLabel}: plane must be XY, XZ or YZ.`);
    if (sketch?.origin !== undefined && !vector(sketch.origin, 3)) errors.push(`${sketchLabel}: origin must be [x,y,z].`);
    if (!Array.isArray(sketch?.profiles) || !sketch.profiles.length) { errors.push(`${sketchLabel}: profiles must not be empty.`); continue; }
    const ids = new Set(), entityIds = new Set(); profileIds.set(sketch.id, ids);
    for (const [profileIndex, profile] of sketch.profiles.entries()) {
      const profileLabel = `${sketchLabel} profile ${profile?.id || profileIndex + 1}`;
      if (!profile?.id || ids.has(profile.id)) errors.push(`${profileLabel}: id must be present and unique within the sketch.`);
      else ids.add(profile.id);
      if (!Array.isArray(profile?.entities) || !profile.entities.length) { errors.push(`${profileLabel}: entities must not be empty.`); continue; }
      for (const [entityIndex, entity] of profile.entities.entries()) {
        const entityLabel = `${profileLabel} entity ${entity?.id || entityIndex + 1}`;
        if (!entity?.id || entityIds.has(entity.id)) errors.push(`${entityLabel}: id must be present and unique within the sketch.`);
        else entityIds.add(entity.id);
        if (entity?.type === "line") {
          if (!vector(entity.start,2) || !vector(entity.end,2)) errors.push(`${entityLabel}: line needs start/end [x,y].`);
          else if (Number(entity.start[0]) === Number(entity.end[0]) && Number(entity.start[1]) === Number(entity.end[1])) errors.push(`${entityLabel}: line endpoints must differ.`);
        } else if (entity?.type === "arc") {
          if (!vector(entity.center,2) || !positive(entity.radius) || !isNumber(entity.startAngle) || !isNumber(entity.endAngle) || Number(entity.startAngle) === Number(entity.endAngle)) errors.push(`${entityLabel}: arc needs center, positive radius and distinct numeric angles.`);
        } else if (entity?.type === "circle") {
          if (!vector(entity.center,2) || !positive(entity.radius)) errors.push(`${entityLabel}: circle needs center and positive radius.`);
          if (profile.entities.length !== 1) errors.push(`${entityLabel}: a circle must be the only entity in its profile.`);
        } else if (entity?.type === "polyline") {
          if (!Array.isArray(entity.points) || entity.points.length < 3 || entity.points.some(point => !vector(point,2)) || entity.closed !== true) errors.push(`${entityLabel}: polyline needs at least three points and closed=true.`);
        } else errors.push(`${entityLabel}: unsupported entity type ${String(entity?.type)}.`);
      }
    }
    for (const [constraintIndex,constraint] of (Array.isArray(sketch.constraints) ? sketch.constraints : []).entries()) {
      const constraintLabel = `${sketchLabel} constraint ${constraintIndex+1}`;
      if (!CONSTRAINT_TYPES.has(constraint?.type)) errors.push(`${constraintLabel}: unsupported constraint type ${String(constraint?.type)}.`);
      if (!Array.isArray(constraint?.refs) || !constraint.refs.length || constraint.refs.some(ref => typeof ref !== "string" || !ref)) errors.push(`${constraintLabel}: refs must contain entity ids.`);
      else if (constraint.refs.some(ref => !entityIds.has(ref))) errors.push(`${constraintLabel}: refs must reference entities in the same sketch.`);
      if (constraint?.value !== undefined && !isNumber(constraint.value)) errors.push(`${constraintLabel}: value must be numeric.`);
    }
  }
  let hasSolid = false;
  for (const [operationIndex, operation] of operations.entries()) {
    const operationLabel = `${label} operation ${operation?.id || operationIndex+1}`;
    if (!operation?.id) errors.push(`${operationLabel}: id is required.`);
    if (["extrude","revolve"].includes(operation?.type)) {
      if (!sketchIds.has(operation.sketchId)) errors.push(`${operationLabel}: unknown sketchId ${String(operation.sketchId)}.`);
      const ids = profileIds.get(operation.sketchId);
      if (!ids?.has(operation.outerProfileId)) errors.push(`${operationLabel}: unknown outerProfileId ${String(operation.outerProfileId)}.`);
      if (!Array.isArray(operation.holeProfileIds) || operation.holeProfileIds.some(id => !ids?.has(id))) errors.push(`${operationLabel}: holeProfileIds must reference profiles in the same sketch.`);
      if (!new Set(["new","add","cut","intersect"]).has(operation.mode)) errors.push(`${operationLabel}: mode must be new, add, cut or intersect.`);
      if (!hasSolid && operation.mode !== "new") errors.push(`${operationLabel}: the first solid operation must use mode=new.`);
      if (hasSolid && operation.mode === "new") errors.push(`${operationLabel}: only the first solid operation may use mode=new within one body.`);
      if (operation.type === "extrude" && !positive(operation.distance)) errors.push(`${operationLabel}: extrusion distance must be positive.`);
      if (operation.type === "revolve") {
        if (!vector(operation.axisOrigin,3) || !vector(operation.axisDirection,3) || operation.axisDirection.every(value => Number(value) === 0)) errors.push(`${operationLabel}: revolve needs a non-zero 3D axis.`);
        if (!positive(operation.angle) || Number(operation.angle) > 360) errors.push(`${operationLabel}: revolve angle must be in (0,360].`);
      }
      hasSolid = true;
    } else if (["fillet","chamfer"].includes(operation?.type)) {
      if (!hasSolid) errors.push(`${operationLabel}: ${operation.type} requires a preceding solid operation.`);
      if (!positive(operation.radius ?? operation.distance)) errors.push(`${operationLabel}: ${operation.type} size must be positive.`);
      if (operation.edgeIndices !== undefined && (!Array.isArray(operation.edgeIndices) || operation.edgeIndices.some(index => !Number.isInteger(Number(index)) || Number(index) < 1))) errors.push(`${operationLabel}: edgeIndices must contain positive 1-based integers.`);
      if (operation.edgeSelector !== undefined && !new Set(["all","vertical","horizontal","circular","longest"]).has(operation.edgeSelector)) errors.push(`${operationLabel}: unsupported edgeSelector.`);
    } else errors.push(`${operationLabel}: unsupported operation type ${String(operation?.type)}.`);
  }
}

export function collectFeatures(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const defaultItemId = items.length === 1 && items[0]?.id ? items[0].id : "I-1";
  const nested = [];
  const nestedIds = new Map();
  for (const item of items) {
    for (const feature of Array.isArray(item?.features) ? item.features : []) {
      const copy = { ...feature, itemId: feature.itemId || item.id || defaultItemId };
      nested.push(copy);
      if (copy.id) {
        if (!nestedIds.has(copy.id)) nestedIds.set(copy.id, new Set());
        nestedIds.get(copy.id).add(copy.itemId);
      }
    }
  }
  const candidates = [];
  for (const feature of Array.isArray(data?.features) ? data.features : []) {
    const copy = { ...feature };
    const possible = nestedIds.get(copy.id);
    if (!copy.itemId && possible?.size === 1) copy.itemId = [...possible][0];
    copy.itemId ||= defaultItemId;
    candidates.push(copy);
  }
  candidates.push(...nested);
  const result = [];
  const seen = new Set();
  for (const feature of candidates) {
    const identity = feature.id || JSON.stringify(Object.fromEntries(Object.entries(feature).filter(([key]) => key !== "itemId")));
    const key = `${feature.itemId}\u0000${identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(feature);
  }
  return result;
}

function validateParameters(feature, label, errors) {
  const operation = feature.operation;
  const params = feature.parameters;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    errors.push(`${label}: parameters must be one object.`);
    return;
  }
  const requirePositive = names => {
    for (const name of names) if (!positive(params[name])) errors.push(`${label}: ${name} must be a positive number.`);
  };
  if (operation === "rectangle") requirePositive(["width", "height"]);
  else if (operation === "extrude" || operation === "pad") {
    if (!positive(params.distance ?? params.depth)) errors.push(`${label}: distance or depth must be a positive number.`);
  } else if (operation === "hole") {
    requirePositive(["diameter"]);
    if (params.center !== undefined && !vector(params.center, 2)) errors.push(`${label}: center must be [x,y].`);
  } else if (operation === "hole_pattern") {
    requirePositive(["diameter"]);
    if (!Array.isArray(params.centers) || !params.centers.length || params.centers.some(center => !vector(center, 2))) errors.push(`${label}: centers must contain one or more [x,y] points.`);
  } else if (operation === "fillet" || operation === "fillet_edges") requirePositive(["radius"]);
  else if (operation === "box") requirePositive(["length", "width", "height"]);
  else if (operation === "cylinder") requirePositive(["radius", "height"]);
  else if (operation === "corner_guard") requirePositive(["height", "leftWing", "rightWing", "thickness"]);
  else if (operation === "corner_cap") requirePositive(["leftWing", "rightWing", "returnDepth", "thickness"]);
  else if (operation === "gusset_bracket") {
    requirePositive(["baseLength", "baseWidth", "baseThickness", "uprightHeight", "uprightThickness", "uprightHoleDiameter", "baseHoleDiameter", "gussetLength", "gussetHeight", "gussetThickness", "edgeRadius"]);
    if (!vector(params.uprightHoleCenter, 2)) errors.push(`${label}: uprightHoleCenter must be [y,z].`);
    if (!Array.isArray(params.baseHoleCenters) || params.baseHoleCenters.length !== 2 || params.baseHoleCenters.some(center => !vector(center, 2))) errors.push(`${label}: baseHoleCenters must contain exactly two [x,y] points.`);
    if (positive(params.edgeRadius) && positive(params.baseWidth) && Number(params.edgeRadius) * 2 >= Number(params.baseWidth)) errors.push(`${label}: edgeRadius must be smaller than half the baseWidth.`);
    if (positive(params.uprightHoleDiameter) && vector(params.uprightHoleCenter, 2)) {
      const r = Number(params.uprightHoleDiameter)/2, y = Number(params.uprightHoleCenter[0]), z = Number(params.uprightHoleCenter[1]);
      if (y < r || y > Number(params.baseWidth)-r || z < Number(params.baseThickness)+r || z > Number(params.uprightHeight)-r) errors.push(`${label}: upright hole falls outside the vertical plate.`);
    }
    if (positive(params.baseHoleDiameter)) {
      const r = Number(params.baseHoleDiameter)/2;
      for (const center of Array.isArray(params.baseHoleCenters) ? params.baseHoleCenters : []) if (vector(center,2) && (Number(center[0]) < r || Number(center[0]) > Number(params.baseLength)-r || Number(center[1]) < r || Number(center[1]) > Number(params.baseWidth)-r)) errors.push(`${label}: base hole center [${center}] falls outside the base.`);
    }
  }
  else if (operation === "fork_plate") {
    requirePositive(["centerFromOpenEnd", "slotLength", "outerRadius", "innerRadius", "armWidth", "slotWidth", "thickness"]);
    if (positive(params.innerRadius) && positive(params.outerRadius) && Number(params.innerRadius) >= Number(params.outerRadius)) errors.push(`${label}: innerRadius must be smaller than outerRadius.`);
    if (positive(params.slotLength) && positive(params.centerFromOpenEnd) && Number(params.slotLength) > Number(params.centerFromOpenEnd)) errors.push(`${label}: slotLength must not exceed centerFromOpenEnd.`);
    if ([params.armWidth,params.slotWidth,params.outerRadius].every(positive) && 2*Number(params.armWidth)+Number(params.slotWidth) > 2*Number(params.outerRadius)) errors.push(`${label}: arms and slot exceed the outer diameter.`);
  }
  else if (operation === "arched_plate") {
    requirePositive(["outerWidth","straightHeight","outerRadius","innerRadius","slotWidth","slotHeight","slotLeftOffset","slotBottomOffset","thickness"]);
    if ([params.outerWidth,params.outerRadius].every(positive) && Math.abs(Number(params.outerWidth)-2*Number(params.outerRadius)) > Math.max(1,Number(params.outerWidth)*.03)) errors.push(`${label}: outerWidth must equal the R crown diameter.`);
    if ([params.innerRadius,params.outerRadius].every(positive) && Number(params.innerRadius) >= Number(params.outerRadius)) errors.push(`${label}: innerRadius must be smaller than outerRadius.`);
    if ([params.slotLeftOffset,params.slotWidth,params.outerWidth].every(positive) && Number(params.slotLeftOffset)+Number(params.slotWidth) >= Number(params.outerWidth)) errors.push(`${label}: rectangular slot must stay inside the side edges.`);
    if ([params.slotBottomOffset,params.slotHeight,params.straightHeight].every(positive) && Number(params.slotBottomOffset)+Number(params.slotHeight) >= Number(params.straightHeight)) errors.push(`${label}: rectangular slot must stay below the crown tangent.`);
  }
  else if (operation === "rounded_end_plate") {
    requirePositive(["overallWidth","overallHeight","endRadius","cornerRadius","centerHoleDiameter","mountingHoleRadius","notchDepth","notchHeight","thickness"]);
    if (!vector(params.centerHoleCenter,2)) errors.push(`${label}: centerHoleCenter must be [x,y].`);
    if (!Array.isArray(params.mountingHoleCenters) || !params.mountingHoleCenters.length || params.mountingHoleCenters.some(center=>!vector(center,2))) errors.push(`${label}: mountingHoleCenters must contain [x,y] points.`);
    if ([params.endRadius,params.overallHeight].every(positive) && Number(params.endRadius) < Number(params.overallHeight)/2) errors.push(`${label}: endRadius must reach the top and bottom edges.`);
    if ([params.cornerRadius,params.overallHeight].every(positive) && Number(params.cornerRadius)*2 >= Number(params.overallHeight)) errors.push(`${label}: cornerRadius must be smaller than half the height.`);
    if ([params.notchHeight,params.overallHeight].every(positive) && Number(params.notchHeight) >= Number(params.overallHeight)) errors.push(`${label}: notchHeight must be smaller than overallHeight.`);
    if ([params.notchDepth,params.overallWidth].every(positive) && Number(params.notchDepth) >= Number(params.overallWidth)) errors.push(`${label}: notchDepth must be smaller than overallWidth.`);
  }
  else if (operation === "feature_tree") validateFeatureTree(params,label,errors);
  else if (operation === "tray_bracket") {
    requirePositive(["width", "depth", "height", "wallThickness", "baseThickness", "holeDiameter", "innerRadius", "chamferSize"]);
    const back = params.backHoleCenters, side = params.sideHoleCenters;
    if (!Array.isArray(back) || back.length !== 2 || back.some(center => !vector(center, 2))) errors.push(`${label}: backHoleCenters must contain exactly two [x,z] points.`);
    if (!Array.isArray(side) || side.length !== 1 || side.some(center => !vector(center, 2))) errors.push(`${label}: sideHoleCenters must contain exactly one [y,z] point.`);
    if (positive(params.wallThickness) && positive(params.width) && Number(params.wallThickness) >= Number(params.width)) errors.push(`${label}: wallThickness must be smaller than width.`);
    if (positive(params.wallThickness) && positive(params.depth) && Number(params.wallThickness) >= Number(params.depth)) errors.push(`${label}: wallThickness must be smaller than depth.`);
    if (positive(params.baseThickness) && positive(params.height) && Number(params.baseThickness) >= Number(params.height)) errors.push(`${label}: baseThickness must be smaller than height.`);
    if (positive(params.innerRadius) && positive(params.wallThickness) && positive(params.baseThickness) && Number(params.innerRadius) >= Math.min(Number(params.wallThickness), Number(params.baseThickness))) errors.push(`${label}: innerRadius must be smaller than the wall and base thicknesses.`);
    if (positive(params.chamferSize) && positive(params.wallThickness) && Number(params.chamferSize) >= Number(params.wallThickness)) errors.push(`${label}: chamferSize must be smaller than wallThickness.`);
    if (positive(params.holeDiameter)) {
      const r = Number(params.holeDiameter) / 2, width = Number(params.width), depth = Number(params.depth), height = Number(params.height), base = Number(params.baseThickness);
      for (const center of Array.isArray(back) ? back : []) if (vector(center, 2) && (Number(center[0]) < r || Number(center[0]) > width - r || Number(center[1]) < base + r || Number(center[1]) > height - r)) errors.push(`${label}: back hole center [${center}] falls outside the back wall.`);
      for (const center of Array.isArray(side) ? side : []) if (vector(center, 2) && (Number(center[0]) < r || Number(center[0]) > depth - r || Number(center[1]) < base + r || Number(center[1]) > height - r)) errors.push(`${label}: side hole center [${center}] falls outside the side wall.`);
    }
  }
  else if (operation === "direct_transition") {
    requirePositive(["inletWidth", "inletHeight", "outletWidth", "outletHeight", "length", "thickness"]);
    if (positive(params.thickness) && [params.inletWidth, params.inletHeight, params.outletWidth, params.outletHeight].some(size => positive(size) && Number(size) <= 2 * Number(params.thickness))) errors.push(`${label}: opening dimensions must exceed twice the wall thickness.`);
  }
}

export function validateGeometryDocument(data) {
  const errors = [];
  const warnings = [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const itemIds = new Set(items.map(item => item?.id).filter(Boolean));
  const features = collectFeatures(data);
  const groups = new Map();

  for (const [index, item] of items.entries()) {
    if (!item?.id) errors.push(`Item ${index + 1}: id is required.`);
    const physical = item?.physicalProperties;
    if (physical !== undefined) {
      if (!physical || typeof physical !== "object" || Array.isArray(physical)) errors.push(`Item ${item.id || index + 1}: physicalProperties must be an object.`);
      else {
        if (physical.densityKgM3 !== undefined && physical.densityKgM3 !== null && !positive(physical.densityKgM3)) errors.push(`Item ${item.id || index + 1}: densityKgM3 must be a positive number when known.`);
        if (physical.material !== undefined && physical.material !== null && typeof physical.material !== "string") errors.push(`Item ${item.id || index + 1}: material must be text when known.`);
        if (physical.role !== undefined && typeof physical.role !== "string") errors.push(`Item ${item.id || index + 1}: physical role must be text.`);
      }
    }
    const transform = item?.transform;
    if (transform) {
      if (!vector(transform.position ?? [0, 0, 0], 3)) errors.push(`Item ${item.id || index + 1}: transform.position must be [x,y,z].`);
      if (!vector(transform.rotation ?? [0, 0, 0], 3)) errors.push(`Item ${item.id || index + 1}: transform.rotation must be [rx,ry,rz].`);
    }
  }

  for (const [index, feature] of features.entries()) {
    const label = `Feature ${feature?.id || index + 1}`;
    if (!feature || typeof feature !== "object") { errors.push(`${label}: must be an object.`); continue; }
    if (!feature.id) errors.push(`${label}: id is required.`);
    if (!SUPPORTED_OPERATIONS.has(feature.operation)) errors.push(`${label}: unsupported operation ${String(feature.operation)}.`);
    else validateParameters(feature, label, errors);
    if (items.length > 1 && !feature.itemId) errors.push(`${label}: itemId is required for an assembly.`);
    if (itemIds.size && !itemIds.has(feature.itemId)) errors.push(`${label}: itemId ${feature.itemId} does not match an item.`);
    if (!groups.has(feature.itemId)) groups.set(feature.itemId, []);
    groups.get(feature.itemId).push(feature);
  }

  for (const [itemId, group] of groups) {
    const operations = group.map(feature => feature.operation);
    const count = operation => operations.filter(value => value === operation).length;
    const transition = count("direct_transition"), corner = count("corner_guard"), cap = count("corner_cap"), tray = count("tray_bracket"), gusset = count("gusset_bracket"), fork = count("fork_plate"), arched = count("arched_plate"), rounded = count("rounded_end_plate"), tree = count("feature_tree"), box = count("box"), cylinder = count("cylinder"), rectangle = count("rectangle"), extrude = count("extrude") + count("pad");
    const baseFamilies = Number(Boolean(transition)) + Number(Boolean(corner)) + Number(Boolean(cap)) + Number(Boolean(tray)) + Number(Boolean(gusset)) + Number(Boolean(fork)) + Number(Boolean(arched)) + Number(Boolean(rounded)) + Number(Boolean(tree)) + Number(Boolean(box)) + Number(Boolean(cylinder)) + Number(Boolean(rectangle || extrude));
    if (baseFamilies !== 1) errors.push(`Item ${itemId}: needs exactly one base recipe; found ${operations.join(", ") || "none"}.`);
    if (transition && (transition !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: direct_transition must be its only feature.`);
    if (corner && (corner !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: corner_guard must be its only feature.`);
    if (cap && (cap !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: corner_cap must be its only feature.`);
    if (tray && (tray !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: tray_bracket must be its only feature.`);
    if (gusset && (gusset !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: gusset_bracket must be its only feature.`);
    if (fork && (fork !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: fork_plate must be its only feature.`);
    if (arched && (arched !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: arched_plate must be its only feature.`);
    if (rounded && (rounded !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: rounded_end_plate must be its only feature.`);
    if (tree && (tree !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: feature_tree must be its only feature.`);
    if (cylinder && (cylinder !== 1 || group.length !== 1)) errors.push(`Item ${itemId}: cylinder must be its only feature.`);
    if (box > 1) errors.push(`Item ${itemId}: only one box base is allowed.`);
    if ((rectangle || extrude) && (rectangle !== 1 || extrude !== 1)) errors.push(`Item ${itemId}: requires exactly one rectangle and one extrude/pad.`);
    const allowedAuxiliary = new Set(["hole", "hole_pattern", "fillet", "fillet_edges"]);
    if ((box || rectangle) && group.some(feature => !allowedAuxiliary.has(feature.operation) && !["box", "rectangle", "extrude", "pad"].includes(feature.operation))) errors.push(`Item ${itemId}: contains an incompatible feature combination.`);
  }

  const featureItemIds = new Set(features.map(feature => feature.itemId));
  const skippedItemIds = [...itemIds].filter(itemId => !featureItemIds.has(itemId));
  if (skippedItemIds.length) warnings.push(`No buildable geometry for items: ${skippedItemIds.join(", ")}.`);
  if (groups.size > 1) {
    for (const itemId of groups.keys()) {
      const item = items.find(candidate => candidate?.id === itemId);
      if (!item?.transform) errors.push(`Item ${itemId}: assembly items require a position and rotation transform.`);
    }
  }
  return { valid: errors.length === 0 && features.length > 0, errors, warnings, featureCount: features.length, solidCount: groups.size, itemIds: [...groups.keys()], skippedItemIds };
}
