import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { type DefinicionLista, LISTA_BLANCA, LISTA_NEGRA } from '../../../dominio/listas';
import { listas } from '../../../contenedor/listas';
import { actorDe, controlador, idDe } from '../respuesta';

/**
 * Listas de control (lista blanca y lista negra). CRUD con el mismo contrato:
 *
 *   GET    /       registros activos (vigentes y vencidos, con la marca `vigente`)
 *   GET    /:id    detalle de un registro
 *   POST   /       alta (reactiva el registro si la placa se había retirado)
 *   PUT    /:id    edición
 *   DELETE /:id    retiro (baja lógica) con motivo
 *
 * Lectura: listas:ver. Cambios: el permiso de cada lista (padron:gestionar para la lista
 * blanca, alertas:gestionar para la lista negra). Las reglas están en dominio/listas.ts y los
 * casos de uso en aplicacion/listas.ts.
 */
function crearRouter(def: DefinicionLista): Router {
  const router = Router();
  const lectura = [authMiddleware, requierePermiso('listas:ver')];
  const edicion = [authMiddleware, requierePermiso(def.permisoEdicion)];
  const contexto = `LISTAS ${def.nombre}`;

  router.get('/', ...lectura, controlador(contexto, `No se pudo consultar la ${def.nombre}.`, async (_req, res) => {
    res.json(await listas.listar(def));
  }));

  router.get('/:id(\\d+)', ...lectura, controlador(contexto, 'No se pudo consultar el registro.', async (req, res) => {
    const id = idDe(req, res);
    if (id !== null) res.json(await listas.obtener(def, id));
  }));

  router.post('/', ...edicion, controlador(contexto, 'No se pudo guardar el registro.', async (req, res) => {
    const { item, accion } = await listas.registrar(def, req.body, actorDe(req));
    res.status(accion === 'reactivado' ? 200 : 201).json({
      message: accion === 'reactivado' ? 'Registro reactivado.' : 'Registro creado.',
      item,
    });
  }));

  router.put('/:id(\\d+)', ...edicion, controlador(contexto, 'No se pudo actualizar el registro.', async (req, res) => {
    const id = idDe(req, res);
    if (id !== null) res.json({ message: 'Registro actualizado.', item: await listas.editar(def, id, req.body, actorDe(req)) });
  }));

  router.delete('/:id(\\d+)', ...edicion, controlador(contexto, 'No se pudo retirar el registro.', async (req, res) => {
    const id = idDe(req, res);
    if (id === null) return;
    await listas.retirar(def, id, req.body?.motivo, actorDe(req));
    res.json({ message: 'Registro retirado de la lista.' });
  }));

  return router;
}

export const autorizadosRouter = crearRouter(LISTA_BLANCA);
export const alertasRouter = crearRouter(LISTA_NEGRA);
