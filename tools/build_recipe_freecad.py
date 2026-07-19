"""Build supported AI recipes as one multi-item STEP and verify its solids."""
import json
import math
import os
import re
import sys
from pathlib import Path

import FreeCAD as App
import Part


if os.environ.get("RECIPE_JSON"):
    source = Path(os.environ["RECIPE_JSON"])
    step_path = Path(os.environ["STEP_OUTPUT"])
    fcstd_path = Path(os.environ["FCSTD_OUTPUT"])
    report_path = Path(os.environ["REPORT_OUTPUT"]) if os.environ.get("REPORT_OUTPUT") else None
else:
    source, step_path, fcstd_path = map(Path, sys.argv[1:4])
    report_path = None

data = json.loads(source.read_text(encoding="utf-8"))
items = data.get("items", []) if isinstance(data.get("items"), list) else []
items_by_id = {item.get("id"): item for item in items}


def collect_features():
    nested = []
    nested_ids = {}
    for item in items:
        item_id = item.get("id", "item")
        for feature in item.get("features", []) if isinstance(item.get("features"), list) else []:
            copied = dict(feature)
            copied.setdefault("itemId", item_id)
            nested.append(copied)
            if copied.get("id"):
                nested_ids.setdefault(copied["id"], set()).add(copied["itemId"])
    candidates = []
    for feature in data.get("features", []) if isinstance(data.get("features"), list) else []:
        copied = dict(feature)
        possible = nested_ids.get(copied.get("id"), set())
        if not copied.get("itemId") and len(possible) == 1:
            copied["itemId"] = next(iter(possible))
        candidates.append(copied)
    candidates.extend(nested)
    result, seen = [], set()
    for feature in candidates:
        item_id = feature.get("itemId", "I-1")
        identity = feature.get("id") or json.dumps(
            {key: value for key, value in feature.items() if key != "itemId"}, sort_keys=True
        )
        if (item_id, identity) in seen:
            continue
        seen.add((item_id, identity))
        copied = dict(feature)
        copied["itemId"] = item_id
        result.append(copied)
    return result


def transition_shape(p):
    iw, ih, ow, oh, length = [float(p[key]) for key in ("inletWidth", "inletHeight", "outletWidth", "outletHeight", "length")]
    thickness = float(p.get("thickness", 1.2))
    offset_x, offset_y = float(p.get("offsetX", 0)), float(p.get("offsetY", 0))

    def wire(width, height, z, dx=0, dy=0):
        points = [
            App.Vector(-width / 2 + dx, -height / 2 + dy, z),
            App.Vector(width / 2 + dx, -height / 2 + dy, z),
            App.Vector(width / 2 + dx, height / 2 + dy, z),
            App.Vector(-width / 2 + dx, height / 2 + dy, z),
        ]
        return Part.makePolygon(points + [points[0]])

    outer = Part.makeLoft([wire(iw, ih, 0), wire(ow, oh, length, offset_x, offset_y)], True, False)
    inner = Part.makeLoft([wire(iw - 2 * thickness, ih - 2 * thickness, 0), wire(ow - 2 * thickness, oh - 2 * thickness, length, offset_x, offset_y)], True, False)
    shape = outer.cut(inner)
    flange_data = [
        (0, iw, ih, float(p.get("inletFlange", 0)), 0, 0),
        (length - thickness, ow, oh, float(p.get("outletFlange", 0)), offset_x, offset_y),
    ]
    for z, width, height, flange, dx, dy in flange_data:
        if flange > 0:
            frame = Part.makeBox(width + 2 * flange, height + 2 * flange, thickness, App.Vector(-width / 2 - flange + dx, -height / 2 - flange + dy, z))
            opening = Part.makeBox(width - 2 * thickness, height - 2 * thickness, thickness, App.Vector(-width / 2 + thickness + dx, -height / 2 + thickness + dy, z))
            shape = shape.fuse(frame.cut(opening))
    return shape


