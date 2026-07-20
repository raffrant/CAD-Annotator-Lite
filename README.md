# CAD Annotator Lite

A focused hybrid rebuild of CAID Technologies' CAD-Annotator: upload a technical drawing, separate physical items and views with hosted or local vision AI, inspect CAD-style annotation layers, and export validated geometry JSON or STEP.

The workspace is inspired by AutoCAD's model-space workflow—drawing canvas, grid, layers, overlays, zoom, item groups, and local geometry export—but it is not a replacement for AutoCAD's complete drafting and modeling command set.

This project was developed for OpenAI Build Week. It started with a conversation with my co-worker Dean about improving an annotation tool so that it could produce something more concrete: evidence-backed 3D geometry rather than labels and bounding boxes alone.

It builds on the Apache-2.0 licensed [caid-technologies/CAD-Annotator](https://github.com/caid-technologies/CAD-Annotator). The upstream project supplied the original foundation for drawing upload, vision-based annotation, and visualization. This repository adds the drawing-to-CAD workflow, local model option, part and view decomposition, validation, geometry execution, and STEP export described below. The complete project narrative is available in [BUILD_WEEK_STORY.md](BUILD_WEEK_STORY.md).

## Why this rebuild

- **Zero dependencies:** native Node HTTP server and browser APIs; no install step.
- **Hosted accuracy or local privacy:** use the OpenAI API for the strongest configured vision model, or Qwen3-VL through Ollama without a key.
- **Explicit data path:** the engine selector states whether the uploaded image is sent to OpenAI or stays on the device.
- **Small surface:** no ORM, generated clients, workspace packages, or UI framework.

## How Codex helped build it

Codex acted as a coding and review partner throughout the Build Week project. I remained responsible for the engineering problem, product direction, safety boundary, supported geometry, and final acceptance of the work. Codex accelerated the implementation in the following areas.

### Local Ollama workflow: no OpenAI API credits required

Codex helped implement and troubleshoot the Ollama path so a drawing can be analyzed locally with `qwen3-vl:4b` instead of calling the OpenAI API. When this mode is selected, the image stays on the machine and the analysis consumes **zero OpenAI API credits**. It still uses the user's own CPU/GPU, memory, and electricity, so “zero credits” does not mean zero compute cost.

The local-model work included:

- detecting whether Ollama and the configured vision model are available;
- keeping the hosted and local data paths explicit in the interface;
- tuning prompt and context requirements for geometry-heavy JSON;
- identifying truncated or malformed model responses;
- adding a compact retry instruction when local generation exceeds its output budget;
- documenting when a larger Ollama context window may help and the memory trade-off it introduces.

This made it possible to demonstrate the workflow without spending API credits while preserving the optional hosted GPT-5.6 path for higher-quality interpretation.

### Identifying separate parts and repeated drawing views

One of the hardest reconstruction problems is determining whether visible geometry represents:

- a separate manufactured component;
- a feature attached to the same body;
- another orthographic view of the same part; or
- a drawing annotation that should never become geometry.

Codex helped trace the existing annotation data, design the body-decomposition rules, and implement grouping logic. Front, top, side, section, and detail views can contribute evidence to the same body instead of becoming duplicate solids. Visible seams, joints, fasteners, material changes, and motion boundaries can indicate genuinely separate parts. Holes, pads, bosses, ribs, fillets, and chamfers remain in the owning body's feature history.

The merged STEP export therefore preserves independent bodies instead of automatically fusing everything into a misleading solid.

### Checking what could go wrong

Codex was especially useful for turning failure cases into explicit checks. Together, we examined how the workflow could produce a convincing but incorrect result and added safeguards for:

- zero or negative dimensions;
- unsupported or incorrectly ordered operations;
- malformed, incomplete, or truncated model JSON;
- duplicate features produced by overlapping analysis or repeated data structures;
- missing item references and invalid transforms;
- holes or radii that cannot fit on the owning face;
- multiple drawing views accidentally reconstructed as multiple parts;
- inferred thicknesses or hidden dimensions presented as confirmed values;
- separate bodies that collide unexpectedly or should be in contact;
- unknown material density being used to invent a mass value;
- a process successfully creating a file that is not valid solid geometry.

The server validates the feature program before starting the CAD engine. It can return exact failures for one correction attempt, but invalid results remain blocked rather than being silently exported. After construction, deterministic OpenCASCADE/FreeCAD checks inspect solids, bounds, volume, surface area, center of mass, contact, and interference.

### Building the CAD execution layer

The upstream project focused on annotation. Codex helped replace an example-specific converter with a generic local operation executor. The resulting pipeline translates validated geometry JSON into CadQuery/OpenCASCADE operations and can use FreeCAD for generalized feature trees.

This work included profiles on multiple planes, lines and arcs, circles and holes, additive and subtractive extrusions, revolutions, patterns, fillets, chamfers, transformed multi-body output, and real ISO 10303 STEP generation. Codex also helped create fixtures and tests to verify that exported results contain meaningful geometry rather than trusting a `.step` filename or a successful command exit.

### Designing the review interface

Codex helped turn the reconstruction pipeline into a usable browser interface rather than leaving it as a collection of scripts. The UI combines a CAD-style canvas with layers, drawing overlays, zoom, item groups, engine and privacy choices, geometry validation feedback, a dimension ledger, physics results, and direct JSON/STEP export actions.

The interface makes the most important boundary visible: confirmed drawing evidence, inferred values, validation failures, and generated geometry are related, but they are not the same thing.

### Repository understanding, debugging, and verification

Codex also helped:

- inspect and explain the upstream repository before changes were made;
- identify the boundary between annotations and executable geometry;
- design the versioned geometry contract and evidence records;
- debug Node.js, Python, CadQuery, FreeCAD, and native dependency issues;
- create targeted regression tests and reproducible drawing fixtures;
- review implementation paths for edge cases and misleading output;
- run focused tests and inspect real STEP results;
- improve setup instructions and prepare the project for a reproducible public demo.

Codex accelerated construction, debugging, testing, and review; it did not replace engineering judgment. The decisions to avoid fabricating missing manufacturing dimensions, constrain the supported operation vocabulary, and require reviewable evidence for generated features remained human-directed.

## Run

Requires Node.js 20 or later.

```powershell
node server.mjs
```

Open <http://localhost:8080>. Without a key or Ollama, use **Try with local demo results**.

Local Ollama is the default whenever its configured model is installed. For optional hosted analysis, run `Copy-Item .env.example .env`, put a valid Platform API key in `.env`, then restart the server and explicitly choose **OpenAI API** in the UI. `OPENAI_MODEL` defaults to `gpt-5.6`. The key stays server-side. API use consumes account quota/credits, and uploaded images are sent to OpenAI only when that engine is selected.

For private local analysis, install Ollama and `qwen3-vl:4b`, then choose **Local Ollama**. Set `OLLAMA_MODEL` to another installed vision model if desired. No API key, credits, or external upload are used in local mode.

Local generation uses a 16,384-token context by default and automatically retries truncated or malformed JSON with a compact-output instruction. Complex drawings inherently produce larger feature programs than simple parts. If Ollama still reports `done_reason: length` and the computer has sufficient RAM/VRAM, set `OLLAMA_NUM_CTX=32768` in `.env` and restart the Node server. A larger context improves output capacity but uses more memory and does not remove ambiguity from hidden or unreadable geometry.

**Export geometry JSON** produces the version-2 local geometry contract. It preserves annotations, percentage and pixel coordinates, image metadata, AI parameters, evidence, confidence, assumptions, item transforms, and validation results. The formal contract is available at [`/geometry-schema.json`](http://localhost:8080/geometry-schema.json). Transcribed dimensions are preferred; missing values are approximated from image proportions and explicitly marked `approximate`.

## Geometry JSON to merged STEP

After analysis, choose **Build merged STEP** to convert the current result directly. You can also export the geometry JSON and select it later under **Build merged STEP from geometry JSON**.

Features carrying different `itemId` values are built separately, transformed using each item's `transform.position` and XYZ `transform.rotation`, then exported together in one STEP compound. Duplicate features present both at the top level and inside `items[].features` are de-duplicated. Labels or view boxes without a supported geometry recipe are not converted into fake solids.

Before Python or FreeCAD is started, the server validates positive dimensions, feature parameters, item references, transforms, supported operations, and compatible base recipes. Hosted output uses a strict JSON schema that forbids zero-sized geometry, then automatically receives one correction pass with the exact validation failures when needed. Zero remains legal only for coordinates and signed offsets. Invalid AI output is shown in the app and blocked from STEP export instead of producing a partial or misleading solid.

The preferred converter is CadQuery. Install it once if wanted:

```powershell
python -m pip install -r requirements-step.txt
```

If CadQuery is unavailable on Windows, the server automatically uses an installed FreeCAD 1.1/1.0/0.21 command-line executable. Conversion remains local. The current geometry recipe supports rectangles with extrusion/pad, holes and patterns, vertical fillets, boxes, cylinders, corner guards, dimensioned three-wall tray brackets with holes/radii/chamfers, reinforced gusset brackets with rounded plates and three through-holes, dimensioned fork/C-shaped plates with concentric openings, exact arched plates with concentric holes and rectangular slots, R-ended mounting plates with independent circular cuts and edge notches, and hollow rectangular direct transitions with flanges.

## Generalized feature trees

Parts outside the optimized recipes can use one `feature_tree` feature per physical body. The generalized executor supports:

- closed XY, XZ and YZ profiles made from ordered lines, arcs, circles or closed polylines;
- multiple hole/slot profiles;
- sequential new/add/cut/intersect extrusions and revolutions;
- fillets and chamfers selected by explicit 1-based edge indices or stable selectors;
- horizontal, vertical, coincident, tangent, parallel, perpendicular, equal, dimensional, angular and fixed constraint records;
- multiple transformed items exported as one STEP assembly document.

Sketch coordinates are the numerically solved geometry used by FreeCAD. Constraint records are validated audit metadata: they describe and check the AI's intended relationships, but the lightweight exporter does not run a separate symbolic constraint solver. STEP itself does not preserve sketch constraints; the JSON is the authoritative editable feature program.

See [`test/fixtures/general-feature-tree.json`](test/fixtures/general-feature-tree.json) for a complete three-body example containing a holed and cut extrusion with an additive boss and fillet, a revolved ring, an arc-based extrusion, and a chamfer.

Generalized local reconstruction uses two Ollama stages: a compact dimension/topology plan followed by the executable feature program. Malformed optional verification responses are discarded, and structurally invalid programs are blocked before FreeCAD. Inferred hidden dimensions and extrusion thicknesses remain marked `approximate`; image-only reconstruction is not manufacturing ground truth.

## Body decomposition and physics report

The AI is instructed to split an assembly at visible seams, joints, fasteners, material changes, or motion boundaries. Pads, bosses, ribs, holes, cuts, fillets, and chamfers belonging to one monolithic manufactured body remain in that body's feature history. Multiple orthographic views of the same body are grouped, not duplicated.

After valid analysis, FreeCAD automatically builds a temporary model and returns a deterministic report containing, for every body, its solid/face count, volume, surface area, center of mass, and XYZ bounds. Every body pair is classified as `separated`, `contact`, or `interference`, with minimum distance and overlap volume. The final merged STEP is a multi-body STEP package: it keeps independently manufactured bodies separate instead of fusing them into one misleading solid.

The final result also contains `dimensionLedger`, a complete inventory generated from the executable feature program. It records the owning body and feature, exact parameter path, value, unit, geometric role, evidence, confidence, and whether the value was confirmed from the drawing, inferred from the image, or used as an assembly placement. The app exposes the full ledger after validation and includes it in exported geometry JSON.

Mass is computed only when `items[].physicalProperties.densityKgM3` is a known positive value. Unknown material density remains `null` and is listed in `unknownDensityItemIds`; the system never guesses a safety-critical mass property from appearance. See [`test/fixtures/physics-assembly.json`](test/fixtures/physics-assembly.json) and the verified report under `evaluation/physics/`.

For dimensioned tray/bracket drawings, local AI first groups all views as one part, reads dimension chains, then a deterministic constraint solver computes hole coordinates and rejects impossible radii or holes outside their wall. This avoids turning drawing borders and extension lines into a large corner guard.

The annotation-only JSON still is not STEP input. A valid input contains a `nodes` feature tree, top-level `features`, or item-level `items[].features`.

## Accuracy boundary

The workflow is fully automatic, but it is not unlimited or infallible: a single perspective image does not mathematically determine hidden dimensions, internal geometry, material, fit, or intended motion. Outputs therefore distinguish confirmed dimensions from proportion-based estimates and use `manufacturingStatus: "approximate-unverified"`. A valid STEP and physics report mean the proposed geometry is structurally valid, consistently translated, and internally checked; they do not certify that estimates match a physical part. Dimensioned multi-view drawings produce much stronger results than a lone perspective render.

## Evaluation and dataset challenges

Related research points to the same limitation observed during development: dependable image-to-CAD generation needs diverse examples that connect visual evidence to executable geometry. The 2026 paper [GIFT: Bootstrapping Image-to-CAD Program Synthesis via Geometric Feedback](https://arxiv.org/abs/2603.27448) reports that a specialist model improved when its original image/program training set was expanded with geometrically verified alternative programs and structured near-miss failures. Its ablation also found that ordinary image augmentation alone produced a much smaller improvement.

CAD Annotator Lite shares the paper's broad image-to-program-to-kernel pattern, but it solves a different input problem. GIFT primarily evaluates rendered single-view CAD images against known CAD programs and ground-truth solids. This project accepts engineering drawings that may contain dimensions, borders, hidden lines, centerlines, sections, repeated orthographic views, multiple bodies, inconsistent annotations, and information that is genuinely missing. It currently uses prompted general-purpose vision models rather than a CAD-specialized model fine-tuned on a large ground-truth dataset.

### Valid export is not the same as accurate reconstruction

A larger dataset is not required for the software to export a STEP file. One sufficiently specified drawing can produce a STEP file when its feature program passes validation and the CAD kernel builds a valid solid. However, export success proves only that the proposed program is executable. It does not prove that the body count, topology, dimensions, curves, or design intent match the source drawing.

There are therefore several separate success levels:

1. The document, physical parts, and repeated views are classified correctly.
2. The generated geometry JSON satisfies the versioned contract.
3. CadQuery/OpenCASCADE or FreeCAD builds a valid B-Rep solid.
4. The exported STEP file can be reopened successfully.
5. The reconstructed topology and dimensions agree with independently prepared ground truth.
6. The workflow correctly refuses export when essential manufacturing information is absent.

The current tests are strongest at levels 2–4: they exercise contract validation, supported operations, assemblies, curved fixtures, physical checks, and real geometry execution. A larger evaluation corpus is needed before making statistical claims about levels 1, 5, and 6 across unfamiliar drawings.

### Why more examples must be chosen carefully

Simply producing many blurred, rotated, or resized copies of one bracket does not demonstrate generalization. Those variants are useful robustness tests, but they remain correlated examples of the same geometry. A credible evaluation set needs independent parts across distinct geometry and drawing families, including:

- simple prismatic and revolved parts;
- arcs, concentric curves, rounded ends, fillets, and chamfers;
- holes, slots, patterns, and asymmetric cut-outs;
- single-body and multi-body assemblies;
- repeated plan, front, side, section, detail, and isometric views;
- clean exports, scans, compression artifacts, faded lines, and perspective distortion;
- complete drawings, missing dimensions, and contradictory dimensions;
- supported parts that should export and unsupported inputs that should be refused.

Every evaluated part should ideally include the source drawing, a reviewed parameter/feature record, a ground-truth STEP file, and metadata describing its family, difficulty, and expected export decision. All visual variants of the same underlying part must remain in the same development or test split to prevent leakage.

### Evaluation plan

An initial Build Week evaluation can use 30–50 independent, deliberately varied parts to reveal failure categories. A set of roughly 100 independent parts provides a more useful first estimate of an overall success rate, although results should still be reported by geometry family and difficulty. Larger samples are needed for narrow statistical confidence intervals; under the conservative assumption that the true success probability is near 50%, the approximate sample requirement is

$$
n \approx \frac{1.96^2(0.5)(0.5)}{e^2},
$$

where $e$ is the desired 95% confidence-interval half-width. This gives approximately 96 independent samples for $e=0.10$ and 385 for $e=0.05$. These are statistical reference points, not claims about the number of examples required to fine-tune a model.

Evaluation should report more than a single “STEP generated” percentage:

- document, part, and view classification accuracy;
- geometry-contract pass rate;
- valid-solid and reopenable-STEP rate;
- correct body, feature, hole, and profile counts;
- absolute dimension error in millimetres for confirmed values;
- geometric overlap or surface-distance against ground truth;
- correct-refusal rate for under-specified or unsupported drawings;
- repeatability across multiple generations of the same drawing;
- results separated by engine, geometry family, image quality, and difficulty.

The paper uses shape IoU after normalizing and aligning the predicted and ground-truth solids. That is valuable for shape comparison, but normalization can hide an incorrect physical scale. Manufacturing-drawing evaluation must also compare absolute dimensions and topology. A visually similar 80 mm part is not an accurate reconstruction of a dimensioned 100 mm part.

### How geometric feedback could extend this project

The existing validation and batch-export tools provide the start of a feedback loop: execute the proposed program, record structural failures, and verify the resulting STEP. To apply a GIFT-like training strategy, the project would additionally need ground-truth programs or STEP files, a geometric comparison metric, many sampled candidate programs, rules for retaining valid alternatives and useful near misses, and an actual fine-tuning pipeline for the local model.

Without fine-tuning, a larger corpus still has immediate value: it can improve prompts, schemas, deterministic reconstruction rules, refusal behavior, regression tests, and the honesty of reported limitations. It does not automatically change the Ollama model's weights. For this project, the next practical milestone is therefore a reproducible ground-truth benchmark before attempting large-scale model training.

## Test

```powershell
npm test
```

## Annotation JSON

Every bounding box uses percentages relative to the original image, so overlays remain correct at any display size. The server validates and clamps model output before returning it to the browser.

## Scope

This first lean release accepts rasterized drawings (PNG, JPG, WEBP). PDF, DWG, and DXF ingestion should be added as separate converters instead of increasing the browser bundle.

Apache-2.0
