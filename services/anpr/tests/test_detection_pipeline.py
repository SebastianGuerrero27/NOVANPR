"""
Pruebas Unitarias para DetectionPipeline con Inyección de Dependencias (MockDetector).
Verifica:
1. Inyección de MockDetector (cero dependencia de GPU o archivos .pt).
2. Seguimiento ByteTrack y Kalman en detect_and_track.
3. Consenso temporal ponderado de placas ecuatorianas ANT.
4. Limpieza de memoria (clear_all_tracks).
5. La única fuente es la cámara RTSP: no hay detección de cuadros del navegador.
"""

import unittest
import numpy as np

from app.dominio.models import Detection
from app.infraestructura.detectors import MockDetector
from app.aplicacion.detector import (
    _COLOR_LEIDA,
    DetectionPipeline,
    TrackedPlateROI,
    is_valid_ecuador_plate,
)


class TestDetectionPipelineDI(unittest.TestCase):
    def setUp(self):
        # Frame dummy (480x640 BGR)
        self.frame = np.full((480, 640, 3), 128, dtype=np.uint8)

        # Mock detections: placa con aspecto ratio válido para Ecuador (bw=120, bh=40 -> AR=3.0)
        self.mock_det = MockDetector([
            Detection(bbox=[100.0, 150.0, 220.0, 190.0], confidence=0.88, class_name="plate")
        ])

        # Pipeline instanciado mediante Inyección de Dependencias
        self.pipeline = DetectionPipeline(detector=self.mock_det)

    def test_dependency_injection_instantiation(self):
        """Verifica que el pipeline se inicializa con el detector inyectado sin tocar disco ni GPU."""
        self.assertIs(self.pipeline.detector, self.mock_det)
        self.assertEqual(len(self.pipeline._trackers), 0)

    def test_solo_fuente_rtsp_sin_api_del_navegador(self):
        """La webcam del navegador se retiró: no queda detección ni consenso de cuadros del navegador."""
        for retirado in ("detect_fast", "browser_detector", "update_browser_track_plate", "get_browser_track_info"):
            self.assertFalse(hasattr(self.pipeline, retirado), retirado)

    def test_detect_and_track_with_mock(self):
        """Verifica que detect_and_track ejecuta ByteTrack y retorna TrackedPlateROI."""
        # Frame 1: crea track inicial
        rois1 = self.pipeline.detect_and_track(self.frame)
        self.assertIsInstance(rois1, list)
        self.assertGreaterEqual(len(rois1), 1)
        roi = rois1[0]
        self.assertIsInstance(roi, TrackedPlateROI)
        self.assertGreaterEqual(roi.confidence, 0.18)
        self.assertEqual(len(roi.plate_bbox), 4)

        # Frame 2: mantiene el tracking del mismo ID
        first_id = roi.tracking_id
        rois2 = self.pipeline.detect_and_track(self.frame)
        self.assertEqual(rois2[0].tracking_id, first_id)

    def test_coordenadas_dentro_del_cuadro(self):
        """Las cajas de las pistas quedan dentro del cuadro (son las que dibuja el HUD)."""
        h, w = self.frame.shape[:2]
        for roi in self.pipeline.detect_and_track(self.frame):
            x1, y1, x2, y2 = roi.plate_bbox
            self.assertTrue(0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h, roi.plate_bbox)

    def test_ecuador_plate_validation_and_consensus(self):
        """Verifica la validación oficial de placas ANT Ecuador y el consenso ponderado."""
        self.assertTrue(is_valid_ecuador_plate("PSY589"))
        self.assertTrue(is_valid_ecuador_plate("PBA1234"))
        self.assertTrue(is_valid_ecuador_plate("PB1234"))
        self.assertFalse(is_valid_ecuador_plate("NOTAPLATE12345"))
        self.assertFalse(is_valid_ecuador_plate("123"))

        # El consenso ponderado debe preferir lecturas válidas
        tid = 42
        self.pipeline.update_track_plate(tid, "PSY0589", confidence=0.90)
        self.pipeline.update_track_plate(tid, "PSY0589", confidence=0.88)
        # Ruido de OCR no debe desplazar al ganador
        self.pipeline.update_track_plate(tid, "RU1D0", confidence=0.30)

        info = self.pipeline.get_track_info(tid)
        self.assertEqual(info.get("plate"), "PSY0589")

    def test_clear_all_tracks(self):
        """Verifica que clear_all_tracks reinicie toda la memoria de tracking y consenso."""
        self.pipeline.detect_and_track(self.frame)
        self.pipeline.update_track_plate(1, "PBA1234", 0.9)

        self.pipeline.clear_all_tracks()
        self.assertEqual(len(self.pipeline._trackers), 0)
        self.assertEqual(self.pipeline.get_track_info(1), {})

    def test_pista_leida_muestra_la_placa_y_luego_el_estado_del_backend(self):
        tid = self.pipeline.detect_and_track(self.frame)[0].tracking_id
        self.pipeline.update_track_plate(tid, "PBA1234", 0.95, "leida")
        self.pipeline.detect_and_track(self.frame)
        ov = self.pipeline._current_overlays[0]
        self.assertEqual(ov.placa, "PBA1234")
        self.assertTrue(ov.label.startswith("PBA-1234"), ov.label)
        self.assertEqual(ov.color, _COLOR_LEIDA)

        self.pipeline.fijar_estado_backend(tid, "alerta")
        self.pipeline.detect_and_track(self.frame)
        ov = self.pipeline._current_overlays[0]
        self.assertEqual((ov.estado, ov.label), ("alerta", "PBA-1234  ALERTA"))


if __name__ == "__main__":
    unittest.main()
