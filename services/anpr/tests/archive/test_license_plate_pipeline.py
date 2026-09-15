"""
Suite de pruebas unitarias para LicensePlatePipeline y sus componentes modulares.
Compatible con unittest y pytest.
"""

import unittest
import numpy as np

from app.core.config_schemas import RunConfig
from app.core.detectors import MockDetector
from app.core.hud import PlateHudState
from app.core.license_plate_pipeline import (
    ALPR_MODE_DETECT,
    ALPR_MODE_FULL,
    OCR_CACHE_FRAME,
    OCR_CACHE_ONCE,
    PLATE_SCOPE_FULL,
    PLATE_SCOPE_VEHICLE,
    LicensePlatePipeline,
)
from app.core.models import Detection, PipelineResult, PlateReading
from app.core.ocr_backends import MockOCREngine
from app.core.trackers import TeachingTracker
from app.core.visualizer import ALPRVisualizer


class TestLicensePlatePipeline(unittest.TestCase):
    def setUp(self):
        self.dummy_frame = np.full((480, 640, 3), 40, dtype=np.uint8)
        self.veh_det = MockDetector([
            Detection(bbox=[100, 100, 400, 350], confidence=0.92, class_name="car"),
        ])
        self.plate_det = MockDetector([
            Detection(bbox=[50, 150, 200, 200], confidence=0.88, class_name="plate"),
        ])
        self.ocr_engine = MockOCREngine(return_text="PBX1234", return_confidence=0.96)
        self.tracker = TeachingTracker(min_hits=1)

    def test_pipeline_initialization(self):
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_FULL,
        )
        self.assertEqual(pipeline.mode, ALPR_MODE_FULL)
        self.assertEqual(pipeline.ocr_cache, OCR_CACHE_ONCE)

    def test_pipeline_from_config(self):
        cfg_dict = {
            "model": "models/license_plate_detector.pt",
            "confidence": 0.40,
            "device": "cpu",
            "alpr": {
                "mode": "detect",
                "ocr_cache": "once",
                "plate_model": "models/license_plate_detector.pt",
                "plate_detector_type": "mock",
                "ocr_engine": "paddle",
                "detection_zone": [[50, 50], [600, 50], [600, 450], [50, 450]],
            },
            "extra": {
                "detector": {"type": "mock"}
            }
        }
        run_cfg = RunConfig.from_dict(cfg_dict)
        self.assertEqual(run_cfg.alpr.mode, "detect")
        self.assertEqual(run_cfg.confidence, 0.40)

        pipeline = LicensePlatePipeline.from_config(run_cfg)
        self.assertEqual(pipeline.mode, "detect")
        self.assertIsNotNone(pipeline.detection_zone)
        self.assertEqual(len(pipeline.detection_zone), 4)

    def test_pipeline_detect_only_mode(self):
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_DETECT,
        )
        res = pipeline.process_frame(self.dummy_frame)
        self.assertIsInstance(res, PipelineResult)
        self.assertIsNotNone(res.annotated_frame)
        self.assertEqual(res.annotated_frame.shape, self.dummy_frame.shape)
        self.assertEqual(len(res.vehicles), 1)
        self.assertGreaterEqual(len(res.plates), 1)
        self.assertGreater(res.latency_ms, 0)

    def test_pipeline_full_mode_with_tracking_and_ocr(self):
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_FULL,
            plate_scope=PLATE_SCOPE_VEHICLE,
            ocr_cache=OCR_CACHE_ONCE,
        )

        res1 = pipeline.process_frame(self.dummy_frame)
        self.assertIsInstance(res1, PipelineResult)
        self.assertGreaterEqual(len(res1.tracks), 1)
        self.assertGreaterEqual(len(res1.readings), 1)
        reading = res1.readings[0]
        self.assertEqual(reading.text, "PBX-1234")
        self.assertEqual(reading.raw_text, "PBX1234")
        self.assertTrue(reading.is_valid)
        self.assertEqual(reading.province, "Pichincha")

        # Validar tarjeta generada en el HUD
        self.assertGreaterEqual(len(res1.active_cards), 1)
        card = res1.active_cards[0]
        self.assertEqual(card.plate_text, "PBX-1234")
        self.assertEqual(card.province, "Pichincha")

    def test_pipeline_ocr_cache_once_vs_frame(self):
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_FULL,
            ocr_cache=OCR_CACHE_ONCE,
        )

        pipeline.process_frame(self.dummy_frame)
        self.assertEqual(len(pipeline.hud_state.readings), 1)

        # Cambiar retorno del OCR para verificar que no se sobreescribe
        self.ocr_engine.return_text = "XYZ9999"
        res2 = pipeline.process_frame(self.dummy_frame)
        self.assertEqual(res2.readings[0].text, "PBX-1234")

        # Probar con OCR_CACHE_FRAME
        pipeline.ocr_cache = OCR_CACHE_FRAME
        res3 = pipeline.process_frame(self.dummy_frame)
        self.assertEqual(res3.readings[0].text, "XYZ-9999")

    def test_pipeline_detection_zone_filter(self):
        far_zone = [(500, 500), (600, 500), (600, 600), (500, 600)]
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_FULL,
            detection_zone=far_zone,
        )
        res = pipeline.process_frame(self.dummy_frame)
        self.assertEqual(len(res.tracks), 0)

    def test_pipeline_reset_state(self):
        pipeline = LicensePlatePipeline(
            vehicle_detector=self.veh_det,
            plate_detector=self.plate_det,
            tracker=self.tracker,
            ocr_backend=self.ocr_engine,
            mode=ALPR_MODE_FULL,
        )
        pipeline.process_frame(self.dummy_frame)
        self.assertGreater(len(pipeline.hud_state.readings), 0)

        pipeline.reset_state()
        self.assertEqual(len(pipeline.hud_state.readings), 0)
        self.assertEqual(len(pipeline.hud_state.cards), 0)
        self.assertEqual(len(pipeline._frame_plate_bboxes), 0)

    def test_visualizer_rendering(self):
        vis = ALPRVisualizer()
        frame = self.dummy_frame.copy()

        dets = [Detection(bbox=[50, 50, 200, 150], confidence=0.85, class_name="car")]
        frame = vis.draw_detections(frame, dets)
        frame = vis.draw_status_hud(frame, fps=30.0, active_tracks=2, mode="FULL")

        state = PlateHudState()
        state.store_reading(1, PlateReading(text="ABC1234", confidence=0.95, plate_bbox=[50, 50, 100, 80], province="Azuay"))
        frame = vis.draw_plate_hud(frame, state.cards)

        self.assertIsNotNone(frame)
        self.assertEqual(frame.shape, self.dummy_frame.shape)


if __name__ == "__main__":
    unittest.main()
