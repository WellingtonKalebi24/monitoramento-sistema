from pathlib import Path

import hashlib
import requests

MODELS_DIR = Path(__file__).resolve().parent / "models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": {
        "url": (
            "https://files.kde.org/digikam/facesengine/yunet/"
            "face_detection_yunet_2023mar.onnx"
        ),
        "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    },
    "face_recognition_sface_2021dec.onnx": {
        "url": (
            "https://files.kde.org/digikam/facesengine/dnnface/"
            "face_recognition_sface_2021dec.onnx"
        ),
        "sha256": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(filename: str, config: dict[str, str]) -> None:
    target = MODELS_DIR / filename
    temporary = target.with_suffix(f"{target.suffix}.part")
    if target.exists() and sha256(target) == config["sha256"]:
        print(f"{filename} já disponível e validado.")
        return

    print(f"Baixando {filename}...")
    with requests.get(config["url"], timeout=120, stream=True) as response:
        response.raise_for_status()
        with temporary.open("wb") as model_file:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    model_file.write(chunk)

    if sha256(temporary) != config["sha256"]:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Checksum inválido para {filename}.")

    temporary.replace(target)
    print(f"{filename} baixado ({target.stat().st_size} bytes).")


def main() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    for filename, config in MODELS.items():
        download(filename, config)


if __name__ == "__main__":
    main()
