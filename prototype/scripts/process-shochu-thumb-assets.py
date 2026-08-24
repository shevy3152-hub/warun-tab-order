import argparse
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps


# These centers match the already reviewed v1 crops. The tighter, portrait
# crop keeps the physical label intact while removing unused bottle/background
# area; no pixels are generated or redrawn.
ASSETS = {
    "shochu-imo-kuro-kirishima": {"angle": -2.0, "label_y": 1030},
    "shochu-imo-akarui-nouson": {"angle": -1.3, "label_y": 1050},
    "shochu-imo-sekitoba": {"angle": -1.8, "label_y": 1050},
    "shochu-imo-jukugaki": {"angle": -1.5, "label_y": 1080},
    "shochu-imo-mitake": {"angle": -1.0, "label_y": 1080},
    "shochu-imo-tonohozan": {"angle": -1.5, "label_y": 1110},
    "shochu-mugi-iichiko": {"angle": -2.5, "label_y": 1040},
    "shochu-mugi-gesshin": {"angle": -1.3, "label_y": 980},
    "shochu-mugi-ginnomizu": {"angle": -1.4, "label_y": 1050},
    "shochu-kokuto-asahi": {"angle": -1.3, "label_y": 1050},
    "shochu-awamori-zanpa-white": {"angle": -1.2, "label_y": 1040},
    "shochu-imo-rice-tenchu": {"angle": -1.2, "label_y": 1090},
}


def adjusted(image: Image.Image, angle: float) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    corner_pixels = [
        image.getpixel(point)
        for point in ((0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1))
    ]
    fill = tuple(round(sum(pixel[channel] for pixel in corner_pixels) / len(corner_pixels)) for channel in range(3))
    if angle:
        image = image.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=fill)
    image = ImageEnhance.Brightness(image).enhance(1.05)
    image = ImageEnhance.Contrast(image).enhance(1.04)
    return image


def save_webp(image: Image.Image, path: Path) -> None:
    fitted = ImageOps.fit(image, (560, 700), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
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
            crop_width, crop_height = 620, 760
            left = image.width // 2 - crop_width // 2
            top = config["label_y"] - crop_height // 2
            crop = image.crop((left, top, left + crop_width, top + crop_height))
            output = output_root / f"{stable_id}-thumb-v2.webp"
            save_webp(crop, output)
            print(f"{stable_id}\tcrop={crop_width}x{crop_height}\toutput={output.name}")


if __name__ == "__main__":
    main()