def tray_bracket_shape(p):
    width, depth, height = [float(p[key]) for key in ("width", "depth", "height")]
    wall, base = float(p["wallThickness"]), float(p["baseThickness"])
    hole_radius = float(p["holeDiameter"]) / 2
    shape = Part.makeBox(width, depth, base)
    shape = shape.fuse(Part.makeBox(width, wall, height))
    shape = shape.fuse(Part.makeBox(wall, depth, height, App.Vector(width-wall, 0, 0))).removeSplitter()
    inner = float(p.get("innerRadius", 0))
    if inner > 0:
        fillet_edges = []
        for edge in shape.Edges:
            box = edge.BoundBox
            floor_back = box.XLength > width-wall-inner and box.YLength < 0.01 and box.ZLength < 0.01 and abs(box.YMin-wall) < 0.01 and abs(box.ZMin-base) < 0.01
            floor_side = box.YLength > depth-wall-inner and box.XLength < 0.01 and box.ZLength < 0.01 and abs(box.XMin-(width-wall)) < 0.01 and abs(box.ZMin-base) < 0.01
            if floor_back or floor_side:
                fillet_edges.append(edge)
        if fillet_edges:
            shape = shape.makeFillet(inner, fillet_edges)
    for x, z in p["backHoleCenters"]:
        cutter = Part.makeCylinder(hole_radius, wall + 2, App.Vector(float(x), -1, float(z)), App.Vector(0, 1, 0))
        shape = shape.cut(cutter)
    for y, z in p["sideHoleCenters"]:
        cutter = Part.makeCylinder(hole_radius, wall + 2, App.Vector(width-wall-1, float(y), float(z)), App.Vector(1, 0, 0))
        shape = shape.cut(cutter)
    chamfer = float(p.get("chamferSize", 0))
    if chamfer > 0:
        back_points = [App.Vector(0, 0, height), App.Vector(chamfer, 0, height), App.Vector(0, 0, height-chamfer)]
        back_wedge = Part.Face(Part.makePolygon(back_points + [back_points[0]])).extrude(App.Vector(0, wall, 0))
        shape = shape.cut(back_wedge)
        side_points = [App.Vector(width-wall, depth, height), App.Vector(width-wall, depth-chamfer, height), App.Vector(width-wall, depth, height-chamfer)]
        side_wedge = Part.Face(Part.makePolygon(side_points + [side_points[0]])).extrude(App.Vector(wall, 0, 0))
        shape = shape.cut(side_wedge)
    return shape


def gusset_bracket_shape(p):
    length, width = float(p["baseLength"]), float(p["baseWidth"])
    base_t, upright_h, upright_t = float(p["baseThickness"]), float(p["uprightHeight"]), float(p["uprightThickness"])
    edge_r = float(p["edgeRadius"])
    # Square rear and two rounded front corners.
    base = Part.makeBox(length-edge_r, width, base_t)
    base = base.fuse(Part.makeBox(edge_r, width-2*edge_r, base_t, App.Vector(length-edge_r, edge_r, 0)))
    for y in (edge_r, width-edge_r):
        base = base.fuse(Part.makeCylinder(edge_r, base_t, App.Vector(length-edge_r, y, 0)))
    # Vertical plate with a rounded top at both outer corners.
    upright = Part.makeBox(upright_t, width, upright_h-edge_r)
    upright = upright.fuse(Part.makeBox(upright_t, width-2*edge_r, edge_r, App.Vector(0, edge_r, upright_h-edge_r)))
    for y in (edge_r, width-edge_r):
        upright = upright.fuse(Part.makeCylinder(edge_r, upright_t, App.Vector(0, y, upright_h-edge_r), App.Vector(1, 0, 0)))
    shape = base.fuse(upright)
    # Left triangular reinforcement web.
    web_points = [
        App.Vector(upright_t, 0, base_t), App.Vector(float(p["gussetLength"]), 0, base_t),
        App.Vector(upright_t, 0, float(p["gussetHeight"])), App.Vector(upright_t, 0, base_t),
    ]
    web = Part.Face(Part.makePolygon(web_points)).extrude(App.Vector(0, float(p["gussetThickness"]), 0))
    shape = shape.fuse(web).removeSplitter()
    # One through-hole in the upright plate, axis X.
    hy, hz = map(float, p["uprightHoleCenter"])
    shape = shape.cut(Part.makeCylinder(float(p["uprightHoleDiameter"])/2, upright_t+2, App.Vector(-1, hy, hz), App.Vector(1, 0, 0)))
    # Two through-holes in the base, axis Z.
    for x, y in p["baseHoleCenters"]:
        shape = shape.cut(Part.makeCylinder(float(p["baseHoleDiameter"])/2, base_t+2, App.Vector(float(x), float(y), -1)))
    return shape


