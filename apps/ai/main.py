from __future__ import annotations

import base64
import os
import select
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import requests
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:4000")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "local-internal-key")
COOLDOWN_SECONDS = int(os.getenv("DETECTION_COOLDOWN_SECONDS", "20"))
FACE_MATCH_THRESHOLD = float(os.getenv("SFACE_MATCH_THRESHOLD", "0.45"))
FACE_MATCH_MARGIN = max(0.0, float(os.getenv("SFACE_MATCH_MARGIN", "0.08")))
ANALYSIS_INTERVAL_SECONDS = max(0.05, float(os.getenv("FACE_ANALYSIS_INTERVAL_SECONDS", "0.25")))
STREAM_FPS = max(1, min(30, int(os.getenv("PREVIEW_STREAM_FPS", "15"))))
PREVIEW_JPEG_QUALITY = max(45, min(95, int(os.getenv("PREVIEW_JPEG_QUALITY", "82"))))
RTMP_DECODE_MAX_WIDTH = max(0, min(1920, int(os.getenv("RTMP_DECODE_MAX_WIDTH", "1280"))))
DETECTION_CLIP_SECONDS = max(0.2, float(os.getenv("DETECTION_CLIP_SECONDS", "3")))
DETECTION_CLIP_FPS = max(1, min(15, int(os.getenv("DETECTION_CLIP_FPS", "8"))))
DETECTION_CLIP_MAX_WIDTH = max(160, min(1280, int(os.getenv("DETECTION_CLIP_MAX_WIDTH", "640"))))
RTMP_CAPTURE_BACKEND = os.getenv("RTMP_CAPTURE_BACKEND", "ffmpeg").lower()
RTMP_FIRST_FRAME_TIMEOUT_SECONDS = max(6.0, float(os.getenv("RTMP_FIRST_FRAME_TIMEOUT_SECONDS", "30")))
RTMP_FRAME_TIMEOUT_SECONDS = max(3.0, float(os.getenv("RTMP_FRAME_TIMEOUT_SECONDS", "10")))
RTMP_NORMALIZED_PATH_PREFIX = os.getenv("RTMP_NORMALIZED_PATH_PREFIX", "").strip().strip("/")
FACE_MODEL_NAME = "opencv_sface_2021dec_v1"

DATA_DIR = Path(__file__).resolve().parent / "data"
DETECTIONS_DIR = DATA_DIR / "detections"
DETECTIONS_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR = Path(__file__).resolve().parent / "models"
YUNET_MODEL_PATH = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
SFACE_MODEL_PATH = MODELS_DIR / "face_recognition_sface_2021dec.onnx"

app = FastAPI(title="Facial Monitoring AI Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/detections/{filename}")
def detection_file(filename: str):
    safe_filename = Path(filename).name
    path = DETECTIONS_DIR / safe_filename

    if path.suffix.lower() == ".mp4":
        webm_path = path.with_suffix(".webm")
        if webm_path.exists():
            return RedirectResponse(url=f"/detections/{webm_path.name}")

    if not path.exists() or not path.is_file():
        return JSONResponse(status_code=404, content={"message": "Arquivo não encontrado."})

    return FileResponse(path)

if not YUNET_MODEL_PATH.exists() or not SFACE_MODEL_PATH.exists():
    raise RuntimeError(
        "Modelos faciais ausentes. Execute: python apps/ai/download_models.py"
    )

face_detector = cv2.FaceDetectorYN.create(
    str(YUNET_MODEL_PATH), "", (320, 320), 0.8, 0.3, 5000
)
face_recognizer = cv2.FaceRecognizerSF.create(str(SFACE_MODEL_PATH), "")
face_model_lock = threading.Lock()


class EmbeddingRequest(BaseModel):
    imageDataUrl: str


class CameraTestRequest(BaseModel):
    cameraId: str | None = None
    sourceType: str = "rtsp"
    rtspUrl: str | None = None
    deviceIndex: int | None = None


