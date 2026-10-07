import fs from 'fs';
import path from 'path';

/**
 * Prueba de aptitud de la arquitectura limpia (docs/ARQUITECTURA_LIMPIA.md): la regla de
 * dependencias se verifica leyendo las importaciones de cada archivo. Si una capa interna
 * empieza a depender de una externa, esta prueba falla y señala el archivo.
 *
 *   dominio/          solo dominio/ (sin paquetes, sin E/S, sin process.env)
 *   aplicacion/       dominio/ y aplicacion/ (sin Express, mssql ni infraestructura)
 *   infraestructura/  sin interfaz/, contenedor/ ni Express
 *   interfaz/http/    sin infraestructura/ (la recibe por contenedor/) ni mssql
 */

const SRC = path.resolve(__dirname, '..');
const CAPAS = ['dominio', 'aplicacion', 'infraestructura', 'interfaz', 'contenedor'] as const;
type Capa = typeof CAPAS[number];

function archivosDe(capa: Capa): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith('.ts')) salida.push(p);
    }
  };
  recorrer(path.join(SRC, capa));
  return salida;
}

/** Importaciones de un archivo: capa de destino (si es relativa a src) o nombre del paquete. */
function importaciones(archivo: string): { especificador: string; capa: Capa | null; paquete: string | null }[] {
  const texto = fs.readFileSync(archivo, 'utf8');
  const especificadores = [...texto.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
  return especificadores.map(especificador => {
    if (!especificador.startsWith('.')) return { especificador, capa: null, paquete: especificador };
    const destino = path.relative(SRC, path.resolve(path.dirname(archivo), especificador)).replace(/\\/g, '/');
    const capa = (CAPAS as readonly string[]).includes(destino.split('/')[0]) ? destino.split('/')[0] as Capa : null;
    return { especificador, capa, paquete: null };
  });
}

const relativo = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');

function violaciones(capa: Capa, prohibido: (i: ReturnType<typeof importaciones>[number]) => boolean): string[] {
  return archivosDe(capa).flatMap(a => importaciones(a).filter(prohibido).map(i => `${relativo(a)} → ${i.especificador}`));
}

describe('Arquitectura limpia · regla de dependencias', () => {
  it('existen exactamente las capas documentadas en src/', () => {
    const carpetas = fs.readdirSync(SRC, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
    expect(carpetas).toEqual([...CAPAS, 'tests'].sort());
  });

  it('dominio: solo importa del dominio y no lee el entorno', () => {
    expect(violaciones('dominio', i => i.paquete !== null || (i.capa !== null && i.capa !== 'dominio'))).toEqual([]);
    expect(archivosDe('dominio').filter(a => /process\.env/.test(fs.readFileSync(a, 'utf8'))).map(relativo)).toEqual([]);
  });

  it('aplicación: solo importa dominio y aplicación (sin Express, mssql ni infraestructura)', () => {
    expect(violaciones('aplicacion', i => i.paquete !== null || (i.capa !== null && !['dominio', 'aplicacion'].includes(i.capa)))).toEqual([]);
    expect(archivosDe('aplicacion').filter(a => /process\.env/.test(fs.readFileSync(a, 'utf8'))).map(relativo)).toEqual([]);
  });

  it('infraestructura: no depende de la interfaz HTTP, del contenedor ni de Express', () => {
    expect(violaciones('infraestructura', i => i.paquete === 'express' || i.capa === 'interfaz' || i.capa === 'contenedor')).toEqual([]);
  });

  it('interfaz HTTP: no usa la infraestructura directamente ni SQL', () => {
    expect(violaciones('interfaz', i => i.capa === 'infraestructura' || i.paquete === 'mssql')).toEqual([]);
    const conSql = archivosDe('interfaz').filter(a => /\b(SELECT|INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(fs.readFileSync(a, 'utf8')));
    expect(conSql.map(relativo)).toEqual([]);
  });

  it('cada módulo con router tiene su contenedor y sus casos de uso', () => {
    const rutas = fs.readdirSync(path.join(SRC, 'interfaz/http/rutas')).map(f => f.replace(/\.ts$/, ''));
    const sinCasos = rutas.filter(r => !fs.existsSync(path.join(SRC, 'aplicacion', `${r}.ts`)));
    expect(sinCasos).toEqual([]);
  });
});
