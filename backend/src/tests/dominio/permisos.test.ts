import {
  CODIGO_POR_ROL, esRol, MATRIZ, PERMISOS, permisosDe, ROL_POR_CODIGO, ROLES, rolesCon, tienePermiso,
} from '../../dominio/permisos';
import type { Permiso, Rol } from '../../dominio/permisos';

describe('RBAC · matriz rol → permiso', () => {
  it('cada rol tiene código de base de datos y viceversa', () => {
    for (const r of ROLES) expect(ROL_POR_CODIGO[CODIGO_POR_ROL[r]]).toBe(r);
    expect(CODIGO_POR_ROL.GestorAccesos).toBe('GESTOR_ACCESOS');
  });

  it('la matriz solo usa permisos del catálogo', () => {
    for (const r of ROLES) for (const p of MATRIZ[r]) expect(Object.keys(PERMISOS)).toContain(p);
  });

  it('el administrador tiene todos los permisos', () => {
    expect(permisosDe('Admin').sort()).toEqual((Object.keys(PERMISOS) as Permiso[]).sort());
  });

  // Tabla de verdad de las capacidades que el sistema promete a cada rol
  const casos: [Rol, Permiso, boolean][] = [
    ['GestorAccesos', 'padron:gestionar', true],
    ['GestorAccesos', 'solicitudes:resolver', true],
    ['GestorAccesos', 'accesos:excepcion', true],
    ['GestorAccesos', 'avisos:acceso', true],
    ['GestorAccesos', 'alertas:gestionar', false],
    ['GestorAccesos', 'avisos:garita', false],
    ['GestorAccesos', 'usuarios:gestionar', false],
    ['GestorAccesos', 'evaluacion:ver', false],
    ['Operador', 'avisos:garita', true],
    ['Operador', 'avisos:acceso', true],
    ['Operador', 'solicitudes:crear', true],
    ['Operador', 'padron:gestionar', false],
    ['Operador', 'solicitudes:resolver', false],
    ['Operador', 'accesos:excepcion', false],
    ['Supervisor', 'alertas:gestionar', true],
    ['Supervisor', 'alarmas:escalamiento', true],
    ['Supervisor', 'detecciones:eliminar', false],
    ['Supervisor', 'configuracion:gestionar', false],
  ];
  it.each(casos)('%s · %s → %s', (rol, permiso, esperado) => {
    expect(tienePermiso(rol, permiso)).toBe(esperado);
  });

  it('todo el personal puede monitorear, validar, consultar listas y solicitar accesos', () => {
    for (const r of ROLES) {
      for (const p of ['operacion:monitorear', 'detecciones:validar', 'listas:ver', 'solicitudes:crear'] as Permiso[]) {
        expect(tienePermiso(r, p)).toBe(true);
      }
    }
  });

  it('enruta notificaciones por permiso', () => {
    expect(rolesCon('padron:gestionar').sort()).toEqual(['Admin', 'GestorAccesos', 'Supervisor']);
    expect(rolesCon('avisos:acceso')).toContain('GestorAccesos');
    expect(rolesCon('avisos:acceso')).toContain('Operador');
    expect(rolesCon('alarmas:escalamiento').sort()).toEqual(['Admin', 'Supervisor']);
  });

  it('rechaza roles desconocidos', () => {
    expect(esRol('GestorAccesos')).toBe(true);
    expect(esRol('Root')).toBe(false);
    expect(tienePermiso(undefined, 'listas:ver')).toBe(false);
    expect(tienePermiso('Root' as Rol, 'listas:ver')).toBe(false);
  });
});