@dataclass
class CameraConfig:
    id: str
    tenant_id: str
    name: str
    source_type: str
    rtsp_url: str | None
    device_index: int | None
    location: str
    mode: str
    status: str


@dataclass
class FaceProfile:
    employee_id: str
    tenant_id: str
    full_name: str
    embedding: np.ndarray


@dataclass
class CameraRuntime:
    config: CameraConfig
    lock: threading.Lock = field(default_factory=threading.Lock)
    latest_frame: Any = None
    latest_snapshot_path: Path | None = None
    frame_buffer: Any = field(default_factory=lambda: deque(maxlen=120))
    connected: bool = False
    face_count: int = 0
    last_error: str | None = None
    last_detection_by_key: dict[str, float] = field(default_factory=dict)
    annotations: list[tuple[int, int, int, int, tuple[int, int, int], str]] = field(default_factory=list)
    last_analysis_at: float = 0.0
    last_frame_at: float = 0.0
    running: bool = False
    active: bool = True


camera_states: dict[str, CameraRuntime] = {}
face_profiles: list[FaceProfile] = []
global_lock = threading.Lock()
webcam_locks: dict[int, threading.Lock] = {}
webcam_locks_guard = threading.Lock()


class FfmpegMjpegCapture:
    """Read RTMP streams through ffmpeg and expose a VideoCapture-like API.

    Some VPS/OpenCV builds report an RTMP stream as open but never deliver frames.
    Piping high-quality MJPEG frames through ffmpeg is slower than a native decoder,
    but it is much more reliable for DVR/camera RTMP publishing.
    """

    def __init__(self, url: str):
        self.url = url
        self.process: subprocess.Popen[bytes] | None = None
        self.buffer = bytearray()
        self.stderr_tail: deque[str] = deque(maxlen=20)
        self._stderr_thread: threading.Thread | None = None
        self._open()

    def _open(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            return

        video_filters = [f"fps={STREAM_FPS}"]
        if RTMP_DECODE_MAX_WIDTH > 0:
            # Keep the main-stream quality useful for face recognition, but avoid
            # decoding/sending unnecessarily huge JPEG frames to the browser.
            # Use force_original_aspect_ratio instead of min()/commas because
            # some ffmpeg builds parse filtergraph commas differently in argv.
            video_filters.append(
                f"scale={RTMP_DECODE_MAX_WIDTH}:-2:force_original_aspect_ratio=decrease"
            )

        command = [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "warning",
            "-fflags",
            "discardcorrupt",
            "-flags",
            "low_delay",
            "-rtmp_live",
            "live",
            "-i",
            self.url,
            "-an",
            "-vf",
            ",".join(video_filters),
            "-q:v",
            "4",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ]

        self.process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        process = self.process
        if process is None or process.stderr is None:
            return

        for line in iter(process.stderr.readline, b""):
            decoded = line.decode("utf-8", errors="replace").strip()
            if decoded:
                self.stderr_tail.append(decoded)

    def isOpened(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def _extract_jpeg(self):
        start = self.buffer.find(b"\xff\xd8")
        if start < 0:
            if len(self.buffer) > 1024 * 1024:
                self.buffer.clear()
            return None

        if start > 0:
            del self.buffer[:start]

        end = self.buffer.find(b"\xff\xd9", 2)
        if end < 0:
            return None

        jpeg = bytes(self.buffer[: end + 2])
        del self.buffer[: end + 2]
        image = np.frombuffer(jpeg, dtype=np.uint8)
        return cv2.imdecode(image, cv2.IMREAD_COLOR)

    def last_error(self) -> str | None:
        errors = list(self.stderr_tail)[-5:]
        return "; ".join(errors) if errors else None

    def read(self, timeout_seconds: float | None = None):
        process = self.process
        if process is None or process.stdout is None:
            return False, None

        deadline = time.time() + (timeout_seconds or RTMP_FRAME_TIMEOUT_SECONDS)
        while time.time() < deadline and self.isOpened():
            frame = self._extract_jpeg()
            if frame is not None:
                return True, frame

            timeout = max(0.1, deadline - time.time())
            if os.name != "nt":
                readable, _, _ = select.select([process.stdout], [], [], timeout)
                if not readable:
                    continue

            chunk = process.stdout.read(4096)
            if not chunk:
                break
            self.buffer.extend(chunk)

        frame = self._extract_jpeg()
        return (True, frame) if frame is not None else (False, None)

    def release(self) -> None:
        process = self.process
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        self.process = None


class RtmpFallbackCapture:
    """Try common DVR RTMP path variants without requiring manual recadastro.

    Some DVRs publish as /stream while others require /live/stream. The system
    stores one URL, but the receiver may expose either shape depending on the
    RTMP server in use. This wrapper tries both and keeps the first one that
    actually yields frames.
    """

    def __init__(self, urls: list[str]):
        self.urls = urls
        self.index = 0
        self.capture: FfmpegMjpegCapture | None = None
        self.error_tail: deque[str] = deque(maxlen=12)
        self._open_current()

    def _open_current(self) -> None:
        if not self.urls:
            return
        self.capture = FfmpegMjpegCapture(self.urls[self.index])

    def isOpened(self) -> bool:
        return self.capture is not None and self.capture.isOpened()

    def _rotate(self) -> bool:
        if self.capture is not None:
            error = self.capture.last_error()
            if error:
                self.error_tail.append(f"{self.capture.url}: {error}")
            self.capture.release()

        if len(self.urls) <= 1:
            self.capture = None
            return False

        self.index = (self.index + 1) % len(self.urls)
        self._open_current()
        return self.isOpened()

    def read(self, timeout_seconds: float | None = None):
        attempts = max(1, len(self.urls))
        per_attempt_timeout = max(3.0, (timeout_seconds or RTMP_FRAME_TIMEOUT_SECONDS) / attempts)

        for _ in range(attempts):
            if self.capture is None or not self.capture.isOpened():
                if not self._rotate():
                    continue

            ok, frame = self.capture.read(per_attempt_timeout)
            if ok and frame is not None:
                return True, frame

            self._rotate()

        return False, None

    def last_error(self) -> str | None:
        errors = list(self.error_tail)
        if self.capture is not None:
            current_error = self.capture.last_error()
            if current_error:
                errors.append(f"{self.capture.url}: {current_error}")
        return "; ".join(errors[-6:]) if errors else None

    def release(self) -> None:
        if self.capture is not None:
            self.capture.release()
            self.capture = None


def decode_data_url(image_data_url: str):
    if "," not in image_data_url:
        raise ValueError("Imagem inválida.")

    _, encoded = image_data_url.split(",", 1)
    raw = base64.b64decode(encoded)
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("Não foi possível ler a imagem.")

    return image


def extract_faces(frame):
    height, width = frame.shape[:2]
    with face_model_lock:
        face_detector.setInputSize((width, height))
        _, faces = face_detector.detect(frame)

    return [] if faces is None else faces


def build_embedding(frame, face_data):
    with face_model_lock:
        aligned_face = face_recognizer.alignCrop(frame, np.asarray(face_data, dtype="float32"))
        feature = face_recognizer.feature(aligned_face)

    vector = feature.astype("float32").flatten()
    norm = np.linalg.norm(vector) or 1.0
    return vector / norm


def cosine_similarity(left: np.ndarray, right: np.ndarray):
    return min(1.0, max(0.0, float(np.dot(left, right))))


def save_snapshot(camera_id: str, frame) -> str:
    filename = f"{camera_id}-{uuid.uuid4()}.jpg"
    path = DETECTIONS_DIR / filename
    cv2.imwrite(str(path), frame)
    runtime = camera_states[camera_id]
    with runtime.lock:
        runtime.latest_snapshot_path = path
    return f"http://localhost:8000/detections/{filename}"


def resize_clip_frame(frame):
    height, width = frame.shape[:2]
    if width <= DETECTION_CLIP_MAX_WIDTH:
        resized = frame
    else:
        scale = DETECTION_CLIP_MAX_WIDTH / width
        resized = cv2.resize(frame, (DETECTION_CLIP_MAX_WIDTH, int(height * scale)))

    output_height, output_width = resized.shape[:2]
    output_width -= output_width % 2
    output_height -= output_height % 2
    return resized[:output_height, :output_width]


def save_clip_with_ffmpeg(runtime: CameraRuntime, clip_frames: list[Any], width: int, height: int):
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None

    filename = f"{runtime.config.id}-{uuid.uuid4()}.mp4"
    path = DETECTIONS_DIR / filename
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(DETECTION_CLIP_FPS),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(path),
    ]

    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        for frame in clip_frames:
            if frame.shape[:2] != (height, width):
                frame = cv2.resize(frame, (width, height))
            process.stdin.write(frame.tobytes())
        process.stdin.close()
        process.wait(timeout=20)
        stderr = process.stderr.read() if process.stderr is not None else b""
    except Exception as exc:
        if path.exists():
            path.unlink(missing_ok=True)
        print(f"[clip] ffmpeg mp4 failed: {exc}", flush=True)
        return None

    if process.returncode != 0:
        if path.exists():
            path.unlink(missing_ok=True)
        print(
            f"[clip] ffmpeg mp4 failed: {stderr.decode('utf-8', errors='replace')}",
            flush=True,
        )
        return None

    if path.exists() and path.stat().st_size > 0:
        with runtime.lock:
            runtime.latest_snapshot_path = path
        return f"http://localhost:8000/detections/{filename}"

    return None


def save_detection_clip(runtime: CameraRuntime, fallback_frame) -> str:
    detected_at = time.time()
    with runtime.lock:
        buffered_frames = [
            frame.copy()
            for timestamp, frame in runtime.frame_buffer
            if timestamp >= detected_at - DETECTION_CLIP_SECONDS
        ]

    if not buffered_frames:
        buffered_frames = [fallback_frame.copy()]

    target_frame_count = max(1, int(DETECTION_CLIP_SECONDS * DETECTION_CLIP_FPS))
    if len(buffered_frames) > target_frame_count:
        step = len(buffered_frames) / target_frame_count
        buffered_frames = [
            buffered_frames[min(int(index * step), len(buffered_frames) - 1)]
            for index in range(target_frame_count)
        ]

    while len(buffered_frames) < target_frame_count:
        buffered_frames.append(buffered_frames[-1].copy())

    clip_frames = [resize_clip_frame(frame) for frame in buffered_frames]
    height, width = clip_frames[0].shape[:2]

    ffmpeg_clip_url = save_clip_with_ffmpeg(runtime, clip_frames, width, height)
    if ffmpeg_clip_url:
        return ffmpeg_clip_url

    filename = f"{runtime.config.id}-{uuid.uuid4()}.webm"
    path = DETECTIONS_DIR / filename
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"VP80"),
        DETECTION_CLIP_FPS,
        (width, height),
    )

    if writer.isOpened():
        for frame in clip_frames:
            if frame.shape[:2] != (height, width):
                frame = cv2.resize(frame, (width, height))
            writer.write(frame)
        writer.release()

        if path.exists() and path.stat().st_size > 0:
            with runtime.lock:
                runtime.latest_snapshot_path = path
            return f"http://localhost:8000/detections/{filename}"

    writer.release()
    return save_snapshot(runtime.config.id, fallback_frame)


