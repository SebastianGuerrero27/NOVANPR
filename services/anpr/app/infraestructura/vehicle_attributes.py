"""
Atributos del vehículo (tipo, color, marca y modelo) como segundo factor de identificación,
al estilo de la "huella del vehículo" de los ALPR comerciales (Flock Safety, Rekor Scout).

Uso principal: si una placa de la lista negra (o autorizada) aparece en un vehículo cuya
marca o color NO coincide con los registrados, puede tratarse de una placa clonada o de un
error de lectura; el backend lo marca para el operador (no decide solo).

Método:
  1. YOLO26n (COCO) ubica el vehículo que contiene la placa (auto, moto, bus, camión).
  2. CLIP (open_clip, zero-shot) compara el recorte del vehículo con descripciones de texto
     del catálogo app/data/catalogo_vehiculos_ecuador.json: tipo, color, marca y, dentro de
     la marca elegida, el modelo. No requiere entrenamiento, pero su exactitud en modelos
     concretos es limitada: por debajo del umbral de confianza el atributo queda como None.

Se ejecuta una vez por vehículo, en la fase asíncrona (main._verify_and_commit).
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass
from typing import Optional

import cv2
import numpy as np

from app.infraestructura.config import (
    VEHICLE_ATTR_ENABLED,
    VEHICLE_ATTR_MIN_CONF,
    VEHICLE_CLIP_MODEL,
    VEHICLE_CLIP_PRETRAINED,
    VEHICLE_DETECTOR_PATH,
)
from app.infraestructura.logger import get_logger

logger = get_logger("vehicle_attributes")

_SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CATALOGO = os.path.join(_SERVICE_DIR, "app", "data", "catalogo_vehiculos_ecuador.json")
_COCO_VEHICULOS = {2: "automóvil", 3: "motocicleta", 5: "bus", 7: "camión"}


@dataclass
class VehicleAttributes:
    tipo: Optional[str] = None
    tipo_conf: float = 0.0
    color: Optional[str] = None
    color_conf: float = 0.0
    marca: Optional[str] = None
    marca_conf: float = 0.0
    modelo: Optional[str] = None
    modelo_conf: float = 0.0
    fuente_caja: str = "ninguna"   # "detector" (YOLO) o "estimada" (a partir de la placa)

    def to_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def vehicle_box_for_plate(boxes: list[tuple[list[float], int, float]], plate_bbox: list[int]) -> Optional[tuple[list[float], int]]:
    """Caja del vehículo que contiene el centro de la placa (la más pequeña si hay varias)."""
    px = (plate_bbox[0] + plate_bbox[2]) / 2
    py = (plate_bbox[1] + plate_bbox[3]) / 2
    contenedoras = [(b, c) for b, c, _ in boxes if b[0] <= px <= b[2] and b[1] <= py <= b[3]]
    if not contenedoras:
        return None
    return min(contenedoras, key=lambda bc: (bc[0][2] - bc[0][0]) * (bc[0][3] - bc[0][1]))


def estimated_vehicle_box(plate_bbox: list[int], frame_shape: tuple[int, ...]) -> list[int]:
    """Sin detección del vehículo: región típica alrededor de la placa (frontal o trasera)."""
    x1, y1, x2, y2 = plate_bbox
    pw, ph = x2 - x1, y2 - y1
    h, w = frame_shape[:2]
    return [max(0, int(x1 - 1.6 * pw)), max(0, int(y1 - 4.5 * ph)), min(w, int(x2 + 1.6 * pw)), min(h, int(y2 + 1.5 * ph))]


class VehicleAttributeRecognizer:
    def __init__(self, detector_path: str = VEHICLE_DETECTOR_PATH, clip_model: str = VEHICLE_CLIP_MODEL,
                 clip_pretrained: str = VEHICLE_CLIP_PRETRAINED, min_conf: float = VEHICLE_ATTR_MIN_CONF) -> None:
        import open_clip
        import torch
        from ultralytics import YOLO

        self._torch = torch
        path = detector_path if os.path.isabs(detector_path) else os.path.join(_SERVICE_DIR, detector_path)
        self.detector = YOLO(path if os.path.exists(path) else detector_path)
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(clip_model, pretrained=clip_pretrained)
        self.model.eval()
        self.tokenizer = open_clip.get_tokenizer(clip_model)
        self.min_conf = min_conf
        self._lock = threading.Lock()

        cat = json.load(open(_CATALOGO, encoding="utf-8"))
        self.marcas: dict[str, list[str]] = cat["marcas"]
        self.colores: dict[str, str] = cat["colores"]
        self.tipos: dict[str, str] = cat["tipos"]
        # Embeddings de texto precalculados (una vez)
        self._emb_tipos = self._text([f"a photo of a {v}." for v in self.tipos.values()])
        self._emb_colores = self._text([f"a photo of a {v} vehicle." for v in self.colores.values()])
        self._emb_marcas = self._text([f"a photo of a {m} vehicle." for m in self.marcas])
        self._emb_modelos = {m: self._text([f"a photo of a {m} {mod}." for mod in mods]) for m, mods in self.marcas.items()}
        self.description = f"YOLO26n + CLIP {clip_model}/{clip_pretrained}"
        logger.info("Reconocedor de atributos del vehículo listo: %s", self.description)

    def _text(self, prompts: list[str]):
        with self._torch.no_grad():
            e = self.model.encode_text(self.tokenizer(prompts))
        return e / e.norm(dim=-1, keepdim=True)

    def _probs(self, img_emb, text_emb) -> np.ndarray:
        logits = 100.0 * img_emb @ text_emb.T
        return logits.softmax(dim=-1).squeeze(0).cpu().numpy()

    def analyze(self, frame: np.ndarray, plate_bbox: list[int]) -> VehicleAttributes:
        from PIL import Image

        attrs = VehicleAttributes()
        with self._lock:
            res = self.detector.predict(frame, conf=0.3, classes=list(_COCO_VEHICULOS), verbose=False, device="cpu")[0]
            boxes = [(b.tolist(), int(c), float(s)) for b, c, s in zip(res.boxes.xyxy, res.boxes.cls, res.boxes.conf)] if res.boxes is not None else []
            found = vehicle_box_for_plate(boxes, plate_bbox)
            if found:
                box, cls = found
                attrs.fuente_caja = "detector"
                if cls != 2:  # moto / bus / camión: la clase COCO ya es el tipo
                    attrs.tipo, attrs.tipo_conf = _COCO_VEHICULOS[cls], 1.0
            else:
                box = estimated_vehicle_box(plate_bbox, frame.shape)
                attrs.fuente_caja = "estimada"
            x1, y1, x2, y2 = [int(v) for v in box]
            crop = frame[max(0, y1):y2, max(0, x1):x2]
            if crop.size == 0:
                return attrs

            img = self.preprocess(Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))).unsqueeze(0)
            with self._torch.no_grad():
                e = self.model.encode_image(img)
            e = e / e.norm(dim=-1, keepdim=True)

            def top(names: list[str], text_emb) -> tuple[Optional[str], float]:
                p = self._probs(e, text_emb)
                i = int(p.argmax())
                return (names[i] if p[i] >= self.min_conf else None), float(p[i])

            if attrs.tipo is None:
                attrs.tipo, attrs.tipo_conf = top(list(self.tipos), self._emb_tipos)
            attrs.color, attrs.color_conf = top(list(self.colores), self._emb_colores)
            if attrs.tipo != "motocicleta":
                attrs.marca, attrs.marca_conf = top(list(self.marcas), self._emb_marcas)
                if attrs.marca:
                    attrs.modelo, attrs.modelo_conf = top(self.marcas[attrs.marca], self._emb_modelos[attrs.marca])
        return attrs


_instance: Optional[VehicleAttributeRecognizer] = None
_state_lock = threading.Lock()
_failed = False


def get_vehicle_recognizer() -> Optional[VehicleAttributeRecognizer]:
    global _instance, _failed
    if not VEHICLE_ATTR_ENABLED or _failed:
        return None
    if _instance is None:
        with _state_lock:
            if _instance is None and not _failed:
                try:
                    _instance = VehicleAttributeRecognizer()
                except Exception as e:
                    _failed = True
                    logger.warning("Atributos del vehículo no disponibles (%s).", e)
    return _instance