def fork_plate_shape(p):
    center_x = float(p["centerFromOpenEnd"])
    slot_length = float(p["slotLength"])
    outer_r, inner_r = float(p["outerRadius"]), float(p["innerRadius"])
    arm, slot, thickness = float(p["armWidth"]), float(p["slotWidth"]), float(p["thickness"])
    center_y = outer_r
    # Circular head plus two straight fork arms surrounding the open slot.
    shape = Part.makeCylinder(outer_r, thickness, App.Vector(center_x, center_y, 0))
    lower = Part.makeBox(center_x, arm, thickness, App.Vector(0, center_y-slot/2-arm, 0))
    upper = Part.makeBox(center_x, arm, thickness, App.Vector(0, center_y+slot/2, 0))
    shape = shape.fuse(lower).fuse(upper).removeSplitter()
    # The concentric round hole merges with the slot to create the fork opening.
    shape = shape.cut(Part.makeCylinder(inner_r, thickness+2, App.Vector(center_x, center_y, -1)))
    shape = shape.cut(Part.makeBox(slot_length+1, slot, thickness+2, App.Vector(-1, center_y-slot/2, -1)))
    return shape.removeSplitter()


def arched_plate_shape(p):
    width, tangent_height = float(p["outerWidth"]), float(p["straightHeight"])
    outer_r, inner_r, thickness = float(p["outerRadius"]), float(p["innerRadius"]), float(p["thickness"])
    center = App.Vector(width / 2, tangent_height, 0)
    # The lower half of the crown overlaps the rectangle, leaving an exact tangent semicircle above y=straightHeight.
    shape = Part.makeBox(width, tangent_height, thickness).fuse(Part.makeCylinder(outer_r, thickness, center)).removeSplitter()
    shape = shape.cut(Part.makeCylinder(inner_r, thickness + 2, App.Vector(center.x, center.y, -1)))
    slot = Part.makeBox(float(p["slotWidth"]), float(p["slotHeight"]), thickness + 2,
                        App.Vector(float(p["slotLeftOffset"]), float(p["slotBottomOffset"]), -1))
    return shape.cut(slot).removeSplitter()


