from pathlib import Path
import Part

root = Path(__file__).resolve().parent.parent
shape = Part.read(str(root / "approximated-corner-guard.step"))
box = shape.BoundBox
assert shape.isValid(), "Re-imported STEP is invalid"
assert len(shape.Solids) == 1, f"Expected one solid, got {len(shape.Solids)}"
assert abs(box.XLength - 600) < 1e-6
assert abs(box.YLength - 600) < 1e-6
assert abs(box.ZLength - 600) < 1e-6
assert len(shape.Faces) == 14
assert shape.Volume > 0
print(f"reimport_valid=True solids={len(shape.Solids)} faces={len(shape.Faces)}")
print(f"reimport_bounds_mm={box.XLength} x {box.YLength} x {box.ZLength}")
print(f"reimport_volume_mm3={shape.Volume:.3f}")
