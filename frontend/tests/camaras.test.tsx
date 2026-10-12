/**
 * Página de cámaras: estados de carga, sin cámaras (con la acción de registrar), error de la API
 * y listado sin credenciales a la vista.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/infraestructura/api', () => ({
  default: { get, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  mensajeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import Camaras from '../src/interfaz/paginas/Camaras';

const responder = (camaras: Promise<unknown>) => {
  get.mockImplementation((ruta: string) => (ruta === '/camaras' ? camaras : Promise.resolve({ data: { en_linea: false } })));
};
const pagina = () => render(<MemoryRouter><Camaras /></MemoryRouter>);

describe('Página de cámaras', () => {
  afterEach(() => get.mockReset());

  it('mientras carga muestra un esqueleto, no una lista vacía ni datos de ejemplo', () => {
    responder(new Promise(() => undefined));
    const { container } = pagina();
    expect(container.querySelector('.esqueleto')).not.toBeNull();
    expect(screen.queryByText('Aún no hay cámaras')).toBeNull();
  });

  it('sin cámaras registradas: estado vacío con la acción de registrar', async () => {
    responder(Promise.resolve({ data: [] }));
    pagina();
    expect(await screen.findByText('Aún no hay cámaras')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Registrar cámara/ })).toHaveLength(2);
  });

  it('si la API falla muestra el error', async () => {
    responder(Promise.reject(new Error('Error al listar las cámaras.')));
    pagina();
    expect(await screen.findByText('Error al listar las cámaras.')).toBeInTheDocument();
  });

  it('el listado muestra la URL con la contraseña enmascarada tal como la entrega la API', async () => {
    responder(Promise.resolve({ data: [{
      id: 3, nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', ip: '192.0.2.10',
      rtsp_url: 'rtsp://admin:******@192.0.2.10:554/Streaming/Channels/101', rtsp_url_vista: null, tiene_credenciales: true,
      activa: true, estado: 'EN_LINEA', ultimo_ping: null, tiempo_respuesta_ms: 12, mensaje_ping: 'Flujo de video disponible',
      created_at: '2026-10-09T10:00:00Z', detecciones: 0, roi: null,
    }] }));
    pagina();
    expect(await screen.findByText('Garita norte')).toBeInTheDocument();
    expect(screen.getByText(/admin:\*{6}@192\.0\.2\.10/)).toBeInTheDocument();
  });
});
