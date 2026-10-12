// @vitest-environment node
/**
 * Guardas del código del frontend: la webcam de pruebas se retiró y las cámaras se administran en
 * el sistema (registros persistentes), así que el código no debe volver a pedir la cámara del
 * equipo ni traer URLs RTSP o direcciones de cámaras fijas.
 */
import { describe, expect, it } from 'vitest';

// Texto de cada archivo de src (Vite lo lee como cadena; no se ejecuta)
const fuentes = import.meta.glob<string>('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
const codigo = Object.entries(fuentes).map(([ruta, texto]) => ({ ruta: ruta.replace('../src/', ''), texto }));

describe('Código del frontend', () => {
  it('lee todo el código fuente', () => {
    expect(codigo.length).toBeGreaterThan(30);
    expect(codigo.map(a => a.ruta)).toContain('interfaz/paginas/Monitoreo.tsx');
  });

  it('no accede a la cámara ni al micrófono del equipo (getUserMedia / mediaDevices) ni menciona la webcam', () => {
    const hallazgos = codigo.filter(a => /getUserMedia|mediaDevices|enumerateDevices|webcam/i.test(a.texto)).map(a => a.ruta);
    expect(hallazgos).toEqual([]);
  });

  it('sin URLs RTSP fijas: solo plantillas del formulario y ejemplos de documentación (RFC 5737)', () => {
    // Una URL fija tiene equipo tras el esquema; «rtsp://…», «rtsp://${…}» o el esquema citado en un
    // mensaje no lo tienen. Los ejemplos usan 192.0.2.0/24, reservada para documentación.
    const fijas = codigo.flatMap(a => (a.texto.match(/rtsps?:\/\/[\w[][^\s'"`<>)]*/gi) ?? [])
      .filter(url => !/^rtsps?:\/\/([^@/]*@)?192\.0\.2\.\d+[:/]/i.test(url))
      .map(url => `${a.ruta}: ${url}`));
    expect(fijas).toEqual([]);
  });

  it('sin direcciones IP privadas fijas (las cámaras se registran en el sistema)', () => {
    const privada = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
    const hallazgos = codigo.filter(a => privada.test(a.texto)).map(a => `${a.ruta}: ${a.texto.match(privada)?.[0]}`);
    expect(hallazgos).toEqual([]);
  });
});
