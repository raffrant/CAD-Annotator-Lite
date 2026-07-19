"""Build the approximated two-wing sheet-metal corner shown in the reference image."""
import FreeCAD as App
import Part
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = str(ROOT / "approximated-corner-guard.step")
FCSTD = str(ROOT / "approximated-corner-guard.FCStd")

# Vision-derived nominal dimensions in mm. Absolute scale is not present in the image.
HEIGHT = 600.0
LEFT_WING = 600.0
RIGHT_WING = 600.0
THICKNESS = 1.5
TOP_RETURN = 18.0
BOTTOM_RETURN = 18.0
CORNER_ANGLE = 90.0

doc = App.newDocument("ApproximatedCornerGuard")

# Two perpendicular vertical sheets. They overlap only through the corner thickness,
# producing one watertight solid after fusion.
left_panel = Part.makeBox(LEFT_WING, THICKNESS, HEIGHT)
right_panel = Part.makeBox(THICKNESS, RIGHT_WING, HEIGHT)

# Returns face into the inside quadrant. Each pair is fused at the corner.
top_left = Part.makeBox(LEFT_WING, TOP_RETURN, THICKNESS, App.Vector(0, 0, HEIGHT - THICKNESS))
top_right = Part.makeBox(TOP_RETURN, RIGHT_WING, THICKNESS, App.Vector(0, 0, HEIGHT - THICKNESS))
bottom_left = Part.makeBox(LEFT_WING, BOTTOM_RETURN, THICKNESS)
bottom_right = Part.makeBox(BOTTOM_RETURN, RIGHT_WING, THICKNESS)

shape = left_panel.fuse(right_panel).fuse(top_left).fuse(top_right).fuse(bottom_left).fuse(bottom_right)
shape = shape.removeSplitter()
if shape.isNull() or not shape.isValid():
    raise RuntimeError("Generated corner guard is not a valid BRep solid")
if len(shape.Solids) != 1:
    raise RuntimeError(f"Expected one connected solid, got {len(shape.Solids)}")

obj = doc.addObject("PartDesign::Feature", "CornerGuard")
obj.Label = "Approximated 90 degree corner guard"
obj.Shape = shape
for name, value in {
    "OverallHeight": HEIGHT,
    "LeftWingWidth": LEFT_WING,
    "RightWingWidth": RIGHT_WING,
    "SheetThickness": THICKNESS,
    "TopReturnDepth": TOP_RETURN,
    "BottomReturnDepth": BOTTOM_RETURN,
    "CornerAngle": CORNER_ANGLE,
}.items():
    obj.addProperty("App::PropertyLength" if name != "CornerAngle" else "App::PropertyAngle", name, "Inferred dimensions")
    setattr(obj, name, value)
obj.addProperty("App::PropertyString", "InferenceWarning", "Verification")
obj.InferenceWarning = "Absolute scale and hidden bend radii are not present in the source image; verify before manufacture."
obj.addProperty("App::PropertyString", "ReferenceInterpretation", "Verification")
obj.ReferenceInterpretation = "Equal 90 degree wings with continuous inward top and bottom returns."

doc.recompute()
Part.export([obj], OUTPUT)
doc.saveAs(FCSTD)

box = shape.BoundBox
expected_volume = (
    LEFT_WING * THICKNESS * HEIGHT
    + THICKNESS * RIGHT_WING * HEIGHT
    + LEFT_WING * TOP_RETURN * THICKNESS
    + TOP_RETURN * RIGHT_WING * THICKNESS
    + LEFT_WING * BOTTOM_RETURN * THICKNESS
    + BOTTOM_RETURN * RIGHT_WING * THICKNESS
)
print(f"valid={shape.isValid()} solids={len(shape.Solids)} faces={len(shape.Faces)}")
print(f"bounds_mm={box.XLength:.3f} x {box.YLength:.3f} x {box.ZLength:.3f}")
print(f"volume_mm3={shape.Volume:.3f} raw_component_volume_mm3={expected_volume:.3f}")
print(f"step={OUTPUT}")
print(f"freecad={FCSTD}")
