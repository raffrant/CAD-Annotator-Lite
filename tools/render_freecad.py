import FreeCAD as App, FreeCADGui as Gui
import sys, os
source=os.environ.get("FCSTD_INPUT",sys.argv[1] if len(sys.argv)>1 else "")
output=os.environ.get("PNG_OUTPUT",sys.argv[2] if len(sys.argv)>2 else "render.png")
doc=App.openDocument(source);doc.recompute();obj=doc.getObject("AIReconstruction") or next(iter(doc.Objects),None)
for candidate in doc.Objects:
    candidate.ViewObject.Visibility=True
if obj:
    if os.environ.get("VIEW_ROTATION_Z"):
        rotation=App.Rotation(App.Vector(0,0,1),float(os.environ["VIEW_ROTATION_Z"]))
        for candidate in doc.Objects:
            candidate.Placement=App.Placement(candidate.Placement.Base,rotation.multiply(candidate.Placement.Rotation))
        doc.recompute()
view=Gui.activeDocument().activeView();view.viewAxonometric();view.fitAll()
for _ in range(8): Gui.updateGui()
view.saveImage(output,900,650,"White");App.closeDocument(doc.Name);Gui.getMainWindow().close()
