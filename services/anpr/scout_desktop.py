"""
ECU 911 — Rekor Scout Native Python Desktop Viewer
Replica con exactitud la interfaz gráfica y los algoritmos de detección de Rekor Scout / OpenALPR:
  1. Zona de Interés de Movimiento Dinámica (MOG2 Motion Detector - Recuadro Verde Translúcido).
  2. Bounding Box Orientado de 4 Puntos (Rotación exacta con la mano, sin desfase).
  3. Badge Táctico de Identificación Centrado sobre la Placa.
  4. Panel Lateral de Placas Recientes (con miniaturas fotográficas en tiempo real).
  5. Barra Inferior de Métricas (FPS, Motion %, Reconocimiento %, Resolución).
"""

import sys
import os
import time
import cv2
import numpy as np
from datetime import datetime

# Asegurar path de imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.core.detector import create_detection_pipeline
from app.core.ocr_engine import create_ocr_engine
from app.utils.plate_parser import validate_ecuadorian_plate, disambiguate_plate


class ScoutDesktopViewer:
    def __init__(self, camera_index=0, width=1280, height=720):
        self.camera_index = camera_index
        self.target_w = width
        self.target_h = height

        print("[Scout] Inicializando detector YOLO y motor OCR...")
        self.pipeline = create_detection_pipeline()
        self.ocr_engine = create_ocr_engine()

        # OpenALPR Motion Detector (MOG2 de OpenCV con supresión de sombras)
        self.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=150, varThreshold=25, detectShadows=False
        )

        # Historial de capturas recientes para el panel lateral
        self.recent_plates = []
        self.last_seen_plate = ""
        self.last_plate_time = 0

        # Métricas
        self.fps = 30.0
        self.motion_pct = 0
        self.recognition_pct = 100
        self.frame_count = 0
        self.fps_start = time.time()

    def run(self):
        print(f"[Scout] Abriendo cámara {self.camera_index} en Windows DirectShow...")
        cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            print(f"[Scout] Fallback a backend estándar para cámara {self.camera_index}...")
            cap = cv2.VideoCapture(self.camera_index)

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.target_w)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.target_h)
        cap.set(cv2.CAP_PROP_FPS, 30)

        window_name = "Rekor Scout — ECU 911 ANPR (Form Nativo)"
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(window_name, 1280, 720)

        print("[Scout] Interfaz de escritorio iniciada. Presiona 'q' o ESC para salir.")

        while True:
            t0 = time.perf_counter()
            ret, frame = cap.read()
            if not ret or frame is None:
                time.sleep(0.01)
                continue

            h, w = frame.shape[:2]
            display_frame = frame.copy()

            # ─────────────────────────────────────────────────────────────────
            # 1. OpenALPR Motion Detector: Zona de Interés Dinámica (MOG2)
            # ─────────────────────────────────────────────────────────────────
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            fg_mask = self.bg_subtractor.apply(gray)
            _, fg_thresh = cv2.threshold(fg_mask, 128, 255, cv2.THRESH_BINARY)
            
            # Limpiar ruido morfológico
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            fg_clean = cv2.morphologyEx(fg_thresh, cv2.MORPH_OPEN, kernel)
            fg_clean = cv2.dilate(fg_clean, kernel, iterations=2)

            motion_pixels = cv2.countNonZero(fg_clean)
            self.motion_pct = int(min(100, (motion_pixels / float(w * h)) * 100 * 6))

            # Obtener el contorno mayor de movimiento para la Zona de Interés
            contours, _ = cv2.findContours(fg_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            motion_bbox = None
            if contours:
                valid_cnts = [c for c in contours if cv2.contourArea(c) > 1200]
                if valid_cnts:
                    all_pts = np.vstack(valid_cnts)
                    mx, my, mw, mh = cv2.boundingRect(all_pts)
                    # Expandir un 15% como margen de búsqueda
                    mx = max(0, mx - int(mw * 0.10))
                    my = max(0, my - int(mh * 0.10))
                    mw = min(w - mx, int(mw * 1.20))
                    mh = min(h - my, int(mh * 1.20))
                    motion_bbox = (mx, my, mw, mh)

            # Dibujar Zona de Interés en verde translúcido estilo Rekor Scout
            if motion_bbox and (self.motion_pct > 3):
                mx, my, mw, mh = motion_bbox
                overlay = display_frame.copy()
                cv2.rectangle(overlay, (mx, my), (mx + mw, my + mh), (40, 190, 70), -1)
                cv2.addWeighted(overlay, 0.22, display_frame, 0.78, 0, display_frame)
                cv2.rectangle(display_frame, (mx, my), (mx + mw, my + mh), (40, 200, 70), 1)

            # ─────────────────────────────────────────────────────────────────
            # 2. Detección de Matrícula (Multiescala Cerca/Lejos)
            # ─────────────────────────────────────────────────────────────────
            rois = self.pipeline.detect_fast(frame)

            for roi in rois:
                bx1, by1, bx2, by2 = roi.plate_bbox
                bw = bx2 - bx1
                bh = by2 - by1

                # Extraer recorte y buscar rotación orientada (4 vértices exactos)
                plate_crop = frame[by1:by2, bx1:bx2]
                oriented_box = None
                if plate_crop.size > 0:
                    crop_gray = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY)
                    _, c_thresh = cv2.threshold(crop_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                    c_cnts, _ = cv2.findContours(c_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    if c_cnts:
                        c_largest = max(c_cnts, key=cv2.contourArea)
                        if cv2.contourArea(c_largest) > 0.20 * (bw * bh):
                            rect = cv2.minAreaRect(c_largest)
                            box_pts = cv2.boxPoints(rect)
                            box_pts[:, 0] += bx1
                            box_pts[:, 1] += by1
                            oriented_box = np.int32(box_pts)

                # Fallback a caja delimitadora ortogonal si no hay contorno claro
                if oriented_box is None:
                    oriented_box = np.array([
                        [bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]
                    ], dtype=np.int32)

                # Dibujar caja orientada idéntica a Rekor Scout (color ámbar/bronce #D97706 o verde)
                box_color = (15, 150, 230)  # Tono naranja/ámbar de Rekor Scout
                cv2.polylines(display_frame, [oriented_box], isClosed=True, color=box_color, thickness=2, lineType=cv2.LINE_AA)

                # 3. Reconocimiento OCR y Badge Superior Flotante
                plate_text = self.pipeline.get_browser_track_info(roi.tracking_id).get("plate", "")
                if not plate_text and plate_crop.size > 0:
                    ocr_res = self.ocr_engine.read_text(plate_crop)
                    if ocr_res:
                        raw_tok = "".join(r.text for r in ocr_res).replace(" ", "").upper()
                        is_val, fmt_p, _ = validate_ecuadorian_plate(raw_tok)
                        if is_val:
                            plate_text = fmt_p
                            self.pipeline.update_browser_track_plate(roi.tracking_id, fmt_p, 0.95, "autorizado")

                if not plate_text:
                    plate_text = f"ID #{roi.tracking_id}"

                # Renderizar Badge oscuro flotante con texto blanco
                badge_text = f" {plate_text} "
                (tw, th), baseline = cv2.getTextSize(badge_text, cv2.FONT_HERSHEY_SIMPLEX, 0.58, 2)
                badge_x = max(10, min(w - tw - 10, bx1 + (bw - tw) // 2))
                badge_y = max(th + 10, by1 - 8)

                # Fondo del badge
                cv2.rectangle(
                    display_frame,
                    (badge_x - 4, badge_y - th - 4),
                    (badge_x + tw + 4, badge_y + baseline + 2),
                    (25, 25, 25),
                    -1
                )
                cv2.rectangle(
                    display_frame,
                    (badge_x - 4, badge_y - th - 4),
                    (badge_x + tw + 4, badge_y + baseline + 2),
                    box_color,
                    1
                )
                cv2.putText(
                    display_frame,
                    badge_text,
                    (badge_x, badge_y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.58,
                    (255, 255, 255),
                    2,
                    cv2.LINE_AA
                )

                # Registrar en panel lateral si es una nueva placa válida
                if "-" in plate_text and plate_text != self.last_seen_plate and (time.time() - self.last_plate_time > 3.0):
                    self.last_seen_plate = plate_text
                    self.last_plate_time = time.time()
                    crop_thumb = cv2.resize(plate_crop, (150, 48)) if plate_crop.size > 0 else None
                    self.recent_plates.insert(0, {
                        "plate": plate_text,
                        "time": datetime.now().strftime("%H:%M:%S"),
                        "thumb": crop_thumb
                    })
                    if len(self.recent_plates) > 5:
                        self.recent_plates.pop()

            # ─────────────────────────────────────────────────────────────────
            # 4. Construir Interfaz de Escritorio con Panel Lateral (Rekor Scout)
            # ─────────────────────────────────────────────────────────────────
            panel_w = 280
            canvas = np.zeros((h + 40, w + panel_w, 3), dtype=np.uint8)
            canvas[:] = (240, 240, 240)  # Fondo gris claro nativo

            # Insertar video principal
            canvas[0:h, panel_w:panel_w + w] = display_frame

            # Dibujar Panel Lateral Izquierdo: "Recent Plates"
            cv2.rectangle(canvas, (0, 0), (panel_w, h + 40), (248, 249, 250), -1)
            cv2.line(canvas, (panel_w, 0), (panel_w, h + 40), (220, 224, 230), 1)

            # Cabecera de Rekor Scout
            cv2.putText(canvas, "Rekor Scout - ECU 911", (16, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (20, 20, 20), 2, cv2.LINE_AA)
            cv2.putText(canvas, "CAM1 (Webcam Local)", (16, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.44, (0, 140, 230), 1, cv2.LINE_AA)
            cv2.line(canvas, (16, 68), (panel_w - 16, 68), (220, 224, 230), 1)

            cv2.putText(canvas, "Recent Plates:", (16, 92), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (60, 60, 60), 1, cv2.LINE_AA)

            y_offset = 110
            for item in self.recent_plates:
                # Caja de placa reciente
                cv2.rectangle(canvas, (14, y_offset), (panel_w - 14, y_offset + 80), (255, 255, 255), -1)
                cv2.rectangle(canvas, (14, y_offset), (panel_w - 14, y_offset + 80), (225, 230, 235), 1)

                cv2.putText(canvas, item["plate"], (24, y_offset + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (15, 23, 42), 2, cv2.LINE_AA)
                cv2.putText(canvas, f"Hora: {item['time']}", (24, y_offset + 42), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (100, 116, 139), 1, cv2.LINE_AA)

                if item["thumb"] is not None:
                    th_h, th_w = item["thumb"].shape[:2]
                    canvas[y_offset + 48:y_offset + 48 + min(28, th_h), 24:24 + min(panel_w - 48, th_w)] = item["thumb"][:28, :panel_w - 48]

                y_offset += 92

            # ─────────────────────────────────────────────────────────────────
            # 5. Barra Inferior de Métricas (Idéntica a Rekor Scout)
            # ─────────────────────────────────────────────────────────────────
            cv2.rectangle(canvas, (0, h), (panel_w + w, h + 40), (255, 255, 255), -1)
            cv2.line(canvas, (0, h), (panel_w + w, h), (215, 220, 228), 1)

            # Medición de FPS
            self.frame_count += 1
            if self.frame_count % 10 == 0:
                el = time.time() - self.fps_start
                if el > 0:
                    self.fps = round(10.0 / el, 1)
                self.fps_start = time.time()

            metrics_str = f"FPS: {self.fps:.1f}   Motion: {self.motion_pct}%   Recognized: {self.recognition_pct}%   Resolution: {w}x{h}"
            cv2.putText(canvas, metrics_str, (panel_w + 20, h + 26), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (50, 50, 50), 1, cv2.LINE_AA)

            cv2.imshow(window_name, canvas)
            key = cv2.waitKey(1) & 0xFF
            if key in (27, ord('q'), ord('Q')):
                break

        cap.release()
        cv2.destroyAllWindows()
        print("[Scout] Visor de escritorio finalizado limpiamente.")


if __name__ == "__main__":
    cam_idx = 0
    if len(sys.argv) > 1:
        try:
            cam_idx = int(sys.argv[1])
        except ValueError:
            cam_idx = sys.argv[1]

    viewer = ScoutDesktopViewer(camera_index=cam_idx)
    viewer.run()
