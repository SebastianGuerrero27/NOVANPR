import {
  CODIGO_POR_ROL, esRol, MATRIZ, PERMISOS, permisosDe, ROL_POR_CODIGO, ROLES, rolesCon, tienePermiso,
} from '../../dominio/permisos';
import type { Permiso, Rol } from '../../dominio/permisos';

describe('RBAC · matriz rol → permiso', () => {
  it('cada rol tiene código de base de datos y viceversa', () => {
    for (const r of ROLES) expect(ROL_POR_CODIGO[CODIGO_POR_ROL[r]]).toBe(r);
    expect(CODIGO_POR_ROL.GestorPermisos).toBe('GESTOR_PERMISOS');
  });

  it('la matriz solo usa permisos del catálogo', () => {
    for (const r of ROLES) for (const p of MATRIZ[r]) expect(Object.keys(PERMISOS)).toContain(p);
  });

  it('el administrador tiene todos los permisos', () => {
    expect(permisosDe('Admin').sort()).toEqual((Object.keys(PERMISOS) as Permiso[]).sort());
  });

  it('solo existen tres roles: Administrador, Guardia y Gestor de permisos', () => {
    expect([...ROLES].sort()).toEqual(['Admin', 'GestorPermisos', 'Guardia']);
    expect(Object.keys(ROL_POR_CODIGO).sort()).toEqual(['ADMIN', 'GESTOR_PERMISOS', 'GUARDIA']);
  });

  // Tabla de verdad de las capacidades que el sistema promete a cada rol
  const casos: [Rol, Permiso, boolean][] = [
    ['GestorPermisos', 'padron:gestionar', true],
    ['GestorPermisos', 'solicitudes:resolver', true],
    ['GestorPermisos', 'listas:ver', true],
    // Una sola vista y sin avisos de monitoreo
    ['GestorPermisos', 'operacion:monitorear', false],
    ['GestorPermisos', 'detecciones:validar', false],
    ['GestorPermisos', 'avisos:acceso', false],
    ['GestorPermisos', 'avisos:garita', false],
    ['GestorPermisos', 'avisos:padron', false],
    ['GestorPermisos', 'alertas:gestionar', false],
    ['GestorPermisos', 'usuarios:gestionar', false],
    ['Guardia', 'operacion:monitorear', true],
    ['Guardia', 'detecciones:validar', true],
    ['Guardia', 'listas:ver', true],
    ['Guardia', 'solicitudes:crear', true],
    ['Guardia', 'avisos:garita', true],
    ['Guardia', 'avisos:padron', true],
    ['Guardia', 'padron:gestionar', false],
    ['Guardia', 'solicitudes:resolver', false],
    ['Guardia', 'accesos:excepcion', false],
    ['Guardia', 'usuarios:gestionar', false],
  ];
  it.each(casos)('%s · %s → %s', (rol, permiso, esperado) => {
    expect(tienePermiso(rol, permiso)).toBe(esperado);
  });

  it('el gestor de permisos solo gestiona la lista blanca y resuelve solicitudes', () => {
    expect(permisosDe('GestorPermisos').sort()).toEqual(['listas:ver', 'padron:gestionar', 'solicitudes:resolver']);
  });

  it('enruta notificaciones por permiso', () => {
    expect(rolesCon('padron:gestionar').sort()).toEqual(['Admin', 'GestorPermisos']);
    expect(rolesCon('avisos:padron').sort()).toEqual(['Admin', 'Guardia']);
    expect(rolesCon('avisos:acceso').sort()).toEqual(['Admin', 'Guardia']);
    expect(rolesCon('alarmas:escalamiento')).toEqual(['Admin']);
  });

  it('rechaza roles desconocidos', () => {
    expect(esRol('GestorPermisos')).toBe(true);
    expect(esRol('Supervisor')).toBe(false);
    expect(esRol('Operador')).toBe(false);
    expect(esRol('Root')).toBe(false);
    expect(tienePermiso(undefined, 'listas:ver')).toBe(false);
    expect(tienePermiso('Root' as Rol, 'listas:ver')).toBe(false);
  });
});
