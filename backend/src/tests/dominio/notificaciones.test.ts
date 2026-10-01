import { CATALOGO, debeEscalar, severidadDeNivel, urgenciaPush } from '../../dominio/notificaciones';
import { PERMISOS } from '../../dominio/permisos';

describe('catálogo de notificaciones', () => {
  it('enruta solo por permisos existentes', () => {
    for (const d of Object.values(CATALOGO)) if (d.permiso) expect(Object.keys(PERMISOS)).toContain(d.permiso);
  });
  it('las alarmas de acceso exigen reconocimiento y se agrupan', () => {
    for (const t of ['acceso.alerta_seguridad', 'acceso.no_registrado', 'acceso.restringido'] as const) {
      expect(CATALOGO[t].requiereAck).toBe(true);
      expect(CATALOGO[t].ventanaS).toBeGreaterThan(0);
    }
  });
  it('prioridad según el nivel de la alerta', () => {
    expect(severidadDeNivel('CRITICA')).toBe('critica');
    expect(severidadDeNivel('ALTA')).toBe('alta');
    expect(severidadDeNivel('MEDIA')).toBe('media');
    expect(severidadDeNivel(undefined)).toBe('critica');
    expect(urgenciaPush('critica')).toBe('high');
    expect(urgenciaPush('baja')).toBe('low');
  });
});

describe('escalamiento (ISA-18.2)', () => {
  const creada = new Date('2026-10-01T10:00:00Z');
  const base = { severidad: 'alta' as const, requiereAck: true, creada, atendida: false, resuelta: false, escalada: false };
  const en = (s: number) => new Date(creada.getTime() + s * 1000);

  it('escala una alarma alta/crítica no atendida tras el umbral', () => {
    expect(debeEscalar(base, en(89), 90)).toBe(false);
    expect(debeEscalar(base, en(90), 90)).toBe(true);
    expect(debeEscalar({ ...base, severidad: 'critica' }, en(120), 90)).toBe(true);
  });
  it('no escala si se reconoció, se resolvió, ya escaló, es de baja prioridad o está desactivado', () => {
    expect(debeEscalar({ ...base, atendida: true }, en(500), 90)).toBe(false);
    expect(debeEscalar({ ...base, resuelta: true }, en(500), 90)).toBe(false);
    expect(debeEscalar({ ...base, escalada: true }, en(500), 90)).toBe(false);
    expect(debeEscalar({ ...base, severidad: 'media' }, en(500), 90)).toBe(false);
    expect(debeEscalar({ ...base, requiereAck: false }, en(500), 90)).toBe(false);
    expect(debeEscalar(base, en(500), 0)).toBe(false);
  });
});
