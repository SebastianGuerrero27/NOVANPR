import { dentroDeHorario, describirHorario, evaluarVigencia, tiempoLocal, validarHorario } from '../../dominio/horario';

const ZONA = 'America/Guayaquil'; // UTC-5, sin horario de verano
// Instante local de Ecuador → Date UTC
const local = (isoLocal: string) => new Date(`${isoLocal}-05:00`);
const LV = [{ dias: [1, 2, 3, 4, 5], desde: '07:00', hasta: '19:00' }];

describe('horario · franjas de acceso', () => {
  it('obtiene el día ISO y la hora local de la institución', () => {
    // 2026-10-05 es lunes
    expect(tiempoLocal(local('2026-10-05T03:30:00'), ZONA)).toEqual({ dia: 1, minutos: 210, ymd: '2026-10-05' });
    // 02:00 UTC del martes = 21:00 del lunes en Ecuador
    expect(tiempoLocal(new Date('2026-10-06T02:00:00Z'), ZONA).dia).toBe(1);
  });

  it('lunes a viernes 07:00–19:00', () => {
    expect(dentroDeHorario(LV, local('2026-10-05T07:00:00'), ZONA)).toBe(true);
    expect(dentroDeHorario(LV, local('2026-10-05T18:59:00'), ZONA)).toBe(true);
    expect(dentroDeHorario(LV, local('2026-10-05T19:00:00'), ZONA)).toBe(false); // fin exclusivo
    expect(dentroDeHorario(LV, local('2026-10-05T06:59:00'), ZONA)).toBe(false);
    expect(dentroDeHorario(LV, local('2026-10-10T10:00:00'), ZONA)).toBe(false); // sábado
  });

  it('franja nocturna que cruza la medianoche (turno 22:00–06:00 que inicia el viernes)', () => {
    const noche = [{ dias: [5], desde: '22:00', hasta: '06:00' }];
    expect(dentroDeHorario(noche, local('2026-10-09T23:00:00'), ZONA)).toBe(true);  // viernes
    expect(dentroDeHorario(noche, local('2026-10-10T05:59:00'), ZONA)).toBe(true);  // madrugada del sábado
    expect(dentroDeHorario(noche, local('2026-10-10T06:00:00'), ZONA)).toBe(false);
    expect(dentroDeHorario(noche, local('2026-10-10T23:00:00'), ZONA)).toBe(false); // sábado noche
    expect(dentroDeHorario(noche, local('2026-10-09T05:00:00'), ZONA)).toBe(false); // madrugada del viernes (inició el jueves)
  });

  it('domingo → lunes al cruzar la medianoche', () => {
    const domingo = [{ dias: [7], desde: '20:00', hasta: '02:00' }];
    expect(dentroDeHorario(domingo, local('2026-10-05T01:00:00'), ZONA)).toBe(true); // lunes 01:00
  });

  it('sin franjas = 24/7', () => {
    expect(dentroDeHorario(null, local('2026-10-10T03:00:00'), ZONA)).toBe(true);
    expect(dentroDeHorario([], local('2026-10-10T03:00:00'), ZONA)).toBe(true);
  });

  it('valida y normaliza la entrada', () => {
    expect(validarHorario(null)).toEqual({ horario: null });
    expect(validarHorario('[]')).toEqual({ horario: null });
    expect(validarHorario([{ dias: [5, 1, 1], desde: '07:00', hasta: '19:00' }]).horario).toEqual([{ dias: [1, 5], desde: '07:00', hasta: '19:00' }]);
    expect(validarHorario([{ dias: [8], desde: '07:00', hasta: '19:00' }]).error).toBeDefined();
    expect(validarHorario([{ dias: [1], desde: '7:00', hasta: '19:00' }]).error).toBeDefined();
    expect(validarHorario([{ dias: [1], desde: '24:00', hasta: '19:00' }]).error).toBeDefined();
    expect(validarHorario([{ dias: [1], desde: '08:00', hasta: '08:00' }]).error).toBeDefined();
    expect(validarHorario('{malo').error).toBeDefined();
    expect(validarHorario(Array.from({ length: 8 }, () => LV[0])).error).toBeDefined();
  });

  it('describe el horario para avisos', () => {
    expect(describirHorario(JSON.stringify(LV))).toBe('L–V 07:00–19:00');
    expect(describirHorario([{ dias: [1, 3, 5], desde: '08:00', hasta: '12:00' }])).toBe('L, X, V 08:00–12:00');
    expect(describirHorario([{ dias: [1, 2, 3, 4, 5, 6, 7], desde: '00:00', hasta: '06:00' }])).toBe('Todos los días 00:00–06:00');
    expect(describirHorario(null)).toBe('Sin restricción horaria');
  });
});

describe('evaluarVigencia', () => {
  const ahora = local('2026-10-05T10:00:00'); // lunes

  it('vigente sin restricciones', () => {
    expect(evaluarVigencia({}, ahora, ZONA)).toBe('vigente');
  });

  it('aún no iniciada y vencida (fechas DATE de SQL Server a medianoche UTC)', () => {
    expect(evaluarVigencia({ fecha_inicio: new Date('2026-10-06T00:00:00Z') }, ahora, ZONA)).toBe('no_iniciada');
    expect(evaluarVigencia({ fecha_inicio: new Date('2026-10-05T00:00:00Z') }, ahora, ZONA)).toBe('vigente');
    expect(evaluarVigencia({ fecha_vencimiento: new Date('2026-10-04T00:00:00Z') }, ahora, ZONA)).toBe('vencida');
    expect(evaluarVigencia({ fecha_vencimiento: '2026-10-05' }, ahora, ZONA)).toBe('vigente'); // vence al final del día
  });

  it('el último día de vigencia se evalúa en hora local, no en UTC', () => {
    // 21:00 del 5 en Ecuador = 02:00 UTC del 6: el permiso que vence el 5 sigue vigente
    expect(evaluarVigencia({ fecha_vencimiento: '2026-10-05' }, new Date('2026-10-06T02:00:00Z'), ZONA)).toBe('vigente');
  });

  it('fuera de horario', () => {
    expect(evaluarVigencia({ horario: JSON.stringify(LV) }, local('2026-10-05T20:00:00'), ZONA)).toBe('fuera_horario');
    expect(evaluarVigencia({ horario: JSON.stringify(LV) }, ahora, ZONA)).toBe('vigente');
  });

  it('un horario corrupto en la base no bloquea (se ignora)', () => {
    expect(evaluarVigencia({ horario: '{corrupto' }, local('2026-10-05T23:00:00'), ZONA)).toBe('vigente');
  });
});
