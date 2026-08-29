from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps


ASSETS = {
    "shochu-imo-kuro-kirishima": {"angle": 8.0, "label_y": 1030},
    "shochu-imo-akarui-nouson": {"angle": 7.0, "label_y": 1050},
    "shochu-imo-sekitoba": {"angle": 8.0, "label_y": 1050},
    "shochu-imo-jukugaki": {"angle": 8.0, "label_y": 1080},
    "shochu-imo-mitake": {"angle": 7.0, "label_y": 1080},
    "shochu-imo-tonohozan": {"angle": 8.0, "label_y": 1110},
    "shochu-mugi-iichiko": {"angle": 10.0, "label_y": 1040},
    "shochu-mugi-gesshin": {"angle": 2.5, "label_y": 980},
    "shochu-mugi-ginnomizu": {"angle": 3.0, "label_y": 1050},
    "shochu-kokuto-asahi": {"angle": 4.0, "label_y": 1050},
    "shochu-awamori-zanpa-white": {"angle": 7.0, "label_y": 1040},
    "shochu-imo-rice-tenchu": {"angle": 1.5, "label_y": 1090},
}


def adjusted(image: Image.Image, angle: float) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    corner_pixels = [image.getpixel(point) for point in ((0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1))]
    fill = tuple(round(sum(pixel[channel] for pixel in corner_pixels) / len(corner_pixels)) for channel in range(3))
    if angle:
        image = image.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=fill)
    image = ImageEnhance.Brightness(image).enhance(1.05)
    image = ImageEnhance.Contrast(image).enhance(1.04)
    return image


def save_webp(image: Image.Image, path: Path, size: tuple[int, int]) -> None:
    fitted = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    fitted.save(path, "WEBP", quality=88, method=6)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    for stable_id, config in ASSETS.items():
        source = source_root / f"{stable_id}.jpeg"
        if not source.is_file():
            raise FileNotFoundError(source)
        with Image.open(source) as original:
            image = adjusted(original, config["angle"])
            detail = output_root / f"{stable_id}-detail-v1.webp"
            thumb = output_root / f"{stable_id}-thumb-v1.webp"
            save_webp(image, detail, (760, 1320))
            label_box = (image.width // 2 - 360, config["label_y"] - 360, image.width // 2 + 360, config["label_y"] + 360)
            label_crop = image.crop(label_box)
            save_webp(label_crop, thumb, (560, 560))
            print(f"{stable_id}\tdetail={detail.name}\tthumb={thumb.name}")


if __name__ == "__main__":
    main()