def refresh_context() -> None:
    try:
        response = requests.get(
            f"{API_BASE_URL}/internal/monitoring-context",
            headers={"x-internal-key": INTERNAL_API_KEY},
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException:
        return

    cameras = [
        CameraConfig(
            id=item["id"],
            tenant_id=item["tenantId"],
            name=item["name"],
            source_type=item.get("sourceType", "rtsp"),
            rtsp_url=item.get("rtspUrl"),
            device_index=item.get("deviceIndex"),
            location=item["location"],
            mode=item["mode"],
            status=item["status"],
        )
        for item in payload.get("cameras", [])
    ]
    profiles = [
        FaceProfile(
            employee_id=item["employeeId"],
            tenant_id=item["tenantId"],
            full_name=item["fullName"],
            embedding=np.array(item["embedding"], dtype="float32"),
        )
        for item in payload.get("faces", [])
    ]

    with global_lock:
        global face_profiles
        face_profiles = profiles
        incoming_camera_ids = {camera.id for camera in cameras}

        for camera in cameras:
            runtime = camera_states.get(camera.id)
            if runtime is None:
                runtime = CameraRuntime(config=camera)
                camera_states[camera.id] = runtime
            else:
                runtime.config = camera
                runtime.active = True

            if not runtime.running:
                runtime.running = True
                threading.Thread(
                    target=monitor_camera_loop,
                    args=(runtime,),
                    daemon=True,
                ).start()

        removed_camera_ids = [
            camera_id
            for camera_id in list(camera_states)
            if camera_id not in incoming_camera_ids
        ]
        for camera_id in removed_camera_ids:
            runtime = camera_states[camera_id]
            runtime.active = False
            runtime.connected = False
            del camera_states[camera_id]


def best_match(tenant_id: str, embedding: np.ndarray):
    with global_lock:
        candidates = [profile for profile in face_profiles if profile.tenant_id == tenant_id]

    if not candidates:
        return None, None

    scored = sorted(
        (
            (profile, cosine_similarity(profile.embedding, embedding))
            for profile in candidates
        ),
        key=lambda item: item[1],
        reverse=True,
    )
    profile, score = scored[0]
    second_score = scored[1][1] if len(scored) > 1 else None

    if score < FACE_MATCH_THRESHOLD:
        return None, score

    if second_score is not None and score - second_score < FACE_MATCH_MARGIN:
        return None, score

    return profile, score


def publish_event(
    runtime: CameraRuntime,
    frame,
    face_count: int,
    employee_id: str | None,
    confidence: float | None,
) -> bool:
    snapshot_url = save_detection_clip(runtime, frame)
    payload = {
        "cameraId": runtime.config.id,
        "employeeId": employee_id,
        "detectedAt": datetime.now(timezone.utc).isoformat(),
        "faceCount": face_count,
        "confidence": confidence,
        "snapshotUrl": snapshot_url,
    }

    try:
        response = requests.post(
            f"{API_BASE_URL}/internal/monitoring-events",
            json=payload,
            headers={"x-internal-key": INTERNAL_API_KEY},
            timeout=10,
        )
        response.raise_for_status()
        return True
    except requests.RequestException as exc:
        with runtime.lock:
            runtime.last_error = f"Falha ao publicar evento: {exc}"
        return False


def rtmp_candidate_urls(rtsp_url: str) -> list[str]:
    candidates: list[str] = []
    prefix = "rtmp://127.0.0.1:1935/"

    if rtsp_url.startswith(prefix):
        path = rtsp_url[len(prefix):].strip("/")
        stream_key = path.split("/")[-1] if path else ""

        def append_candidate(candidate: str) -> None:
            if candidate not in candidates:
                candidates.append(candidate)

        # Publicação externa tem um único padrão: /live/CHAVE. Quando existe um
        # normalizador na VPS, a IA lê /normalized/CHAVE primeiro, mas esse caminho
        # nunca é exibido ao cliente nem precisa ser configurado no DVR.
        if RTMP_NORMALIZED_PATH_PREFIX and stream_key:
            append_candidate(prefix + RTMP_NORMALIZED_PATH_PREFIX + "/" + stream_key)

        if stream_key:
            append_candidate(prefix + "live/" + stream_key)

        # Compatibilidade temporária com cadastros antigos salvos sem /live.
        append_candidate(rtsp_url)
        if stream_key:
            append_candidate(prefix + stream_key)
    else:
        candidates.append(rtsp_url)

    return candidates


def open_capture(source_type: str, rtsp_url: str | None, device_index: int | None):
    if source_type == "webcam":
        index = device_index if device_index is not None else 0
        return cv2.VideoCapture(index)

    if not rtsp_url:
        return cv2.VideoCapture()

    if (
        source_type == "rtmp"
        and RTMP_CAPTURE_BACKEND in {"ffmpeg", "auto"}
        and shutil.which("ffmpeg") is not None
    ):
        return RtmpFallbackCapture(rtmp_candidate_urls(rtsp_url))

    return cv2.VideoCapture(rtsp_url)


def get_webcam_lock(device_index: int | None) -> threading.Lock:
    index = device_index if device_index is not None else 0
    with webcam_locks_guard:
        if index not in webcam_locks:
            webcam_locks[index] = threading.Lock()
        return webcam_locks[index]


def monitor_camera_loop(runtime: CameraRuntime) -> None:
    while runtime.active:
        device_lock = (
            get_webcam_lock(runtime.config.device_index)
            if runtime.config.source_type == "webcam"
            else None
        )
        if device_lock is not None and not device_lock.acquire(timeout=2):
            with runtime.lock:
                runtime.connected = False
                runtime.last_error = "Webcam já está em uso por outra câmera cadastrada."
            time.sleep(1)
            continue

        capture = open_capture(
            runtime.config.source_type,
            runtime.config.rtsp_url,
            runtime.config.device_index,
        )
        if not capture.isOpened():
            with runtime.lock:
                runtime.connected = False
                if runtime.config.source_type == "webcam":
                    runtime.last_error = "Nao foi possivel abrir a webcam local."
                elif runtime.config.source_type == "rtmp" and shutil.which("ffmpeg") is None:
                    runtime.last_error = "Nao foi possivel ler RTMP: ffmpeg nao esta instalado na VPS."
                elif runtime.config.source_type == "rtmp":
                    runtime.last_error = "Nao foi possivel conectar ao stream RTMP."
                else:
                    runtime.last_error = "Nao foi possivel conectar a camera RTSP."
            capture.release()
            if device_lock is not None:
                device_lock.release()
            time.sleep(5)
            continue

        # Um processo ffmpeg aberto não significa que o DVR entregou vídeo. A
        # câmera só fica online depois do primeiro frame decodificado.
        with runtime.lock:
            runtime.connected = False
            runtime.last_error = None

        received_frame = False

        while capture.isOpened() and runtime.active:
            if isinstance(capture, (FfmpegMjpegCapture, RtmpFallbackCapture)):
                read_timeout = (
                    RTMP_FRAME_TIMEOUT_SECONDS
                    if received_frame
                    else RTMP_FIRST_FRAME_TIMEOUT_SECONDS
                )
                ok, frame = capture.read(read_timeout)
            else:
                ok, frame = capture.read()

            if not ok or frame is None:
                with runtime.lock:
                    runtime.connected = False
                    if runtime.config.source_type == "rtmp":
                        detail = (
                            capture.last_error()
                            if isinstance(capture, (FfmpegMjpegCapture, RtmpFallbackCapture))
                            else None
                        )
                        runtime.last_error = (
                            "Nenhum frame de vídeo RTMP foi recebido. O sistema tentou o fluxo "
                            "normalizado da VPS e o padrão rtmp://IP:1935/live/CHAVE. "
                            "Confirme se a chave publicada pela câmera é exatamente a mesma "
                            "mostrada no cadastro."
                        )
                        if detail:
                            runtime.last_error = f"{runtime.last_error} Detalhe ffmpeg: {detail}"
                    else:
                        runtime.last_error = "Falha ao ler frame da camera."
                break

            received_frame = True
            now = time.time()
            with runtime.lock:
                runtime.last_frame_at = now
                runtime.connected = True
                runtime.last_error = None
            event_to_publish: tuple[int, str | None, float | None, str] | None = None
            with runtime.lock:
                annotations = list(runtime.annotations)
                face_count = runtime.face_count

            if now - runtime.last_analysis_at >= ANALYSIS_INTERVAL_SECONDS:
                faces = extract_faces(frame)
                recognized_keys: list[tuple[str | None, float | None]] = []
                annotations = []

                for face_data in faces:
                    x, y, w, h = [int(value) for value in face_data[:4]]
                    embedding = build_embedding(frame, face_data)
                    profile, score = best_match(runtime.config.tenant_id, embedding)
                    employee_id = profile.employee_id if profile else None
                    recognized_keys.append((employee_id, score))
                    color = (0, 255, 0) if profile else (0, 165, 255)
                    label = profile.full_name if profile else "Desconhecido"
                    annotations.append((x, y, w, h, color, label))

                face_count = len(faces)
                runtime.last_analysis_at = now
                with runtime.lock:
                    runtime.annotations = list(annotations)
                    runtime.face_count = face_count

                if face_count > 0:
                    employee_id, confidence = recognized_keys[0]
                    if employee_id is not None:
                        event_key = employee_id
                        last_detection = runtime.last_detection_by_key.get(event_key, 0)
                        if now - last_detection >= COOLDOWN_SECONDS:
                            event_to_publish = (face_count, employee_id, confidence, event_key)

            displayed_frame = frame.copy()
            for x, y, w, h, color, label in annotations:
                cv2.rectangle(displayed_frame, (x, y), (x + w, y + h), color, 2)
                cv2.putText(
                    displayed_frame,
                    label,
                    (x, max(y - 10, 20)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    color,
                    2,
                )

            with runtime.lock:
                runtime.latest_frame = displayed_frame
                runtime.frame_buffer.append((now, displayed_frame.copy()))
                while (
                    runtime.frame_buffer
                    and runtime.frame_buffer[0][0] < now - (DETECTION_CLIP_SECONDS * 2)
                ):
                    runtime.frame_buffer.popleft()

            if event_to_publish is not None:
                face_count, employee_id, confidence, event_key = event_to_publish
                if publish_event(runtime, displayed_frame, face_count, employee_id, confidence):
                    runtime.last_detection_by_key[event_key] = now

        capture.release()
        if device_lock is not None:
            device_lock.release()
        time.sleep(2)


def supervisor_loop() -> None:
    while True:
        refresh_context()
        time.sleep(10)


def frame_generator(camera_id: str):
    while True:
        runtime = camera_states.get(camera_id)
        frame = None

        if runtime:
            with runtime.lock:
                frame = None if runtime.latest_frame is None else runtime.latest_frame.copy()

        if frame is None:
            time.sleep(0.1)
            continue

        ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), PREVIEW_JPEG_QUALITY])
        if not ok:
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n" + buffer.tobytes() + b"\r\n"
        )
        time.sleep(1 / STREAM_FPS)


