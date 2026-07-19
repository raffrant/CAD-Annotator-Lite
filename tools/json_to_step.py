"""Convert a supported CAID/OpenCAD feature-tree JSON document to STEP."""
import json
import sys
from pathlib import Path

def find_nodes(data: dict) -> dict:
    """Accept raw trees and common OpenCAD/CAID artifact wrappers."""
    if isinstance(data.get("nodes"), dict):
        return data["nodes"]
    for key in ("tree", "feature_tree", "featureTree", "design", "artifact", "data"):
        child = data.get(key)
        if isinstance(child, dict):
            found = find_nodes(child)
            if found:
                return found
    return {}


def build_feature_recipe(data: dict, cq):
    features = data.get("features", [])
    if not features:
        document_type = data.get("documentType", "unknown")
        if data.get("stepEligible") is False:
            raise ValueError(
                f"The {document_type} analysis is not a single buildable mechanical solid; "
                "it contains separated document items but no STEP geometry."
            )
        raise ValueError("Geometry recipe has no features to build")
    supported = {"rectangle", "extrude", "pad", "hole", "hole_pattern", "fillet", "fillet_edges", "corner_guard", "corner_cap", "direct_transition", "tray_bracket", "gusset_bracket", "fork_plate", "arched_plate", "rounded_end_plate", "feature_tree", "box", "cylinder"}
    unsupported = sorted({str(f.get("operation")) for f in features if f.get("operation") not in supported})
    if unsupported:
        raise ValueError(
            "STEP export blocked because these AI features are not implemented by the solid builder: "
            + ", ".join(unsupported)
            + ". No features were discarded."
        )
    operations = [feature.get("operation") for feature in features]
    base_families = sum(bool(any(operation in family for operation in operations)) for family in (
        {"direct_transition"}, {"corner_guard"}, {"corner_cap"}, {"tray_bracket"}, {"gusset_bracket"}, {"fork_plate"}, {"arched_plate"}, {"rounded_end_plate"}, {"feature_tree"}, {"box"}, {"cylinder"}, {"rectangle", "extrude", "pad"}
    ))
    if base_families != 1:
        raise ValueError("Each item must contain exactly one supported base recipe; no feature was discarded")
    if any(f.get("operation") in {"gusset_bracket", "fork_plate", "arched_plate", "rounded_end_plate", "feature_tree"} for f in features):
        raise ValueError("This feature uses the verified FreeCAD builder; export through the app server or FreeCADCmd")
    tray = next((f for f in features if f.get("operation") == "tray_bracket"), None)
    if tray:
        if len(features) != 1:
            raise ValueError("tray_bracket must be the only feature for its item")
        p = tray.get("parameters", {})
        width, depth, height = map(float, (p["width"], p["depth"], p["height"]))
        wall, base = float(p["wallThickness"]), float(p["baseThickness"])
        radius = float(p["holeDiameter"]) / 2
        shape = cq.Workplane("XY").box(width, depth, base, centered=(False, False, False))
        shape = shape.union(cq.Workplane("XY").box(width, wall, height, centered=(False, False, False)))
        shape = shape.union(cq.Workplane("XY").box(wall, depth, height, centered=(False, False, False)).translate((width-wall, 0, 0)))
        for x, z in p["backHoleCenters"]:
            cutter = cq.Solid.makeCylinder(radius, wall + 2, cq.Vector(float(x), -1, float(z)), cq.Vector(0, 1, 0))
            shape = shape.cut(cq.Workplane("XY").newObject([cutter]))
        for y, z in p["sideHoleCenters"]:
            cutter = cq.Solid.makeCylinder(radius, wall + 2, cq.Vector(width-wall-1, float(y), float(z)), cq.Vector(1, 0, 0))
            shape = shape.cut(cq.Workplane("XY").newObject([cutter]))
        chamfer = float(p.get("chamferSize", 0))
        if chamfer > 0:
            left_wedge = cq.Workplane("XZ").polyline([(0, height), (chamfer, height), (0, height-chamfer)]).close().extrude(wall)
            if left_wedge.val().BoundingBox().ymin < -0.01:
                left_wedge = left_wedge.translate((0, wall, 0))
            shape = shape.cut(left_wedge)
            front_wedge = cq.Workplane("YZ").polyline([(depth, height), (depth-chamfer, height), (depth, height-chamfer)]).close().extrude(wall)
            if front_wedge.val().BoundingBox().xmin < -0.01:
                front_wedge = front_wedge.translate((width, 0, 0))
            else:
                front_wedge = front_wedge.translate((width-wall, 0, 0))
            shape = shape.cut(front_wedge)
        inner = float(p.get("innerRadius", 0))
        if inner > 0:
            candidate_edges = []
            for edge in shape.val().Edges():
                box = edge.BoundingBox()
                if (box.xlen > width-wall-inner and box.ylen < 0.01 and box.zlen < 0.01 and abs(box.ymin-wall) < 0.01 and abs(box.zmin-base) < 0.01) or (box.ylen > depth-wall-inner and box.xlen < 0.01 and box.zlen < 0.01 and abs(box.xmin-(width-wall)) < 0.01 and abs(box.zmin-base) < 0.01):
                    candidate_edges.append(edge)
            if candidate_edges:
                shape = shape.newObject([shape.val().makeFillet(inner, candidate_edges)])
        return shape
    transition = next((f for f in features if f.get("operation") == "direct_transition"), None)
    if transition:
        if len(features) != 1:
            raise ValueError("direct_transition must be the only feature for its item")
        p = transition.get("parameters", {})
        iw, ih, ow, oh, length = map(float, (p["inletWidth"], p["inletHeight"], p["outletWidth"], p["outletHeight"], p["length"]))
        thickness = float(p.get("thickness", 1.2)); ox, oy = float(p.get("offsetX", 0)), float(p.get("offsetY", 0))
        if min(iw, ih, ow, oh, length, thickness) <= 0 or min(iw, ih, ow, oh) <= 2 * thickness:
            raise ValueError("Direct transition dimensions are invalid")
        outer = cq.Workplane("XY").rect(iw, ih).workplane(offset=length).center(ox, oy).rect(ow, oh).loft(combine=True)
        inner = cq.Workplane("XY").rect(iw-2*thickness, ih-2*thickness).workplane(offset=length).center(ox, oy).rect(ow-2*thickness, oh-2*thickness).loft(combine=True)
        solid = outer.cut(inner)
        inlet_flange = float(p.get("inletFlange", 0)); outlet_flange = float(p.get("outletFlange", 0))
        if inlet_flange > 0:
            frame = cq.Workplane("XY").rect(iw+2*inlet_flange, ih+2*inlet_flange).extrude(thickness).cut(cq.Workplane("XY").rect(iw-2*thickness, ih-2*thickness).extrude(thickness))
            solid = solid.union(frame)
        if outlet_flange > 0:
            frame = cq.Workplane("XY").workplane(offset=length-thickness).center(ox, oy).rect(ow+2*outlet_flange, oh+2*outlet_flange).extrude(thickness).cut(cq.Workplane("XY").workplane(offset=length-thickness).center(ox, oy).rect(ow-2*thickness, oh-2*thickness).extrude(thickness))
            solid = solid.union(frame)
        return solid
    cap = next((f for f in features if f.get("operation") == "corner_cap"), None)
    if cap:
        if len(features) != 1:
            raise ValueError("corner_cap must be the only feature for its item")
        p = cap.get("parameters", {})
        left, right = float(p["leftWing"]), float(p["rightWing"])
        depth, thickness = float(p["returnDepth"]), float(p["thickness"])
        return cq.Workplane("XY").box(left, depth, thickness, centered=(False, False, False)).union(cq.Workplane("XY").box(depth, right, thickness, centered=(False, False, False)))
    corner = next((f for f in features if f.get("operation") == "corner_guard"), None)
    if corner:
        if len(features) != 1:
            raise ValueError("corner_guard must be the only feature for its item")
        p = corner.get("parameters", {})
        height, left, right = float(p["height"]), float(p["leftWing"]), float(p["rightWing"])
        thickness = float(p.get("thickness", 1.5)); top = float(p.get("topReturn", 0)); bottom = float(p.get("bottomReturn", 0))
        solid = cq.Workplane("XY").box(left, thickness, height, centered=(False, False, False)).union(cq.Workplane("XY").box(thickness, right, height, centered=(False, False, False)))
        if top > 0:
            solid = solid.union(cq.Workplane("XY").box(left, top, thickness, centered=(False, False, False)).translate((0, 0, height-thickness))).union(cq.Workplane("XY").box(top, right, thickness, centered=(False, False, False)).translate((0, 0, height-thickness)))
        if bottom > 0:
            solid = solid.union(cq.Workplane("XY").box(left, bottom, thickness, centered=(False, False, False))).union(cq.Workplane("XY").box(bottom, right, thickness, centered=(False, False, False)))
        return solid
    primitive = next((f for f in features if f.get("operation") in {"box", "cylinder"}), None)
    if primitive:
        p = primitive.get("parameters", {})
        if primitive["operation"] == "cylinder":
            if len(features) != 1:
                raise ValueError("cylinder must be the only feature for its item")
            return cq.Workplane("XY").circle(float(p["radius"])).extrude(float(p["height"]))
        if sum(feature.get("operation") == "box" for feature in features) != 1:
            raise ValueError("Only one box base is allowed per item")
        depth = float(p["height"])
        solid = cq.Workplane("XY").box(float(p["length"]), float(p["width"]), depth)
    else:
        rectangle = next((f for f in features if f.get("operation") == "rectangle"), None)
        extrude = next((f for f in features if f.get("operation") in {"extrude", "pad"}), None)
        if not rectangle or not extrude or sum(feature.get("operation") == "rectangle" for feature in features) != 1 or sum(feature.get("operation") in {"extrude", "pad"} for feature in features) != 1:
            found = ", ".join(sorted({str(f.get("operation")) for f in features}))
            raise ValueError(f"Feature recipe needs exactly one rectangle and one extrude/pad. Found: {found}")
        rp, ep = rectangle.get("parameters", {}), extrude.get("parameters", {})
        width, height = float(rp["width"]), float(rp["height"])
        depth = float(ep.get("distance", ep.get("depth", 0)))
        if min(width, height, depth) <= 0:
            raise ValueError("Rectangle dimensions and extrusion distance must be positive")
        solid = cq.Workplane("XY").rect(width, height, centered=True).extrude(depth)
    for feature in features:
        operation, params = feature.get("operation"), feature.get("parameters", {})
        if operation == "hole_pattern":
            diameter = float(params["diameter"])
            for center in params.get("centers", []):
                solid = solid.faces(">Z").workplane().center(float(center[0]), float(center[1])).hole(diameter)
        elif operation == "hole":
            center = params.get("center", [0, 0])
            solid = solid.faces(">Z").workplane().center(float(center[0]), float(center[1])).hole(float(params["diameter"]))
        elif operation in {"fillet", "fillet_edges"}:
            radius = float(params.get("radius", 0))
            if radius > 0:
                solid = solid.edges(params.get("edgeSelector", "|Z")).fillet(radius)
    return solid


