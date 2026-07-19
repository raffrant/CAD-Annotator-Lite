const $ = selector => document.querySelector(selector);

const state = {
  file: null,
  url: null,
  image: null,
  result: null,
  selected: null,
  filter: "all",
  zoom: 1,
  boxes: true,
  modelReady: null,
  health: null,
  busy: false,
};

const colors = {
  dimension: "#e5653f",
  tolerance: "#ae7bff",
  datum: "#55b8a8",
  surface: "#e8b34f",
  note: "#6c9cff",
  symbol: "#d875a4",
};

const demo = {
  summary: "Mounting plate with an outer profile, four mounting holes, a central bore, and thickness specification.",
  documentType: "mechanical_part_drawing",
  stepEligible: true,
  parameters: { width: 120, height: 80, thickness: 6 },
  items: [{
    id: "I-1",
    label: "Mounting plate",
    kind: "mechanical_part",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    views: [{ view: "plan", box: { x: 18, y: 18, width: 65, height: 60 } }],
    visibleDetails: ["120 × 80 mm plate", "four Ø8 mounting holes", "central bore", "6 mm assumed thickness"],
  }],
  features: [
    { id: "F-1", itemId: "I-1", operation: "rectangle", parameters: { width: 120, height: 80 }, confidence: .98, status: "confirmed" },
    { id: "F-2", itemId: "I-1", operation: "extrude", parameters: { distance: 6 }, confidence: .45, status: "approximate" },
    { id: "F-3", itemId: "I-1", operation: "hole_pattern", parameters: { diameter: 8, centers: [[-45, -25], [45, -25], [-45, 25], [45, 25]], through: true }, confidence: .85, status: "approximate" },
    { id: "F-4", itemId: "I-1", operation: "hole", parameters: { diameter: 30, center: [0, 0], through: true }, confidence: .4, status: "approximate" },
  ],
  assumptions: ["Plate thickness estimated as 6 mm.", "Hole centers and central bore diameter estimated from drawing proportions."],
  unresolvedQuestions: [],
  geometryValidation: { valid: true, errors: [], warnings: [], featureCount: 4, solidCount: 1, itemIds: ["I-1"], skippedItemIds: [] },
  engine: { kind: "local", model: "built-in-demo", externalApiUsed: false },
  annotations: [
    { id: "A-1", type: "dimension", label: "Overall width", value: "120 mm", confidence: .98, box: { x: 27, y: 8, width: 45, height: 8 } },
    { id: "A-2", type: "dimension", label: "Overall height", value: "80 mm", confidence: .97, box: { x: 7, y: 24, width: 10, height: 48 } },
    { id: "A-3", type: "tolerance", label: "Hole pattern", value: "4 × Ø8 ±0.1", confidence: .94, box: { x: 65, y: 21, width: 23, height: 9 } },
    { id: "A-4", type: "datum", label: "Primary datum", value: "A", confidence: .91, box: { x: 72, y: 70, width: 8, height: 10 } },
    { id: "A-5", type: "surface", label: "Surface finish", value: "Ra 3.2", confidence: .87, box: { x: 41, y: 77, width: 16, height: 9 } },
    { id: "A-6", type: "note", label: "Material", value: "AL 6061-T6", confidence: .96, box: { x: 67, y: 85, width: 24, height: 7 } },
  ],
};

function makeDemoDrawing() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720" viewBox="0 0 1100 720"><rect width="1100" height="720" fill="#f6f4ed"/><g fill="none" stroke="#202723" stroke-width="3"><rect x="230" y="155" width="650" height="390" rx="6"/><circle cx="340" cy="260" r="34"/><circle cx="770" cy="260" r="34"/><circle cx="340" cy="440" r="34"/><circle cx="770" cy="440" r="34"/><circle cx="555" cy="350" r="84"/><path d="M230 112h650m-650 20v-40m650 40v-40M188 155v390m20-390h-40m40 390h-40" stroke-width="2"/><path d="m245 112 18-7v14zm620 0-18-7v14zM188 170l-7 18h14zm0 360-7-18h14z" fill="#202723"/></g><g fill="#202723" font-family="Arial,sans-serif"><text x="505" y="100" font-size="28">120 mm</text><text x="143" y="370" font-size="28" transform="rotate(-90 143 370)">80 mm</text><text x="715" y="185" font-size="24">4 × Ø8 ±0.1</text><text x="795" y="510" font-size="25">▱ A</text><text x="475" y="610" font-size="24">⌁ Ra 3.2</text><text x="735" y="665" font-size="23">AL 6061-T6</text></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(value = "") {
  const element = document.createElement("div");
  element.textContent = value;
  return element.innerHTML;
}

