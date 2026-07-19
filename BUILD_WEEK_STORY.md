# Drawing2STEP: From Engineering Drawings to Evidence-Backed CAD

## Inspiration

Drawing2STEP began with a conversation with my co-worker, Dean, about how we could improve an existing engineering-drawing annotation tool and turn its output into something more concrete.

Legacy drawings often contain enough information to manufacture a real part, but converting them into editable 3D CAD is still a slow, manual process. Vision models can identify labels, dimensions, and drawing views, but annotations alone are not the final engineering artifact. We wanted to go one step further: use the drawing evidence to create a structured CAD feature plan, generate real geometry, and preserve a clear link between every modeled feature and the source information that justified it.

I started with the public, Apache-2.0 licensed [CAID Technologies CAD-Annotator project](https://github.com/caid-technologies/CAD-Annotator). The upstream project already provided a strong foundation for uploading drawings, extracting annotations with vision models, and displaying bounding boxes. My Build Week goal was to extend that foundation into an end-to-end drawing-to-CAD workflow rather than build another annotation-only demo.

The central question became:

> Can an AI-assisted system reconstruct useful CAD geometry from a drawing while remaining honest about what the drawing does—and does not—prove?

## What I built

Drawing2STEP converts a rasterized engineering drawing into an evidence-backed parametric geometry artifact and a validated ISO 10303 STEP file.

The workflow:

1. Analyzes the complete drawing to understand its overall structure, physical parts, and drawing views.
2. Splits large images into overlapping high-resolution regions so that small dimensions and callouts remain legible.
3. Extracts dimensions, annotations, views, geometric clues, confidence, and provenance from each region.
4. Rebases local tile coordinates into the original image coordinate system and deterministically reconciles duplicate observations.
5. Produces a conservative parametric feature plan using a deliberately constrained operation vocabulary.
6. Links each proposed feature and parameter to its supporting annotations through an evidence and dimension ledger.
7. Separates confirmed dimensions from inferred or approximate values.
8. Blocks misleading exports when required parameters are invalid or unresolved.
9. Executes supported operations locally through CadQuery/OpenCASCADE, with FreeCAD support for generalized feature trees.
10. Validates the resulting bodies and exports real STEP geometry.

The supported operations focus on geometry that can be generated and checked reliably: profiles, lines, arcs, circles, extrusions, additive and subtractive operations, holes, patterns, revolutions, fillets, and chamfers. Multiple physical bodies can remain separate in a merged STEP package instead of being incorrectly fused into a single solid.

The application also produces deterministic information about the generated result, including solid count, bounding boxes, volume, surface area, center of mass, and contact or interference between bodies. Mass is only calculated when a known material density is provided; the system does not guess safety-critical material properties from appearance.

## How I built it

I approached the problem as a hybrid AI and deterministic geometry system.

The vision model is responsible for interpreting the drawing: recognizing views, reading annotations, associating dimensions with features, and proposing a reconstruction plan. Conventional code is responsible for coordinate transforms, schema validation, feature execution, physical checks, and STEP export. This creates an intentional boundary between what the model *believes* it sees and what the CAD engine can actually build and verify.

For tiled analysis, an annotation at tile-local coordinates \((x_t,y_t)\) is mapped back to the full drawing using the tile offset \((o_x,o_y)\):

$$
x_g = x_t + o_x, \qquad y_g = y_t + o_y
$$

Overlapping tiles improve small-text recognition, but they can produce repeated observations. Those observations are normalized and compared using their labels, values, view membership, spatial distance, and bounding-box overlap. A common overlap measure is intersection over union:

$$
\operatorname{IoU}(A,B) = \frac{|A \cap B|}{|A \cup B|}
$$

Likely duplicates are merged deterministically while their source-tile provenance and confidence are retained.

The model output is not sent directly to the geometry kernel. It first passes through a versioned geometry contract that checks positive dimensions, supported operations, item references, transforms, base-feature compatibility, and evidence status. Geometry is then built as an ordered feature history. Conceptually, the result is:

$$
S_n = f_n\!\left(f_{n-1}\!\left(\dots f_2(f_1(S_0))\right)\right)
$$

where \(S_0\) is the initial profile or solid and each \(f_i\) is a validated CAD operation such as an extrusion, cut, fillet, or chamfer.

I used GPT-5.6 for hosted drawing interpretation and reconstruction planning, while keeping the API key and model calls on the server. I also added a local vision path for private analysis. The final STEP conversion happens locally, and invalid model output is rejected or returned for correction rather than silently converted into partial geometry.

Codex accelerated the work by helping me inspect the upstream project, understand its architecture, design the reconstruction contract, implement and debug the TypeScript and browser workflow, generalize the Python geometry executor, create focused tests and fixtures, diagnose native CAD dependency issues, and verify that the exported files contain real OpenCASCADE STEP geometry.

The core product decisions remained human-directed: choosing the engineering problem with Dean, limiting the supported geometry, requiring evidence and confidence, keeping separate bodies separate, and refusing to present inferred dimensions as manufacturing truth.

## Challenges I faced

### 1. Curved geometry is much harder than it appears

Curved parts were the largest interpretation challenge. A raster image can show an arc, rounded end, fillet, concentric opening, or perspective-distorted circle without clearly revealing its construction. The model may recognize that a boundary is curved but still confuse the radius, center, tangent relationship, or whether the curve is additive or subtractive.

For a circle, a few noisy pixels can significantly affect the inferred parameters:

$$
(x-a)^2 + (y-b)^2 = r^2
$$

If \((a,b)\) or \(r\) is not explicitly dimensioned, many different valid circles can resemble the same rasterized curve. Perspective and line thickness make the ambiguity worse. The solution was not to pretend that the model had recovered exact geometry. I expanded the operation vocabulary gradually, added dimension and topology checks, created targeted fixtures for arc-based parts, and marked unsupported or inferred values for review.

### 2. Even 2D drawings require extensive iteration

At first, the problem seemed simpler because the input was “only” a 2D technical drawing. In practice, reliable interpretation required repeated prompt refinement, examples, evaluation cases, schema constraints, and deterministic post-processing. This was closer to training a workflow than asking a model a single question.

Engineering drawings contain borders, extension lines, centerlines, section marks, hidden lines, multiple scales, repeated views, and dimensions that may apply to geometry far from their printed position. The system had to learn, through iterative evaluation and explicit rules, which lines describe the part and which lines only describe the drawing.

### 3. Multiple views are not multiple parts

Front, top, side, section, and detail views often describe the same physical body. A naïve pipeline can create one solid per view or interpret a detail view as a separate component. I added view grouping and body-decomposition rules so that orthographic views reinforce one reconstruction while visible seams, joints, material changes, and motion boundaries can indicate separate manufactured bodies.

### 4. Missing dimensions create an unavoidable truth boundary

A single image does not uniquely determine hidden geometry, thickness, material, tolerances, fit, or design intent. There is no algorithm that can recover information that was never present in the drawing.

This forced an important product decision: distinguish transcribed dimensions from inferred estimates and expose unresolved requirements instead of inventing plausible manufacturing values. A structurally valid STEP file proves that the proposed geometry can be built; it does **not** prove that every inferred parameter matches the designer's intent.

### 5. Model output had to become executable without becoming trusted

Vision-language models can return malformed JSON, truncated responses, unsupported operations, inconsistent units, impossible radii, zero-sized solids, or holes outside the owning face. Generating syntactically valid JSON was not enough.

I added strict schemas, compact retry paths, explicit units, bounded operations, dimension ledgers, geometric preconditions, and a correction pass that receives the exact validation failures. This made failures visible and actionable while preventing invalid plans from reaching the CAD kernel.

### 6. CAD dependencies and export validation are real engineering work

Producing a file named `.step` is easy; producing a valid solid through a real geometry kernel is not. CadQuery, OpenCASCADE, and FreeCAD introduce native dependencies and environment-specific behavior. I had to diagnose installation and command-line execution issues, support practical fallback paths, inspect exported files, and test actual geometric properties rather than trusting a successful process exit.

### 7. A reproducible demo needs more than a successful golden run

The golden bracket result proved the pipeline, but a Build Week submission also needs a bundled input, stable setup instructions, repeatable output, clear limitations, and a short demonstration that viewers can understand. Preparing fixtures and validation reports was essential for showing that the result was produced by the workflow rather than handcrafted for the video.

## What I learned

The most important lesson was that AI should not replace the geometry kernel or the engineering review boundary. It is most useful as an interpreter and planner inside a system that keeps evidence, uncertainty, execution, and validation separate.

I also learned that:

- A small, reliable CAD vocabulary is more valuable than a broad vocabulary that fails unpredictably.
- Provenance is a product feature, not merely debugging metadata.
- Confidence without source evidence is not sufficient for engineering decisions.
- Overlapping image analysis improves legibility, but only when paired with deterministic coordinate reconciliation and deduplication.
- Valid geometry and accurate reconstruction are different claims and must be reported separately.
- Multi-stage analysis works better than asking one model response to understand the drawing, resolve ambiguity, and emit executable CAD all at once.
- Error messages are part of the AI workflow: precise validation feedback makes correction more dependable.
- Local execution and an optional local vision path matter when drawings contain private engineering information.
- Good evaluation fixtures should include not only the successful bracket but also curves, repeated views, multiple bodies, missing dimensions, invalid topology, and contradictory annotations.

## Why it is different

Drawing2STEP does not treat model output as geometric truth. Every stage preserves the distinction between visual evidence, model interpretation, deterministic execution, and engineering verification.

Each generated parameter can record its value, unit, geometric role, source evidence, confidence, owning body, and whether it was confirmed, inferred, or used only for assembly placement. Unsupported or contradictory geometry is surfaced for review. The system favors an honest incomplete result over a confident but fabricated manufacturing model.

That evidence-backed boundary is the main contribution: the output is not just a 3D shape, but an auditable proposal for how the drawing became that shape.

## Origin and Build Week contribution

Drawing2STEP builds on the Apache-2.0 licensed [caid-technologies/CAD-Annotator](https://github.com/caid-technologies/CAD-Annotator).

The upstream project contributed the starting point for drawing upload, vision-based annotation extraction, bounding-box visualization, and GD&T/DFM-oriented analysis.

My OpenAI Build Week work extended that foundation with:

- complete-drawing and high-resolution regional analysis;
- global-coordinate reconciliation and deterministic deduplication;
- confidence and source provenance;
- an evidence-backed parametric geometry contract;
- conservative reconstruction planning;
- multi-view grouping and multi-body decomposition;
- confirmed-versus-inferred dimension tracking;
- a generic CadQuery/OpenCASCADE operation executor;
- generalized FreeCAD feature trees;
- geometry, physics, contact, and interference validation;
- real STEP generation;
- a dedicated review and export workflow;
- focused tests, evaluation artifacts, and reproducible fixtures.

## Current status and next steps

The golden bracket workflow generates a valid OpenCASCADE STEP file, and the system now supports a broader set of prismatic, revolved, curved, and multi-body examples. The project is being prepared as a reproducible public repository with a bundled sample drawing and a demonstration video under three minutes.

The next steps are to expand the curved-geometry evaluation set, improve uncertainty visualization, add more contradiction checks across orthographic views, support additional drawing formats such as PDF/DWG/DXF through dedicated converters, and test the workflow with more real-world legacy drawings.

The long-term goal is not “one image in, perfect CAD out.” It is a trustworthy engineering assistant that shortens reconstruction time, shows its work, and knows when a human decision is still required.
