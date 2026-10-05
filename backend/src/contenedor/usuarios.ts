import { casosUsuarios } from '../aplicacion/usuarios';
import { auditoriaCuentasSql, clavesBcrypt, tokensEnlace } from '../infraestructura/cuentas';
import { repositorioUsuariosSql } from '../infraestructura/persistencia/usuariosSql';
import { invalidarCuenta } from '../infraestructura/sesiones';
import { emailService } from '../infraestructura/servicios/emailService';
import { dominiosPermitidos, urlFrontend } from '../infraestructura/servicios/seguridad';

/**
 * Raíz de composición de la administración de cuentas: SQL Server, correo institucional, bcrypt
 * y la invalidación inmediata de las sesiones de la cuenta afectada.
 */
export const usuarios = casosUsuarios({
  repositorio: repositorioUsuariosSql,
  auditoria: auditoriaCuentasSql,
  correo: emailService,
  tokens: tokensEnlace,
  claves: clavesBcrypt,
  // Borra el estado de la cuenta en la caché del middleware y cierra sus conexiones de tiempo real
  invalidarSesiones: id => invalidarCuenta(id),
  dominiosPermitidos: () => dominiosPermitidos(),
  urlFrontend: () => urlFrontend(),
});
