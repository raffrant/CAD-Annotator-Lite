# Protolab: Turn 2D Engineering Drawings into 3D Models

## Inspiration

Many manufacturers still rely on legacy 2D engineering drawings, yet converting them into editable 3D CAD remains a slow and manual process. Skilled engineers must repeatedly interpret dimensions, compare orthographic views, reconstruct feature histories, and validate the final model before it can be manufactured or modified.

Modern vision-language models can recognize dimensions, labels, and drawing views, but they generally stop after annotation. They do not generate an engineering model that can be edited, validated, or manufactured.

Protolab was inspired by a conversation with my coworker, Dean, about extending an existing engineering-drawing annotation tool into something far more useful. Instead of simply extracting annotations, we wanted AI to become an engineering assistant that could understand a drawing, organize its evidence, propose a CAD reconstruction, and produce editable geometry while remaining transparent about what was directly supported by the drawing and what still required engineering judgment.

Starting from the open-source CAD-Annotator project, my Build Week goal was to transform annotation into a complete drawing-to-CAD workflow.

The guiding question became:

> **Can AI reduce the manual work of CAD reconstruction while remaining honest about what the drawing does—and does not—prove?**

---

# What I built

Protolab converts rasterized engineering drawings into evidence-backed, editable CAD models and validated ISO 10303 STEP files.

Instead of manually recreating geometry feature by feature, engineers upload a drawing and receive a structured engineering workflow that includes:

- extracted dimensions, annotations, and drawing views;
- grouped orthographic views and detected physical bodies;
- a validated CAD feature reconstruction plan;
- editable 3D geometry;
- a manufacturable STEP model;
- traceable links between every CAD parameter and its supporting drawing evidence.

To improve accuracy, Protolab analyzes both the complete drawing and overlapping high-resolution regions so small dimensions remain readable. Duplicate observations are reconciled, multiple drawing views are grouped into a single physical object, and separate manufactured bodies are identified when appropriate.

The current reconstruction pipeline supports common parametric CAD operations including sketches, extrusions, revolutions, cuts, holes, patterns, fillets, and chamfers.

Before exporting, every reconstructed model is validated through a deterministic geometry pipeline. The system checks solid validity, body count, bounding boxes, volume, surface area, center of mass, and body interference before producing the final STEP file.

Rather than replacing engineers, Protolab reduces repetitive reconstruction work and provides a transparent, editable starting point that engineers can confidently review, modify, and manufacture.

---

# How I built it

I approached Protolab as a hybrid AI and deterministic geometry system.

The vision model is responsible for interpreting engineering drawings: recognizing views, reading annotations, associating dimensions with geometry, and proposing a reconstruction plan. Deterministic software is responsible for coordinate transforms, schema validation, feature execution, geometry verification, and STEP generation.

This separation creates a deliberate boundary between what the model believes it sees and what the CAD engine can actually verify.

### Coordinate reconciliation

Engineering drawings are analyzed in overlapping tiles to preserve readability of small annotations. Tile-local coordinates are transformed back into global drawing coordinates using

$$
x_g=x_t+o_x,\qquad
y_g=y_t+o_y
$$

where $(o_x,o_y)$ represents the tile offset.

### Duplicate removal

Because overlapping tiles observe the same geometry multiple times, extracted annotations are compared using labels, dimensions, spatial proximity, drawing views, and bounding-box overlap.

A common similarity metric is Intersection over Union:

$$
\mathrm{IoU}(A,B)=\frac{|A\cap B|}{|A\cup B|}
$$

Likely duplicates are merged while preserving confidence scores and provenance back to the original drawing regions.

### Geometry reconstruction

The model output is never executed directly.

Instead, every proposed operation passes through a versioned geometry contract that validates:

- supported CAD operations;
- positive dimensions;
- valid references;
- transformation consistency;
- evidence status;
- feature dependencies.

Validated operations are then executed as an ordered feature history

$$
S_n=
f_n\!\left(
f_{n-1}
\left(
\dots
f_2(f_1(S_0))
\right)
\right)
$$

where $S_0$ is the initial sketch or solid and each $f_i$ represents a verified CAD operation such as an extrusion, cut, fillet, or chamfer.

### AI and CAD pipeline

GPT-5.6 performs hosted drawing interpretation and reconstruction planning while keeping model credentials securely on the server. A local vision pipeline is also available for privacy-sensitive workflows.

Generated reconstruction plans are executed locally through OpenCASCADE-based CAD tooling. Invalid outputs are rejected, corrected, or returned for review rather than silently producing incomplete geometry.

### Development workflow

Codex significantly accelerated development by helping inspect the original project architecture, implement the reconstruction contract, extend the browser workflow, generalize the Python CAD executor, diagnose native CAD dependencies, build focused tests, and verify exported STEP geometry.

