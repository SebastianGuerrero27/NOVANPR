import fs from 'fs';
import path from 'path';
import { lotesSql, MIGRACIONES } from '../../infraestructura/db';

const DIR_DB = path.resolve(__dirname, '../../../../db');

describe('migraciones de esquema', () => {
  const scripts = fs.readdirSync(DIR_DB).filter(f => f.endsWith('.sql'));

  it.each(scripts)('%s se separa en lotes GO', (archivo) => {
    const lotes = lotesSql(fs.readFileSync(path.join(DIR_DB, archivo), 'utf8'));
    expect(lotes.length).toBeGreaterThan(0);
    for (const lote of lotes) expect(lote).not.toMatch(/^\s*GO\s*$/im);
  });

  it('todas las migraciones registradas existen en db/', () => {
    for (const m of MIGRACIONES) expect(fs.existsSync(path.join(DIR_DB, m))).toBe(true);
  });

  it('separa por GO solo cuando está en su propia línea', () => {
    expect(lotesSql('SELECT 1\nGO\nSELECT N\'GOOD\'\n  go  \nSELECT 2')).toEqual(["SELECT 1", "SELECT N'GOOD'", 'SELECT 2']);
  });

  it('la migración v5 agrega el rol Gestor de accesos y quita el CHECK de códigos', () => {
    const v5 = fs.readFileSync(path.join(DIR_DB, 'migration_v5_accesos_notificaciones.sql'), 'utf8');
    expect(v5).toMatch(/GESTOR_ACCESOS/);
    expect(v5).toMatch(/DROP CONSTRAINT/);
  });

  it('la migración v6 deja solo tres roles y reasigna las cuentas de los retirados', () => {
    const v6 = fs.readFileSync(path.join(DIR_DB, 'migration_v6_tres_roles.sql'), 'utf8');
    expect(v6).toMatch(/codigo = 'GUARDIA'/);
    expect(v6).toMatch(/codigo = 'GESTOR_PERMISOS'/);
    expect(v6).toMatch(/DELETE FROM Roles WHERE codigo IN \('OPERADOR', 'SUPERVISOR', 'GESTOR_ACCESOS'\)/);
    expect(MIGRACIONES.indexOf('migration_v6_tres_roles.sql')).toBe(MIGRACIONES.indexOf('migration_v7_auditoria_retencion.sql') - 1);
  });

  describe('migración v7 · tablas de archivo de la auditoría (retención)', () => {
    const v7 = fs.readFileSync(path.join(DIR_DB, 'migration_v7_auditoria_retencion.sql'), 'utf8');
    const init = fs.readFileSync(path.join(DIR_DB, 'init.sql'), 'utf8');

    /** "nombre TIPO NULL|NOT NULL" de cada columna de un CREATE TABLE (la clave primaria nunca es nula). */
    const columnas = (script: string, tabla: string): string[] => {
      const bloque = script.match(new RegExp(`CREATE TABLE ${tabla} \\(([\\s\\S]*?)\\n\\s*\\);`));
      if (!bloque) throw new Error(`No se encontró CREATE TABLE ${tabla}`);
      return bloque[1].split('\n').map(l => l.replace(/--.*$/, '').trim()).filter(Boolean).map(l => {
        const [nombre, tipo] = l.replace(/,$/, '').split(/\s+/);
        return `${nombre} ${tipo} ${/NOT NULL|PRIMARY KEY/i.test(l) ? 'NOT NULL' : 'NULL'}`;
      });
    };

    it('va justo antes de la v8', () => {
      expect(MIGRACIONES.indexOf('migration_v7_auditoria_retencion.sql')).toBe(MIGRACIONES.indexOf('migration_v8_solicitudes_version.sql') - 1);
    });

    it.each([
      ['AuditoriaOperacionesArchivo', 'AuditoriaOperaciones'],
      ['AuditoriaUsuariosArchivo', 'AuditoriaUsuarios'],
      ['AuditoriaAccesosArchivo', 'AuditoriaAccesos'],
    ])('%s: idempotente y con las mismas columnas que %s más fecha_archivado', (archivo, origen) => {
      expect(v7).toContain(`IF OBJECT_ID('dbo.${archivo}', 'U') IS NULL`);
      expect(columnas(v7, archivo)).toEqual([...columnas(init, origen), 'fecha_archivado DATETIME2 NOT NULL']);
      expect(v7).toMatch(new RegExp(`CREATE TABLE ${archivo} \\([\\s\\S]*?fecha_archivado\\s+DATETIME2\\s+NOT NULL DEFAULT SYSDATETIME\\(\\)`));
    });

    it('conserva el id original (sin IDENTITY) y no edita ni borra registros', () => {
      const sentencias = v7.replace(/--.*$/gm, '');
      expect(sentencias).not.toMatch(/IDENTITY/i);
      expect(sentencias).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP)\b/i);
    });
  });

  describe('migración v8 · versión de las solicitudes (concurrencia optimista)', () => {
    const v8 = fs.readFileSync(path.join(DIR_DB, 'migration_v8_solicitudes_version.sql'), 'utf8');

    it('se aplica antes de la v9', () => {
      expect(MIGRACIONES.indexOf('migration_v8_solicitudes_version.sql')).toBe(MIGRACIONES.indexOf('migration_v9_camaras_vista_cifrado.sql') - 1);
    });

    it('agrega la columna una sola vez, no nula y con versión inicial 1', () => {
      expect(v8).toContain("IF COL_LENGTH('dbo.SolicitudesAcceso', 'version') IS NULL");
      expect(v8).toMatch(/ALTER TABLE SolicitudesAcceso ADD version INT NOT NULL CONSTRAINT DF_SolicitudesAcceso_version DEFAULT 1;/);
    });
  });

  describe('migración v9 · flujo de vista y credenciales cifradas de las cámaras', () => {
    const v9 = fs.readFileSync(path.join(DIR_DB, 'migration_v9_camaras_vista_cifrado.sql'), 'utf8');

    it('se aplica antes de la v10', () => {
      expect(MIGRACIONES.indexOf('migration_v9_camaras_vista_cifrado.sql')).toBe(MIGRACIONES.indexOf('migration_v10_fuente_rtsp.sql') - 1);
    });

    it('amplía rtsp_url a 512 (el texto cifrado ocupa más) y agrega rtsp_url_vista, ambas idempotentes', () => {
      expect(v9).toContain("IF COL_LENGTH('dbo.Camaras', 'rtsp_url') < 512");
      expect(v9).toMatch(/ALTER TABLE Camaras ALTER COLUMN rtsp_url VARCHAR\(512\) NOT NULL;/);
      expect(v9).toContain("IF COL_LENGTH('dbo.Camaras', 'rtsp_url_vista') IS NULL");
      expect(v9).toMatch(/ALTER TABLE Camaras ADD rtsp_url_vista VARCHAR\(512\) NULL;/);
    });
  });
  describe('migración v10 · fuente por omisión rtsp (sin webcam)', () => {
    const v10 = fs.readFileSync(path.join(DIR_DB, 'migration_v10_fuente_rtsp.sql'), 'utf8');

    it('se aplica antes de la v11', () => {
      expect(MIGRACIONES.indexOf('migration_v10_fuente_rtsp.sql')).toBe(MIGRACIONES.indexOf('migration_v11_zonas_exclusion.sql') - 1);
    });

    it('solo reemplaza el DEFAULT de la columna (busca su nombre en el catálogo) y no toca registros', () => {
      expect(v10).toContain('sys.default_constraints');
      expect(v10).toMatch(/DROP CONSTRAINT ' \+ QUOTENAME\(@restriccion\)/);
      expect(v10).toMatch(/ADD CONSTRAINT DF_DeteccionVehiculo_fuente DEFAULT 'rtsp' FOR fuente/);
      expect(v10).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    });

    it('init.sql crea la columna con el mismo valor por omisión', () => {
      expect(fs.readFileSync(path.join(DIR_DB, 'init.sql'), 'utf8')).toMatch(/fuente\s+VARCHAR\(255\)\s+NULL DEFAULT 'rtsp'/);
    });
  });

  describe('migración v11 · zonas de exclusión de las cámaras', () => {
    const v11 = fs.readFileSync(path.join(DIR_DB, 'migration_v11_zonas_exclusion.sql'), 'utf8');

    it('se aplica antes de la v12', () => {
      expect(MIGRACIONES.indexOf('migration_v11_zonas_exclusion.sql')).toBe(MIGRACIONES.indexOf('migration_v12_eliminar_notificaciones.sql') - 1);
    });

    it('agrega la columna de forma idempotente y no toca registros', () => {
      expect(v11).toContain("IF COL_LENGTH('dbo.Camaras', 'exclusiones') IS NULL");
      expect(v11).toMatch(/ALTER TABLE Camaras ADD exclusiones NVARCHAR\(MAX\) NULL;/);
      expect(v11).not.toMatch(/\b(UPDATE|DELETE)\b/i);
    });

    it('init.sql crea la columna', () => {
      expect(fs.readFileSync(path.join(DIR_DB, 'init.sql'), 'utf8')).toMatch(/exclusiones\s+NVARCHAR\(MAX\)\s+NULL/);
    });
  });
  describe('migración v12 · quitar notificaciones de la bandeja', () => {
    const v12 = fs.readFileSync(path.join(DIR_DB, 'migration_v12_eliminar_notificaciones.sql'), 'utf8');

    it('se aplica antes de la migración de direcciones', () => {
      expect(MIGRACIONES.indexOf('migration_v12_eliminar_notificaciones.sql')).toBe(MIGRACIONES.indexOf('migration_v13_direccion_camara.sql') - 1);
    });

    it('agrega la marca por usuario de forma idempotente y no borra ni modifica registros', () => {
      expect(v12).toContain("IF COL_LENGTH('dbo.NotificacionUsuario', 'fecha_eliminacion') IS NULL");
      expect(v12).toMatch(/ALTER TABLE NotificacionUsuario ADD fecha_eliminacion DATETIME2 NULL;/);
      expect(v12).not.toMatch(/(UPDATE|DELETE|DROP)/i);
    });
  });
  describe('migración v13 · dirección de cámaras y movimientos', () => {
    const v13 = fs.readFileSync(path.join(DIR_DB, 'migration_v13_direccion_camara.sql'), 'utf8');

    it('es la última migración registrada', () => {
      expect(MIGRACIONES[MIGRACIONES.length - 1]).toBe('migration_v13_direccion_camara.sql');
    });

    it('agrega dirección con valor de compatibilidad para cámaras y registros anteriores', () => {
      expect(v13).toContain("IF COL_LENGTH('dbo.Camaras', 'direccion') IS NULL");
      expect(v13).toContain("DEFAULT ('ingreso')");
      expect(v13).toContain("IF COL_LENGTH('dbo.DeteccionVehiculo', 'tipo_movimiento') IS NULL");
      expect(v13).toContain("CHECK (tipo_movimiento IN ('ingreso', 'salida'))");
      expect(v13).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/i);
    });
  });
});
