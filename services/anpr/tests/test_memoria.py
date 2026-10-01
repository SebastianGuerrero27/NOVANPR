"""Registros en memoria del servicio: la purga evita la fuga de memoria en operación 24/7."""

from app.utils.memoria import purgar_expirados


def test_purga_solo_entradas_vencidas():
    registro = {1: 99.0, 2: 150.0, 3: 169.0, "ABC1234": 10.0}
    eliminadas = purgar_expirados(registro, ahora=170.0, horizonte_s=70.0)
    assert eliminadas == 2
    assert registro == {2: 150.0, 3: 169.0}


def test_horizonte_es_exclusivo_y_registro_vacio():
    registro = {1: 100.0}
    assert purgar_expirados(registro, ahora=170.0, horizonte_s=70.0) == 0
    assert registro == {1: 100.0}
    assert purgar_expirados({}, ahora=1.0, horizonte_s=1.0) == 0


def test_crecimiento_acotado_con_tracks_monotonicos():
    registro: dict[int, float] = {}
    for t in range(10_000):  # un track nuevo por segundo durante ~2,8 h
        registro[t] = float(t)
        purgar_expirados(registro, ahora=float(t), horizonte_s=70.0)
    assert len(registro) <= 71