function message(text, error = false) {
  const element = $("#message");
  element.textContent = text;
  element.classList.toggle("error", error);
}

function syncAnalyzeButton() {
  const provider = $("#provider")?.value || state.health?.defaultProvider;
  const ready = provider === "openai" ? state.health?.openAiConfigured : state.health?.modelReady;
  state.modelReady = Boolean(ready);
  $("#analyze").disabled = state.busy || !state.file || !ready;
}

async function checkHealth() {
  const status = $("#status");
  try {
    const health = await fetch("/api/health").then(response => response.json());
    state.health = health;
    const provider = $("#provider");
    provider.querySelector('option[value="openai"]').disabled = !health.openAiConfigured;
    provider.querySelector('option[value="ollama"]').disabled = !health.modelReady;
    const preferred = health.defaultProvider === "openai" && health.openAiConfigured ? "openai" : health.modelReady ? "ollama" : health.openAiConfigured ? "openai" : "ollama";
    provider.value = preferred;
    state.modelReady = preferred === "openai" ? Boolean(health.openAiConfigured) : Boolean(health.modelReady);
    status.classList.toggle("ready", state.modelReady);
    status.classList.toggle("offline", !state.modelReady);
    status.textContent = preferred === "openai" && health.openAiConfigured ? `${health.openAiModel} · OpenAI configured` : state.modelReady ? `${health.model} · local` : "No AI engine";
    $("#provider-note").textContent = preferred === "openai" ? "Image is sent to OpenAI" : "Image stays on this device";
    status.title = health.freecadReady ? "FreeCAD STEP backend detected" : "CadQuery is required for STEP export";
  } catch {
    state.modelReady = false;
    status.classList.remove("ready");
    status.classList.add("offline");
    status.textContent = "Local engine unavailable";
  }
  syncAnalyzeButton();
}

function showStage() {
  $("#empty").classList.add("hidden");
  $("#stage").classList.remove("hidden");
}

function resetView() {
  state.zoom = 1;
  $("#stage").style.transform = "scale(1)";
  $("#zoom-label").textContent = "100%";
}

function setFile(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) return message("Choose a PNG, JPG, or WEBP image.", true);
  if (file.size > 12 * 1024 * 1024) return message("That image is larger than 12 MB.", true);
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file, url: URL.createObjectURL(file), image: null, result: null, selected: null, filter: "all" });
  resetView();
  $("#drawing").src = state.url;
  $("#file-name").textContent = file.name;
  $("#file-size").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $("#file-meta").classList.remove("hidden");
  $("#drop").classList.add("compact");
  $("#add").disabled = false;
  syncAnalyzeButton();
  showStage();
  render();
  message("");
}

function clearFile() {
  if (state.url) URL.revokeObjectURL(state.url);
  Object.assign(state, { file: null, url: null, image: null, result: null, selected: null, filter: "all" });
  resetView();
  $("#file").value = "";
  $("#file-meta").classList.add("hidden");
  $("#drop").classList.remove("compact");
  $("#add").disabled = true;
  syncAnalyzeButton();
  $("#stage").classList.add("hidden");
  $("#empty").classList.remove("hidden");
  render();
}

function dataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractVisualEvidence() {
  const image = $("#drawing");
  if (!image.complete || !image.naturalWidth) await image.decode();
  const scale = Math.min(1, 600 / image.naturalWidth);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  for (let index = 0; index < dark.length; index++) {
    const offset = index * 4;
    dark[index] = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3 < 175 ? 1 : 0;
  }
  const columnCounts = Array.from({ length: width }, (_, x) => {
    let count = 0;
    for (let y = 0; y < height; y++) count += dark[y * width + x];
    return count;
  });
  const verticalColumns = [];
  for (let x = 0; x < width; x++) if (columnCounts[x] > height * .35) verticalColumns.push(x);
  const clusterValues = values => {
    const clusters = [];
    for (const value of values) {
      const current = clusters.at(-1);
      if (!current || value - current.at(-1) > 3) clusters.push([value]);
      else current.push(value);
    }
    return clusters.map(cluster => Math.round(cluster.reduce((sum, value) => sum + value, 0) / cluster.length));
  };
  const verticals = clusterValues(verticalColumns);
  // Perspective renders often place an outer edge almost on the crop boundary.
  // Keep those edges; document-sheet borders are rejected later by the layout guard.
  const usableVerticals = verticals.filter(x => x > width * .001 && x < width * .999);
  let pairedTop = 0; let pairedBottom = 0; let sampled = 0;
  for (let x = 2; x < width - 2; x += 3) {
    if (usableVerticals.some(lineX => Math.abs(lineX - x) < 5)) continue;
    const rows = [];
    for (let y = 0; y < height; y++) if (dark[y * width + x]) rows.push(y);
    const rowClusters = clusterValues(rows);
    if (rowClusters.length < 4) continue;
    sampled++;
    const topGap = rowClusters[1] - rowClusters[0];
    const bottomGap = rowClusters.at(-1) - rowClusters.at(-2);
    if (topGap >= 2 && topGap <= height * .06) pairedTop++;
    if (bottomGap >= 2 && bottomGap <= height * .06) pairedBottom++;
  }
  const topPairFraction = sampled ? pairedTop / sampled : 0;
  const bottomPairFraction = sampled ? pairedBottom / sampled : 0;
  const threeMain = usableVerticals.length >= 3 ? [usableVerticals[0], usableVerticals[Math.floor(usableVerticals.length / 2)], usableVerticals.at(-1)] : [];
  const span = threeMain.length ? threeMain[2] - threeMain[0] : 0;
  const apparentHeight = threeMain.length ? Math.max(...threeMain.map(x => columnCounts[x])) : height;
  return {
    method: "deterministic-dark-line-scan",
    imageSize: [width, height],
    longVerticals: usableVerticals,
    topPairFraction: Number(topPairFraction.toFixed(3)),
    bottomPairFraction: Number(bottomPairFraction.toFixed(3)),
    cornerLike: Boolean(threeMain.length && span > width * .55 && topPairFraction > .2 && bottomPairFraction > .2),
    leftWingRatioToHeight: threeMain.length ? Number(((threeMain[1] - threeMain[0]) / apparentHeight).toFixed(3)) : null,
    rightWingRatioToHeight: threeMain.length ? Number(((threeMain[2] - threeMain[1]) / apparentHeight).toFixed(3)) : null,
  };
}

function normalizeAnalysis(value) {
  const allowedTypes = new Set(Object.keys(colors));
  value.annotations = (Array.isArray(value.annotations) ? value.annotations : []).map((annotation, index) => {
    const raw = annotation?.box || {};
    const x = Math.max(0, Math.min(100, Number(raw.x) || 0));
    const y = Math.max(0, Math.min(100, Number(raw.y) || 0));
    const width = Math.max(0, Math.min(100 - x, Number(raw.width) || 0));
    const height = Math.max(0, Math.min(100 - y, Number(raw.height) || 0));
    return {
      ...annotation,
      id: String(annotation?.id || `A-${index + 1}`),
      type: allowedTypes.has(annotation?.type) ? annotation.type : "note",
      label: String(annotation?.label || "Detected detail"),
      value: String(annotation?.value || ""),
      confidence: Math.max(0, Math.min(1, Number(annotation?.confidence) || 0)),
      box: { x, y, width, height },
    };
  });
  value.features = Array.isArray(value.features) ? value.features : [];
  value.items = Array.isArray(value.items) ? value.items : [];
  value.assumptions = Array.isArray(value.assumptions) ? value.assumptions : [];
  value.unresolvedQuestions = Array.isArray(value.unresolvedQuestions) ? value.unresolvedQuestions : [];
  return value;
}

function busy(on) {
  state.busy = on;
  syncAnalyzeButton();
  const hosted = $("#provider").value === "openai";
  $("#analyze span").textContent = on ? `${hosted ? "OpenAI" : "Local AI"} is reconstructing…` : `Analyze with ${hosted ? "OpenAI" : "local AI"}`;
  document.body.classList.toggle("busy", on);
}