def rounded_end_plate_shape(p):
    width, height = float(p["overallWidth"]), float(p["overallHeight"])
    end_r, corner_r, thickness = float(p["endRadius"]), float(p["cornerRadius"]), float(p["thickness"])
    center_x, center_y = width - end_r, height / 2
    if end_r < center_y:
        raise RuntimeError("rounded_end_plate endRadius must reach the top and bottom edges")
    intersection_x = center_x + math.sqrt(max(0, end_r * end_r - center_y * center_y))
    root2 = math.sqrt(2)
    p0, p1 = App.Vector(0, corner_r, 0), App.Vector(corner_r, 0, 0)
    lower_right, upper_right = App.Vector(intersection_x, 0, 0), App.Vector(intersection_x, height, 0)
    p4, p5 = App.Vector(corner_r, height, 0), App.Vector(0, height-corner_r, 0)
    edges = [
        Part.Arc(p0,App.Vector(corner_r-corner_r/root2,corner_r-corner_r/root2,0),p1).toShape(),
        Part.makeLine(p1,lower_right),
        Part.Arc(lower_right,App.Vector(width,center_y,0),upper_right).toShape(),
        Part.makeLine(upper_right,p4),
        Part.Arc(p4,App.Vector(corner_r-corner_r/root2,height-corner_r+corner_r/root2,0),p5).toShape(),
        Part.makeLine(p5,p0),
    ]
    shape = Part.Face(Part.Wire(edges)).extrude(App.Vector(0,0,thickness))
    cx, cy = map(float,p["centerHoleCenter"])
    shape = shape.cut(Part.makeCylinder(float(p["centerHoleDiameter"])/2,thickness+2,App.Vector(cx,cy,-1)))
    for x, y in p["mountingHoleCenters"]:
        shape = shape.cut(Part.makeCylinder(float(p["mountingHoleRadius"]),thickness+2,App.Vector(float(x),float(y),-1)))
    notch_y = (height-float(p["notchHeight"]))/2
    notch = Part.makeBox(float(p["notchDepth"])+1,float(p["notchHeight"]),thickness+2,App.Vector(-1,notch_y,-1))
    return shape.cut(notch).removeSplitter()


