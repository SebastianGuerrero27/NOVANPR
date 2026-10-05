"""
Modelos de datos y entidades de dominio para el pipeline ANPR / ALPR.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple, Union
import numpy as np


@dataclass
class Detection:
    """Representa una detección individual generada por un modelo de visión."""
    bbox: list[float] | tuple[float, float, float, float]  # [x1, y1, x2, y2]
    confidence: float
    class_id: int = 0
    class_name: str = "vehicle"
    track_id: Optional[int] = None
    color: tuple[int, int, int] = (0, 255, 0)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def x1(self) -> float:
        return float(self.bbox[0])

    @property
    def y1(self) -> float:
        return float(self.bbox[1])

    @property
    def x2(self) -> float:
        return float(self.bbox[2])

    @property
    def y2(self) -> float:
        return float(self.bbox[3])

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)

    @property
    def bottom_center(self) -> tuple[float, float]:
        return ((self.x1 + self.x2) / 2.0, self.y2)


@dataclass
class PlateReading:
    """Lectura alfanumérica de una matrícula vehicular con metadatos asociados."""
    text: str
    confidence: float
    plate_bbox: list[float] | tuple[float, float, float, float]
    vehicle_bbox: Optional[list[float] | tuple[float, float, float, float]] = None
    track_id: Optional[int] = None
    timestamp: float = field(default_factory=time.time)
    is_valid: bool = True
    province: str = ""
    service_type: str = ""
    vehicle_type: str = "car"
    raw_text: str = ""
    crop_image: Optional[np.ndarray] = None


@dataclass
class Track:
    """Estado de seguimiento espaciotemporal de un vehículo o matrícula."""
    track_id: int
    bbox: list[float] | tuple[float, float, float, float]
    class_name: str = "car"
    confidence: float = 1.0
    hits: int = 1
    age: int = 1
    time_since_update: int = 0
    history: list[tuple[float, float]] = field(default_factory=list)
    reading: Optional[PlateReading] = None
    plate_bbox: Optional[list[float] | tuple[float, float, float, float]] = None
    color: tuple[int, int, int] = (0, 255, 200)

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    @property
    def bottom_center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, float(y2))


@dataclass
class PlateCaptureLine:
    """Línea virtual de captura con vector de sentido de avance vehicular."""
    start: tuple[int, int]
    end: tuple[int, int]
    movement_vector: Optional[tuple[float, float]] = None
    color: tuple[int, int, int] = (0, 165, 255)
    thickness: int = 3


@dataclass
class PlateHudCard:
    """Representa una tarjeta informativa táctica en el overlay HUD."""
    track_id: int | str
    plate_text: str
    confidence: float
    crop_image: Optional[np.ndarray] = None
    timestamp: float = field(default_factory=time.time)
    status: str = "normal"  # "normal", "blacklist", "authorized", "warning"
    is_valid: bool = True
    vehicle_type: str = "car"
    province: str = ""
    service_type: str = ""
    notes: str = ""


@dataclass
class PipelineResult:
    """Resultado estructurado completo emitido por el pipeline ANPR por cada frame."""
    annotated_frame: np.ndarray
    readings: list[PlateReading] = field(default_factory=list)
    vehicles: list[Detection] = field(default_factory=list)
    plates: list[Detection] = field(default_factory=list)
    tracks: list[Track] = field(default_factory=list)
    active_cards: list[PlateHudCard] = field(default_factory=list)
    frame_idx: int = 0
    latency_ms: float = 0.0
    fps: float = 0.0
