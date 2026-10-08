"""
Pruebas Unitarias para DetectionPipeline con Inyección de Dependencias (MockDetector).
Verifica:
1. Inyección de MockDetector (cero dependencia de GPU o archivos .pt).
2. Seguimiento ByteTrack y Kalman en detect_and_track.
3. Detección rápida y tracking aislado en detect_fast.
4. Aislamiento estricto de namespaces de placas (RTSP vs Browser).
5. Consenso temporal ponderado de placas ecuatorianas ANT.
6. Limpieza de memoria (clear_all_tracks).
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
    normalize_plate_text,
)


class TestDetectionPipelineDI(unittest.TestCase):
    def setUp(self):
        # Frame dummy (480x640 BGR)
        self.frame = np.full((480, 640, 3), 128, dtype=np.uint8)

        # Mock detections: placa con aspecto ratio válido para Ecuador (bw=120, bh=40 -> AR=3.0)
        self.mock_det = MockDetector([
            Detection(bbox=[100.0, 150.0, 220.0, 190.0], confidence=0.88, class_name="plate")
        ])
        self.browser_mock_det = MockDetector([
            Detection(bbox=[105.0, 152.0, 222.0, 191.0], confidence=0.85, class_name="plate")
        ])

        # Pipeline instanciado mediante Inyección de Dependencias
        self.pipeline = DetectionPipeline(
            detector=self.mock_det,
            browser_detector=self.browser_mock_det,
        )

    def test_dependency_injection_instantiation(self):
        """Verifica que el pipeline se inicializa con los detectores inyectados sin tocar disco ni GPU."""
        self.assertIs(self.pipeline.detector, self.mock_det)
        self.assertIs(self.pipeline.browser_detector, self.browser_mock_det)
        self.assertEqual(len(self.pipeline._trackers), 0)
        self.assertEqual(len(self.pipeline._browser_trackers), 0)

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

    def test_detect_fast_with_browser_mock(self):
        """Verifica que detect_fast usa el detector de browser y rastreadores aislados."""
        rois = self.pipeline.detect_fast(self.frame)
        self.assertIsInstance(rois, list)
        self.assertGreaterEqual(len(rois), 1)
        self.assertGreaterEqual(rois[0].confidence, 0.18)

    def test_namespace_isolation_rtsp_vs_browser(self):
        """
        Verifica que las lecturas OCR de RTSP y Browser estén 100% aisladas,
        evitando el bug de etiquetas desplazadas por colisión de tracking_id.
        """
        tid = 99
        # Actualizar en RTSP
        self.pipeline.update_track_plate(tid, "PBA1234", confidence=0.95, status="autorizado")

        # RTSP debe tener la placa
        rtsp_info = self.pipeline.get_track_info(tid)
        self.assertEqual(rtsp_info.get("plate"), "PBA1234")
        self.assertEqual(rtsp_info.get("status"), "autorizado")

        # Browser NO debe tener esa placa
        browser_info = self.pipeline.get_browser_track_info(tid)
        self.assertEqual(browser_info.get("plate", ""), "")

        # Ahora registrar en Browser una placa diferente para el mismo tid
        self.pipeline.update_browser_track_plate(tid, "PSY0589", confidence=0.92, status="alerta")

        # Ambos namespaces deben mantener sus valores independientes
        self.assertEqual(self.pipeline.get_track_info(tid).get("plate"), "PBA1234")
        self.assertEqual(self.pipeline.get_browser_track_info(tid).get("plate"), "PSY0589")

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
        """Verifica que clear_all_tracks reinicie toda la memoria de tracking y namespaces."""
        self.pipeline.detect_and_track(self.frame)
        self.pipeline.detect_fast(self.frame)
        self.pipeline.update_track_plate(1, "PBA1234", 0.9)
        self.pipeline.update_browser_track_plate(1, "PSY0589", 0.9)

        self.pipeline.clear_all_tracks()
        self.assertEqual(len(self.pipeline._trackers), 0)
        self.assertEqual(len(self.pipeline._browser_trackers), 0)
        self.assertEqual(self.pipeline.get_track_info(1), {})
        self.assertEqual(self.pipeline.get_browser_track_info(1), {})

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
