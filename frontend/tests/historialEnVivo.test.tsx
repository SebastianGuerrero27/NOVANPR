/**
 * Historial en vivo: un ingreso eliminado o consolidado con su paso previo (deteccion:eliminada)
 * solo descuenta el total si se estaba mostrando, y sale del aviso de nuevos si se había anunciado.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { TiempoRealContext } from '../src/aplicacion/tiempoReal';

const { get } = vi.hoisted(() => ({
  get: vi.fn((url: string) => Promise.resolve({
    data: url === '/camaras' ? [] : {
      items: [{ id: 1, placa: 'PBA-1234', fecha_hora_ingreso: '2026-10-12T15:00:00Z', estado_validacion: 'autorizado',
        estado_procesamiento: 'procesado', fuente: 'rtsp', camara: null, confianza_ocr: 0.95, validado_manualmente: false,
        vehiculo: { marca: null, modelo: null, color: null }, tipo_vehiculo: null }],
      total: 1, pagina: 1, tamano: 25,
    },
  })),
}));
vi.mock('../src/infraestructura/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/infraestructura/api')>()),
  default: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../src/aplicacion/AuthContext', () => ({ useAuth: () => ({ puede: () => false }) }));
vi.mock('../src/interfaz/componentes/Notificaciones', () => ({ useNotificar: () => vi.fn() }));

import Detecciones from '../src/interfaz/paginas/Detecciones';

/** Socket.IO de prueba: guarda los manejadores para emitir eventos del servidor */
function socketDePrueba() {
  const manejadores = new Map<string, (d: unknown) => void>();
  const socket = {
    on: (evento: string, fn: (d: unknown) => void) => { manejadores.set(evento, fn); },
    off: (evento: string) => { manejadores.delete(evento); },
  } as unknown as Socket;
  const emitir = (evento: string, datos: unknown) => act(() => { manejadores.get(evento)?.(datos); });
  return { socket, emitir };
}

describe('Historial de ingresos en vivo', () => {
  it('un ingreso anunciado que se consolida sale del aviso sin descontar el total; uno visible sí lo descuenta', async () => {
    const { socket, emitir } = socketDePrueba();
    render(
      <MemoryRouter>
        <TiempoRealContext.Provider value={{ socket, conectado: true, reconexiones: 0 }}>
          <Detecciones />
        </TiempoRealContext.Provider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('1 registros')).toBeTruthy();

    emitir('deteccion:nueva', { id: 50 });
    emitir('deteccion:nueva', { id: 51 });
    expect(screen.getByText('Se registraron 2 ingresos nuevos.')).toBeTruthy();

    // El motor consolidó el ingreso 50 con su paso previo: nunca estuvo en la tabla ni en el total
    emitir('deteccion:eliminada', { id: 50 });
    expect(screen.getByText('Se registró 1 ingreso nuevo.')).toBeTruthy();
    expect(screen.getByText('1 registros')).toBeTruthy();

    // Uno que no se mostraba ni se anunció (otra página u otro filtro) no altera nada
    emitir('deteccion:eliminada', { id: 999 });
    expect(screen.getByText('1 registros')).toBeTruthy();

    // La fila visible eliminada sale de la tabla y del total
    emitir('deteccion:eliminada', { id: 1 });
    expect(screen.getByText('0 registros')).toBeTruthy();
    expect(screen.queryByText('PBA-1234')).toBeNull();
  });
});
