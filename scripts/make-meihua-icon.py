"""Build the Mei Hua app icon and compact sidebar mark."""

from math import cos, pi, sin
from pathlib import Path
import shutil
import subprocess

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets'
OUTPUT = ASSETS / 'meihua'
OUTPUT.mkdir(exist_ok=True)
SIZE = 1024
SCALE = 3
CANVAS = SIZE * SCALE


def point(x, y):
    return (round(x * SCALE), round(y * SCALE))


image = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((point(24, 24), point(1000, 1000)), radius=point(220, 0)[0], fill='#173037')
draw.rounded_rectangle((point(44, 44), point(980, 980)), radius=point(205, 0)[0], outline='#547078', width=6 * SCALE)

# A quiet snow drift and a plum branch anchor the blossom at small sizes.
draw.ellipse((point(560, 750), point(1240, 1230)), fill='#29444b')
branch = [point(187, 811), point(330, 690), point(472, 594), point(568, 447)]
draw.line(branch, fill='#704948', width=45 * SCALE, joint='curve')
draw.line([point(324, 696), point(314, 576), point(265, 504)], fill='#704948', width=24 * SCALE, joint='curve')
draw.line([point(451, 613), point(567, 665), point(670, 675)], fill='#704948', width=21 * SCALE, joint='curve')

center = (520, 457)
for index in range(5):
    angle = -pi / 2 + index * 2 * pi / 5
    px = center[0] + 151 * cos(angle)
    py = center[1] + 151 * sin(angle)
    petal = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    pd = ImageDraw.Draw(petal)
    pd.ellipse((point(px - 127, py - 116), point(px + 127, py + 116)), fill='#bf3959', outline='#e77f96', width=7 * SCALE)
    image.alpha_composite(petal)

draw = ImageDraw.Draw(image)
draw.ellipse((point(439, 376), point(601, 538)), fill='#712a42')
for index in range(12):
    angle = index * 2 * pi / 12
    x = center[0] + 72 * cos(angle)
    y = center[1] + 72 * sin(angle)
    draw.line([point(*center), point(x, y)], fill='#f0c9a1', width=7 * SCALE)
    draw.ellipse((point(x - 10, y - 10), point(x + 10, y + 10)), fill='#f8d9a9')
draw.ellipse((point(496, 433), point(544, 481)), fill='#f4d6a8')

# Snow is a restrained accent, not a second logo.
draw.arc((point(363, 150), point(675, 455)), 190, 341, fill='#f4fbfa', width=29 * SCALE)
draw.ellipse((point(373, 230), point(415, 271)), fill='#f4fbfa')
draw.ellipse((point(686, 249), point(706, 269)), fill='#d6e8e9')
draw.ellipse((point(737, 290), point(749, 302)), fill='#d6e8e9')

image = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
image.save(OUTPUT / 'icon.png', optimize=True)
image.resize((128, 128), Image.Resampling.LANCZOS).save(OUTPUT / 'brand-mark.png', optimize=True)

iconset = ASSETS / 'Meihua.iconset'
iconset.mkdir(exist_ok=True)
try:
    for pixels in (16, 32, 128, 256, 512):
        image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(iconset / f'icon_{pixels}x{pixels}.png')
        image.resize((pixels * 2, pixels * 2), Image.Resampling.LANCZOS).save(iconset / f'icon_{pixels}x{pixels}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(ASSETS / 'Meihua.icns')], check=True)
finally:
    shutil.rmtree(iconset)