@app.on_event("startup")
def startup_event() -> None:
    refresh_context()
    threading.Thread(target=supervisor_loop, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok", "faceModel": FACE_MODEL_NAME}


@app.get("/status")
def status():
    with global_lock:
        runtimes = list(camera_states.values())

    return {
        "connected": any(runtime.connected for runtime in runtimes),
        "cameraCount": len(runtimes),
        "faceCount": sum(runtime.face_count for runtime in runtimes),
        "cameras": [
            {
                "id": runtime.config.id,
                "connected": runtime.connected,
                "faceCount": runtime.face_count,
                "lastError": runtime.last_error,
                "lastFrameAt": runtime.last_frame_at,
            }
            for runtime in runtimes
        ],
    }


@app.get("/status/{camera_id}")
def camera_status(camera_id: str):
    runtime = camera_states.get(camera_id)

    if runtime is None:
        return JSONResponse(status_code=404, content={"message": "Câmera não encontrada."})

    with runtime.lock:
        return {
            "connected": runtime.connected,
            "faceCount": runtime.face_count,
            "lastError": runtime.last_error,
            "lastFrameAt": runtime.last_frame_at,
        }


@app.post("/embedding")
def embedding(request: EmbeddingRequest):
    try:
        image = decode_data_url(request.imageDataUrl)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"message": str(exc)})

    faces = extract_faces(image)
    if len(faces) == 0:
        return JSONResponse(
            status_code=400,
            content={"message": "Nenhum rosto encontrado na imagem."},
        )

    vector = build_embedding(image, faces[0])
    return {"embedding": vector.tolist(), "model": FACE_MODEL_NAME}


