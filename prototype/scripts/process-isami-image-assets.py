from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps


ITEM_ID = "menu-24eeac7c-2388-4ef5-87b0-21f5013f5673"
SOURCE_SIZE = (1440, 1920)
LABEL_CENTER_X = 780
LABEL_CENTER_Y = 1490
THUMB_CROP_SIZE = (620, 760)

# The supplied bottle leans slightly to the right at the cap. Positive PIL
# rotation corrects that tilt before the alpha crop is calculated.
ROTATION_DEGREES = 3.5


def adjusted(source: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(source).convert("RGB")
    if image.size != SOURCE_SIZE:
        raise ValueError(f"Unexpected source size: {image.size}; expected {SOURCE_SIZE}")

    corner_pixels = [
        image.getpixel(point)
        for point in ((0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1))
    ]
    fill = tuple(round(sum(pixel[channel] for pixel in corner_pixels) / len(corner_pixels)) for channel in range(3))
    image = image.rotate(ROTATION_DEGREES, Image.Resampling.BICUBIC, expand=True, fillcolor=fill)

    return ImageEnhance.Contrast(ImageEnhance.Brightness(image).enhance(1.05)).enhance(1.04)


def fit_photo(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    return ImageOps.fit(image, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5)).convert("RGB")


def make_thumbnail(image: Image.Image) -> Image.Image:
    crop_width, crop_height = THUMB_CROP_SIZE
    left = round(LABEL_CENTER_X - crop_width / 2)
    top = round(LABEL_CENTER_Y - crop_height / 2)
    crop = image.crop((left, top, left + crop_width, top + crop_height))
    return fit_photo(crop, (560, 700))


def paste_contained(sheet: Image.Image, asset: Image.Image, box: tuple[int, int, int, int]) -> None:
    x, y, width, height = box
    background = Image.new("RGBA", (width, height), (238, 234, 226, 255))
    fitted = ImageOps.contain(asset, (width - 12, height - 12), method=Image.Resampling.LANCZOS)
    background.alpha_composite(fitted, ((width - fitted.width) // 2, (height - fitted.height) // 2))
    sheet.alpha_composite(background, (x, y))


def make_contact_sheet(output_root: Path, path: Path) -> None:
    stable_ids = [
        "shochu-imo-kuro-kirishima", "shochu-imo-akarui-nouson", "shochu-imo-sekitoba",
        "shochu-imo-jukugaki", "shochu-imo-mitake", "shochu-imo-tonohozan",
        "shochu-mugi-iichiko", "shochu-mugi-gesshin", "shochu-mugi-ginnomizu",
        "shochu-kokuto-asahi", "shochu-awamori-zanpa-white", "shochu-imo-rice-tenchu",
        ITEM_ID,
    ]
    titles = {
        "shochu-imo-kuro-kirishima": "黒霧島", "shochu-imo-akarui-nouson": "明るい農村",
        "shochu-imo-sekitoba": "赤兎馬", "shochu-imo-jukugaki": "熟柿",
        "shochu-imo-mitake": "三岳", "shochu-imo-tonohozan": "富乃宝山",
        "shochu-mugi-iichiko": "いいちこ", "shochu-mugi-gesshin": "月心",
        "shochu-mugi-ginnomizu": "銀の水", "shochu-kokuto-asahi": "朝日",
        "shochu-awamori-zanpa-white": "残波 白", "shochu-imo-rice-tenchu": "天誅",
        ITEM_ID: "伊佐美（再加工）",
    }
    columns, cell_width, cell_height = 4, 220, 260
    rows = (len(stable_ids) + columns - 1) // columns
    sheet = Image.new("RGBA", (columns * cell_width, 48 + rows * cell_height * 2 + 48), (246, 242, 235, 255))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("C:/Windows/Fonts/meiryo.ttc", 14)
    draw.text((16, 14), "焼酎画像比較：thumb（上）／detail（下）・元写真の背景を保持", fill=(30, 30, 30, 255), font=font)
    thumb_y, detail_y = 48, 48 + rows * cell_height
    for index, stable_id in enumerate(stable_ids):
        x = (index % columns) * cell_width
        y = (index // columns) * cell_height
        thumb_name = f"{stable_id}-thumb-v2.webp" if stable_id != ITEM_ID else f"{ITEM_ID}-thumb-v1.png"
        detail_name = f"{stable_id}-detail-v1.webp" if stable_id != ITEM_ID else f"{ITEM_ID}-detail-v1.png"
        with Image.open(output_root / thumb_name) as thumb:
            paste_contained(sheet, thumb.convert("RGBA"), (x + 10, thumb_y + y + 24, 200, 200))
        with Image.open(output_root / detail_name) as detail:
            paste_contained(sheet, detail.convert("RGBA"), (x + 10, detail_y + y + 24, 200, 200))
        draw.text((x + 12, thumb_y + y + 4), titles[stable_id], fill=(30, 30, 30, 255), font=font)
        draw.text((x + 12, detail_y + y + 4), titles[stable_id], fill=(30, 30, 30, 255), font=font)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path)
    args = parser.parse_args()
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    with Image.open(args.source) as original:
        image = adjusted(original)
        detail = fit_photo(image, (760, 1320))
        thumb = make_thumbnail(image)
        detail_path = output_root / f"{ITEM_ID}-detail-v1.png"
        thumb_path = output_root / f"{ITEM_ID}-thumb-v1.png"
        detail.save(detail_path, "PNG", optimize=True)
        thumb.save(thumb_path, "PNG", optimize=True)
        if args.contact_sheet:
            make_contact_sheet(output_root, args.contact_sheet.resolve())
        print(f"source={args.source.resolve()}")
        print(f"detail={detail_path} size={detail.size} mode={detail.mode}")
        print(f"thumb={thumb_path} size={thumb.size} mode={thumb.mode}")


if __name__ == "__main__":
    main()
