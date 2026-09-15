"""
Esquemas de configuración tipados para el Pipeline ANPR / ALPR.
Permite instanciar componentes desde dataclasses, diccionarios o archivos YAML/JSON.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple, Union


@dataclass
class DetectorConfig:
    """Configuración para modelos de detección (YOLO, ONNX)."""
    model_path: str = "models/license_plate_detector.pt"
    model_type: str = "yolo"
    confidence: float = 0.35
    device: str = "cpu"
    imgsz: int = 640
    iou: float = 0.45
    max_det: int = 20
    classes: Optional[list[Union[int, str]]] = None
    half: bool = False


@dataclass
class TrackerConfig:
    """Configuración para el algoritmo de seguimiento (ByteTrack / Sort)."""
    type: str = "bytetrack"
    max_age: int = 30
    min_hits: int = 2
    lost_buffer: int = 3
    high_thresh: float = 0.5
    low_thresh: float = 0.1
    match_thresh: float = 0.8
    low_match_thresh: float = 0.5
    same_class: bool = True
    trail_length: int = 15


@dataclass
class PaddleConfig:
    """Configuración específica para el motor OCR PaddleOCR / RapidOCR."""
    mode: str = "rec-only"  # "full" o "rec-only"
    lang: str = "en"
    use_gpu: bool = False
    use_angle_cls: bool = True
    min_crop_width: int = 480
    enhance: bool = True


@dataclass
class HUDConfig:
    """Configuración de la interfaz gráfica y tarjetas HUD."""
    panel_x: int = 16
    panel_y: int = 16
    panel_width: int = 320
    panel_height: Optional[int] = None
    title: str = "Lecturas ANPR"
    max_cards: int = 6
    show_status_polygon: bool = True
    status_polygon: Optional[list[tuple[int, int]]] = None
    show_metrics: bool = True
    theme: str = "tactical_dark"


@dataclass
class VisualizerConfig:
    """Configuración de renderizado visual (colores, grosores, fuentes)."""
    line_width: int = 2
    show_labels: bool = True
    bbox_style: str = "corners"  # "corners", "rect", "tactical"
    track_anchor: str = "center"  # "center", "bottom_center"
    font_scale: float = 0.65
    font_thickness: int = 2
    draw_hud: bool = True
    show_detection_zone: bool = True
    show_capture_line: bool = True
    show_plate_boxes: bool = True
    show_tracks: bool = True


@dataclass
class ALPRConfig:
    """Configuración principal del pipeline ALPR."""
    mode: str = "full"  # "full" (vehículos + placas + OCR) o "detect" (solo cajas)
    ocr_cache: str = "once"  # "once" (guarda por track) o "frame" (recalcula cada frame)
    plate_scope: str = "vehicle"  # "vehicle" (ROI vehículo) o "full" (full-frame search)
    plate_model: str = "models/license_plate_detector.pt"
    plate_detector_type: str = "yolo"
    plate_confidence: float = 0.35
    plate_imgsz: int = 640
    plate_max_det: int = 20

    ocr_engine: str = "paddle"  # "paddle", "yolo-chars", "rapidocr", "easyocr"
    ocr_model: str = "models/ocr_chars.pt"
    ocr_detector_type: str = "yolo"
    ocr_confidence: float = 0.30
    ocr_crop_padding: float = 0.08
    ocr_lang: str = "en"
    ocr_imgsz: int = 640
    ocr_max_det: int = 32

    detection_zone: Optional[list[tuple[int, int]]] = None
    show_detection_zone: bool = True
    capture_line: Optional[tuple[tuple[int, int], tuple[int, int]]] = None
    movement_line: Optional[tuple[tuple[int, int], tuple[int, int]]] = None
    vehicle_classes: Optional[list[str]] = None

    paddle: PaddleConfig = field(default_factory=PaddleConfig)
    hud: HUDConfig = field(default_factory=HUDConfig)


@dataclass
class RunConfig:
    """Configuración completa para ejecución desde CLI, API o archivo de configuración."""
    model: str = "models/yolo11n.pt"
    confidence: float = 0.35
    device: str = "cpu"
    imgsz: int = 640
    iou: float = 0.45
    max_det: int = 50
    classes: Optional[list[str]] = None
    half: bool = False
    line_width: int = 2
    show_labels: bool = True
    bbox_style: str = "corners"
    track_anchor: str = "center"
    extra: dict[str, Any] = field(default_factory=dict)
    alpr: ALPRConfig = field(default_factory=ALPRConfig)
    tracker: TrackerConfig = field(default_factory=TrackerConfig)
    visualizer: VisualizerConfig = field(default_factory=VisualizerConfig)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunConfig":
        """Parsea un diccionario arbitrario a RunConfig fuertemente tipado."""
        alpr_data = data.get("alpr", {})
        if not isinstance(alpr_data, dict):
            alpr_data = {}

        paddle_data = alpr_data.get("paddle", {})
        paddle_cfg = PaddleConfig(
            mode=str(paddle_data.get("mode", "rec-only")),
            lang=str(paddle_data.get("lang", "en")),
            use_gpu=bool(paddle_data.get("use_gpu", False)),
            use_angle_cls=bool(paddle_data.get("use_angle_cls", True)),
            min_crop_width=int(paddle_data.get("min_crop_width", 480)),
            enhance=bool(paddle_data.get("enhance", True)),
        )

        hud_data = alpr_data.get("hud", {})
        hud_cfg = HUDConfig(
            panel_x=int(hud_data.get("panel_x", 16)),
            panel_y=int(hud_data.get("panel_y", 16)),
            panel_width=int(hud_data.get("panel_width", 320)),
            panel_height=int(hud_data["panel_height"]) if hud_data.get("panel_height") is not None else None,
            title=str(hud_data.get("title", "Lecturas ANPR")),
            max_cards=int(hud_data.get("max_cards", 6)),
            show_status_polygon=bool(hud_data.get("show_status_polygon", True)),
            status_polygon=hud_data.get("status_polygon"),
            show_metrics=bool(hud_data.get("show_metrics", True)),
        )

        alpr_cfg = ALPRConfig(
            mode=str(alpr_data.get("mode", "full")),
            ocr_cache=str(alpr_data.get("ocr_cache", "once")),
            plate_scope=str(alpr_data.get("plate_scope", "vehicle")),
            plate_model=str(alpr_data.get("plate_model", "models/license_plate_detector.pt")),
            plate_detector_type=str(alpr_data.get("plate_detector_type", "yolo")),
            plate_confidence=float(alpr_data.get("plate_confidence", data.get("confidence", 0.35))),
            plate_imgsz=int(alpr_data.get("plate_imgsz", data.get("imgsz", 640))),
            plate_max_det=int(alpr_data.get("plate_max_det", 20)),
            ocr_engine=str(alpr_data.get("ocr_engine", "paddle")),
            ocr_model=str(alpr_data.get("ocr_model", "models/ocr_chars.pt")),
            ocr_detector_type=str(alpr_data.get("ocr_detector_type", "yolo")),
            ocr_confidence=float(alpr_data.get("ocr_confidence", 0.30)),
            ocr_crop_padding=float(alpr_data.get("crop_padding", 0.08)),
            ocr_lang=str(alpr_data.get("ocr_lang", "en")),
            ocr_imgsz=int(alpr_data.get("ocr_imgsz", 640)),
            ocr_max_det=int(alpr_data.get("ocr_max_det", 32)),
            detection_zone=alpr_data.get("detection_zone"),
            show_detection_zone=bool(alpr_data.get("show_detection_zone", True)),
            capture_line=alpr_data.get("capture_line"),
            movement_line=alpr_data.get("movement_line"),
            vehicle_classes=alpr_data.get("vehicle_classes"),
            paddle=paddle_cfg,
            hud=hud_cfg,
        )

        tracker_data = data.get("tracker", data.get("extra", {}).get("tracker", {}))
        if not isinstance(tracker_data, dict):
            tracker_data = {}
        tracker_cfg = TrackerConfig(
            type=str(tracker_data.get("type", "bytetrack")),
            max_age=int(tracker_data.get("max_age", 30)),
            min_hits=int(tracker_data.get("min_hits", 2)),
            lost_buffer=int(tracker_data.get("lost_buffer", 3)),
            high_thresh=float(tracker_data.get("high_thresh", 0.5)),
            low_thresh=float(tracker_data.get("low_thresh", 0.1)),
            match_thresh=float(tracker_data.get("match_thresh", 0.8)),
            low_match_thresh=float(tracker_data.get("low_match_thresh", 0.5)),
            same_class=bool(tracker_data.get("same_class", True)),
            trail_length=int(tracker_data.get("trail_length", 15)),
        )

        visualizer_cfg = VisualizerConfig(
            line_width=int(data.get("line_width", 2)),
            show_labels=bool(data.get("show_labels", True)),
            bbox_style=str(data.get("bbox_style", "corners")),
            track_anchor=str(data.get("track_anchor", "center")),
            font_scale=float(data.get("font_scale", 0.65)),
            font_thickness=int(data.get("font_thickness", 2)),
        )

        return cls(
            model=str(data.get("model", "models/yolo11n.pt")),
            confidence=float(data.get("confidence", 0.35)),
            device=str(data.get("device", "cpu")),
            imgsz=int(data.get("imgsz", 640)),
            iou=float(data.get("iou", 0.45)),
            max_det=int(data.get("max_det", 50)),
            classes=data.get("classes"),
            half=bool(data.get("half", False)),
            line_width=int(data.get("line_width", 2)),
            show_labels=bool(data.get("show_labels", True)),
            bbox_style=str(data.get("bbox_style", "corners")),
            track_anchor=str(data.get("track_anchor", "center")),
            extra=dict(data.get("extra", {})),
            alpr=alpr_cfg,
            tracker=tracker_cfg,
            visualizer=visualizer_cfg,
        )
