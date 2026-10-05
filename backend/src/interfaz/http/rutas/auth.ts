import { type Request, type Response, Router } from 'express';
import { authMiddleware } from '../middlewares/auth';
import { type MotivoRechazo, RechazoAutenticacion } from '../../../aplicacion/auth';
import type { Visitante } from '../../../aplicacion/usuarios';
import { auth } from '../../../contenedor/auth';
import { ipDe } from '../peticion';
import { actorDe, controlador } from '../respuesta';

/**
 * Autenticación y ciclo de vida de la cuenta.
 *
 *   GET  /api/auth/estado                  ¿falta la configuración inicial? ¿SMTP activo?
 *   POST /api/auth/configuracion-inicial   crea el PRIMER administrador (solo si no hay ninguno)
 *   POST /api/auth/login                   correo + contraseña (bloqueo temporal por intentos)
 *   POST /api/auth/registro                cuenta nueva (rol Guardia) + correo de verificación
 *   GET  /api/auth/verificar-email         activa la cuenta con el token del correo
 *   POST /api/auth/reenviar-verificacion   nuevo enlace de verificación
 *   POST /api/auth/olvide-password         enlace de restablecimiento (respuesta siempre genérica)
 *   POST /api/auth/restablecer-password    define la nueva contraseña con el token
 *   GET  /api/auth/me                      datos de la sesión actual (incluye los permisos del rol)
 *   PUT  /api/auth/perfil                  nombre y cargo propios
 *   POST /api/auth/cambiar-password        cambio con la contraseña actual
 *
 * Las reglas están en dominio/usuarios.ts y los casos de uso en aplicacion/auth.ts.
 */
const router = Router();

/** Código HTTP de cada rechazo de la autenticación (los demás errores los traduce controlador()). */
const ESTADO_RECHAZO: Record<MotivoRechazo, number> = {
  credenciales: 401,
  sesion_inactiva: 401,
  bloqueo_administrativo: 403,
  no_verificado: 403,
  inactiva: 403,
  enlace_vencido: 410,
  bloqueo_temporal: 423,
};

/**
 * controlador() que además responde los rechazos de la autenticación con su código: { error, codigo? }.
 * Lo usan todas las rutas del módulo, de modo que un rechazo nunca termine en un 500.
 */
function controladorAuth(contexto: string, mensaje500: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return controlador(contexto, mensaje500, async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!(e instanceof RechazoAutenticacion)) throw e;
      if (!res.headersSent) res.status(ESTADO_RECHAZO[e.motivo]).json({ error: e.message, ...(e.codigo ? { codigo: e.codigo } : {}) });
    }
  });
}

/**
 * Flujo de respuesta genérica: responde lo mismo pase lo que pase (no permite descubrir correos
 * registrados). El caso de uso no falla: registra sus errores en el log.
 */
function respuestaGenerica(mensaje: string, fn: (req: Request) => Promise<void>) {
  return async (req: Request, res: Response) => {
    await fn(req).catch(() => undefined);
    res.json({ message: mensaje });
  };
}

/** Quien usa un flujo público (sin sesión): su IP y su navegador quedan en la auditoría. */
const visitanteDe = (req: Request): Visitante => ({ ip: ipDe(req), agente: String(req.headers['user-agent'] || '') });

// ─────────────────────────────────────────────────────────────────────────────

router.get('/estado', controladorAuth('AUTH estado', 'No se pudo consultar el estado del sistema.', async (_req, res) => {
  res.json(await auth.estado());
}));

router.post('/configuracion-inicial', controladorAuth('AUTH configuración inicial', 'No se pudo crear el administrador.', async (req, res) => {
  const sesion = await auth.configuracionInicial(req.body, visitanteDe(req));
  res.status(201).json({ message: 'Administrador creado.', ...sesion });
}));

router.post('/login', controladorAuth('AUTH login', 'Error interno al iniciar sesión.', async (req, res) => {
  res.json(await auth.login(req.body, visitanteDe(req)));
}));

router.post('/registro', controladorAuth('AUTH registro', 'No se pudo completar el registro.', async (req, res) => {
  const { enviado } = await auth.registrar(req.body, visitanteDe(req));
  res.status(201).json({
    message: enviado
      ? 'Cuenta creada. Revise su correo y siga el enlace para activarla.'
      : 'Cuenta creada, pero no se pudo enviar el correo de verificación. Solicite un nuevo enlace.',
  });
}));

router.get('/verificar-email', controladorAuth('AUTH verificar email', 'No se pudo verificar el correo.', async (req, res) => {
  const resultado = await auth.verificarEmail(req.query.token, visitanteDe(req));
  res.json({
    message: resultado === 'ya_verificado'
      ? 'Su correo ya estaba verificado. Puede iniciar sesión.'
      : 'Correo verificado. Su cuenta está activa: ya puede iniciar sesión.',
  });
}));

router.post('/reenviar-verificacion', respuestaGenerica(
  'Si la cuenta existe y está pendiente de verificación, recibirá un nuevo enlace.',
  req => auth.reenviarVerificacion(req.body?.email),
));

router.post('/olvide-password', respuestaGenerica(
  'Si el correo pertenece a una cuenta activa, recibirá un enlace para restablecer la contraseña.',
  req => auth.olvidePassword(req.body?.email, visitanteDe(req)),
));

router.post('/restablecer-password', controladorAuth('AUTH restablecer contraseña', 'No se pudo restablecer la contraseña.', async (req, res) => {
  await auth.restablecerPassword(req.body, visitanteDe(req));
  res.json({ message: 'Contraseña actualizada. Ya puede iniciar sesión.' });
}));

router.get('/me', authMiddleware, controladorAuth('AUTH me', 'No se pudo obtener la sesión.', async (req, res) => {
  res.json({ user: await auth.sesionActual(req.user!.id) });
}));

/** Datos propios editables por el usuario (nombre y cargo). El correo y el rol los gestiona el administrador. */
router.put('/perfil', authMiddleware, controladorAuth('AUTH perfil', 'No se pudo actualizar el perfil.', async (req, res) => {
  await auth.actualizarPerfil(req.body, actorDe(req));
  res.json({ message: 'Perfil actualizado.' });
}));

router.post('/cambiar-password', authMiddleware, controladorAuth('AUTH cambiar contraseña', 'No se pudo cambiar la contraseña.', async (req, res) => {
  await auth.cambiarPassword(req.body, actorDe(req));
  res.json({ message: 'Contraseña actualizada.' });
}));

export default router;
