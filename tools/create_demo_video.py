from pathlib import Path
import math, sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".video-deps"))
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import imageio_ffmpeg

W, H, FPS, DURATION = 1280, 720, 15, 62
source = Image.open(r"C:\Users\RFRANT~1\AppData\Local\Temp\codex-clipboard-a1c1a846-3688-4deb-a3df-93027919cf1d.png").convert("RGB")
app = Image.open(ROOT / "evaluation/video-01-app-start.png").convert("RGB")
cad = Image.open(ROOT / "evaluation/gusset-bracket/gusset-bracket-render.png").convert("RGB")
output = ROOT / "evaluation/Drawing2STEP-demo.mp4"

regular = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 30)
small = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 24)
bold = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 48)
title = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 64)

def fit(image, box, cover=False):
    x, y, w, h = box
    scale = max(w/image.width, h/image.height) if cover else min(w/image.width, h/image.height)
    resized = image.resize((max(1,int(image.width*scale)), max(1,int(image.height*scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (w,h), "white")
    canvas.paste(resized, ((w-resized.width)//2,(h-resized.height)//2))
    return canvas

def base():
    return Image.new("RGB", (W,H), "#111715")

def header(frame, heading, sub=""):
    d=ImageDraw.Draw(frame); d.text((55,38),heading,font=bold,fill="#f4f1e8")
    if sub:d.text((58,100),sub,font=small,fill="#9fb0a8")

def panel(frame, image, box):
    x,y,w,h=box; frame.paste(fit(image,(0,0,w,h)),(x,y)); ImageDraw.Draw(frame).rounded_rectangle((x,y,x+w,y+h),18,outline="#6c9cff",width=3)

def bullets(frame, values, x=700, y=220):
    d=ImageDraw.Draw(frame)
    for i,v in enumerate(values):
        yy=y+i*62; d.ellipse((x,yy+10,x+14,yy+24),fill="#6c9cff"); d.text((x+30,yy),v,font=regular,fill="#f4f1e8")

def frame_at(t):
    f=base(); d=ImageDraw.Draw(f)
    if t < 6:
        d.text((70,225),"Drawing2STEP",font=title,fill="#f4f1e8")
        d.text((74,315),"Local AI drawing → validated FreeCAD STEP",font=regular,fill="#6c9cff")
        d.text((74,382),"Fast demonstration",font=small,fill="#9fb0a8")
    elif t < 15:
        header(f,"1. Start with a drawing","One image becomes structured geometry evidence")
        panel(f,source,(80,155,520,470)); bullets(f,["Local Ollama vision","Detect body, holes and ribs","Estimate missing dimensions"],680,220)
    elif t < 25:
        header(f,"2. Analyze inside Drawing2STEP","The image stays local when Ollama is selected")
        bg=fit(app,(0,0,W-100,H-180),cover=True).filter(ImageFilter.GaussianBlur(0.4)); f.paste(bg,(50,145))
        d.rounded_rectangle((790,205,1190,525),18,fill="#111715",outline="#6c9cff",width=3)
        d.text((825,235),"AI reconstruction",font=regular,fill="#f4f1e8")
        for i,v in enumerate(["Base plate","Upright plate","Triangular gusset","3 through-holes"]): d.text((830,295+i*50),"✓  "+v,font=small,fill="#b9d7c9")
    elif t < 36:
        header(f,"3. Build the feature program","Small physical features are checked before export")
        boxes=[("IMAGE",70),("OLLAMA",310),("VALIDATE",550),("FREECAD",790),("STEP",1030)]
        for label,x in boxes:
            d.rounded_rectangle((x,280,x+170,370),15,fill="#1e2925",outline="#6c9cff",width=3); d.text((x+25,308),label,font=small,fill="#f4f1e8")
        for x in [245,485,725,965]: d.line((x,325,x+55,325),fill="#e5653f",width=5); d.polygon([(x+55,325),(x+40,316),(x+40,334)],fill="#e5653f")
        d.text((145,445),"Dimensions • topology • holes • transforms • interference checks",font=regular,fill="#9fb0a8")
    elif t < 49:
        header(f,"4. Open the generated model in FreeCAD","The STEP is a real solid, not a rendered picture")
        panel(f,cad,(70,150,760,510)); bullets(f,["Base and upright","Reinforcing web","Large upright hole","Two base holes"],875,190)
    elif t < 57:
        header(f,"5. Automate engineering handoff","Repeatable image-to-CAD preparation")
        bullets(f,["Reduce manual tracing","Preserve dimension evidence","Block invalid geometry","Export JSON + STEP","Continue editing in FreeCAD"],235,190)
    else:
        d.text((155,245),"Drawing2STEP",font=title,fill="#f4f1e8")
        d.text((160,340),"AI interpretation + deterministic CAD verification",font=regular,fill="#6c9cff")
        d.text((160,410),"Local • reviewable • automation-ready",font=small,fill="#9fb0a8")
    # Progress line and subtle frame number movement keep the MP4 visibly animated.
    d.rectangle((0,H-9,int(W*t/DURATION),H),fill="#6c9cff")
    return f

writer = imageio_ffmpeg.write_frames(str(output),(W,H),fps=FPS,codec="libx264",pix_fmt_in="rgb24",pix_fmt_out="yuv420p",output_params=["-crf","21","-movflags","+faststart"])
writer.send(None)
for index in range(DURATION*FPS): writer.send(frame_at(index/FPS).tobytes())
writer.close()
print(output)
