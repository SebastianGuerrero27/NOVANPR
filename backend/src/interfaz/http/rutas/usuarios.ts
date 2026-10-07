import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { usuarios } from '../../../contenedor/usuarios';
import { actorDe, controlador, idDe } from '../respuesta';

/**
 * Administración de cuentas (permiso usuarios:gestionar). Toda acción queda en AuditoriaUsuarios.
 *
 *   GET    /api/usuarios                          listado
 *   GET    /api/usuarios/roles                    catálogo de roles
 *   GET    /api/usuarios/auditoria                acciones administrativas y accesos recientes
 *   GET    /api/usuarios/:id                      detalle (mismo formato que un elemento del listado)
 *   POST   /api/usuarios                          crea cuenta y envía enlace para definir contraseña
 *   PUT    /api/usuarios/:id                      nombre, cargo, rol, estado
 *   POST   /api/usuarios/:id/bloquear             bloqueo administrativo
 *   POST   /api/usuarios/:id/desbloquear          quita bloqueos (administrativo y por intentos)
 *   POST   /api/usuarios/:id/restablecer-password envía enlace de restablecimiento
 *   DELETE /api/usuarios/:id                      baja lógica (estado inactivo) con motivo
 *
 * Las reglas están en dominio/usuarios.ts y los casos de uso en aplicacion/usuarios.ts.
 */
const router = Router();
router.use(authMiddleware, requierePermiso('usuarios:gestionar'));

router.get('/', controlador('USUARIOS listar', 'No se pudo obtener la lista de usuarios.', async (_req, res) => {
  res.json(await usuarios.listar());
}));

router.get('/roles', controlador('USUARIOS roles', 'No se pudo obtener el catálogo de roles.', async (_req, res) => {
  res.json(await usuarios.roles());
}));

router.get('/auditoria', controlador('USUARIOS auditoría', 'No se pudo obtener la auditoría.', async (req, res) => {
  res.json(await usuarios.auditoria(req.query.limite));
}));

// Después de /roles y /auditoria: el patrón /:id también los captura
router.get('/:id', controlador('USUARIOS detalle', 'No se pudo obtener el usuario.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await usuarios.obtener(id));
}));

router.post('/', controlador('USUARIOS crear', 'No se pudo crear el usuario.', async (req, res) => {
  const { usuario, enviado } = await usuarios.crear(req.body, actorDe(req));
  res.status(201).json({
    message: enviado
      ? 'Usuario creado. Se envió un correo para que defina su contraseña.'
      : 'Usuario creado, pero no se pudo enviar el correo. Use "Enviar enlace de contraseña".',
    usuario,
  });
}));

router.put('/:id', controlador('USUARIOS actualizar', 'No se pudo actualizar el usuario.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Usuario actualizado.', usuario: await usuarios.editar(id, req.body, actorDe(req)) });
}));

router.post('/:id/bloquear', controlador('USUARIOS bloquear', 'No se pudo bloquear el usuario.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Usuario bloqueado.', usuario: await usuarios.bloquear(id, req.body?.motivo, actorDe(req)) });
}));

router.post('/:id/desbloquear', controlador('USUARIOS desbloquear', 'No se pudo desbloquear el usuario.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Usuario desbloqueado.', usuario: await usuarios.desbloquear(id, actorDe(req)) });
}));

router.post('/:id/restablecer-password', controlador('USUARIOS restablecer', 'No se pudo generar el enlace.', async (req, res) => {
  const id = idDe(req, res);
  if (id === null) return;
  const enviado = await usuarios.enviarEnlacePassword(id, actorDe(req));
  res.json({ message: enviado ? 'Enlace de restablecimiento enviado.' : 'No se pudo enviar el correo.' });
}));

router.delete('/:id', controlador('USUARIOS baja', 'No se pudo dar de baja la cuenta.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Cuenta dada de baja.', usuario: await usuarios.darDeBaja(id, req.body?.motivo, actorDe(req)) });
}));

export default router;
