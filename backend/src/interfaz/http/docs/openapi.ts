import type { Permiso } from '../../../dominio/permisos';
import { NOMBRE_ROL, rolesCon } from '../../../dominio/permisos';
import { RUTAS } from './rutas';

/**
 * Documentación OpenAPI 3.0 de la API (Swagger UI en /api/docs).
 *
 * La especificación se genera a partir de un catálogo declarativo (interfaz/http/docs/rutas.ts): cada ruta
 * declara su acceso —pública, sesión, token del servicio ANPR o permiso RBAC— y de ahí salen el
 * esquema de seguridad y los roles que pueden usarla. Una prueba (tests/docs/openapi.test.ts)
 * compara el catálogo con las rutas montadas en Express: una ruta nueva sin documentar, o una
 * documentada que ya no existe, hace fallar la integración continua.
 */

export type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface CampoDoc {
  tipo: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  descripcion?: string;
  requerido?: boolean;
  ejemplo?: unknown;
  valores?: string[];
  /** Formato OpenAPI (date, date-time, email, password, binary…) */
  formato?: string;
}

/** publica: sin credenciales · sesion: JWT de cualquier usuario · servicio: token del motor ANPR */
export type Acceso = 'publica' | 'sesion' | 'servicio' | Permiso | Permiso[];

export interface RutaDoc {
  metodo: Metodo;
  /** Ruta completa con la sintaxis de Express, idéntica a la montada (p. ej. '/api/camaras/:id(\\d+)') */
  ruta: string;
  /** Grupo en Swagger UI */
  etiqueta: string;
  resumen: string;
  descripcion?: string;
  acceso: Acceso;
  cuerpo?: Record<string, CampoDoc>;
  consulta?: Record<string, CampoDoc>;
  /** Respuestas destacadas además de las genéricas de autenticación */
  respuestas?: Record<number, string>;
  /** La respuesta es un archivo (CSV, imagen…) en lugar de JSON */
  archivo?: string;
}

/** '/api/camaras/:id(\\d+)' → '/api/camaras/{id}' */
export function rutaOpenApi(ruta: string): string {
  return ruta.replace(/:(\w+)(\([^)]*\))?\??/g, '{$1}');
}

function esquema(c: CampoDoc): Record<string, unknown> {
  return {
    type: c.tipo,
    ...(c.formato ? { format: c.formato } : {}),
    ...(c.descripcion ? { description: c.descripcion } : {}),
    ...(c.valores ? { enum: c.valores } : {}),
    ...(c.ejemplo !== undefined ? { example: c.ejemplo } : {}),
    ...(c.tipo === 'array' ? { items: {} } : {}),
  };
}

function permisosDe(acceso: Acceso): Permiso[] {
  if (Array.isArray(acceso)) return acceso;
  return acceso === 'publica' || acceso === 'sesion' || acceso === 'servicio' ? [] : [acceso];
}

function textoAcceso(acceso: Acceso): string {
  if (acceso === 'publica') return 'Acceso: **público**.';
  if (acceso === 'sesion') return 'Acceso: **cualquier usuario con sesión**.';
  if (acceso === 'servicio') return 'Acceso: **servicio ANPR** (cabecera `X-Servicio-Token`).';
  const permisos = permisosDe(acceso);
  const roles = Object.keys(NOMBRE_ROL)
    .filter(r => permisos.every(p => rolesCon(p).includes(r as never)))
    .map(r => NOMBRE_ROL[r as keyof typeof NOMBRE_ROL]);
  return `Permiso requerido: ${permisos.map(p => `\`${p}\``).join(' + ')} · Roles: ${roles.join(', ')}.`;
}

export function generarOpenApi(rutas: RutaDoc[] = RUTAS): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of rutas) {
    const ruta = rutaOpenApi(r.ruta);
    const parametros = [...ruta.matchAll(/\{(\w+)\}/g)].map(m => ({
      name: m[1], in: 'path', required: true, schema: { type: /id$/i.test(m[1]) ? 'integer' : 'string' },
    }));
    for (const [nombre, c] of Object.entries(r.consulta ?? {})) {
      parametros.push({ name: nombre, in: 'query', required: !!c.requerido, schema: esquema(c) } as never);
    }
    const respuestas: Record<string, unknown> = {
      200: r.archivo
        ? { description: 'Archivo', content: { [r.archivo]: { schema: { type: 'string', format: 'binary' } } } }
        : { description: 'Operación correcta' },
    };
    for (const [codigo, texto] of Object.entries(r.respuestas ?? {})) respuestas[codigo] = { description: texto };
    if (r.acceso !== 'publica') respuestas[401] ??= { description: 'Sin credenciales o credenciales inválidas' };
    if (permisosDe(r.acceso).length) respuestas[403] ??= { description: 'El rol no tiene el permiso requerido' };

    const requeridos = Object.entries(r.cuerpo ?? {}).filter(([, c]) => c.requerido).map(([n]) => n);
    paths[ruta] ??= {};
    paths[ruta][r.metodo] = {
      tags: [r.etiqueta],
      summary: r.resumen,
      description: [r.descripcion, textoAcceso(r.acceso)].filter(Boolean).join('\n\n'),
      ...(parametros.length ? { parameters: parametros } : {}),
      ...(r.cuerpo ? {
        requestBody: {
          required: requeridos.length > 0,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: Object.fromEntries(Object.entries(r.cuerpo).map(([n, c]) => [n, esquema(c)])),
            ...(requeridos.length ? { required: requeridos } : {}),
          } } },
        },
      } : {}),
      responses: respuestas,
      security: r.acceso === 'publica' ? [] : r.acceso === 'servicio' ? [{ servicioAnpr: [] }] : [{ bearerAuth: [] }],
      ...(permisosDe(r.acceso).length ? { 'x-permisos': permisosDe(r.acceso) } : {}),
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'ECU 911 · Sistema ANPR — API',
      version: '1.0.0',
      description: [
        'API del sistema de reconocimiento automático de placas para el control de ingreso vehicular.',
        '',
        '**Autenticación:** obtenga un token con `POST /api/auth/login` y péguelo en **Authorize** (esquema `bearerAuth`).',
        'Cada operación indica el permiso RBAC que exige y los roles que lo tienen: Administrador, Guardia y Gestor de permisos.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'Este servidor' }],
    tags: [...new Set(rutas.map(r => r.etiqueta))].map(name => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        servicioAnpr: { type: 'apiKey', in: 'header', name: 'X-Servicio-Token' },
      },
    },
    paths,
  };
}
