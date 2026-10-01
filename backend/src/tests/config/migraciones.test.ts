import fs from 'fs';
import path from 'path';
import { lotesSql, MIGRACIONES } from '../../config/db';

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
    expect(MIGRACIONES[MIGRACIONES.length - 1]).toBe('migration_v5_accesos_notificaciones.sql');
  });
});
