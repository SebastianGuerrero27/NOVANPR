/**
 * Formulario de cámara: solo equipos IP (sin webcam ni celulares), enlace RTSP armado con la
 * contraseña codificada y enmascarada en pantalla, flujo secundario derivado y validaciones.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../src/infraestructura/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  mensajeError: (e: unknown) => String(e),
}));

import { FormularioCamara, rutaSecundaria } from '../src/interfaz/componentes/FormularioCamara';
import type { Camara } from '../src/dominio/tipos';

const escribir = (etiqueta: RegExp, valor: string) => {
  const campo = screen.getByLabelText(etiqueta);
  fireEvent.change(campo, { target: { value: valor } });
  fireEvent.blur(campo);
};

describe('Formulario de cámara', () => {
  it('ofrece solo cámaras IP: sin webcam ni celulares', () => {
    render(<FormularioCamara onCerrar={() => undefined} onGuardada={() => undefined} />);
    const tipos = Array.from((screen.getByLabelText('Tipo de equipo') as HTMLSelectElement).options).map(o => o.textContent);
    expect(tipos).toEqual(['Cámara Hikvision', 'Cámara Dahua / Imou', 'Cámara IP genérica (ONVIF / RTSP)', 'Escribir la URL completa (avanzado)']);
    expect(document.body.textContent).not.toMatch(/webcam|celular/i);
  });

  it('arma el enlace principal y el secundario; la contraseña nunca aparece en pantalla', () => {
    render(<FormularioCamara onCerrar={() => undefined} onGuardada={() => undefined} />);
    escribir(/IP o nombre del equipo/, '192.0.2.10');
    escribir(/^Usuario/, 'admin');
    escribir(/^Contraseña/, 'Ecu911@Garita#26');
    expect(screen.getByText('rtsp://admin:******@192.0.2.10:554/Streaming/Channels/101')).toBeInTheDocument();
    expect(screen.getByText('rtsp://admin:******@192.0.2.10:554/Streaming/Channels/102')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Ecu911');
  });

  it('una IP inválida muestra el error y no permite guardar', () => {
    render(<FormularioCamara onCerrar={() => undefined} onGuardada={() => undefined} />);
    escribir(/^Nombre/, 'Garita norte');
    escribir(/^Ubicación/, 'Acceso vehicular norte');
    escribir(/IP o nombre del equipo/, '999.1.1.1');
    escribir(/^Usuario/, 'admin');
    escribir(/^Contraseña/, 'Clave#2026');
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    escribir(/IP o nombre del equipo/, '192.0.2.10');
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled();
  });

  it('al editar, si cambia la IP pide escribir de nuevo la contraseña (la guardada solo vale para el mismo equipo)', () => {
    const camara: Camara = {
      id: 3, nombre: 'Garita norte', ubicacion: 'Acceso vehicular norte', ip: '192.0.2.10',
      direccion: 'ingreso',
      rtsp_url: 'rtsp://admin:******@192.0.2.10:554/Streaming/Channels/101',
      rtsp_url_vista: 'rtsp://admin:******@192.0.2.10:554/Streaming/Channels/102', tiene_credenciales: true,
      activa: true, estado: 'EN_LINEA', ultimo_ping: null, tiempo_respuesta_ms: null, mensaje_ping: null, created_at: '2026-10-09T10:00:00Z', roi: null,
    };
    render(<FormularioCamara camara={camara} onCerrar={() => undefined} onGuardada={() => undefined} />);
    // Mismo equipo: la contraseña guardada se conserva (viaja enmascarada)
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled();
    escribir(/IP o nombre del equipo/, '192.0.2.20');
    expect(screen.getByText('Cambió la IP o el puerto: escriba de nuevo la contraseña.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    escribir(/^Contraseña/, 'Nueva#2026');
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled();
    expect(screen.getByText('rtsp://admin:******@192.0.2.20:554/Streaming/Channels/101')).toBeInTheDocument();
  });
});

describe('Flujo secundario derivado del principal', () => {
  it.each([
    ['/Streaming/Channels/101', '/Streaming/Channels/102'],
    ['/Streaming/Channels/1601', '/Streaming/Channels/1602'],
    ['/ISAPI/Streaming/channels/101', '/ISAPI/Streaming/channels/102'],
    ['/cam/realmonitor?channel=1&subtype=0', '/cam/realmonitor?channel=1&subtype=1'],
  ])('%s → %s', (principal, secundaria) => expect(rutaSecundaria(principal)).toBe(secundaria));

  it.each(['/Streaming/Channels/102', '/cam/realmonitor?channel=1&subtype=1', '/', '/live'])('%s no tiene secundario derivable', ruta => {
    expect(rutaSecundaria(ruta)).toBeNull();
  });
});