def feature_tree_shape(p):
    sketches = {sketch["id"]: sketch for sketch in p.get("sketches", [])}

    def map_point(sketch, point):
        x, y = map(float, point)
        ox, oy, oz = map(float, sketch.get("origin", [0, 0, 0]))
        if sketch["plane"] == "XY":
            return App.Vector(ox+x, oy+y, oz)
        if sketch["plane"] == "XZ":
            return App.Vector(ox+x, oy, oz+y)
        return App.Vector(ox, oy+x, oz+y)

    def normal(sketch):
        return {"XY":App.Vector(0,0,1), "XZ":App.Vector(0,-1,0), "YZ":App.Vector(1,0,0)}[sketch["plane"]]

    def profile_wire(sketch, profile):
        entities = profile.get("entities", [])
        if len(entities) == 1 and entities[0].get("type") == "circle":
            entity = entities[0]
            return Part.Wire([Part.makeCircle(float(entity["radius"]),map_point(sketch,entity["center"]),normal(sketch))])
        edges = []
        for entity in entities:
            kind = entity.get("type")
            if kind == "line":
                edges.append(Part.makeLine(map_point(sketch,entity["start"]),map_point(sketch,entity["end"])))
            elif kind == "polyline":
                points = [map_point(sketch,point) for point in entity["points"]]
                if len(points) > 1 and (points[0]-points[-1]).Length < 1e-7:
                    points = points[:-1]
                for start,end in zip(points,points[1:]+points[:1]):
                    if (start-end).Length > 1e-7:
                        edges.append(Part.makeLine(start,end))
            elif kind == "arc":
                center = entity["center"]
                radius = float(entity["radius"])
                start, end = float(entity["startAngle"]), float(entity["endAngle"])
                if entity.get("clockwise", False):
                    span = -((start-end) % 360 or 360)
                else:
                    span = (end-start) % 360 or 360
                if abs(span) >= 359.999:
                    raise RuntimeError("Use a circle entity instead of a 360-degree arc")
                def arc_point(angle):
                    radians = angle * 3.141592653589793 / 180
                    return map_point(sketch,[float(center[0])+radius*math.cos(radians),float(center[1])+radius*math.sin(radians)])
                edges.append(Part.Arc(arc_point(start),arc_point(start+span/2),arc_point(start+span)).toShape())
        if not edges:
            raise RuntimeError(f"Profile {profile.get('id')} has no buildable edges")
        try:
            edges = Part.__sortEdges__(edges)
        except Exception:
            pass
        wire = Part.Wire(edges)
        if not wire.isClosed():
            raise RuntimeError(f"Profile {profile.get('id')} is not a closed wire")
        return wire

    def operation_face(operation):
        sketch = sketches.get(operation.get("sketchId"))
        if not sketch:
            raise RuntimeError(f"Unknown sketch {operation.get('sketchId')}")
        profiles = {profile["id"]:profile for profile in sketch.get("profiles", [])}
        outer = profile_wire(sketch,profiles[operation["outerProfileId"]])
        holes = [profile_wire(sketch,profiles[profile_id]) for profile_id in operation.get("holeProfileIds", [])]
        face = Part.Face(outer)
        for hole in holes:
            face = face.cut(Part.Face(hole))
        return face, sketch

    def selected_edges(shape, operation):
        indices = operation.get("edgeIndices")
        if indices:
            return [shape.Edges[int(index)-1] for index in indices if int(index) <= len(shape.Edges)]
        selector = operation.get("edgeSelector", "all")
        if selector == "all": return list(shape.Edges)
        if selector == "longest": return [max(shape.Edges,key=lambda edge:edge.Length)]
        if selector == "circular": return [edge for edge in shape.Edges if hasattr(edge.Curve,"Radius")]
        if selector == "vertical": return [edge for edge in shape.Edges if edge.BoundBox.ZLength > max(edge.BoundBox.XLength,edge.BoundBox.YLength)*2]
        return [edge for edge in shape.Edges if edge.BoundBox.ZLength < 1e-6]

    shape = None
    for operation in p.get("operations", []):
        kind = operation.get("type")
        if kind in {"extrude","revolve"}:
            face, sketch = operation_face(operation)
            if kind == "extrude":
                direction = normal(sketch)
                distance = float(operation["distance"])
                if operation.get("symmetric",False):
                    face.translate(direction * (-distance/2))
                tool = face.extrude(direction * distance)
            else:
                tool = face.revolve(App.Vector(*map(float,operation["axisOrigin"])),App.Vector(*map(float,operation["axisDirection"])),float(operation["angle"]))
            mode = operation.get("mode")
            if mode == "new": shape = tool
            elif mode == "add": shape = shape.fuse(tool)
            elif mode == "cut": shape = shape.cut(tool)
            elif mode == "intersect": shape = shape.common(tool)
            shape = shape.removeSplitter()
        elif kind == "fillet":
            edges = selected_edges(shape,operation)
            if not edges: raise RuntimeError(f"Fillet {operation.get('id')} selected no edges")
            shape = shape.makeFillet(float(operation["radius"]),edges)
        elif kind == "chamfer":
            edges = selected_edges(shape,operation)
            if not edges: raise RuntimeError(f"Chamfer {operation.get('id')} selected no edges")
            shape = shape.makeChamfer(float(operation["distance"]),edges)
    if shape is None:
        raise RuntimeError("Feature tree produced no solid")
    return shape.removeSplitter()


