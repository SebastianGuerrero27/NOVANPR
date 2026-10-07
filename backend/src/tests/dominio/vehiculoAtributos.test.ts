import { compararVehiculo } from '../../dominio/vehiculoAtributos';

describe('compararVehiculo (segundo factor)', () => {
  it('coincide cuando marca y color son iguales (sin tildes ni mayúsculas)', () => {
    const r = compararVehiculo({ marca: 'Chevrolet', color: 'Rojo' }, { marca: 'chevrolet', color: 'rojo' });
    expect(r.resultado).toBe('coincide');
  });

  it('marca distinta indica posible placa clonada', () => {
    const r = compararVehiculo({ marca: 'Chevrolet', color: 'rojo' }, { marca: 'Kia', color: 'rojo' });
    expect(r.resultado).toBe('no_coincide');
    expect(r.detalle).toContain('marca registrada Chevrolet, observada Kia');
  });

  it('colores que la cámara confunde (gris / plateado) no generan falsa discrepancia', () => {
    expect(compararVehiculo({ color: 'gris' }, { color: 'plateado' }).resultado).toBe('coincide');
    expect(compararVehiculo({ color: 'café' }, { color: 'beige' }).resultado).toBe('coincide');
  });

  it('Great Wall y Haval se tratan como la misma marca', () => {
    expect(compararVehiculo({ marca: 'Great Wall' }, { marca: 'Haval' }).resultado).toBe('coincide');
  });

  it('el modelo no se usa para decidir (reconocimiento poco fiable)', () => {
    const r = compararVehiculo({ marca: 'Haval', modelo: 'H6' }, { marca: 'Haval', modelo: 'Jolion' });
    expect(r.resultado).toBe('coincide');
  });

  it('sin atributos comparables no se afirma nada', () => {
    expect(compararVehiculo({ marca: null, color: null }, { marca: 'Kia', color: 'rojo' }).resultado).toBe('sin_datos');
    expect(compararVehiculo({ marca: 'Kia' }, { color: 'rojo' }).resultado).toBe('sin_datos');
    expect(compararVehiculo(null, { marca: 'Kia' }).resultado).toBe('sin_datos');
  });
});
