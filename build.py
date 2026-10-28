#!/usr/bin/env python3
"""Inline vendor + src into dist/scalpview.html."""
import glob, os, sys
H = os.path.dirname(os.path.abspath(__file__))
src = lambda p: open(os.path.join(H, p), encoding="utf8").read()
css = "\n".join(src(os.path.relpath(f, H)) for f in sorted(glob.glob(os.path.join(H, "src/*.css"))))
js = [src("vendor/lightweight-charts.js")]
for f in sorted(glob.glob(os.path.join(H, "src/*.js"))):
    js.append(f"/* ---- {os.path.basename(f)} ---- */\n" + open(f, encoding="utf8").read())
page = src("src/index.html").replace("/*@CSS@*/", css).replace("/*@JS@*/", "\n;\n".join(js).replace("</script", "<\\/script"))
os.makedirs(os.path.join(H, "dist"), exist_ok=True)
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(H, "dist/scalpview.html")
tmp = out + ".tmp"
open(tmp, "w", encoding="utf8").write(page)
os.replace(tmp, out)  # atomic, so a parallel test never loads a half-written file
print(f"{out} {len(page)//1024} KB")
