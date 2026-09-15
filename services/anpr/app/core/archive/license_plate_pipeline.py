"""
Pipeline Integral ANPR de Grado Producción (LicensePlatePipeline 10/10).

Arquitectura:
  - Inyección de dependencias para detectores, tracker y motor OCR.
  - Desacoplamiento total del renderizado con ALPRVisualizer.
  - Tipado estricto con RunConfig y retorno estructurado PipelineResult.
  - Soporte de múltiples modos (full, detect) y alcances (vehicle ROI, full-frame).
  - Estrategias de caché por track ('once') o por frame ('frame').
  - Validación normativa oficial ANT Ecuador integrada.
  - Sin 'assert' para tolerancia a fallos en producción.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np

from app.core.config_schemas import (
    ALPRConfig,
    RunConfig,
    TrackerConfig,
    VisualizerConfig,
)
from app.core.detectors import BaseDetector, create_detector
from app.core.ecuador_plate_validator import EcuadorPlateValidator
from app.core.hud import PlateHudState
from app.core.models import (
    Detection,
    PlateCaptureLine,
    PlateReading,
    PipelineResult,
    Track,
)
from app.core.ocr_backends import (
    BaseOCREngine,
    PaddleOCREngine,
    YoloCharsOCREngine,
)
from app.core.trackers import BaseTracker, create_teaching_tracker, update_tracks
from app.core.utils_alpr import (
    bbox_cache_key,
    crop_bbox,
    dedupe_consecutive_points,
    detect_plates_for_vehicles,
    detect_plates_full_frame,
    filter_detections_in_zone,
    is_point_in_polygon,
    movement_vector_from_line,
    optional_panel_height,
    parse_line,
    parse_points,
)
from app.core.visualizer import ALPRVisualizer
from app.utils.logger import get_logger

logger = get_logger("license_plate_pipeline")

# Constantes estándar de configuración
ALPR_MODE_FULL = "full"
ALPR_MODE_DETECT = "detect"
OCR_CACHE_ONCE = "once"
OCR_CACHE_FRAME = "frame"
PLATE_SCOPE_VEHICLE = "vehicle"
PLATE_SCOPE_FULL = "full"
BBOX_CORNERS = "corners"
PLATE_COLOR = (0, 255, 128)


class LicensePlatePipeline:
    """Pipeline de Detección Vehicular, Reconocimiento de Matrículas y Visualización HUD."""

    def __init__(
        self,
        vehicle_detector: BaseDetector,
        plate_detector: BaseDetector,
        tracker: Optional[BaseTracker | object] = None,
        *,
        mode: str = ALPR_MODE_FULL,
        ocr_cache: str = OCR_CACHE_ONCE,
        plate_scope: str = PLATE_SCOPE_VEHICLE,
        ocr_backend: Optional[BaseOCREngine | BaseDetector] = None,
        ocr_engine: str = "paddle",
        ocr_confidence: float = 0.25,
        crop_padding: float = 0.08,
        hud_state: Optional[PlateHudState] = None,
        visualizer: Optional[ALPRVisualizer] = None,
        hud_panel_x: int = 16,
        hud_panel_y: int = 90,
        hud_panel_width: int = 340,
        hud_panel_height: Optional[int] = None,
        hud_title: str = "LECTURAS ANPR",
        status_polygon: Optional[list[tuple[int, int]]] = None,
        show_status_polygon: bool = True,
        detection_zone: Optional[list[tuple[int, int]]] = None,
        show_detection_zone: bool = True,
        capture_line: Optional[PlateCaptureLine] = None,
        line_width: int = 2,
        show_labels: bool = True,
        bbox_style: str = BBOX_CORNERS,
        track_anchor: str = "center",
        paddle_min_crop_width: int = 480,
        paddle_enhance: bool = True,
        validator: Optional[EcuadorPlateValidator] = None,
    ) -> None:
        if vehicle_detector is None:
            raise ValueError("vehicle_detector no puede ser None")
        if plate_detector is None:
            raise ValueError("plate_detector no puede ser None")

        self.vehicle_detector = vehicle_detector
        self.plate_detector = plate_detector
        self.tracker = tracker
        self.mode = mode
        self.ocr_cache = ocr_cache
        self.plate_scope = plate_scope
        self.ocr_backend = ocr_backend
        self.ocr_engine = ocr_engine
        self.ocr_confidence = ocr_confidence
        self.crop_padding = crop_padding
        self.hud_state = hud_state or PlateHudState()
        self.visualizer = visualizer or ALPRVisualizer()
        self.hud_panel_x = hud_panel_x
        self.hud_panel_y = hud_panel_y
        self.hud_panel_width = hud_panel_width
        self.hud_panel_height = hud_panel_height
        self.hud_title = hud_title
        self.status_polygon = status_polygon or [(16, 16), (640, 16), (640, 80), (16, 80)]
        self.show_status_polygon = show_status_polygon
        self.detection_zone = detection_zone
        self.show_detection_zone = show_detection_zone
        self.capture_line = capture_line
        self.line_width = line_width
        self.show_labels = show_labels
        self.bbox_style = bbox_style
        self.track_anchor = track_anchor
        self.paddle_min_crop_width = paddle_min_crop_width
        self.paddle_enhance = paddle_enhance
        self.validator = validator or EcuadorPlateValidator()

        # Cachés temporales por frame
        self._frame_plate_bboxes: dict[int, list[float]] = {}
        self._frame_idx: int = 0
        self._last_fps: float = 30.0

        logger.info(
            "LicensePlatePipeline inicializado (mode=%s, scope=%s, cache=%s, ocr=%s)",
            mode,
            plate_scope,
            ocr_cache,
            ocr_engine,
        )

    def reset_state(self) -> None:
        """Reinicia el estado en memoria para un nuevo video o stream."""
        self._frame_plate_bboxes.clear()
        self._frame_idx = 0
        self.hud_state.clear()
        if self.tracker and hasattr(self.tracker, "reset"):
            self.tracker.reset()
        logger.info("Estado del pipeline reiniciado.")

    @classmethod
    def from_config(cls, config: RunConfig) -> "LicensePlatePipeline":
        """Construye e inicializa el pipeline completo a partir de un RunConfig fuertemente tipado."""
        if not config.model:
            raise ValueError("config.model es obligatorio para inicializar el detector de vehículos")

        alpr = config.alpr
        tracker_cfg = config.tracker
        hud_cfg = alpr.hud
        paddle_cfg = alpr.paddle
        vis_cfg = config.visualizer

        mode = alpr.mode.lower()
        ocr_cache = alpr.ocr_cache.lower()
        plate_scope = alpr.plate_scope.lower()
        detect_only = mode == ALPR_MODE_DETECT

        vehicle_classes = alpr.vehicle_classes or config.classes or ["car", "truck", "bus", "motorcycle"]

        # 1. Detector de Vehículos
        vehicle_detector = create_detector(
            config.model,
            model_type=str(config.extra.get("detector", {}).get("type", "yolo")),
            confidence=config.confidence,
            device=config.device,
            imgsz=config.imgsz,
            iou=config.iou,
            max_det=config.max_det,
            classes=vehicle_classes,
            half=config.half,
        )

        # 2. Detector de Matrículas
        plate_detector = create_detector(
            alpr.plate_model,
            model_type=alpr.plate_detector_type,
            confidence=alpr.plate_confidence,
            device=config.device,
            imgsz=alpr.plate_imgsz,
            iou=config.iou,
            max_det=alpr.plate_max_det,
            half=config.half,
        )

        # 3. Tracker Espaciotemporal (ByteTrack)
        tracker: Optional[BaseTracker] = None
        if not detect_only:
            tracker = create_teaching_tracker(
                tracker_cfg.type,
                max_age=tracker_cfg.max_age,
                min_hits=tracker_cfg.min_hits,
                lost_buffer=tracker_cfg.lost_buffer,
                high_thresh=tracker_cfg.high_thresh,
                low_thresh=tracker_cfg.low_thresh,
                match_thresh=tracker_cfg.match_thresh,
                low_match_thresh=tracker_cfg.low_match_thresh,
                same_class=tracker_cfg.same_class,
                trail_length=tracker_cfg.trail_length,
            )

        # 4. Motor OCR
        ocr_backend: Optional[BaseOCREngine | BaseDetector] = None
        if not detect_only:
            if alpr.ocr_engine in {"paddle", "rapidocr", "easyocr"}:
                use_gpu = str(config.device).lower() not in {"", "cpu"}
                ocr_backend = PaddleOCREngine(
                    lang=alpr.ocr_lang,
                    use_gpu=use_gpu,
                    rec_only=(paddle_cfg.mode == "rec-only"),
                    use_angle_cls=paddle_cfg.use_angle_cls,
                    min_crop_width=paddle_cfg.min_crop_width,
                    enhance=paddle_cfg.enhance,
                )
            elif alpr.ocr_engine in {"yolo-chars", "yolo"}:
                char_detector = create_detector(
                    alpr.ocr_model,
                    model_type=alpr.ocr_detector_type,
                    confidence=alpr.ocr_confidence,
                    device=config.device,
                    imgsz=alpr.ocr_imgsz,
                    iou=config.iou,
                    max_det=alpr.ocr_max_det,
                    half=config.half,
                )
                ocr_backend = YoloCharsOCREngine(char_detector)
            else:
                logger.warning("Motor OCR '%s' no reconocido, utilizando fallback PaddleOCREngine", alpr.ocr_engine)
                ocr_backend = PaddleOCREngine(lang=alpr.ocr_lang)

        # 5. Zonas de Interés y Líneas de Disparo
        detection_zone = None
        if alpr.detection_zone:
            detection_zone = dedupe_consecutive_points(parse_points(alpr.detection_zone))

        capture_line = None
        if alpr.capture_line:
            start, end = parse_line(alpr.capture_line)
            movement_vector = None
            if alpr.movement_line:
                m_start, m_end = parse_line(alpr.movement_line)
                movement_vector = movement_vector_from_line(m_start, m_end)
            capture_line = PlateCaptureLine(start=start, end=end, movement_vector=movement_vector)

        # 6. HUD State y Visualizer
        hud_state = PlateHudState(max_cards=hud_cfg.max_cards)
        visualizer = ALPRVisualizer(vis_cfg)

        status_polygon = None
        if hud_cfg.status_polygon:
            status_polygon = parse_points(hud_cfg.status_polygon)

        return cls(
            vehicle_detector=vehicle_detector,
            plate_detector=plate_detector,
            tracker=tracker,
            mode=mode,
            ocr_cache=ocr_cache,
            plate_scope=plate_scope,
            ocr_backend=ocr_backend,
            ocr_engine=alpr.ocr_engine,
            ocr_confidence=alpr.ocr_confidence,
            crop_padding=alpr.ocr_crop_padding,
            hud_state=hud_state,
            visualizer=visualizer,
            hud_panel_x=hud_cfg.panel_x,
            hud_panel_y=hud_cfg.panel_y,
            hud_panel_width=hud_cfg.panel_width,
            hud_panel_height=hud_cfg.panel_height,
            hud_title=hud_cfg.title,
            status_polygon=status_polygon,
            show_status_polygon=hud_cfg.show_status_polygon,
            detection_zone=detection_zone,
            show_detection_zone=alpr.show_detection_zone,
            capture_line=capture_line,
            line_width=vis_cfg.line_width,
            show_labels=vis_cfg.show_labels,
            bbox_style=vis_cfg.bbox_style,
            track_anchor=vis_cfg.track_anchor,
            paddle_min_crop_width=paddle_cfg.min_crop_width,
            paddle_enhance=paddle_cfg.enhance,
        )

    # =========================================================================
    # Ciclo Principal de Procesamiento de Fotograma
    # =========================================================================

    def process_frame(self, frame: np.ndarray) -> PipelineResult:
        """
        Procesa un fotograma completo: detecta vehículos, asocia tracks, detecta placas,
        ejecuta OCR y genera el frame visual anotado junto con el resultado estructurado.
        """
        if frame is None or frame.size == 0:
            return PipelineResult(annotated_frame=np.zeros((10, 10, 3), dtype=np.uint8))

        t0 = time.time()
        self._frame_idx += 1

        # 1. Detección de Vehículos
        vehicles = self.vehicle_detector.predict(frame)

        # 2. Modo solo Detección
        if self.mode == ALPR_MODE_DETECT:
            return self._process_detect_frame(frame, vehicles, t0)

        # 3. Modo Full-Frame (sin seguimiento por vehículos)
        if self.plate_scope == PLATE_SCOPE_FULL:
            return self._process_full_frame_ocr(frame, vehicles, t0)

        # 4. Modo Full con Seguimiento (Vehicle ROI -> Plate -> OCR + Cache)
        if self.tracker is None:
            raise RuntimeError("El tracker no fue inicializado para el modo de seguimiento de vehículos.")

        tracks = update_tracks(self.tracker, vehicles, frame)
        zone_tracks = self._tracks_in_zone(tracks)

        self._refresh_plate_bboxes(frame, zone_tracks)
        self._update_capture_line_for_plates(zone_tracks)

        if self.ocr_cache == OCR_CACHE_FRAME:
            self._read_plates_every_frame(frame, zone_tracks)
        else:
            self._read_new_plates(frame, zone_tracks)

        self._sync_reading_plate_bboxes(zone_tracks)

        # 5. Renderizado Desacoplado con ALPRVisualizer
        vis = frame.copy()
        if self.show_detection_zone:
            vis = self.visualizer.draw_detection_zone(vis, self.detection_zone)
        if self.capture_line:
            vis = self.visualizer.draw_capture_line(vis, self.capture_line)

        vis = self.visualizer.draw_tracks(
            vis,
            zone_tracks,
            thickness=self.line_width,
            font_scale=0.75,
            show_labels=self.show_labels,
            labels=["id", "class"],
            bbox_style=self.bbox_style,
            track_anchor=self.track_anchor,
        )

        detected_plate_boxes = list(self._frame_plate_bboxes.values())
        vis = self.visualizer.draw_plate_boxes(vis, detected_plate_boxes)

        active_readings = list(self.hud_state.readings.values())
        vis = self.visualizer.draw_plate_ocr_labels(
            vis,
            plate_bboxes={bbox_cache_key(pb): pb for pb in detected_plate_boxes},
            readings=active_readings,
        )

        dt = max(1e-4, time.time() - t0)
        self._last_fps = 1.0 / dt

        if self.show_status_polygon:
            vis = self.visualizer.draw_status_hud(
                vis,
                self.status_polygon,
                fps=self._last_fps,
                active_tracks=len(zone_tracks),
                mode=self.mode,
            )

        vis = self.visualizer.draw_plate_hud(
            vis,
            self.hud_state.cards,
            panel_x=self.hud_panel_x,
            panel_y=self.hud_panel_y,
            panel_width=self.hud_panel_width,
            panel_height=self.hud_panel_height,
            title=self.hud_title,
        )

        # Construir Detecciones de Matrículas
        plate_detections = [
            Detection(bbox=pb, confidence=0.9, class_name="plate")
            for pb in detected_plate_boxes
        ]

        return PipelineResult(
            annotated_frame=vis,
            readings=active_readings,
            vehicles=vehicles,
            plates=plate_detections,
            tracks=zone_tracks,
            active_cards=list(self.hud_state.cards),
            frame_idx=self._frame_idx,
            latency_ms=dt * 1000.0,
            fps=self._last_fps,
        )

    # =========================================================================
    # Modos Específicos de Procesamiento
    # =========================================================================

    def _process_detect_frame(
        self,
        frame: np.ndarray,
        vehicles: list[Detection],
        t0: float,
    ) -> PipelineResult:
        """Dibuja cajas de vehículos y placas por frame sin ejecutar OCR."""
        zone_vehicles = self._vehicles_in_zone(vehicles)
        plates = detect_plates_for_vehicles(
            frame,
            zone_vehicles,
            self.plate_detector,
            crop_padding=self.crop_padding,
            plate_color=PLATE_COLOR,
        )

        vis = frame.copy()
        if self.show_detection_zone:
            vis = self.visualizer.draw_detection_zone(vis, self.detection_zone)

        vis = self.visualizer.draw_detections(
            vis,
            zone_vehicles,
            thickness=self.line_width,
            font_scale=0.65,
            show_labels=self.show_labels,
            labels=["class", "confidence"],
            bbox_style=self.bbox_style,
        )
        vis = self.visualizer.draw_detections(
            vis,
            plates,
            thickness=max(2, self.line_width + 1),
            font_scale=0.70,
            show_labels=self.show_labels,
            labels=["class", "confidence"],
            bbox_style=self.bbox_style,
        )

        dt = max(1e-4, time.time() - t0)
        return PipelineResult(
            annotated_frame=vis,
            vehicles=zone_vehicles,
            plates=plates,
            frame_idx=self._frame_idx,
            latency_ms=dt * 1000.0,
            fps=1.0 / dt,
        )

    def _process_full_frame_ocr(
        self,
        frame: np.ndarray,
        vehicles: list[Detection],
        t0: float,
    ) -> PipelineResult:
        """Busca matrículas directamente en todo el fotograma y ejecuta OCR."""
        plates = detect_plates_full_frame(frame, self.plate_detector, plate_color=PLATE_COLOR)
        plates = filter_detections_in_zone(plates, self.detection_zone, anchor=self.track_anchor)

        readings = self._ocr_plate_detections(frame, plates)
        if self.ocr_cache == OCR_CACHE_FRAME:
            self.hud_state.set_frame_readings(readings)
        else:
            for r in readings:
                key = str(bbox_cache_key(r.plate_bbox))
                self.hud_state.store_reading(key, r)

        vis = frame.copy()
        if self.show_detection_zone:
            vis = self.visualizer.draw_detection_zone(vis, self.detection_zone)
        if self.capture_line:
            vis = self.visualizer.draw_capture_line(vis, self.capture_line)

        zone_vehicles = self._vehicles_in_zone(vehicles)
        vis = self.visualizer.draw_detections(
            vis,
            zone_vehicles,
            thickness=self.line_width,
            font_scale=0.65,
            show_labels=self.show_labels,
            labels=["class", "confidence"],
            bbox_style=self.bbox_style,
        )
        vis = self.visualizer.draw_plate_boxes(vis, [p.bbox for p in plates])
        vis = self.visualizer.draw_plate_ocr_labels(
            vis,
            plate_bboxes={bbox_cache_key(p.bbox): p.bbox for p in plates},
            readings=list(self.hud_state.readings.values()),
        )

        dt = max(1e-4, time.time() - t0)
        if self.show_status_polygon:
            vis = self.visualizer.draw_status_hud(
                vis,
                self.status_polygon,
                fps=1.0 / dt,
                active_tracks=len(zone_vehicles),
                mode=self.mode,
            )

        vis = self.visualizer.draw_plate_hud(
            vis,
            self.hud_state.cards,
            panel_x=self.hud_panel_x,
            panel_y=self.hud_panel_y,
            panel_width=self.hud_panel_width,
            panel_height=self.hud_panel_height,
            title=self.hud_title,
        )

        return PipelineResult(
            annotated_frame=vis,
            readings=list(self.hud_state.readings.values()),
            vehicles=zone_vehicles,
            plates=plates,
            active_cards=list(self.hud_state.cards),
            frame_idx=self._frame_idx,
            latency_ms=dt * 1000.0,
            fps=1.0 / dt,
        )

    # =========================================================================
    # Helpers de OCR y Filtrado Espacial
    # =========================================================================

    def _tracks_in_zone(self, tracks: list[Track]) -> list[Track]:
        """Filtra tracks que residen dentro de la zona de interés."""
        if not self.detection_zone or len(self.detection_zone) < 3:
            return tracks
        return [
            t for t in tracks
            if is_point_in_polygon(
                t.bottom_center if self.track_anchor == "bottom_center" else t.center,
                self.detection_zone,
            )
        ]

    def _vehicles_in_zone(self, vehicles: list[Detection]) -> list[Detection]:
        """Filtra vehículos que residen dentro de la zona de interés."""
        return filter_detections_in_zone(vehicles, self.detection_zone, anchor=self.track_anchor)

    def _refresh_plate_bboxes(self, frame: np.ndarray, tracks: list[Track]) -> None:
        """Detecta matrículas dentro del bounding box de cada vehículo activo."""
        self._frame_plate_bboxes.clear()
        for trk in tracks:
            crop, [cx1, cy1, cx2, cy2] = crop_bbox(frame, trk.bbox, padding=self.crop_padding)
            if crop.size == 0:
                continue

            plate_dets = self.plate_detector.predict(crop)
            if plate_dets:
                best_plate = max(plate_dets, key=lambda d: d.confidence)
                px1 = best_plate.bbox[0] + cx1
                py1 = best_plate.bbox[1] + cy1
                px2 = best_plate.bbox[2] + cx1
                py2 = best_plate.bbox[3] + cy1
                box = [px1, py1, px2, py2]
                self._frame_plate_bboxes[trk.track_id] = box
                trk.plate_bbox = box

    def _update_capture_line_for_plates(self, tracks: list[Track]) -> None:
        """Opcional: evalúa cruce de línea virtual para captura de eventos."""
        pass

    def _read_new_plates(self, frame: np.ndarray, tracks: list[Track]) -> None:
        """Ejecuta detección y OCR solo en los tracks que aún no tienen lectura confirmada."""
        for trk in tracks:
            if self.hud_state.has_reading(trk.track_id):
                continue
            reading = self._read_plate_for_track(frame, trk)
            if reading is not None:
                self.hud_state.store_reading(trk.track_id, reading)
                trk.reading = reading

    def _read_plates_every_frame(self, frame: np.ndarray, tracks: list[Track]) -> None:
        """Ejecuta detección y OCR en cada track en cada fotograma."""
        for trk in tracks:
            reading = self._read_plate_for_track(frame, trk)
            if reading is not None:
                self.hud_state.store_reading(trk.track_id, reading, overwrite=True)
                trk.reading = reading

    def _read_plate_for_track(self, frame: np.ndarray, track: Track) -> Optional[PlateReading]:
        """Extrae el recorte de matrícula del track y ejecuta el motor OCR."""
        plate_box = self._frame_plate_bboxes.get(track.track_id)
        if not plate_box:
            return None

        plate_crop, _ = crop_bbox(frame, plate_box, padding=0.04)
        if plate_crop.size == 0:
            return None

        text, confidence = self._read_plate(plate_crop)
        if not text or confidence < self.ocr_confidence:
            return None

        # Validación normativa oficial ANT Ecuador
        val_res = self.validator.validate(text)

        return PlateReading(
            text=val_res.formatted_plate if val_res.is_valid else text,
            confidence=confidence,
            plate_bbox=plate_box,
            vehicle_bbox=track.bbox,
            track_id=track.track_id,
            is_valid=val_res.is_valid,
            province=val_res.provincia,
            service_type=val_res.servicio,
            vehicle_type=track.class_name,
            raw_text=text,
            crop_image=plate_crop,
        )

    def _read_plate(self, plate_crop: np.ndarray) -> tuple[str, float]:
        """Invoca el backend OCR configurado."""
        if self.ocr_backend is None:
            return "", 0.0

        if hasattr(self.ocr_backend, "read_plate"):
            return self.ocr_backend.read_plate(plate_crop)

        # Si el backend es un detector de caracteres
        if hasattr(self.ocr_backend, "predict"):
            char_dets = self.ocr_backend.predict(plate_crop)
            if not char_dets:
                return "", 0.0
            char_dets.sort(key=lambda d: d.bbox[0])
            chars = [d.class_name.upper() for d in char_dets if d.class_name]
            confs = [d.confidence for d in char_dets]
            return "".join(chars), float(np.mean(confs)) if confs else 0.0

        return "", 0.0

    def _ocr_plate_detections(
        self,
        frame: np.ndarray,
        plates: list[Detection],
    ) -> list[PlateReading]:
        """Procesa una lista de detecciones de matrículas con OCR."""
        readings: list[PlateReading] = []
        for p in plates:
            plate_crop, _ = crop_bbox(frame, p.bbox, padding=0.04)
            text, conf = self._read_plate(plate_crop)
            if not text or conf < self.ocr_confidence:
                continue

            val_res = self.validator.validate(text)
            readings.append(
                PlateReading(
                    text=val_res.formatted_plate if val_res.is_valid else text,
                    confidence=conf,
                    plate_bbox=p.bbox,
                    is_valid=val_res.is_valid,
                    province=val_res.provincia,
                    service_type=val_res.servicio,
                    raw_text=text,
                    crop_image=plate_crop,
                )
            )
        return readings

    def _sync_reading_plate_bboxes(self, tracks: list[Track]) -> None:
        """Sincroniza las coordenadas actuales de la placa en las lecturas almacenadas."""
        for trk in tracks:
            reading = self.hud_state.get_reading(trk.track_id)
            if reading and trk.track_id in self._frame_plate_bboxes:
                reading.plate_bbox = self._frame_plate_bboxes[trk.track_id]

    def _sync_frame_reading_bboxes(self, plates: list[Detection], readings: list[PlateReading]) -> None:
        """Sincroniza bboxes de lecturas en modo full-frame."""
        pass
