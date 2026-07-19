$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root "evaluation\hackathon-narration"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.Rate = 1
$voice.Volume = 100

$segments = @(
    "Drawing2STEP turns a technical drawing into structured, editable CAD. Its goal is simple: reduce repetitive tracing, keep the design intent visible, and deliver geometry an engineer can verify in FreeCAD.",
    "Start with the picture you want to reconstruct. It can be a CAD screenshot, a dimensioned drawing, or a clean mechanical render. Here, we use a gusset bracket with a base, an upright wall, a reinforcing rib, and three holes.",
    "Open Drawing2STEP and click Choose a drawing. Select the image from your computer. Under Vision engine, choose Local Ollama so the image stays on your device. Keep the AI verification pass enabled, then click Analyze with AI.",
    "The AI does more than label the image. It separates the object into physical features: the base plate, upright plate, gusset, rounded boundaries, and through holes. Dimensions shown in the drawing are treated as evidence; missing values are estimated and clearly identified.",
    "Now review the reconstruction summary. Drawing2STEP checks that dimensions are positive, profiles are closed, holes remain separate cut features, and operations form a valid feature tree. This prevents malformed AI output from becoming broken CAD.",
    "When the result is ready, click Export geometry JSON to save the editable feature program. Then click Build merged STEP to construct the complete solid. JSON preserves the reasoning and dimensions; STEP is the manufacturing-compatible three-dimensional result.",
    "For the final check, open FreeCAD. Choose File, then Open, and select the generated STEP file. Inspect the base, upright, gusset, rounded edges, and every hole. Rotate the model and confirm that the separate features merge into one coherent solid.",
    "For OpenAI Build Week, Drawing2STEP connects local AI interpretation with deterministic CAD validation. It makes image-to-CAD work faster, reviewable, and ready for automation, while keeping FreeCAD as the final source of geometric confidence."
)

for ($i = 0; $i -lt $segments.Count; $i++) {
    $path = Join-Path $outDir ("segment-{0:D2}.wav" -f ($i + 1))
    $voice.SetOutputToWaveFile($path)
    $voice.Speak($segments[$i])
    $voice.SetOutputToNull()
}

$voice.Dispose()
Write-Output $outDir
