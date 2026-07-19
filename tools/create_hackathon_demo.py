from pathlib import Path
import json
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".video-deps"))

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import imageio_ffmpeg

W, H, FPS = 1280, 720, 15
EVAL = ROOT / "evaluation"
NARRATION = EVAL / "hackathon-narration"
SOURCE = EVAL / "hackathon-source.png"
APP = EVAL / "video-01-app-start.png"
CAD = EVAL / "gusset-bracket" / "gusset-bracket-render.png"
OUTPUT = EVAL / "Drawing2STEP-build-week-video.mp4"

source = Image.open(SOURCE).convert("RGB")
app = Image.open(APP).convert("RGB")
cad = Image.open(CAD).convert("RGB")

FONT = Path(r"C:\Windows\Fonts")
fonts = {
    "hero": ImageFont.truetype(str(FONT / "segoeuib.ttf"), 68),
    "h1": ImageFont.truetype(str(FONT / "segoeuib.ttf"), 44),
    "h2": ImageFont.truetype(str(FONT / "segoeuib.ttf"), 30),
    "body": ImageFont.truetype(str(FONT / "segoeui.ttf"), 27),
    "small": ImageFont.truetype(str(FONT / "segoeui.ttf"), 21),
    "tiny": ImageFont.truetype(str(FONT / "segoeui.ttf"), 17),
}

INK = "#F7F3EA"
MUTED = "#9FB0A8"
BLUE = "#6E9FFF"
ORANGE = "#F07850"
GREEN = "#77C7A2"
BG = "#101714"
CARD = "#18221E"
CARD_2 = "#202C27"


def wav_duration(path):
    with wave.open(str(path), "rb") as audio:
        return audio.getnframes() / audio.getframerate()


segments = sorted(NARRATION.glob("segment-*.wav"))
if len(segments) != 8:
    raise RuntimeError("Generate the eight narration segments first.")

durations = [wav_duration(path) for path in segments]
starts = []
cursor = 0.0
for duration in durations:
    starts.append(cursor)
    cursor += duration
TOTAL = cursor
(NARRATION / "segments.json").write_text(
    json.dumps({"durations": durations, "total": TOTAL}, indent=2), encoding="utf-8"
)


