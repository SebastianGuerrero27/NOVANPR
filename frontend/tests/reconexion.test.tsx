/**
 * Resincronización tras una caída de Socket.IO: la pantalla vuelve a consultar la API solo por las
 * reconexiones ocurridas mientras está abierta (al montarse ya pide sus datos).
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TiempoRealContext, useReconexion } from '../src/aplicacion/tiempoReal';

const Pantalla = ({ alReconectar }: { alReconectar: () => void }) => {
  useReconexion(alReconectar);
  return null;
};

const conReconexiones = (n: number, alReconectar: () => void) => (
  <TiempoRealContext.Provider value={{ socket: null, conectado: true, reconexiones: n }}>
    <Pantalla alReconectar={alReconectar} />
  </TiempoRealContext.Provider>
);

describe('useReconexion', () => {
  it('no recarga al montarse, aunque antes hubo reconexiones (evita pedir los datos dos veces)', () => {
    const recargar = vi.fn();
    render(conReconexiones(3, recargar));
    expect(recargar).not.toHaveBeenCalled();
  });

  it('recarga una vez por cada reconexión ocurrida con la pantalla abierta, con el manejador vigente', () => {
    const primero = vi.fn();
    const vigente = vi.fn();
    const { rerender } = render(conReconexiones(0, primero));
    rerender(conReconexiones(0, vigente));
    expect(vigente).not.toHaveBeenCalled();
    rerender(conReconexiones(1, vigente));
    rerender(conReconexiones(1, vigente));
    rerender(conReconexiones(2, vigente));
    expect(vigente).toHaveBeenCalledTimes(2);
    expect(primero).not.toHaveBeenCalled();
  });
});
