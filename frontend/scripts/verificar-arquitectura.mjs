#!/usr/bin/env node
/**
 * Prueba de aptitud de la arquitectura del frontend (docs/ARQUITECTURA_LIMPIA.md): lee las
 * importaciones de cada archivo y falla si una capa depende de otra que no le corresponde. Se
 * ejecuta en `npm run build`, así que la integración continua y la imagen de producción la aplican.
 *
 *   dominio/          reglas puras: solo dominio/ (sin React, sin red, sin el navegador)
 *   infraestructura/  cliente HTTP, Web Push y WebRTC: dominio/ y paquetes de red (sin React)
 *   aplicacion/       sesión, tiempo real y notificaciones (React): dominio/ e infraestructura/
 *   interfaz/         componentes, páginas y plantilla: todo lo anterior, pero nunca axios ni
 *                     socket.io-client directamente (la red pasa por infraestructura/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CAPAS = ['dominio', 'infraestructura', 'aplicacion', 'interfaz'];
const RED = ['axios', 'socket.io-client'];

const PERMITIDO = {
  dominio: { capas: ['dominio'], paquetes: [] },
  infraestructura: { capas: ['dominio', 'infraestructura'], paquetes: RED },
  aplicacion: { capas: ['dominio', 'infraestructura', 'aplicacion'], paquetes: ['react', 'react-router-dom', 'socket.io-client'] },
  interfaz: { capas: ['dominio', 'infraestructura', 'aplicacion', 'interfaz', 'assets'], paquetes: null, prohibidos: RED },
};

function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? archivos(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

const errores = [];
const carpetas = fs.readdirSync(SRC, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
const esperadas = [...CAPAS, 'assets'].sort();
if (JSON.stringify(carpetas) !== JSON.stringify(esperadas)) errores.push(`src/ debe contener exactamente ${esperadas.join(', ')} (hay: ${carpetas.join(', ')})`);

for (const capa of CAPAS) {
  const regla = PERMITIDO[capa];
  for (const archivo of archivos(path.join(SRC, capa))) {
    const texto = fs.readFileSync(archivo, 'utf8');
    const rel = path.relative(SRC, archivo).replace(/\\/g, '/');
    for (const m of texto.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const esp = m[1];
      if (esp.startsWith('.')) {
        const destino = path.relative(SRC, path.resolve(path.dirname(archivo), esp)).replace(/\\/g, '/').split('/')[0];
        if (!regla.capas.includes(destino)) errores.push(`${rel} → ${esp} (${capa} no puede depender de ${destino})`);
      } else {
        const paquete = esp.startsWith('@') ? esp.split('/').slice(0, 2).join('/') : esp.split('/')[0];
        if (regla.paquetes && !regla.paquetes.includes(paquete)) errores.push(`${rel} → ${esp} (paquete no permitido en ${capa})`);
        if (regla.prohibidos?.includes(paquete)) errores.push(`${rel} → ${esp} (la interfaz usa la red solo a través de infraestructura/)`);
      }
    }
    if (capa === 'dominio' && /\b(window|document|localStorage|fetch)\b/.test(texto.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
      errores.push(`${rel} usa APIs del navegador (el dominio debe ser puro)`);
    }
  }
}

if (errores.length) {
  console.error(`Arquitectura: ${errores.length} dependencia(s) no permitida(s):\n  ${errores.join('\n  ')}`);
  process.exit(1);
}
console.log('Arquitectura del frontend: todas las dependencias respetan las capas.');
