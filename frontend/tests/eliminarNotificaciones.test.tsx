/**
 * Quitar notificaciones de la bandeja (como en vigilance-heart): solo las revisadas tienen papelera
 * y "Limpiar revisadas" pide confirmación antes de quitarlas todas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Notificacion } from '../src/dominio/tipos';

const { centro, notificar } = vi.hoisted(() => ({
  centro: {
    items: [] as unknown[], noLeidas: 0, pendientes: 0, revisadas: 0,
    marcarLeida: vi.fn().mockResolvedValue(undefined), marcarTodas: vi.fn(), reconocer: vi.fn(),
    eliminar: vi.fn().mockResolvedValue(undefined),
    eliminarRevisadas: vi.fn().mockResolvedValue('Se eliminaron 3 notificaciones revisadas. Las alarmas pendientes siguen en la bandeja.'),
  },
  notificar: vi.fn(),
}));
vi.mock('../src/aplicacion/notificaciones', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/aplicacion/notificaciones')>()),
  useCentroNotificaciones: () => centro,
}));
vi.mock('../src/interfaz/componentes/Notificaciones', () => ({ useNotificar: () => notificar }));

import { CampanaNotificaciones, ItemNotificacion } from '../src/interfaz/componentes/CentroNotificaciones';

const notificacion = (cambios: Partial<Notificacion>): Notificacion => ({
  id: 1, tipo: 'acceso.autorizado', severidad: 'baja', titulo: 'Ingreso autorizado', mensaje: 'PBA-1234 · Garita', enlace: null, datos: null,
  repeticiones: 1, requiere_ack: false, fecha_creacion: '2026-10-13T12:00:00Z', fecha_ultima: '2026-10-13T12:00:00Z',
  leida: true, atendida: null, resuelta: false, escalada: false, ...cambios,
});

const enRouter = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('Quitar notificaciones de la bandeja', () => {
  afterEach(() => vi.clearAllMocks());

  it('solo una notificación revisada (leída y sin alarma pendiente) tiene papelera', async () => {
    enRouter(<>
      <ItemNotificacion n={notificacion({ id: 1, titulo: 'Sin leer', leida: false })} />
      <ItemNotificacion n={notificacion({ id: 2, titulo: 'Alarma pendiente', requiere_ack: true, severidad: 'alta' })} />
      <ItemNotificacion n={notificacion({ id: 3, titulo: 'Revisada' })} />
      <ItemNotificacion n={notificacion({ id: 4, titulo: 'Alarma atendida', requiere_ack: true, atendida: { usuario: null, fecha: '2026-10-13T12:01:00Z' } })} />
    </>);
    const papeleras = screen.getAllByTitle('Eliminar notificación revisada');
    expect(papeleras.map(b => b.getAttribute('aria-label'))).toEqual([
      'Eliminar notificación revisada: Revisada', 'Eliminar notificación revisada: Alarma atendida',
    ]);
    await act(async () => { fireEvent.click(papeleras[0]); });
    expect(centro.eliminar).toHaveBeenCalledWith(3);
    expect(centro.marcarLeida).not.toHaveBeenCalled();   // el clic no abre la notificación
  });

  it('si el servidor la rechaza (p. ej. la alarma volvió a quedar pendiente), se informa el motivo', async () => {
    centro.eliminar.mockRejectedValueOnce(new Error('Esta alarma está pendiente de atención.'));
    enRouter(<ItemNotificacion n={notificacion({ id: 5 })} />);
    await act(async () => { fireEvent.click(screen.getByTitle('Eliminar notificación revisada')); });
    expect(notificar).toHaveBeenCalledWith('error', 'No se pudo eliminar la notificación', expect.any(String));
  });

  it('"Limpiar revisadas" de la campana pide confirmación y luego las quita', async () => {
    Object.assign(centro, { items: [notificacion({ id: 3 })], noLeidas: 0, pendientes: 1, revisadas: 3 });
    enRouter(<CampanaNotificaciones />);
    fireEvent.click(screen.getByRole('button', { name: /Notificaciones/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar revisadas (3)' }));
    expect(centro.eliminarRevisadas).not.toHaveBeenCalled();
    expect(screen.getByText(/Las alarmas pendientes de atención y las no leídas se conservan/)).toBeTruthy();
    // La confirmación se dibuja en el <body>, no dentro del encabezado (su backdrop-filter la recortaba)
    expect(document.querySelector('.modal-fondo')?.parentElement).toBe(document.body);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Sí, limpiar revisadas/ })); });
    expect(centro.eliminarRevisadas).toHaveBeenCalledTimes(1);
    expect(notificar).toHaveBeenCalledWith('exito', 'Se eliminaron 3 notificaciones revisadas. Las alarmas pendientes siguen en la bandeja.');
  });

  it('sin notificaciones revisadas no se ofrece limpiar', () => {
    Object.assign(centro, { items: [notificacion({ id: 1, leida: false })], noLeidas: 1, pendientes: 0, revisadas: 0 });
    enRouter(<CampanaNotificaciones />);
    fireEvent.click(screen.getByRole('button', { name: /Notificaciones/ }));
    expect(screen.queryByRole('button', { name: /Limpiar revisadas/ })).toBeNull();
  });
});
