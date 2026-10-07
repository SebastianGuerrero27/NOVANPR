import type { Router } from 'express';
import { generarOpenApi, rutaOpenApi } from '../../interfaz/http/docs/openapi';
import { RUTAS } from '../../interfaz/http/docs/rutas';
import { PERMISOS } from '../../dominio/permisos';

jest.mock('../../infraestructura/servicios/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MONTAJES } = require('../../app') as { MONTAJES: [string, Router][] };

/** "metodo ruta" de cada ruta registrada en los routers montados. */
function rutasExpress(): string[] {
  const rutas: string[] = [];
  for (const [prefijo, router] of MONTAJES) {
    for (const capa of (router as any).stack) {
      if (!capa.route) continue;
      for (const metodo of Object.keys(capa.route.methods)) rutas.push(`${metodo} ${prefijo}${capa.route.path}`);
    }
  }
  return rutas.sort();
}

describe('Documentación OpenAPI (Swagger)', () => {
  const documentadas = RUTAS.map(r => `${r.metodo} ${r.ruta}`).sort();

  it('toda ruta montada en Express está documentada y no se documentan rutas inexistentes', () => {
    const express = rutasExpress();
    expect(documentadas.filter(r => !express.includes(r))).toEqual([]);
    expect(express.filter(r => !documentadas.includes(r))).toEqual([]);
  });

  it('no hay rutas documentadas dos veces', () => {
    expect(new Set(documentadas).size).toBe(documentadas.length);
  });

  it('el acceso declarado usa permisos del catálogo RBAC', () => {
    for (const r of RUTAS) {
      const permisos = Array.isArray(r.acceso) ? r.acceso : ['publica', 'sesion', 'servicio'].includes(r.acceso) ? [] : [r.acceso];
      for (const p of permisos) expect(Object.keys(PERMISOS)).toContain(p);
    }
  });

  it('genera OpenAPI 3 con seguridad JWT y los roles de cada permiso', () => {
    const spec = generarOpenApi() as any;
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    const alta = spec.paths['/api/vehiculos-autorizados/'].post;
    expect(alta['x-permisos']).toEqual(['padron:gestionar']);
    expect(alta.description).toContain('Gestor de permisos');
    expect(alta.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.paths['/api/auth/login'].post.security).toEqual([]);
  });

  it('convierte los parámetros de Express a la sintaxis OpenAPI', () => {
    expect(rutaOpenApi('/api/camaras/:id(\d+)/roi')).toBe('/api/camaras/{id}/roi');
    expect(rutaOpenApi('/api/medios/:ruta')).toBe('/api/medios/{ruta}');
  });
});
