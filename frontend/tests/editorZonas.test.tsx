/**
 * Editor de zonas de la cámara: área de detección y zonas de exclusión dibujadas sobre el video,
 * con la misma validación que la API y lo que se envía al guardar.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Camara } from '../src/dominio/tipos';

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock('../src/infraestructura/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put, delete: vi.fn() },
  mensajeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
// Sin WebRTC en jsdom: la capa de dibujo se monta directamente
vi.mock('../src/interfaz/componentes/envivo', () => ({
  ReproductorWebRTC: ({ capa }: { capa: React.ReactNode }) => <div style={{ position: 'relative' }}>{capa}</div>,
}));

import { EditorRoi, errorZonas } from '../src/interfaz/componentes/EditorRoi';

const CAMARA: Camara = {
  id: 3, nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', ip: '192.0.2.10',
  rtsp_url: 'rtsp://admin:******@192.0.2.10:554/Streaming/Channels/101', rtsp_url_vista: null, tiene_credenciales: true,
  activa: true, estado: 'EN_LINEA', ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null, created_at: '2026-10-09T10:00:00Z',
  roi: null, exclusiones: [],
};

/** Clic sobre el video en px de una superficie de 200×100 */
const pulsar = (x: number, y: number) => act(() => {
  screen.getByTestId('superficie-zonas').dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
});

describe('Editor de zonas', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, x: 0, y: 0, right: 200, bottom: 100, toJSON: () => ({}) } as DOMRect);
    put.mockResolvedValue({ data: { camera: CAMARA } });
  });
  afterEach(() => { vi.restoreAllMocks(); put.mockReset(); });

  it('validación previa: área de 3+ vértices o vacía; zonas completas (las vacías se ignoran)', () => {
    expect(errorZonas([], [])).toBeNull();
    expect(errorZonas([[0, 0], [1, 0]], [])).toMatch(/área de detección necesita al menos 3 vértices/);
    expect(errorZonas([], [[[0, 0], [1, 0], [1, 1]], [], [[0, 0]]])).toBe('Complete la zona de exclusión 3 (mínimo 3 vértices) o bórrela.');
  });

  it('dibuja una zona de exclusión y la guarda junto al área (normalizada 0–1)', async () => {
    const guardada = vi.fn();
    render(<EditorRoi camara={CAMARA} onCerrar={() => undefined} onGuardada={guardada} />);
    fireEvent.click(screen.getByRole('button', { name: /Zonas de exclusión/ }));
    pulsar(140, 0);
    pulsar(200, 0);
    pulsar(200, 20);
    expect(screen.getByRole('button', { name: 'Zona 1 · 3 vértices' })).toBeInTheDocument();
    expect(screen.getByTestId('zona-exclusion-1')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Guardar zonas/ })); });
    expect(put).toHaveBeenCalledWith('/camaras/3/roi', { roi: null, exclusiones: [[[0.7, 0], [1, 0], [1, 0.2]]] });
    expect(guardada).toHaveBeenCalledWith(CAMARA);
  });

  it('una zona incompleta no se guarda y se explica por qué', async () => {
    render(<EditorRoi camara={CAMARA} onCerrar={() => undefined} onGuardada={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Zonas de exclusión/ }));
    pulsar(20, 20);
    pulsar(60, 20);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Guardar zonas/ })); });
    expect(screen.getByText('Complete la zona de exclusión 1 (mínimo 3 vértices) o bórrela.')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();
  });

  it('carga las zonas guardadas, permite borrarlas y una nueva zona empieza con el siguiente clic', async () => {
    const conZonas = { ...CAMARA, roi: [[0, 0.2], [1, 0.2], [1, 1], [0, 1]] as [number, number][], exclusiones: [[[0.7, 0], [1, 0], [1, 0.2]]] as [number, number][][] };
    render(<EditorRoi camara={conZonas} onCerrar={() => undefined} onGuardada={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Zonas de exclusión \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Borrar zona 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Nueva zona/ }));
    pulsar(0, 80);
    pulsar(60, 80);
    pulsar(60, 100);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Guardar zonas/ })); });
    expect(put).toHaveBeenCalledWith('/camaras/3/roi', {
      roi: [[0, 0.2], [1, 0.2], [1, 1], [0, 1]],
      exclusiones: [[[0, 0.8], [0.3, 0.8], [0.3, 1]]],
    });
  });

  it('el área de detección se dibuja en su modo y se puede borrar para usar el cuadro completo', async () => {
    render(<EditorRoi camara={{ ...CAMARA, roi: [[0, 0], [1, 0], [1, 1]] }} onCerrar={() => undefined} onGuardada={() => undefined} />);
    expect(screen.getByText('3 vértices')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Borrar área/ }));
    expect(screen.getByText('Sin área: se analiza el cuadro completo.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Guardar zonas/ })); });
    expect(put).toHaveBeenCalledWith('/camaras/3/roi', { roi: null, exclusiones: [] });
  });
});
