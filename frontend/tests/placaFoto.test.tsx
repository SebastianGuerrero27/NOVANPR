/**
 * La placa se muestra con la foto real del recorte y la lectura en texto, nunca dibujada. Si el motor
 * no pudo recortarla, la API repite la foto del vehículo en imagen_placa: no se muestra como placa.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlacaFoto, recortePlaca } from '../src/interfaz/componentes/deteccion';

const VEHICULO = '/media/ingreso_1.jpg?exp=1&firma=a';
const RECORTE = '/media/placa_1.jpg?exp=1&firma=b';

describe('Foto de la placa', () => {
  it('muestra el recorte real y la lectura con el formato de la ANT', () => {
    const { container } = render(<PlacaFoto d={{ placa: 'PBA1234', imagen_placa: RECORTE, imagen_vehiculo: VEHICULO }} />);
    const foto = screen.getByAltText('Placa PBA1234') as HTMLImageElement;
    expect(foto.getAttribute('src')).toContain('/media/placa_1.jpg');
    expect(screen.getByText('PBA-1234')).toBeTruthy();
    expect(container.querySelector('.placa-foto-imagen img')).toBe(foto);
  });

  it('sin recorte no presenta la foto del vehículo como si fuera la placa', () => {
    render(<PlacaFoto d={{ placa: 'PBA1234', imagen_placa: VEHICULO, imagen_vehiculo: VEHICULO }} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTitle('Sin recorte de la placa')).toBeTruthy();
    expect(screen.getByText('PBA-1234')).toBeTruthy();
  });

  it('recortePlaca solo devuelve un recorte distinto de la foto del vehículo', () => {
    expect(recortePlaca({ imagen_placa: RECORTE, imagen_vehiculo: VEHICULO })).toBe(RECORTE);
    expect(recortePlaca({ imagen_placa: VEHICULO, imagen_vehiculo: VEHICULO })).toBeNull();
    expect(recortePlaca({ imagen_placa: null, imagen_vehiculo: VEHICULO })).toBeNull();
  });
});
