import { casosAuth } from '../aplicacion/auth';
import { auditoriaCuentasSql, clavesBcrypt, tokensEnlace } from '../infraestructura/cuentas';
import { repositorioAuthSql } from '../infraestructura/persistencia/authSql';
import { firmarToken } from '../infraestructura/sesiones';
import { config } from '../infraestructura/servicios/configuracion';
import { emailService } from '../infraestructura/servicios/emailService';
import { dominiosPermitidos, maxIntentos, minutosBloqueo, urlFrontend } from '../infraestructura/servicios/seguridad';

/**
 * Raíz de composición de la autenticación: SQL Server, JWT, bcrypt, correo institucional y los
 * parámetros editables del sistema (registro público, dominios, intentos y minutos de bloqueo).
 */
export const auth = casosAuth({
  repositorio: repositorioAuthSql,
  auditoria: auditoriaCuentasSql,
  correo: emailService,
  tokens: tokensEnlace,
  claves: clavesBcrypt,
  sesiones: { firmar: u => firmarToken(u) },
  parametros: {
    registroHabilitado: () => config.booleano('registro_publico_habilitado'),
    dominiosPermitidos: () => dominiosPermitidos(),
    unidadInstitucional: () => config.texto('unidad_institucional'),
    maxIntentos: () => maxIntentos(),
    minutosBloqueo: () => minutosBloqueo(),
  },
  urlFrontend: () => urlFrontend(),
  registrarFallo: (contexto, e) => console.error(`[AUTH] ${contexto}:`, e instanceof Error ? e.message : e),
});
