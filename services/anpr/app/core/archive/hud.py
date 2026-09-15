"""
Gestión de Estado y Estructuras del Panel HUD para ANPR.
Mantiene las lecturas activas y la pila de tarjetas informativas.
"""

from __future__ import annotations

import time
from typing import Dict, List, Optional, Union
from app.core.models import PlateHudCard, PlateReading
from app.utils.logger import get_logger

logger = get_logger("hud")


class PlateHudState:
    """Mantiene el estado en memoria de las lecturas y tarjetas flotantes del HUD."""

    def __init__(self, max_cards: int = 6) -> None:
        self.max_cards = max_cards
        self.readings: dict[int | str, PlateReading] = {}
        self.cards: list[PlateHudCard] = []

    def has_reading(self, key: int | str) -> bool:
        """Verifica si ya existe una lectura almacenada para un track_id o clave de bbox."""
        return key in self.readings

    def get_reading(self, key: int | str) -> Optional[PlateReading]:
        return self.readings.get(key)

    def store_reading(
        self,
        key: int | str,
        reading: PlateReading,
        *,
        overwrite: bool = False,
        status: str = "normal",
        notes: str = "",
    ) -> None:
        """Almacena o actualiza una lectura y genera/actualiza su tarjeta en el HUD."""
        if not overwrite and key in self.readings:
            return

        self.readings[key] = reading

        # Determinar estado
        card_status = status
        if not reading.is_valid:
            card_status = "warning"

        card = PlateHudCard(
            track_id=key,
            plate_text=reading.text,
            confidence=reading.confidence,
            crop_image=reading.crop_image,
            timestamp=reading.timestamp,
            status=card_status,
            is_valid=reading.is_valid,
            vehicle_type=reading.vehicle_type,
            province=reading.province,
            service_type=reading.service_type,
            notes=notes,
        )

        # Actualizar si ya existe la tarjeta para este ID
        existing_idx = next((i for i, c in enumerate(self.cards) if str(c.track_id) == str(key)), -1)
        if existing_idx >= 0:
            self.cards[existing_idx] = card
        else:
            self.cards.insert(0, card)
            if len(self.cards) > self.max_cards:
                self.cards.pop()

    def set_frame_readings(self, readings: list[PlateReading]) -> None:
        """Reemplaza todas las lecturas del frame actual (modo frame-by-frame)."""
        self.readings.clear()
        self.cards.clear()
        for idx, r in enumerate(readings):
            key = r.track_id if r.track_id is not None else f"det_{idx}"
            self.store_reading(key, r, overwrite=True)

    def clear(self) -> None:
        """Limpia todo el estado del HUD."""
        self.readings.clear()
        self.cards.clear()
