"""Draws the plugin's PNG icons (action list, category, plugin, default key)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "io.github.antoinersx.t3codedeck.sdPlugin" / "imgs"
WHITE, AMBER, GREEN, BG = (240, 243, 245, 255), (247, 184, 61, 255), (60, 203, 127, 255), (15, 17, 19, 255)

def canvas(size, bg=None):
    s = size * 8
    im = Image.new("RGBA", (s, s), bg or (0, 0, 0, 0))
    return im, ImageDraw.Draw(im), s

def done(im, size, name):
    im.resize((size, size), Image.LANCZOS).save(OUT / name)

def g_thread(d, s, c):  # stacked rows = threads
    for i, y in enumerate((0.22, 0.45, 0.68)):
        d.rounded_rectangle([s*0.14, s*y, s*0.86, s*(y+0.16)], radius=s*0.05, fill=c if i else AMBER)

def g_threads(d, s, c):  # knob with list
    d.ellipse([s*0.1, s*0.1, s*0.9, s*0.9], outline=c, width=int(s*0.08))
    for y in (0.36, 0.5, 0.64):
        d.line([s*0.32, s*y, s*0.68, s*y], fill=c, width=int(s*0.07))

def g_model(d, s, c):  # spark
    m = s/2
    pts = [(m, s*0.1), (m+s*0.11, m-s*0.11), (s*0.9, m), (m+s*0.11, m+s*0.11), (m, s*0.9), (m-s*0.11, m+s*0.11), (s*0.1, m), (m-s*0.11, m-s*0.11)]
    d.polygon(pts, fill=c)

def g_effort(d, s, c):  # rising bars
    for i, h in enumerate((0.3, 0.5, 0.75)):
        x = s*(0.14 + i*0.26)
        d.rounded_rectangle([x, s*(0.88-h), x+s*0.2, s*0.88], radius=s*0.04, fill=c)

def g_usage(d, s, c):  # gauge
    d.arc([s*0.08, s*0.18, s*0.92, s*1.02], 180, 360, fill=c, width=int(s*0.1))
    d.line([s*0.5, s*0.6, s*0.72, s*0.36], fill=c, width=int(s*0.08))
    d.ellipse([s*0.43, s*0.53, s*0.57, s*0.67], fill=c)

def mark(d, s):  # plugin / category mark: T3-ish deck of status dots
    for i, col in enumerate((AMBER, GREEN, WHITE)):
        y = s*(0.22 + i*0.22)
        d.ellipse([s*0.2, y, s*0.34, y+s*0.14], fill=col)
        d.rounded_rectangle([s*0.42, y+s*0.03, s*0.82, y+s*0.11], radius=s*0.04, fill=WHITE)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("act-thread", g_thread), ("act-threads", g_threads), ("act-model", g_model), ("act-effort", g_effort), ("act-usage", g_usage)):
        for size, suffix in ((20, ""), (40, "@2x")):
            im, d, s = canvas(size); fn(d, s, WHITE); done(im, size, f"{name}{suffix}.png")
    for size, suffix in ((28, ""), (56, "@2x")):
        im, d, s = canvas(size); mark(d, s); done(im, size, f"category{suffix}.png")
    for size, suffix in ((256, ""), (512, "@2x")):
        im, d, s = canvas(size, BG); mark(d, s); done(im, size, f"plugin{suffix}.png")
    for size, suffix in ((72, ""), (144, "@2x")):
        im, d, s = canvas(size, BG); g_thread(d, s, (90, 98, 105, 255)); done(im, size, f"key-thread{suffix}.png")

if __name__ == "__main__":
    sys.exit(main())