async function analyze() {
  if (!state.file) return;
  busy(true);
  state.result = null;
  render();
  try {
    const visualEvidence = await extractVisualEvidence();
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: await dataUrl(state.file), visualEvidence, detailed: $("#detailed").checked, provider: $("#provider").value }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const value = normalizeAnalysis(await response.json());
    if (!value.engine || !["local", "hosted"].includes(value.engine.kind)) throw new Error("The AI engine did not return a verified result");
    state.result = value;
    if (value.geometryValidation?.valid) {
      try {
        const physicsResponse = await fetch("/api/physics-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(composeArtifact()) });
        if (!physicsResponse.ok) throw new Error((await physicsResponse.json()).error || "physics check failed");
        value.physicsReport = await physicsResponse.json();
      } catch (physicsError) {
        value.physicsReport = { valid: false, error: physicsError.message };
      }
    }
    const nested = value.items.flatMap(item => Array.isArray(item.features) ? item.features : []);
    const featureCount = value.features.length + nested.length;
    if (value.geometryValidation?.valid && value.physicsReport?.valid) message(`Complete result: ${value.items.length} physical body/bodies, ${featureCount} geometry features, ${value.dimensionLedger?.length || 0} dimensional values, ${value.physicsReport.relations.length} body relationships, and ${value.annotations.length} drawing details.`);
    else if (value.geometryValidation?.valid) message(`Geometry is valid, but the FreeCAD physics check was unavailable: ${value.physicsReport?.error || "unknown error"}.`, true);
    else message(`Separated ${value.items.length} item group(s) from a ${value.documentType || "drawing"}. ${value.geometryValidation?.errors?.[0] || "No supported geometry recipe was generated."}`, true);
    render();
  } catch (error) {
    state.result = null;
    render();
    message(`AI analysis failed: ${error.message}. No geometry was generated.`, true);
  } finally {
    busy(false);
  }
}

function filtered() {
  return state.result?.annotations.filter(annotation => state.filter === "all" || annotation.type === state.filter) || [];
}