@app.post("/cameras/test")
def test_camera(request: CameraTestRequest):
    runtime = camera_states.get(request.cameraId) if request.cameraId else None
    if runtime is not None:
        with runtime.lock:
            if runtime.connected:
                return {"connected": True, "message": "Câmera online e transmitindo frames."}

    device_lock = get_webcam_lock(request.deviceIndex) if request.sourceType == "webcam" else None
    if device_lock is not None and not device_lock.acquire(timeout=3):
        runtime = camera_states.get(request.cameraId) if request.cameraId else None
        with runtime.lock if runtime is not None else threading.Lock():
            connected = bool(runtime and runtime.connected)
        return {
            "connected": connected,
            "message": (
                "Câmera online e transmitindo frames."
                if connected
                else "Webcam ocupada; aguarde o monitoramento iniciar e teste novamente."
            ),
        }

    try:
        capture = open_capture(request.sourceType, request.rtspUrl, request.deviceIndex)
        ok = capture.isOpened()
        frame_ok = False

        if ok:
            if isinstance(capture, (FfmpegMjpegCapture, RtmpFallbackCapture)):
                frame_ok, _ = capture.read(min(RTMP_FIRST_FRAME_TIMEOUT_SECONDS, 15.0))
            else:
                frame_ok, _ = capture.read()

        capture_error = (
            capture.last_error()
            if isinstance(capture, (FfmpegMjpegCapture, RtmpFallbackCapture))
            else None
        )
        capture.release()
    finally:
        if device_lock is not None:
            device_lock.release()

    return {
        "connected": bool(ok and frame_ok),
        "message": (
            "Conexão OK"
            if ok and frame_ok
            else (
                "Não foi possível ler a webcam local."
                if request.sourceType == "webcam"
                else "Não foi possível ler o stream."
            )
        ),
    }