def build(data: dict):
    try:
        import cadquery as cq
    except ImportError as error:
        raise RuntimeError(
            "CadQuery is not installed for this Python. Run: "
            "python -m pip install -r requirements-step.txt"
        ) from error
    items = data.get("items", []) if isinstance(data.get("items"), list) else []
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

    # The UI may preserve a feature both at the top level and inside its item.
    # Resolve the item first, then retain one canonical copy for the builder.
    candidates = []
    for feature in data.get("features", []) if isinstance(data.get("features"), list) else []:
        copied = dict(feature)
        possible_items = nested_ids.get(copied.get("id"), set())
        if not copied.get("itemId") and len(possible_items) == 1:
            copied["itemId"] = next(iter(possible_items))
        candidates.append(copied)
    candidates.extend(nested)

    top_features = []
    seen = set()
    for feature in candidates:
        item_id = feature.get("itemId", "I-1")
        identity = feature.get("id") or json.dumps(
            {key: value for key, value in feature.items() if key != "itemId"},
            sort_keys=True,
        )
        key = (item_id, identity)
        if key in seen:
            continue
        seen.add(key)
        copied = dict(feature)
        copied["itemId"] = item_id
        top_features.append(copied)
    if top_features:
        groups = {}
        for feature in top_features:
            groups.setdefault(feature.get("itemId", "I-1"), []).append(feature)
        if len(groups) == 1:
            return build_feature_recipe({**data, "features": top_features}, cq)
        shapes = []
        items_by_id = {item.get("id"): item for item in items}
        for item_id, features in groups.items():
            built = build_feature_recipe({"features": features}, cq).val()
            transform = items_by_id.get(item_id, {}).get("transform", {})
            position = transform.get("position", [0, 0, 0])
            rotation = transform.get("rotation", [0, 0, 0])
            if len(position) != 3 or len(rotation) != 3:
                raise ValueError(f"Item {item_id} transform must contain three position and rotation values")
            rx, ry, rz = map(float, rotation)
            if rx:
                built = built.rotate((0, 0, 0), (1, 0, 0), rx)
            if ry:
                built = built.rotate((0, 0, 0), (0, 1, 0), ry)
            if rz:
                built = built.rotate((0, 0, 0), (0, 0, 1), rz)
            built = built.translate(cq.Vector(*map(float, position)))
            shapes.append(built)
        return cq.Workplane("XY").newObject([cq.Compound.makeCompound(shapes)])
    if isinstance(data.get("features"), list):
        return build_feature_recipe(data, cq)
    if isinstance(data.get("annotations"), list) and not find_nodes(data):
        raise ValueError(
            "This is annotation-result JSON, not geometry. Choose an OpenCAD/CAID "
            "feature-tree JSON containing nodes with create_sketch and extrude operations."
        )
    nodes = find_nodes(data)
    operations = sorted({str(n.get("operation")) for n in nodes.values() if n.get("operation")})
    sketches = [n for n in nodes.values() if n.get("operation") in {"create_sketch", "add_sketch", "sketch"}]
    extrudes = [n for n in nodes.values() if n.get("operation") in {"extrude", "pad", "add_extrude"}]
    if not sketches or not extrudes:
        seen = ", ".join(operations) if operations else "none"
        raise ValueError(
            "No buildable sketch/extrude pair was found. This exporter requires geometry "
            f"feature-tree JSON, not drawing annotations. Operations found: {seen}"
        )

    params = sketches[0].get("parameters", {})
    entities = params.get("entities", {})
    if isinstance(entities, list):
        entities = {str(i): value for i, value in enumerate(entities)}
    segments = params.get("segments", [])
    lines = [e for e in entities.values() if e.get("type") == "line"] or [e for e in segments if e.get("type") == "line"]
    points = [p for line in lines for p in (line.get("start"), line.get("end")) if p]
    if not points:
        raise ValueError("Sketch must contain line entities describing a rectangular profile")
    xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    width, height = max_x - min_x, max_y - min_y
    if width <= 0 or height <= 0:
        raise ValueError("Sketch profile has invalid dimensions")

    ep = extrudes[0].get("parameters", {})
    depth = float(ep.get("distance", ep.get("depth", 0)))
    if depth <= 0:
        raise ValueError("Extrude distance must be positive")
    solid = cq.Workplane("XY").rect(width, height, centered=True).extrude(depth)
    center_x, center_y = (min_x + max_x) / 2, (min_y + max_y) / 2
    circles = [e for e in entities.values() if e.get("type") == "circle" and e.get("subtract", False)]
    for circle in circles:
        cx, cy = map(float, circle["center"])
        diameter = 2 * float(circle["radius"])
        solid = solid.faces(">Z").workplane().center(cx - center_x, cy - center_y).hole(diameter)

    fillets = [n for n in nodes.values() if n.get("operation") in {"fillet", "fillet_edges"}]
    if fillets:
        radius = float(fillets[0].get("parameters", {}).get("radius", 0))
        if radius > 0:
            solid = solid.edges("|Z").fillet(radius)
    return solid


def convert(source: Path, target: Path) -> None:
    with source.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    build(data).val().exportStep(str(target))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: json_to_step.py input.json output.step")
    convert(Path(sys.argv[1]), Path(sys.argv[2]))