function select(id) {
  state.selected = id;
  renderCards();
  renderBoxes();
  renderEditor();
  if (id) document.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderEditor() {
  const annotation = state.result?.annotations.find(candidate => candidate.id === state.selected);
  const editor = $("#editor");
  editor.classList.toggle("hidden", !annotation);
  if (annotation) {
    $("#edit-type").value = annotation.type;
    $("#edit-label").value = annotation.label;
    $("#edit-value").value = annotation.value;
  }
}

function saveEdit() {
  const annotation = state.result?.annotations.find(candidate => candidate.id === state.selected);
  if (!annotation) return;
  annotation.type = $("#edit-type").value;
  annotation.label = $("#edit-label").value.trim() || "Annotation";
  annotation.value = $("#edit-value").value.trim();
  annotation.confidence = 1;
  render();
  renderEditor();
  message("Annotation saved locally.");
}

function deleteEdit() {
  if (!state.result) return;
  state.result.annotations = state.result.annotations.filter(annotation => annotation.id !== state.selected);
  state.selected = null;
  render();
  renderEditor();
}

function addManual() {
  if (!state.result) state.result = { summary: "Manual offline annotation session.", annotations: [], items: [], features: [], stepEligible: false };
  const number = state.result.annotations.length + 1;
  const annotation = { id: `M-${Date.now()}`, type: "note", label: `Manual annotation ${number}`, value: "", confidence: 1, box: { x: 35, y: 35, width: 30, height: 12 } };
  state.result.annotations.push(annotation);
  select(annotation.id);
  render();
  message("Edit the centered annotation details.");
}

function render() {
  const annotations = state.result?.annotations || [];
  const items = state.result?.items || [];
  const dimensions = state.result?.dimensionLedger || [];
  $("#count").textContent = items.length ? `${items.length} item group(s) · ${annotations.length} callouts` : annotations.length ? `${annotations.length} callouts` : "No annotations";
  if (items.length) $("#count").textContent = `${items.length} physical body/bodies · ${dimensions.length} geometry values · ${annotations.length} callouts`;
  $("#export").disabled = !["local", "hosted"].includes(state.result?.engine?.kind);
  $("#build-step").disabled = !state.result || state.result.stepEligible !== true || state.result.geometryValidation?.valid !== true;
  renderItems();
  renderFilters();
  renderCards();
  renderBoxes();
  const summary = $("#summary");
  summary.textContent = state.result?.summary || "";
  summary.classList.toggle("hidden", !state.result?.summary);
}

function renderItems() {
  const items = state.result?.items || [];
  const topFeatures = state.result?.features || [];
  $("#item-list").innerHTML = items.map(item => {
    const featureCount = (item.features || []).length + topFeatures.filter(feature => (feature.itemId || items[0]?.id) === item.id).length;
    const position = item.transform?.position;
    return `<div class="item-group"><strong>${escapeHtml(item.label || item.id)}</strong><span>${escapeHtml(item.kind || "component")} · ${featureCount} feature(s)</span><small>${(item.views || []).map(view => escapeHtml(view.view)).join(" · ") || "single view"}${position ? ` · XYZ ${position.map(Number).join(", ")} mm` : ""}</small><small>${(item.visibleDetails || []).map(escapeHtml).join("; ")}</small></div>`;
  }).join("");
  $("#item-list").querySelectorAll(".item-group").forEach((element, index) => {
    const body = state.result?.physicsReport?.bodies?.find(candidate => candidate.itemId === items[index]?.id);
    if (body) element.querySelector("span").append(` · ${body.volumeMm3.toLocaleString()} mm³ · ${body.massKg == null ? "mass needs density" : `${body.massKg} kg`}`);
  });
  const report = state.result?.physicsReport;
  if (report?.valid) {
    const relationships = report.relations.length
      ? report.relations.map(value => `${value.itemA} ↔ ${value.itemB}: ${value.relation}${value.relation === "separated" ? ` (${value.minimumDistanceMm} mm)` : value.relation === "interference" ? ` (${value.overlapVolumeMm3} mm³ overlap)` : ""}`).join("; ")
      : "Single body; no pairwise relationship to test.";
    $("#item-list").insertAdjacentHTML("beforeend", `<div class="item-group"><strong>Deterministic assembly check</strong><span>${report.stepSolidCount} STEP solid(s) · ${report.totalVolumeMm3.toLocaleString()} mm³ total</span><small>${escapeHtml(relationships)}</small><small>${report.massComplete ? `Complete mass: ${report.knownMassKg} kg` : `Known mass: ${report.knownMassKg} kg; missing density for ${escapeHtml(report.unknownDensityItemIds.join(", ") || "all bodies")}`}</small></div>`);
  }
  const ledger = state.result?.dimensionLedger || [];
  if (ledger.length) {
    const rows = ledger.map(entry => `${entry.itemId || "document"} · ${entry.path} = ${Array.isArray(entry.value) ? `[${entry.value.join(", ")}]` : entry.value} ${entry.unit} · ${entry.source}`).join("\n");
    $("#item-list").insertAdjacentHTML("beforeend", `<details class="item-group"><summary><strong>Complete physical dimension ledger</strong><span>${ledger.length} values</span></summary><small style="white-space:pre-wrap">${escapeHtml(rows)}</small></details>`);
  }
}

function renderFilters() {
  const types = [...new Set((state.result?.annotations || []).map(annotation => annotation.type))];
  $("#filters").innerHTML = types.length ? ["all", ...types].map(type => `<button class="${state.filter === type ? "active" : ""}" data-filter="${escapeHtml(type)}">${escapeHtml(type)}</button>`).join("") : "";
}

function renderCards() {
  const list = filtered();
  $("#cards").innerHTML = list.length ? list.map(annotation => {
    const accent = colors[annotation.type] || colors.note;
    return `<button class="card ${state.selected === annotation.id ? "selected" : ""}" data-card="${escapeHtml(annotation.id)}"><span class="card-top"><i style="--accent:${accent}">${escapeHtml(annotation.type)}</i><small>${Math.round(annotation.confidence * 100)}%</small></span><strong>${escapeHtml(annotation.label)}</strong><span class="value">${escapeHtml(annotation.value) || "No readable value"}</span><span class="confidence"><i style="width:${annotation.confidence * 100}%;--accent:${accent}"></i></span></button>`;
  }).join("") : `<div class="no-results">${state.result ? "No callouts in this category." : "Detected callouts will be organized here."}</div>`;
}

function renderBoxes() {
  const list = filtered();
  $("#boxes").innerHTML = state.boxes ? list.map(annotation => `<button class="box ${state.selected === annotation.id ? "selected" : ""}" data-box="${escapeHtml(annotation.id)}" style="left:${annotation.box.x}%;top:${annotation.box.y}%;width:${annotation.box.width}%;height:${annotation.box.height}%;--accent:${colors[annotation.type] || colors.note}"><span>${escapeHtml(annotation.id)}</span></button>`).join("") : "";
}

function zoom(delta) {
  state.zoom = Math.min(2.5, Math.max(.35, delta === "fit" ? 1 : state.zoom + delta));
  $("#stage").style.transform = `scale(${state.zoom})`;
  $("#zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
}

function composeArtifact() {
  const result = state.result;
  const image = $("#drawing");
  const pixelWidth = image.naturalWidth || 0;
  const pixelHeight = image.naturalHeight || 0;
  const items = result.items || [];
  const features = result.features || [];
  const nestedFeatures = items.flatMap(item => (item.features || []).map(feature => ({ ...feature, itemId: feature.itemId || item.id })));
  const defaultItemId = items.length === 1 ? items[0].id : "I-1";
  const itemIds = [...new Set([...features, ...nestedFeatures].map(feature => feature.itemId || defaultItemId))];
  const annotations = (result.annotations || []).map(annotation => ({
    ...annotation,
    coordinateSystem: "percent-from-image-top-left",
    center: { x: annotation.box.x + annotation.box.width / 2, y: annotation.box.y + annotation.box.height / 2 },
    pixelBox: pixelWidth && pixelHeight ? {
      x: Math.round(annotation.box.x / 100 * pixelWidth),
      y: Math.round(annotation.box.y / 100 * pixelHeight),
      width: Math.round(annotation.box.width / 100 * pixelWidth),
      height: Math.round(annotation.box.height / 100 * pixelHeight),
    } : null,
  }));
  return {
    schemaVersion: 2,
    artifactType: "ai-cad-geometry",
    artifactId: `cad-${Date.now()}`,
    createdAt: new Date().toISOString(),
    units: "mm",
    automationMode: "fully-automatic",
    manufacturingStatus: "approximate-unverified",
    documentType: result.documentType,
    stepEligible: result.stepEligible === true && result.geometryValidation?.valid === true,
    sourceImage: {
      name: state.file?.name || "demo-drawing.svg",
      mimeType: state.file?.type || "image/svg+xml",
      bytes: state.file?.size || null,
      pixelWidth,
      pixelHeight,
      aspectRatio: pixelHeight ? pixelWidth / pixelHeight : null,
    },
    summary: result.summary || "",
    parameters: result.parameters || {},
    items,
    features,
    annotations,
    assumptions: result.assumptions || [],
    unresolvedQuestions: result.unresolvedQuestions || [],
    layout: result.layout,
    classification: result.classification,
    geometryValidation: result.geometryValidation,
    dimensionLedger: result.dimensionLedger || [],
    physicsReport: result.physicsReport,
    assembly: {
      mode: itemIds.length > 1 ? "compound" : "single-solid",
      itemIds,
      skippedItemIds: result.geometryValidation?.skippedItemIds || [],
      transformUnits: "mm",
      rotationUnits: "degrees",
    },
    engine: result.engine,
    provenance: {
      method: result.engine?.kind === "hosted" ? "OpenAI vision reconstruction with structured output and deterministic geometry validation" : "local Ollama vision extraction with deterministic geometry validation",
      model: result.engine?.model,
      externalApiUsed: Boolean(result.engine?.externalApiUsed),
      warning: "Dimensions marked approximate are estimates from image evidence and are not manufacturing-certified.",
    },
  };
}

function triggerDownload(blob, filename) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function exportGeometry() {
  if (!["local", "hosted"].includes(state.result?.engine?.kind)) return message("Export blocked: a successful AI analysis is required.", true);
  const artifact = composeArtifact();
  const featureCount = artifact.geometryValidation?.featureCount || 0;
  triggerDownload(new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" }), `${state.file?.name?.replace(/\.[^.]+$/, "") || "cad-drawing"}-geometry.json`);
  message(`Geometry JSON exported with ${artifact.items.length} item group(s), ${featureCount} validated features, and ${artifact.annotations.length} annotations.`);
}

async function exportStep(file) {
  if (!file) return;
  message("Validating and building STEP solids locally…");
  try {
    const text = await file.text();
    let document;
    try { document = JSON.parse(text); } catch { throw new Error("The selected file is not valid JSON."); }
    const nestedFeatures = (document.items || []).flatMap(item => Array.isArray(item.features) ? item.features : []);
    const hasTree = document.nodes || document.tree?.nodes || document.feature_tree?.nodes || document.featureTree?.nodes;
    const hasRecipe = (Array.isArray(document.features) && document.features.length > 0) || nestedFeatures.length > 0;
    if (!hasTree && !hasRecipe) throw new Error(`The JSON separates ${Array.isArray(document.items) ? document.items.length : 0} items, but contains no buildable geometry.`);
    const response = await fetch("/api/export-step", { method: "POST", headers: { "content-type": "application/json" }, body: text });
    if (!response.ok) {
      const value = await response.json().catch(() => ({ error: `STEP export failed with status ${response.status}` }));
      throw new Error(value.error);
    }
    triggerDownload(await response.blob(), `${file.name.replace(/\.json$/i, "")}.step`);
    const itemIds = new Set([...(document.features || []), ...nestedFeatures].map(feature => feature.itemId).filter(Boolean));
    message(`STEP built successfully${itemIds.size > 1 ? ` with ${itemIds.size} positioned solids` : ""}.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    $("#tree-file").value = "";
  }
}

function buildCurrentStep() {
  if (!["local", "hosted"].includes(state.result?.engine?.kind)) return message("A successful AI analysis is required.", true);
  const artifact = composeArtifact();
  if (!artifact.stepEligible) return message("STEP build blocked because the geometry contract is not valid.", true);
  const name = `${state.file?.name?.replace(/\.[^.]+$/, "") || "cad-drawing"}-geometry.json`;
  exportStep(new File([JSON.stringify(artifact)], name, { type: "application/json" }));
}

$("#file").onchange = event => setFile(event.target.files[0]);
$("#remove").onclick = clearFile;
$("#analyze").onclick = analyze;
$("#provider").onchange = event => {
  const hosted = event.target.value === "openai";
  $("#provider-note").textContent = hosted ? "Image is sent to OpenAI" : "Image stays on this device";
  $("#analyze span").textContent = `Analyze with ${hosted ? "OpenAI" : "local AI"}`;
  syncAnalyzeButton();
};
$("#add").onclick = addManual;
$("#export").onclick = exportGeometry;
$("#build-step").onclick = buildCurrentStep;
$("#save-edit").onclick = saveEdit;
$("#delete-edit").onclick = deleteEdit;
$("#tree-file").onchange = event => exportStep(event.target.files[0]);
$("#demo").onclick = () => {
  clearFile();
  state.image = makeDemoDrawing();
  $("#drawing").src = state.image;
  state.result = structuredClone(demo);
  $("#add").disabled = false;
  showStage();
  message("Validated local CAD demo loaded — no API call made.");
  render();
};
$("#filters").onclick = event => {
  const button = event.target.closest("[data-filter]");
  if (button) { state.filter = button.dataset.filter; render(); }
};
$("#cards").onclick = event => {
  const button = event.target.closest("[data-card]");
  if (button) select(button.dataset.card);
};
$("#boxes").onclick = event => {
  const button = event.target.closest("[data-box]");
  if (button) select(button.dataset.box);
};
$("#toggle-boxes").onclick = event => {
  state.boxes = !state.boxes;
  event.currentTarget.classList.toggle("active", state.boxes);
  renderBoxes();
};
$("#zoom-in").onclick = () => zoom(.15);
$("#zoom-out").onclick = () => zoom(-.15);
$("#fit").onclick = () => zoom("fit");

const drop = $("#drop");
["dragenter", "dragover"].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove("over"); }));
drop.ondrop = event => setFile(event.dataTransfer.files[0]);
document.onkeydown = event => {
  if (event.key === "Enter" && state.file && !$("#analyze").disabled) analyze();
  if (event.key === "Escape") select(null);
};

render();
checkHealth();