The engineering decisions remained human-directed: defining the supported operation set, preserving evidence traceability, separating inferred values from confirmed dimensions, grouping orthographic views correctly, and ensuring that unsupported geometry is reported instead of fabricated.

---

# Challenges I faced

## 1. Curved geometry is far more ambiguous than it appears

Curved geometry became the largest interpretation challenge. Raster images often show arcs, fillets, rounded ends, or circles without uniquely determining their construction.

Even small pixel errors affect the inferred parameters

$$
(x-a)^2+(y-b)^2=r^2
$$

If neither the center nor radius is explicitly dimensioned, multiple geometries can satisfy the same raster image.

Rather than pretending AI recovered exact geometry, I gradually expanded supported operations, added topology and dimension validation, built targeted evaluation fixtures, and clearly marked inferred parameters for engineering review.

---

## 2. Engineering drawings contain far more ambiguity than expected

Although the input is only a 2D drawing, engineering documentation contains hidden lines, centerlines, section views, detail views, multiple scales, overlapping dimensions, and repeated orthographic projections.

Reliable reconstruction required repeated prompt refinement, structured schemas, deterministic post-processing, and extensive evaluation.

The system also had to distinguish multiple views describing the same physical object from drawings that genuinely contained multiple manufactured bodies.

Most importantly, missing dimensions create a fundamental information boundary. Thickness, tolerances, hidden geometry, and design intent cannot always be recovered from a single drawing.

Instead of inventing values, Protolab distinguishes confirmed dimensions, inferred estimates, and unresolved requirements.

---

## 3. AI output must become executable engineering data

Producing valid JSON is not enough for CAD generation.

Vision-language models may generate unsupported operations, inconsistent units, impossible radii, invalid references, or zero-sized solids.

To address this, I implemented strict schemas, bounded operations, geometry validation, correction passes, explicit units, and detailed validation feedback before any geometry reaches the CAD kernel.

Failures become visible, explainable, and recoverable instead of silently producing incorrect models.

---

## 4. Reliable CAD generation requires real engineering infrastructure

Generating a file named `.step` is easy.

Generating a valid STEP model through OpenCASCADE is not.

Supporting CadQuery, OpenCASCADE, and FreeCAD required solving native dependency issues, validating exported solids, testing geometric properties, and building reproducible examples that demonstrate the complete workflow rather than a handcrafted success case.

---

# What I learned

The most valuable AI productivity tools do not replace engineers—they eliminate repetitive work while making results easier to review.

Building Protolab reinforced several lessons:

- deterministic validation is as important as AI interpretation;
- a smaller, reliable CAD vocabulary is more useful than broad but inconsistent support;
- source evidence is more valuable than confidence scores alone;
- valid geometry and accurate reconstruction are different claims;
- multi-stage AI systems are more dependable than a single prompting step;
- local execution matters for confidential engineering data;
- uncertainty should be exposed rather than hidden.

---

# Why it's different

Most drawing-analysis tools stop after extracting annotations.

Protolab continues the workflow by reconstructing editable CAD, validating manufacturable geometry, exporting STEP models, and preserving traceability between every generated feature and its supporting drawing evidence.

Instead of presenting AI output as engineering truth, it separates four distinct layers:

1. what the drawing shows;
2. how AI interprets it;
3. what the CAD engine successfully builds;
4. what still requires engineering review.

This produces an auditable engineering proposal rather than simply another generated 3D model.

---

# Work & Productivity Impact

Reconstructing CAD from legacy engineering drawings is repetitive, expensive, and time-consuming.

Protolab brings interpretation, reconstruction, validation, and export into a single workflow.

It helps engineering teams:

- convert legacy drawings into editable CAD faster;
- reduce repetitive reconstruction work;
- detect missing or conflicting dimensions earlier;
- maintain traceability between drawings and generated geometry;
- create manufacturable STEP models while preserving engineering uncertainty;
- support confidential workflows through local geometry generation.

The workflow is especially valuable for manufacturing companies, repair operations, suppliers, hardware startups, and organizations modernizing large archives of legacy engineering drawings.

---

# Current Status

The current prototype successfully generates validated OpenCASCADE STEP models from representative engineering drawings using an evidence-backed reconstruction workflow.

Future work includes expanding curved geometry support, improving uncertainty visualization, strengthening cross-view consistency checking, and supporting additional engineering formats such as PDF, DWG, and DXF.

The long-term goal is not **"one image in, perfect CAD out."**

It is a trustworthy engineering productivity tool that reduces reconstruction time, shows its work, and gives engineers an editable, validated starting point for the next stage of design and manufacturing.
