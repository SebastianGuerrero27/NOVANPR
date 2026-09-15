"""
Motor de Renderizado Visual Desacoplado para ANPR (ALPRVisualizer / HUDRenderer).
Cumple con el Principio de Responsabilidad Única (SRP): Separa el cómputo de la visualización.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple, Union
import cv2
import numpy as np

from app.core.config_schemas import VisualizerConfig
from app.core.models import (
    Detection,
    PlateCaptureLine,
    PlateHudCard,
    PlateReading,
    Track,
)


# Paleta de Colores Tácticos (BGR)
COLOR_NEON_GREEN = (0, 255, 128)
COLOR_NEON_BLUE = (255, 160, 30)
COLOR_NEON_CYAN = (255, 230, 0)
COLOR_ALERT_RED = (40, 40, 240)
COLOR_WARNING_AMBER = (0, 180, 255)
COLOR_DARK_PANEL = (20, 24, 30)
COLOR_PANEL_BORDER = (60, 70, 85)
COLOR_WHITE = (255, 255, 255)
COLOR_GRAY = (160, 165, 175)


class ALPRVisualizer:
    """Renderizador táctico de alto impacto visual para video en tiempo real."""

    def __init__(self, config: Optional[VisualizerConfig] = None) -> None:
        self.config = config or VisualizerConfig()

    # =========================================================================
    # 1. Dibujo de Cajas Delimitadoras y Brackets Tácticos
    # =========================================================================

    def draw_corner_brackets(
        self,
        img: np.ndarray,
        bbox: list[float] | tuple[float, float, float, float],
        color: tuple[int, int, int],
        thickness: int = 2,
        corner_len: int = 14,
    ) -> None:
        """Dibuja brackets esquineros estilo Sci-Fi/HUD militar."""
        x1, y1, x2, y2 = [int(round(v)) for v in bbox]
        w = x2 - x1
        h = y2 - y1
        cl = min(corner_len, max(4, min(w // 3, h // 3)))

        # Top-Left
        cv2.line(img, (x1, y1), (x1 + cl, y1), color, thickness)
        cv2.line(img, (x1, y1), (x1, y1 + cl), color, thickness)

        # Top-Right
        cv2.line(img, (x2, y1), (x2 - cl, y1), color, thickness)
        cv2.line(img, (x2, y1), (x2, y1 + cl), color, thickness)

        # Bottom-Right
        cv2.line(img, (x2, y2), (x2 - cl, y2), color, thickness)
        cv2.line(img, (x2, y2), (x2, y2 - cl), color, thickness)

        # Bottom-Left
        cv2.line(img, (x1, y2), (x1 + cl, y2), color, thickness)
        cv2.line(img, (x1, y2), (x1, y2 - cl), color, thickness)

    def draw_detections(
        self,
        frame: np.ndarray,
        detections: list[Detection],
        thickness: int = 2,
        font_scale: float = 0.65,
        show_labels: bool = True,
        labels: Optional[list[str]] = None,
        bbox_style: str = "corners",
    ) -> np.ndarray:
        """Dibuja detecciones de vehículos o matrículas en el frame."""
        if frame is None or not detections:
            return frame

        vis = frame
        for det in detections:
            x1, y1, x2, y2 = [int(round(v)) for v in det.bbox]
            color = det.color or COLOR_NEON_BLUE

            if bbox_style == "corners":
                self.draw_corner_brackets(vis, det.bbox, color, thickness=thickness, corner_len=16)
                # Borde tenue complementario
                cv2.rectangle(vis, (x1, y1), (x2, y2), color, 1, lineType=cv2.LINE_AA)
            else:
                cv2.rectangle(vis, (x1, y1), (x2, y2), color, thickness, lineType=cv2.LINE_AA)

            if show_labels:
                parts = []
                requested_labels = labels or ["class", "confidence"]
                if "class" in requested_labels:
                    parts.append(det.class_name.upper())
                if "confidence" in requested_labels:
                    parts.append(f"{det.confidence:.0%}")
                if "id" in requested_labels and det.track_id is not None:
                    parts.append(f"#{det.track_id}")

                label_text = " | ".join(parts)
                self._draw_badge(vis, (x1, y1 - 6), label_text, color, font_scale=font_scale)

        return vis

    def draw_tracks(
        self,
        frame: np.ndarray,
        tracks: list[Track],
        thickness: int = 2,
        font_scale: float = 0.7,
        font_thickness: int = 2,
        show_labels: bool = True,
        labels: Optional[list[str]] = None,
        bbox_style: str = "corners",
        track_anchor: str = "center",
    ) -> np.ndarray:
        """Dibuja tracks con estelas de trayectoria histórica y badges tácticos."""
        if frame is None or not tracks:
            return frame

        vis = frame
        for trk in tracks:
            x1, y1, x2, y2 = [int(round(v)) for v in trk.bbox]
            color = trk.color or COLOR_NEON_CYAN

            # 1. Dibujar estela de trayectoria (Trail)
            if len(trk.history) >= 2:
                pts = np.array([[int(p[0]), int(p[1])] for p in trk.history], dtype=np.int32)
                cv2.polylines(vis, [pts], isClosed=False, color=color, thickness=1, lineType=cv2.LINE_AA)
                # Puntos de la estela con gradiente
                for i, pt in enumerate(trk.history):
                    alpha = (i + 1) / float(len(trk.history))
                    radius = max(1, int(3 * alpha))
                    cv2.circle(vis, (int(pt[0]), int(pt[1])), radius, color, -1)

            # 2. Dibujar Bounding Box
            if bbox_style == "corners":
                self.draw_corner_brackets(vis, trk.bbox, color, thickness=thickness, corner_len=18)
                cv2.rectangle(vis, (x1, y1), (x2, y2), color, 1, lineType=cv2.LINE_AA)
            else:
                cv2.rectangle(vis, (x1, y1), (x2, y2), color, thickness, lineType=cv2.LINE_AA)

            # 3. Dibujar Etiquetas
            if show_labels:
                parts = []
                requested_labels = labels or ["id", "class"]
                if "id" in requested_labels:
                    parts.append(f"#{trk.track_id}")
                if "class" in requested_labels:
                    parts.append(trk.class_name.upper())
                if "confidence" in requested_labels:
                    parts.append(f"{trk.confidence:.0%}")

                label_text = " | ".join(parts)
                self._draw_badge(vis, (x1, y1 - 6), label_text, color, font_scale=font_scale)

        return vis

    # =========================================================================
    # 2. Zonas de Detección y Líneas Virtuales de Disparo
    # =========================================================================

    def draw_detection_zone(
        self,
        frame: np.ndarray,
        zone: Optional[list[tuple[int, int]]],
        color: tuple[int, int, int] = (0, 220, 255),
        alpha: float = 0.15,
    ) -> np.ndarray:
        """Dibuja polígono semitransparente que delimita la zona activa de inferencia."""
        if frame is None or not zone or len(zone) < 3:
            return frame

        vis = frame
        overlay = vis.copy()
        pts = np.array(zone, dtype=np.int32)
        cv2.fillPoly(overlay, [pts], color)
        cv2.addWeighted(overlay, alpha, vis, 1.0 - alpha, 0, vis)
        cv2.polylines(vis, [pts], isClosed=True, color=color, thickness=2, lineType=cv2.LINE_AA)

        # Etiqueta de Zona
        first_pt = zone[0]
        self._draw_badge(vis, (first_pt[0], first_pt[1] - 8), "ZONA ACTIVA ANPR", color, font_scale=0.55)
        return vis

    def draw_capture_line(
        self,
        frame: np.ndarray,
        line: Optional[PlateCaptureLine],
    ) -> np.ndarray:
        """Dibuja la línea virtual de captura y la flecha directriz de avance."""
        if frame is None or line is None:
            return frame

        vis = frame
        cv2.line(vis, line.start, line.end, line.color, line.thickness, lineType=cv2.LINE_AA)
        cv2.circle(vis, line.start, 5, line.color, -1)
        cv2.circle(vis, line.end, 5, line.color, -1)

        # Flecha de vector de movimiento si existe
        if line.movement_vector:
            mx = (line.start[0] + line.end[0]) // 2
            my = (line.start[1] + line.end[1]) // 2
            vx, vy = line.movement_vector
            arrow_end = (int(mx + vx * 40), int(my + vy * 40))
            cv2.arrowedLine(vis, (mx, my), arrow_end, line.color, 2, tipLength=0.35)

        return vis

    # =========================================================================
    # 3. Matrículas y Lecturas OCR en Frame
    # =========================================================================

    def draw_plate_boxes(
        self,
        frame: np.ndarray,
        plate_bboxes: list[list[float] | tuple[float, float, float, float]],
        color: tuple[int, int, int] = COLOR_NEON_GREEN,
        thickness: int = 2,
    ) -> np.ndarray:
        """Dibuja cajas resaltadas sobre las matrículas detectadas."""
        if frame is None or not plate_bboxes:
            return frame

        vis = frame
        for bbox in plate_bboxes:
            x1, y1, x2, y2 = [int(round(v)) for v in bbox]
            self.draw_corner_brackets(vis, bbox, color, thickness=thickness, corner_len=8)
            cv2.rectangle(vis, (x1, y1), (x2, y2), color, 1, lineType=cv2.LINE_AA)
        return vis

    def draw_plate_ocr_labels(
        self,
        frame: np.ndarray,
        plate_bboxes: dict[Any, Any],
        readings: list[PlateReading],
        font_scale: float = 0.75,
        font_thickness: int = 2,
    ) -> np.ndarray:
        """Dibuja el texto OCR reconocido con fondo oscuro de alto contraste sobre la matrícula."""
        if frame is None or not readings:
            return frame

        vis = frame
        for r in readings:
            if not r.plate_bbox or not r.text:
                continue
            x1, y1, x2, y2 = [int(round(v)) for v in r.plate_bbox]
            badge_color = COLOR_NEON_GREEN if r.is_valid else COLOR_WARNING_AMBER
            text = f"{r.text} ({r.confidence:.0%})"
            self._draw_badge(vis, (x1, y1 - 8), text, badge_color, font_scale=font_scale, bold=True)
        return vis

    # =========================================================================
    # 4. Paneles HUD Tácticos (Status Bar y Tarjetas Flotantes)
    # =========================================================================

    def draw_status_hud(
        self,
        frame: np.ndarray,
        status_polygon: Optional[list[tuple[int, int]]] = None,
        title: str = "ECU 911 — SISTEMA ANPR ZONA 3",
        fps: float = 0.0,
        active_tracks: int = 0,
        mode: str = "FULL",
    ) -> np.ndarray:
        """Dibuja la barra de estado superior con métricas operativas en tiempo real."""
        if frame is None:
            return frame

        vis = frame
        h, w = vis.shape[:2]

        # Coordenadas por defecto del status bar
        x1, y1, x2, y2 = 16, 16, min(w - 16, 680), 75
        if status_polygon and len(status_polygon) >= 4:
            x1 = min(p[0] for p in status_polygon)
            y1 = min(p[1] for p in status_polygon)
            x2 = max(p[0] for p in status_polygon)
            y2 = max(p[1] for p in status_polygon)

        # Panel semitransparente
        self._draw_glass_panel(vis, (x1, y1, x2, y2), alpha=0.75)

        # Texto de Título
        cv2.putText(vis, title, (x1 + 14, y1 + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, COLOR_NEON_CYAN, 2, cv2.LINE_AA)

        # Métricas
        info_str = f"FPS: {fps:.1f}  |  TRACKS: {active_tracks}  |  MODO: {mode.upper()}  |  SISTEMA: ACTIVO"
        cv2.putText(vis, info_str, (x1 + 14, y1 + 46), cv2.FONT_HERSHEY_SIMPLEX, 0.45, COLOR_WHITE, 1, cv2.LINE_AA)

        return vis

    def draw_plate_hud(
        self,
        frame: np.ndarray,
        cards: list[PlateHudCard],
        panel_x: int = 16,
        panel_y: int = 90,
        panel_width: int = 340,
        panel_height: Optional[int] = None,
        title: str = "ULTIMAS DETECCIONES",
    ) -> np.ndarray:
        """Dibuja la pila vertical de tarjetas HUD con placas, confianza y miniaturas."""
        if frame is None or not cards:
            return frame

        vis = frame
        card_h = 58
        margin = 8
        total_h = panel_height or (40 + len(cards) * (card_h + margin))

        # Panel de fondo contenedor
        px2 = panel_x + panel_width
        py2 = panel_y + total_h
        self._draw_glass_panel(vis, (panel_x, panel_y, px2, py2), alpha=0.82)

        # Encabezado del panel
        cv2.putText(vis, title.upper(), (panel_x + 12, panel_y + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.50, COLOR_NEON_BLUE, 2, cv2.LINE_AA)

        curr_y = panel_y + 34
        for card in cards:
            cx1 = panel_x + 8
            cy1 = curr_y
            cx2 = panel_x + panel_width - 8
            cy2 = cy1 + card_h

            # Color del borde según estado
            border_color = COLOR_NEON_GREEN
            if card.status == "blacklist":
                border_color = COLOR_ALERT_RED
            elif card.status == "warning" or not card.is_valid:
                border_color = COLOR_WARNING_AMBER
            elif card.status == "authorized":
                border_color = COLOR_NEON_BLUE

            # Fondo de la tarjeta individual
            cv2.rectangle(vis, (cx1, cy1), (cx2, cy2), (28, 34, 42), -1)
            cv2.rectangle(vis, (cx1, cy1), (cx2, cy2), border_color, 1, lineType=cv2.LINE_AA)

            # Placa en negrita
            cv2.putText(vis, card.plate_text, (cx1 + 10, cy1 + 26), cv2.FONT_HERSHEY_SIMPLEX, 0.70, COLOR_WHITE, 2, cv2.LINE_AA)

            # Confianza y datos
            sub_info = f"Conf: {card.confidence:.0%} | {card.vehicle_type.upper()}"
            if card.province:
                sub_info += f" | {card.province}"
            cv2.putText(vis, sub_info, (cx1 + 10, cy1 + 46), cv2.FONT_HERSHEY_SIMPLEX, 0.38, COLOR_GRAY, 1, cv2.LINE_AA)

            # Badge de Estado en la esquina derecha de la tarjeta
            status_text = card.status.upper()
            status_badge_x = cx2 - 80
            cv2.rectangle(vis, (status_badge_x, cy1 + 8), (cx2 - 8, cy1 + 24), border_color, -1)
            cv2.putText(vis, status_text[:8], (status_badge_x + 4, cy1 + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.34, (10, 10, 10), 1, cv2.LINE_AA)

            curr_y += card_h + margin

        return vis

    # =========================================================================
    # Helpers Internos de Dibujo
    # =========================================================================

    def _draw_glass_panel(
        self,
        img: np.ndarray,
        rect: tuple[int, int, int, int],
        alpha: float = 0.75,
    ) -> None:
        """Dibuja un panel oscuro semitransparente con borde sutil."""
        x1, y1, x2, y2 = rect
        h, w = img.shape[:2]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 <= x1 or y2 <= y1:
            return

        sub = img[y1:y2, x1:x2]
        overlay = np.full_like(sub, COLOR_DARK_PANEL)
        cv2.addWeighted(overlay, alpha, sub, 1.0 - alpha, 0, sub)
        cv2.rectangle(img, (x1, y1), (x2, y2), COLOR_PANEL_BORDER, 1, lineType=cv2.LINE_AA)

    def _draw_badge(
        self,
        img: np.ndarray,
        pos: tuple[int, int],
        text: str,
        bg_color: tuple[int, int, int],
        font_scale: float = 0.60,
        bold: bool = False,
    ) -> None:
        """Dibuja una pastilla/etiqueta con texto legible."""
        px, py = pos
        font_thickness = 2 if bold else 1
        (tw, th), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thickness)

        pad_x = 6
        pad_y = 4
        bx1 = max(0, px)
        by1 = max(0, py - th - pad_y * 2)
        bx2 = bx1 + tw + pad_x * 2
        by2 = py

        cv2.rectangle(img, (bx1, by1), (bx2, by2), bg_color, -1)
        cv2.putText(
            img,
            text,
            (bx1 + pad_x, by2 - pad_y),
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            (10, 15, 20),
            font_thickness,
            cv2.LINE_AA,
        )


# =============================================================================
# Funciones Libres para Compatibilidad y Modularidad
# =========================================================================

_DEFAULT_VISUALIZER = ALPRVisualizer()


def draw_tracks(frame: np.ndarray, tracks: list[Track], **kwargs) -> np.ndarray:
    return _DEFAULT_VISUALIZER.draw_tracks(frame, tracks, **kwargs)


def draw_detections(frame: np.ndarray, detections: list[Detection], **kwargs) -> np.ndarray:
    return _DEFAULT_VISUALIZER.draw_detections(frame, detections, **kwargs)


def draw_plate_hud(frame: np.ndarray, cards: list[PlateHudCard], **kwargs) -> np.ndarray:
    return _DEFAULT_VISUALIZER.draw_plate_hud(frame, cards, **kwargs)