def build_group(features):
    supported = {"rectangle", "extrude", "pad", "hole", "hole_pattern", "fillet", "fillet_edges", "corner_guard", "corner_cap", "direct_transition", "tray_bracket", "gusset_bracket", "fork_plate", "arched_plate", "rounded_end_plate", "feature_tree", "box", "cylinder"}
    unsupported = sorted({str(feature.get("operation")) for feature in features if feature.get("operation") not in supported})
    if unsupported:
        raise RuntimeError("Unsupported operations: " + ", ".join(unsupported) + ". No features were discarded.")
    operations = [feature.get("operation") for feature in features]
    base_families = sum(bool(any(operation in family for operation in operations)) for family in (
        {"direct_transition"}, {"corner_guard"}, {"corner_cap"}, {"tray_bracket"}, {"gusset_bracket"}, {"fork_plate"}, {"arched_plate"}, {"rounded_end_plate"}, {"feature_tree"}, {"box"}, {"cylinder"}, {"rectangle", "extrude", "pad"}
    ))
    if base_families != 1:
        raise RuntimeError("Each item must contain exactly one supported base recipe")
    gusset = next((f for f in features if f.get("operation") == "gusset_bracket"), None)
    if gusset:
        if len(features) != 1:
            raise RuntimeError("gusset_bracket must be the only feature for its item")
        return gusset_bracket_shape(gusset.get("parameters", {}))
    fork = next((f for f in features if f.get("operation") == "fork_plate"), None)
    if fork:
        if len(features) != 1:
            raise RuntimeError("fork_plate must be the only feature for its item")
        return fork_plate_shape(fork.get("parameters", {}))
    arched = next((f for f in features if f.get("operation") == "arched_plate"), None)
    if arched:
        if len(features) != 1:
            raise RuntimeError("arched_plate must be the only feature for its item")
        return arched_plate_shape(arched.get("parameters", {}))
    rounded = next((f for f in features if f.get("operation") == "rounded_end_plate"), None)
    if rounded:
        if len(features) != 1:
            raise RuntimeError("rounded_end_plate must be the only feature for its item")
        return rounded_end_plate_shape(rounded.get("parameters", {}))
    tree = next((f for f in features if f.get("operation") == "feature_tree"), None)
    if tree:
        if len(features) != 1:
            raise RuntimeError("feature_tree must be the only feature for its item")
        return feature_tree_shape(tree.get("parameters", {}))
    tray = next((f for f in features if f.get("operation") == "tray_bracket"), None)
    if tray:
        if len(features) != 1:
            raise RuntimeError("tray_bracket must be the only feature for its item")
        return tray_bracket_shape(tray.get("parameters", {}))
    transition = next((f for f in features if f.get("operation") == "direct_transition"), None)
    if transition:
        if len(features) != 1:
            raise RuntimeError("direct_transition must be the only feature for its item")
        return transition_shape(transition.get("parameters", {}))
    cap = next((f for f in features if f.get("operation") == "corner_cap"), None)
    if cap:
        if len(features) != 1:
            raise RuntimeError("corner_cap must be the only feature for its item")
        p = cap.get("parameters", {})
        left, right = float(p["leftWing"]), float(p["rightWing"])
        depth, thickness = float(p["returnDepth"]), float(p["thickness"])
        return Part.makeBox(left, depth, thickness).fuse(Part.makeBox(depth, right, thickness)).removeSplitter()
    corner = next((f for f in features if f.get("operation") == "corner_guard"), None)
    if corner:
        if len(features) != 1:
            raise RuntimeError("corner_guard must be the only feature for its item")
        p = corner.get("parameters", {})
        height, left, right = float(p["height"]), float(p["leftWing"]), float(p["rightWing"])
        thickness = float(p.get("thickness", 1.5))
        top, bottom = float(p.get("topReturn", 0)), float(p.get("bottomReturn", 0))
        shape = Part.makeBox(left, thickness, height).fuse(Part.makeBox(thickness, right, height))
        if top:
            shape = shape.fuse(Part.makeBox(left, top, thickness, App.Vector(0, 0, height - thickness))).fuse(Part.makeBox(top, right, thickness, App.Vector(0, 0, height - thickness)))
        if bottom:
            shape = shape.fuse(Part.makeBox(left, bottom, thickness)).fuse(Part.makeBox(bottom, right, thickness))
        return shape
    primitive = next((f for f in features if f.get("operation") in {"box", "cylinder"}), None)
    if primitive:
        p = primitive.get("parameters", {})
        if primitive["operation"] == "box":
            if sum(feature.get("operation") == "box" for feature in features) != 1:
                raise RuntimeError("Only one box base is allowed per item")
            length, width, height = float(p["length"]), float(p["width"]), float(p["height"])
            depth = height
            cut_z = -depth / 2 - 1
            shape = Part.makeBox(length, width, height, App.Vector(-length / 2, -width / 2, -height / 2))
        else:
            if len(features) != 1:
                raise RuntimeError("cylinder must be the only feature for its item")
            return Part.makeCylinder(float(p["radius"]), float(p["height"]), App.Vector(0, 0, 0))
    else:
        rectangle = next((f for f in features if f.get("operation") == "rectangle"), None)
        extrude = next((f for f in features if f.get("operation") in {"extrude", "pad"}), None)
        if not rectangle or not extrude or sum(feature.get("operation") == "rectangle" for feature in features) != 1 or sum(feature.get("operation") in {"extrude", "pad"} for feature in features) != 1:
            found = ", ".join(sorted({str(f.get("operation")) for f in features}))
            raise RuntimeError(f"Item needs exactly one rectangle and one extrude/pad; found: {found}")
        rp, ep = rectangle.get("parameters", {}), extrude.get("parameters", {})
        width, height = float(rp["width"]), float(rp["height"])
        depth = float(ep.get("distance", ep.get("depth", 0)))
        cut_z = -1
        shape = Part.makeBox(width, height, depth, App.Vector(-width / 2, -height / 2, 0))
    for feature in features:
        operation, p = feature.get("operation"), feature.get("parameters", {})
        if operation == "hole":
            x, y = map(float, p.get("center", [0, 0]))
            cutter = Part.makeCylinder(float(p["diameter"]) / 2, depth + 2, App.Vector(x, y, cut_z))
            shape = shape.cut(cutter)
        elif operation == "hole_pattern":
            for center in p.get("centers", []):
                x, y = map(float, center)
                cutter = Part.makeCylinder(float(p["diameter"]) / 2, depth + 2, App.Vector(x, y, cut_z))
                shape = shape.cut(cutter)
        elif operation in {"fillet", "fillet_edges"} and float(p.get("radius", 0)) > 0:
            vertical = [edge for edge in shape.Edges if abs((edge.Vertexes[-1].Point - edge.Vertexes[0].Point).z) > depth * 0.8]
            if vertical:
                shape = shape.makeFillet(float(p["radius"]), vertical)
    return shape


