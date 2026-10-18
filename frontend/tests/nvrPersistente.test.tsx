import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const { get, puede, user } = vi.hoisted(() => ({ get: vi.fn(), puede: vi.fn(() => true), user: { id: 1 } }));

vi.mock('../src/infraestructura/api', () => ({
  default: { get, post: vi.fn() },
  mensajeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../src/aplicacion/AuthContext', () => ({
  useAuth: () => ({ user, puede }),
}));
vi.mock('../src/aplicacion/tiempoReal', () => ({
  useEvento: () => undefined,
  useReconexion: () => undefined,
}));
vi.mock('../src/interfaz/componentes/envivo', async () => {
  const React = await import('react');
  return {
    VisorEnVivo: ({ camaraId }: { camaraId: number }) => React.createElement('div', { 'data-testid': `video-${camaraId}` }),
    ReproductorWebRTC: () => null,
  };
});

import { NvrDockProvider } from '../src/interfaz/componentes/NvrDock';

const NavegacionPrueba = () => {
  const navegar = useNavigate();
  return <button onClick={() => navegar('/inicio')}>Cambiar módulo</button>;
};

describe('mini reproductor NVR persistente', () => {
  beforeEach(() => {
    localStorage.setItem('anpr_nvr_slots_v1', JSON.stringify([3, null, null, null]));
    localStorage.removeItem('anpr_nvr_dock_open');
    get.mockImplementation((ruta: string) => Promise.resolve({
      data: ruta === '/camaras'
        ? [{ id: 3, nombre: 'Acceso principal', activa: true, direccion: 'ingreso', rtsp_url_vista: null }]
        : { camara_activa: { id: 3 } },
    }));
  });

  afterEach(() => {
    get.mockReset();
    localStorage.clear();
  });

  it('mantiene el video montado al navegar entre módulos', async () => {
    render(
      <MemoryRouter initialEntries={['/monitoreo']}>
        <NvrDockProvider>
          <Routes>
            <Route path="/monitoreo" element={<NavegacionPrueba />} />
            <Route path="/inicio" element={<span>Inicio del sistema</span>} />
          </Routes>
        </NvrDockProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('video-3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar módulo' }));
    expect(await screen.findByText('Inicio del sistema')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('video-3')).toBeInTheDocument());
  });

  it('conserva el flujo montado cuando se contrae el dock', async () => {
    render(
      <MemoryRouter initialEntries={['/monitoreo']}>
        <NvrDockProvider><span>Monitoreo</span></NvrDockProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('video-3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Contraer reproductor NVR' }));
    expect(screen.getByTestId('video-3')).toBeInTheDocument();
  });
});
