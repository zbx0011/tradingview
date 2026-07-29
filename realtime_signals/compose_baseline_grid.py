"""Compose four per-market state charts into one token-efficient image."""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_path = Path(r"C:\Windows\Fonts\arialbd.ttf")
    if font_path.exists():
        return ImageFont.truetype(str(font_path), size)
    return ImageFont.load_default()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, nargs=4, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    canvas = Image.new("RGB", (1180, 860), "#0d131d")
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (18, 12),
        "HOURLY VISUAL BASELINE · 4 MARKETS · EACH TILE: OUTER 36H + INNER 9H",
        fill="#e5edf8",
        font=_font(19),
    )
    positions = ((10, 48), (595, 48), (10, 454), (595, 454))
    size = (575, 396)
    for source, position in zip(args.inputs, positions):
        with Image.open(source) as image:
            resized = image.convert("RGB").resize(size, Image.Resampling.LANCZOS)
        canvas.paste(resized, position)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(args.output, format="PNG", optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