groups = {}
for feature in collect_features():
    groups.setdefault(feature.get("itemId", "I-1"), []).append(feature)
if not groups:
    raise RuntimeError("No supported buildable geometry features")

doc = App.newDocument("AIReconstruction")
objects, shapes, built_items = [], [], []
for index, (item_id, features) in enumerate(groups.items(), 1):
    shape = build_group(features).removeSplitter()
    transform = items_by_id.get(item_id, {}).get("transform", {})
    position, rotation = transform.get("position", [0, 0, 0]), transform.get("rotation", [0, 0, 0])
    if len(position) != 3 or len(rotation) != 3:
        raise RuntimeError(f"Item {item_id} transform must have three position and rotation values")
    for axis, angle in zip((App.Vector(1, 0, 0), App.Vector(0, 1, 0), App.Vector(0, 0, 1)), map(float, rotation)):
        if angle:
            shape.rotate(App.Vector(0, 0, 0), axis, angle)
    shape.translate(App.Vector(*map(float, position)))
    if not shape.isValid() or len(shape.Solids) != 1:
        raise RuntimeError(f"Generated item {item_id} must be exactly one valid connected solid; found {len(shape.Solids)}")
    name = "AIReconstruction" if index == 1 else "Item_" + re.sub(r"[^A-Za-z0-9_]", "_", str(item_id))
    obj = doc.addObject("PartDesign::Feature", name)
    obj.Label = items_by_id.get(item_id, {}).get("label", str(item_id))
    obj.addProperty("App::PropertyString", "SourceItemId")
    obj.SourceItemId = str(item_id)
    obj.Shape = shape
    objects.append(obj)
    shapes.append(shape)
    built_items.append((str(item_id), items_by_id.get(item_id, {}), shape))

doc.recompute()
Part.export(objects, str(step_path))
doc.saveAs(str(fcstd_path))
check = Part.read(str(step_path))
box = check.BoundBox
summary = {
    "valid": check.isValid(),
    "items": len(groups),
    "solids": len(check.Solids),
    "faces": len(check.Faces),
    "volume": check.Volume,
    "bounds": [box.XLength, box.YLength, box.ZLength],
}


