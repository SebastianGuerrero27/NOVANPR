import fs from 'fs';
import path from 'path';
import { lotesSql, MIGRACIONES } from '../../infraestructura/db';

const DIR_DB = path.resolve(__dirname, '../../../../db');

describe('migraciones de esquema', () => {
  const scripts = fs.readdirSync(DIR_DB).filter(f => f.endsWith('.sql'));

  it.each(scripts)('%s se separa en lotes sin USE ni CREATE DATABASE', (archivo) => {
    const lotes = lotesSql(fs.readFileSync(path.join(DIR_DB, archivo), 'utf8'));
    expect(lotes.length).toBeGreaterThan(0);
    for (const lote of lotes) {
      expect(lote).not.toMatch(/^\s*USE\s+/im);
      expect(lote).not.toMatch(/CREATE\s+DATABASE/i);
      expect(lote).not.toMatch(/^\s*GO\s*$/im);
    }
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

    it('es la última migración registrada', () => {
      expect(MIGRACIONES[MIGRACIONES.length - 1]).toBe('migration_v8_solicitudes_version.sql');
    });

    it('agrega la columna una sola vez, no nula y con versión inicial 1', () => {
      expect(v8).toContain("IF COL_LENGTH('dbo.SolicitudesAcceso', 'version') IS NULL");
      expect(v8).toMatch(/ALTER TABLE SolicitudesAcceso ADD version INT NOT NULL CONSTRAINT DF_SolicitudesAcceso_version DEFAULT 1;/);
    });
  });
});