@app.get("/stream/{camera_id}.mjpg")
def stream(camera_id: str):
    if camera_id not in camera_states:
        return JSONResponse(status_code=404, content={"message": "Câmera não encontrada."})

    return StreamingResponse(
        frame_generator(camera_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.get("/snapshot/{camera_id}.jpg")
def snapshot(camera_id: str):
    runtime = camera_states.get(camera_id)
    if runtime is None:
        return JSONResponse(status_code=404, content={"message": "Câmera não encontrada."})

    with runtime.lock:
        path = runtime.latest_snapshot_path

    if path is None or not path.exists():
        return JSONResponse(
            status_code=404,
            content={"message": "Nenhum snapshot disponível ainda."},
        )

    return FileResponse(path)


@app.get("/frame/{camera_id}.jpg")
def frame(camera_id: str):
    runtime = camera_states.get(camera_id)
    if runtime is None:
        return JSONResponse(status_code=404, content={"message": "Câmera não encontrada."})

    with runtime.lock:
        latest_frame = None if runtime.latest_frame is None else runtime.latest_frame.copy()

    if latest_frame is None:
        return JSONResponse(
            status_code=404,
            content={"message": "Nenhum frame disponível ainda."},
        )

    ok, buffer = cv2.imencode(".jpg", latest_frame, [int(cv2.IMWRITE_JPEG_QUALITY), PREVIEW_JPEG_QUALITY])
    if not ok:
        return JSONResponse(
            status_code=500,
            content={"message": "Não foi possível gerar o frame atual."},
        )

    return StreamingResponse(iter([buffer.tobytes()]), media_type="image/jpeg")