def rounded(value):
    return round(float(value), 6)


def vector_values(vector):
    return [rounded(vector.x), rounded(vector.y), rounded(vector.z)]


def body_report(item_id, item, shape):
    bounds = shape.BoundBox
    mass_shape = shape.Solids[0] if len(shape.Solids) == 1 else shape
    physical = item.get("physicalProperties", {}) if isinstance(item.get("physicalProperties"), dict) else {}
    density = physical.get("densityKgM3")
    density = float(density) if isinstance(density, (int, float)) and density > 0 else None
    result = {
        "itemId": item_id,
        "label": item.get("label", item_id),
        "role": physical.get("role"),
        "material": physical.get("material"),
        "solidCount": len(shape.Solids),
        "faceCount": len(shape.Faces),
        "volumeMm3": rounded(shape.Volume),
        "surfaceAreaMm2": rounded(shape.Area),
        "centerOfMassMm": vector_values(mass_shape.CenterOfMass),
        "bounds": {
            "minMm": [rounded(bounds.XMin), rounded(bounds.YMin), rounded(bounds.ZMin)],
            "maxMm": [rounded(bounds.XMax), rounded(bounds.YMax), rounded(bounds.ZMax)],
            "sizeMm": [rounded(bounds.XLength), rounded(bounds.YLength), rounded(bounds.ZLength)],
        },
        "densityKgM3": density,
        "massKg": rounded(shape.Volume * 1e-9 * density) if density else None,
    }
    return result


if report_path:
    bodies = [body_report(item_id, item, shape) for item_id, item, shape in built_items]
    relations = []
    adjacency = {item_id: set() for item_id, _, _ in built_items}
    contact_tolerance = 0.01
    interference_tolerance = 1e-6
    for left_index, (left_id, _, left_shape) in enumerate(built_items):
        for right_id, _, right_shape in built_items[left_index + 1:]:
            distance = float(left_shape.distToShape(right_shape)[0])
            overlap = left_shape.common(right_shape)
            overlap_volume = float(overlap.Volume) if not overlap.isNull() else 0.0
            relation = "interference" if overlap_volume > interference_tolerance else "contact" if distance <= contact_tolerance else "separated"
            if relation != "separated":
                adjacency[left_id].add(right_id)
                adjacency[right_id].add(left_id)
            relations.append({
                "itemA": left_id,
                "itemB": right_id,
                "relation": relation,
                "minimumDistanceMm": rounded(distance),
                "overlapVolumeMm3": rounded(overlap_volume),
            })
    components, visited = [], set()
    for item_id in adjacency:
        if item_id in visited:
            continue
        stack, component = [item_id], []
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            component.append(current)
            stack.extend(adjacency[current] - visited)
        components.append(component)
    known_mass = sum(body["massKg"] or 0 for body in bodies)
    report = {
        "schemaVersion": 1,
        "valid": bool(summary["valid"] and summary["solids"] == len(bodies)),
        "packagingMode": "multi-body-step" if len(bodies) > 1 else "single-body-step",
        "bodyCount": len(bodies),
        "stepSolidCount": summary["solids"],
        "totalVolumeMm3": rounded(sum(body["volumeMm3"] for body in bodies)),
        "knownMassKg": rounded(known_mass),
        "massComplete": all(body["massKg"] is not None for body in bodies),
        "unknownDensityItemIds": [body["itemId"] for body in bodies if body["massKg"] is None],
        "overallBoundsMm": {"size": [rounded(box.XLength), rounded(box.YLength), rounded(box.ZLength)]},
        "bodies": bodies,
        "relations": relations,
        "contactComponents": components,
        "warnings": [relation for relation in relations if relation["relation"] == "interference"],
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

print(json.dumps(summary))