def contain(image, width, height, background="#FFFFFF"):
    scale = min(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", (width, height), background)
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def cover(image, width, height):
    scale = max(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    x = (resized.width - width) // 2
    y = (resized.height - height) // 2
    return resized.crop((x, y, x + width, y + height))


def background():
    frame = Image.new("RGB", (W, H), BG)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((760, -350, 1480, 370), fill=(53, 99, 108, 85))
    draw.ellipse((-420, 430, 420, 1080), fill=(70, 74, 111, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(95))
    frame.paste(glow, (0, 0), glow)
    return frame


def rounded_card(frame, box, fill=CARD, outline="#31443C", radius=22, width=2):
    ImageDraw.Draw(frame).rounded_rectangle(box, radius, fill=fill, outline=outline, width=width)


def image_card(frame, image, box, label=None, background_color="#FFFFFF"):
    x1, y1, x2, y2 = box
    rounded_card(frame, box, fill="#F5F3EC", outline="#3D544B", radius=24, width=2)
    margin = 14
    visual = contain(image, x2 - x1 - margin * 2, y2 - y1 - margin * 2, background_color)
    frame.paste(visual, (x1 + margin, y1 + margin))
    if label:
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle((x1 + 24, y1 + 22, x1 + 24 + 16 + draw.textlength(label, font=fonts["tiny"]), y1 + 55), 10, fill=BG)
        draw.text((x1 + 32, y1 + 28), label, font=fonts["tiny"], fill=INK)


def topbar(frame, step, title, kicker):
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle((52, 38, 129, 74), 12, fill=BLUE)
    draw.text((68, 45), f"{step:02d}", font=fonts["tiny"], fill="#0E1512")
    draw.text((151, 39), kicker.upper(), font=fonts["tiny"], fill=BLUE)
    draw.text((52, 87), title, font=fonts["h1"], fill=INK)


def bullet_list(frame, items, x, y, spacing=53, color=INK):
    draw = ImageDraw.Draw(frame)
    for index, item in enumerate(items):
        yy = y + index * spacing
        draw.ellipse((x, yy + 9, x + 12, yy + 21), fill=GREEN)
        draw.text((x + 29, yy), item, font=fonts["small"], fill=color)


def pill(draw, xy, text, fill=CARD_2, color=INK, outline="#3A4D45"):
    x, y = xy
    width = int(draw.textlength(text, font=fonts["tiny"])) + 30
    draw.rounded_rectangle((x, y, x + width, y + 36), 18, fill=fill, outline=outline, width=1)
    draw.text((x + 15, y + 7), text, font=fonts["tiny"], fill=color)
    return width


def app_canvas(with_source=False, analyzed=False):
    canvas = contain(app, 1120, 560, "#F3F0E8")
    if with_source:
        visual = contain(source, 540, 370, "#F7F4ED")
        canvas.paste(visual, (300, 115))
    if analyzed:
        draw = ImageDraw.Draw(canvas)
        draw.rounded_rectangle((862, 126, 1090, 470), 14, fill="#FAF8F2", outline="#D7D1C6", width=2)
        draw.text((882, 146), "Reconstruction", font=fonts["small"], fill="#171D1A")
        entries = [("Base plate", "75 x 60 x 10"), ("Upright", "60 x 55 x 10"), ("Gusset", "verified"), ("Holes", "3 through")]
        for idx, (name, value) in enumerate(entries):
            yy = 198 + idx * 61
            draw.ellipse((882, yy + 5, 892, yy + 15), fill="#4D83F3")
            draw.text((904, yy), name, font=fonts["tiny"], fill="#171D1A")
            draw.text((904, yy + 23), value, font=fonts["tiny"], fill="#66706B")
    return canvas


def scene_goal(local_t, duration):
    frame = background()
    draw = ImageDraw.Draw(frame)
    draw.text((62, 72), "OPENAI BUILD WEEK", font=fonts["tiny"], fill=BLUE)
    draw.text((62, 135), "From drawing", font=fonts["hero"], fill=INK)
    draw.text((62, 215), "to verified CAD.", font=fonts["hero"], fill=INK)
    draw.text((66, 316), "Drawing2STEP converts visual design intent into", font=fonts["body"], fill=MUTED)
    draw.text((66, 356), "structured geometry and a FreeCAD-ready STEP.", font=fonts["body"], fill=MUTED)
    x = 66
    for label in ["LOCAL AI", "FEATURE TREE", "CAD VALIDATION"]:
        x += pill(draw, (x, 438), label, fill="#1B2924", color=GREEN) + 12
    image_card(frame, source, (805, 100, 1035, 334), "INPUT")
    image_card(frame, cad, (950, 385, 1190, 625), "OUTPUT")
    draw.line((1008, 341, 1008, 375), fill=ORANGE, width=5)
    draw.polygon([(1008, 385), (996, 369), (1020, 369)], fill=ORANGE)
    return frame


def scene_source(local_t, duration):
    frame = background()
    topbar(frame, 1, "Start with the desired picture", "Input")
    image_card(frame, source, (65, 165, 635, 650), "SOURCE DRAWING")
    bullet_list(frame, ["CAD screenshot or render", "Dimensioned technical drawing", "Clean mechanical reference"], 715, 227)
    draw = ImageDraw.Draw(frame)
    draw.text((715, 405), "Example object", font=fonts["tiny"], fill=BLUE)
    draw.text((715, 443), "Gusset bracket", font=fonts["h2"], fill=INK)
    draw.text((715, 494), "Base + upright + rib + 3 holes", font=fonts["small"], fill=MUTED)
    return frame


def scene_clicks(local_t, duration):
    frame = background()
    topbar(frame, 2, "Upload and run local AI", "Click-by-click")
    ui = app_canvas(with_source=True)
    frame.paste(ui, (80, 145))
    draw = ImageDraw.Draw(frame)
    clicks = [
        ((94, 330, 285, 450), "1  Choose a drawing"),
        ((94, 486, 285, 548), "2  Local Ollama"),
        ((94, 550, 285, 620), "3  Verification ON"),
        ((94, 622, 285, 689), "4  Analyze with AI"),
    ]
    active = min(3, int((local_t / max(duration, 0.1)) * 4))
    for idx, (box, label) in enumerate(clicks):
        color = ORANGE if idx == active else BLUE
        draw.rounded_rectangle(box, 13, outline=color, width=4 if idx == active else 2)
        if idx == active:
            lx = min(box[2] + 14, 1000)
            draw.rounded_rectangle((lx, box[1] + 4, lx + 226, box[1] + 42), 12, fill=BG, outline=color, width=2)
            draw.text((lx + 12, box[1] + 11), label, font=fonts["tiny"], fill=INK)
    return frame


def scene_features(local_t, duration):
    frame = background()
    topbar(frame, 3, "AI separates the smallest physical features", "Interpret")
    image_card(frame, source, (70, 164, 610, 646), "VISUAL EVIDENCE")
    draw = ImageDraw.Draw(frame)
    features = [
        ("F-01", "Base plate", "extrusion", BLUE),
        ("F-02", "Upright wall", "extrusion", GREEN),
        ("F-03", "Reinforcing rib", "support", ORANGE),
        ("F-04", "Three holes", "cuts", "#C99AF7"),
        ("F-05", "Rounded edges", "fillets", "#F4C56A"),
    ]
    for idx, (fid, name, operation, color) in enumerate(features):
        y = 174 + idx * 88
        rounded_card(frame, (682, y, 1195, y + 70), fill=CARD_2, outline="#3A4D45", radius=16, width=2)
        draw.rounded_rectangle((700, y + 17, 762, y + 53), 10, fill=color)
        draw.text((714, y + 25), fid, font=fonts["tiny"], fill="#101714")
        draw.text((785, y + 11), name, font=fonts["small"], fill=INK)
        draw.text((785, y + 39), operation, font=fonts["tiny"], fill=MUTED)
    return frame


def scene_review(local_t, duration):
    frame = background()
    topbar(frame, 4, "Review evidence before geometry", "Validate")
    ui = app_canvas(with_source=True, analyzed=True)
    frame.paste(ui, (80, 145))
    draw = ImageDraw.Draw(frame)
    draw.rounded_rectangle((95, 598, 1178, 681), 18, fill=BG, outline=GREEN, width=2)
    checks = ["positive dimensions", "closed profiles", "separate cuts", "valid feature order"]
    x = 125
    for check in checks:
        draw.text((x, 625), "CHECK  " + check, font=fonts["tiny"], fill=GREEN)
        x += int(draw.textlength("CHECK  " + check, font=fonts["tiny"])) + 36
    return frame


def scene_export(local_t, duration):
    frame = background()
    topbar(frame, 5, "Export the feature program and solid", "Deliver")
    draw = ImageDraw.Draw(frame)
    rounded_card(frame, (82, 180, 580, 588), fill=CARD, outline="#3A4D45", radius=25)
    rounded_card(frame, (700, 180, 1198, 588), fill=CARD, outline="#3A4D45", radius=25)
    draw.text((122, 222), "GEOMETRY JSON", font=fonts["tiny"], fill=BLUE)
    draw.text((122, 272), "Editable intent", font=fonts["h2"], fill=INK)
    bullet_list(frame, ["Dimensions", "Feature operations", "Evidence and confidence"], 124, 338, 53)
    draw.rounded_rectangle((122, 510, 532, 562), 14, fill=BLUE)
    draw.text((223, 522), "Export geometry JSON", font=fonts["small"], fill="#101714")
    draw.text((740, 222), "MERGED STEP", font=fonts["tiny"], fill=GREEN)
    draw.text((740, 272), "Manufacturing solid", font=fonts["h2"], fill=INK)
    bullet_list(frame, ["Merged bodies", "Real cuts and holes", "FreeCAD-compatible"], 742, 338, 53)
    draw.rounded_rectangle((740, 510, 1150, 562), 14, fill=GREEN)
    draw.text((846, 522), "Build merged STEP", font=fonts["small"], fill="#101714")
    draw.line((600, 383, 680, 383), fill=ORANGE, width=5)
    draw.polygon([(686, 383), (670, 373), (670, 393)], fill=ORANGE)
    return frame


def scene_freecad(local_t, duration):
    frame = background()
    topbar(frame, 6, "Open the STEP in FreeCAD and verify", "Confidence")
    image_card(frame, source, (60, 168, 500, 615), "REFERENCE")
    image_card(frame, cad, (535, 168, 980, 615), "FREECAD RESULT")
    draw = ImageDraw.Draw(frame)
    draw.line((506, 385, 528, 385), fill=ORANGE, width=5)
    draw.polygon([(533, 385), (519, 376), (519, 394)], fill=ORANGE)
    bullet_list(frame, ["File > Open", "Select .STEP", "Rotate model", "Check every hole", "Confirm one solid"], 1020, 200, 60)
    draw.rounded_rectangle((535, 624, 980, 670), 14, fill="#163127", outline=GREEN, width=2)
    draw.text((645, 634), "GEOMETRY VERIFIED", font=fonts["small"], fill=GREEN)
    return frame


def scene_close(local_t, duration):
    frame = background()
    draw = ImageDraw.Draw(frame)
    draw.text((64, 70), "DRAWING2STEP", font=fonts["tiny"], fill=BLUE)
    draw.text((64, 150), "Visual intent in.", font=fonts["hero"], fill=INK)
    draw.text((64, 230), "Verified geometry out.", font=fonts["hero"], fill=INK)
    draw.text((68, 352), "Local AI interpretation", font=fonts["body"], fill=MUTED)
    draw.text((68, 397), "+ deterministic CAD validation", font=fonts["body"], fill=MUTED)
    x = 68
    for label in ["FASTER", "REVIEWABLE", "AUTOMATION-READY"]:
        x += pill(draw, (x, 495), label, fill="#1B2924", color=GREEN) + 12
    image_card(frame, cad, (910, 133, 1195, 545), "VERIFIED STEP")
    draw.text((68, 612), "Created for OpenAI Build Week", font=fonts["small"], fill=ORANGE)
    return frame


scene_functions = [
    scene_goal,
    scene_source,
    scene_clicks,
    scene_features,
    scene_review,
    scene_export,
    scene_freecad,
    scene_close,
]

# The layouts are intentionally static, except for the four highlighted click
# targets. Cache them once so long narrated scenes render quickly and exactly.
scene_cache = []
for index, function in enumerate(scene_functions):
    if index == 2:
        scene_cache.append([
            function((step + 0.25) * durations[index] / 4, durations[index])
            for step in range(4)
        ])
    else:
        scene_cache.append(function(0, durations[index]))


def frame_at(t):
    index = len(starts) - 1
    for candidate, start in enumerate(starts):
        if t < start + durations[candidate]:
            index = candidate
            break
    local_t = t - starts[index]
    if index == 2:
        active = min(3, int((local_t / max(durations[index], 0.1)) * 4))
        frame = scene_cache[index][active].copy()
    else:
        frame = scene_cache[index].copy()
    draw = ImageDraw.Draw(frame)
    progress = min(1.0, max(0.0, t / TOTAL))
    draw.rectangle((0, H - 8, W, H), fill="#26342E")
    draw.rectangle((0, H - 8, int(W * progress), H), fill=BLUE)
    draw.text((1168, 43), f"{index + 1}/8", font=fonts["tiny"], fill=MUTED)
    return frame


writer = imageio_ffmpeg.write_frames(
    str(OUTPUT),
    (W, H),
    fps=FPS,
    codec="libx264",
    pix_fmt_in="rgb24",
    pix_fmt_out="yuv420p",
    output_params=["-crf", "19", "-preset", "medium", "-movflags", "+faststart"],
)
writer.send(None)
for frame_index in range(round(TOTAL * FPS)):
    writer.send(frame_at(frame_index / FPS).tobytes())
writer.close()
print(json.dumps({"output": str(OUTPUT), "duration": TOTAL, "segments": durations}, indent=2))
