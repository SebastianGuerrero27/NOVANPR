import {
  esIdValido, normalizarPlaca, validarEmail, validarEntero, validarFecha, validarHost, validarPlaca, validarTexto,
} from '../../dominio/validacion';

describe('Validación · placa (ANT Ecuador)', () => {
  it.each([
    ['ABC1234', 'ABC1234', 'auto'],
    ['abc-1234', 'ABC1234', 'auto'],
    [' pba 1234 ', 'PBA1234', 'auto'],
    ['AB123C', 'AB123C', 'moto'],
    ['ab-123c', 'AB123C', 'moto'],
  ])('acepta %s → %s (%s)', (entrada, placa, tipo) => {
    expect(validarPlaca(entrada)).toEqual({ ok: true, valor: { placa, tipo } });
  });

  it.each(['', 'ABC123', 'AB1234', 'ABCD1234', 'ABC12345', '1234ABC', 'A1B2C3D', 'ABC-12A4', 'AB12CD'])('rechaza %p', entrada => {
    expect(validarPlaca(entrada).ok).toBe(false);
  });

  it('normaliza lo escrito: mayúsculas y sin separadores', () => {
    expect(normalizarPlaca('a b-c.1/2#3$4')).toBe('ABC1234');
  });
});

describe('Validación · texto', () => {
  it('nombre: letras con tildes, ñ y signos de nombres', () => {
    expect(validarTexto('  María   José Ñúñez-O\'Neil ', { etiqueta: 'Nombre', tipo: 'nombre', max: 150 }))
      .toEqual({ ok: true, valor: "María José Ñúñez-O'Neil" });
    expect(validarTexto('Juan 2', { etiqueta: 'Nombre', tipo: 'nombre', max: 150 }).ok).toBe(false);
  });

  it('letras: sin números', () => {
    expect(validarTexto('Blanco perla', { etiqueta: 'Color', tipo: 'letras', max: 30 }).ok).toBe(true);
    expect(validarTexto('Rojo1', { etiqueta: 'Color', tipo: 'letras', max: 30 }).ok).toBe(false);
  });

  it('libre: rechaza etiquetas HTML (XSS almacenado)', () => {
    expect(validarTexto('Entrega de equipos, 2 cajas.', { etiqueta: 'Motivo', tipo: 'libre', max: 300 }).ok).toBe(true);
    expect(validarTexto('<script>alert(1)</script>', { etiqueta: 'Motivo', tipo: 'libre', max: 300 }).ok).toBe(false);
  });

  it('obligatorio, mínimo y máximo', () => {
    expect(validarTexto('', { etiqueta: 'Motivo', tipo: 'libre', max: 10, requerido: true })).toEqual({ ok: false, error: 'El campo «Motivo» es obligatorio.' });
    expect(validarTexto('', { etiqueta: 'Motivo', tipo: 'libre', max: 10 })).toEqual({ ok: true, valor: null });
    expect(validarTexto('abc', { etiqueta: 'Motivo', tipo: 'libre', max: 10, min: 5 }).ok).toBe(false);
    expect(validarTexto('abcdefghijk', { etiqueta: 'Motivo', tipo: 'libre', max: 10 }).ok).toBe(false);
  });
});

describe('Validación · números y formatos', () => {
  it('entero: solo dígitos y dentro del rango', () => {
    expect(validarEntero('42', { etiqueta: 'N', min: 1, max: 100 })).toEqual({ ok: true, valor: 42 });
    for (const malo of ['12a', '1.5', '1e3', ' ', 'abc']) expect(validarEntero(malo, { etiqueta: 'N', requerido: true }).ok).toBe(false);
    expect(validarEntero('0', { etiqueta: 'N', min: 1 }).ok).toBe(false);
    expect(validarEntero('101', { etiqueta: 'N', max: 100 }).ok).toBe(false);
  });

  it('rechaza arreglos y objetos en lugar de convertirlos a texto (String([3]) === "3")', () => {
    expect(validarEntero([3], { etiqueta: 'N' }).ok).toBe(false);
    expect(validarPlaca(['ABC1234']).ok).toBe(false);
    expect(validarTexto({ a: 1 }, { etiqueta: 'Motivo', tipo: 'libre', max: 10 }).ok).toBe(false);
    expect(validarFecha(['2026-01-01'], { etiqueta: 'F' }).ok).toBe(false);
  });

  it('id de ruta', () => {
    expect(esIdValido('15')).toBe(true);
    expect(esIdValido('0')).toBe(false);
    expect(esIdValido('1;DROP')).toBe(false);
  });

  it('correo, fecha real y host', () => {
    expect(validarEmail(' Ana@ECU911.gob.ec ')).toEqual({ ok: true, valor: 'ana@ecu911.gob.ec' });
    expect(validarEmail('ana@').ok).toBe(false);
    expect(validarFecha('2026-02-28', { etiqueta: 'F' }).ok).toBe(true);
    expect(validarFecha('2026-02-30', { etiqueta: 'F' }).ok).toBe(false);
    expect(validarHost('192.168.1.20').ok).toBe(true);
    expect(validarHost('camara-norte.local').ok).toBe(true);
    expect(validarHost('300.1.1.1').ok).toBe(false);
  });
});
