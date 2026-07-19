"""Inspect a STEP file with FreeCAD and report deterministic shape statistics."""
import json
import os
import sys

import Part

source = os.environ.get("STEP_INPUT") or (sys.argv[1] if len(sys.argv) > 1 else "")
if not source:
    raise SystemExit("Set STEP_INPUT or pass a STEP path")
shape = Part.read(source)
box = shape.BoundBox
surface_kinds = {}
cylinder_radii = []
for face in shape.Faces:
    kind = type(face.Surface).__name__
    surface_kinds[kind] = surface_kinds.get(kind, 0) + 1
    if hasattr(face.Surface, "Radius"):
        cylinder_radii.append(round(float(face.Surface.Radius), 6))
print(json.dumps({
    "valid": shape.isValid(),
    "solids": len(shape.Solids),
    "shells": len(shape.Shells),
    "faces": len(shape.Faces),
    "volume": shape.Volume,
    "bounds": [box.XLength, box.YLength, box.ZLength],
    "surfaceKinds": surface_kinds,
    "cylinderRadii": sorted(cylinder_radii),
}))
