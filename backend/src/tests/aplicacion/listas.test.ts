import { casosListas, type RepositorioListas } from '../../aplicacion/listas';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { LISTA_BLANCA, LISTA_NEGRA } from '../../dominio/listas';

/** Casos de uso de las listas con dobles de prueba: sin base de datos, sin red. */

const ACTOR: Actor = { id: 9, email: 'gestor@ecu911.gob.ec', nombre: 'Gestor', rol: 'GestorPermisos', ip: '10.0.0.1' };

function preparar(existente: { id: number; activo: boolean } | null = null) {
  const repositorio: jest.Mocked<RepositorioListas> = {
    listar: jest.fn().mockResolvedValue([]),
    obtener: jest.fn().mockImplementation(async (_d, id) => ({ id, placa: 'PBA1234', propietario: 'Juan Pérez' })),
    obtenerActivo: jest.fn().mockResolvedValue({ id: 5, placa: 'PBA1234', propietario: 'Juan Pérez', categoria: 'FUNCIONARIO' }),
    buscarPorPlaca: jest.fn().mockResolvedValue(existente),
    existeOtraConPlaca: jest.fn().mockResolvedValue(false),
    crear: jest.fn().mockResolvedValue(77),
    reactivar: jest.fn().mockResolvedValue(undefined),
    actualizar: jest.fn().mockResolvedValue(undefined),
    retirar: jest.fn().mockResolvedValue('PBA1234'),
  };
  const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emitir: jest.fn() };
  const avisos = { registroAgregado: jest.fn() };
  const casos = casosListas({ repositorio, auditoria, eventos, avisos, describirHorario: () => 'Todos los días' });
  return { casos, repositorio, auditoria, eventos, avisos };
}

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · listas', () => {
  it('registrar: valida, crea, audita, difunde y avisa a la garita', async () => {
    const { casos, repositorio, auditoria, eventos, avisos } = preparar();
    const r = await casos.registrar(LISTA_BLANCA, { placa: 'pba-1234', propietario: 'Juan Pérez', color: 'Blanco' }, ACTOR);
    expect(r.accion).toBe('creado');
    expect(repositorio.crear).toHaveBeenCalledWith(LISTA_BLANCA, expect.objectContaining({ placa: 'PBA1234' }), 9, undefined);
    expect(auditoria.operacion).toHaveBeenCalledWith(ACTOR, 'LISTA_ALTA', 'autorizado', 77, expect.stringContaining('PBA1234'));
    expect(eventos.emitir).toHaveBeenCalledWith('listas:actualizadas', { lista: 'autorizado' });
    expect(avisos.registroAgregado).toHaveBeenCalledWith(LISTA_BLANCA, expect.objectContaining({ id: 77 }), ACTOR);
  });

  it('registrar: rechaza placas fuera del formato AAA-1234 / AA-123A sin tocar la base', async () => {
    const { casos, repositorio } = preparar();
    const e = await fallo(casos.registrar(LISTA_BLANCA, { placa: 'ABC123', propietario: 'Juan Pérez' }, ACTOR));
    expect(e.tipo).toBe('validacion');
    expect(e.message).toMatch(/ABC-1234/);
    expect(repositorio.buscarPorPlaca).not.toHaveBeenCalled();
  });

  it('registrar: rechaza un propietario con números y un color con dígitos', async () => {
    const { casos } = preparar();
    expect((await fallo(casos.registrar(LISTA_BLANCA, { placa: 'PBA1234', propietario: 'Juan 23' }, ACTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.registrar(LISTA_BLANCA, { placa: 'PBA1234', propietario: 'Juan', color: 'Rojo2' }, ACTOR))).tipo).toBe('validacion');
  });

  it('registrar: conflicto si la placa ya está activa; reactiva si se había retirado', async () => {
    expect((await fallo(preparar({ id: 5, activo: true }).casos.registrar(LISTA_BLANCA, { placa: 'PBA1234', propietario: 'Ana' }, ACTOR))).tipo)
      .toBe('conflicto');
    const { casos, repositorio, auditoria } = preparar({ id: 5, activo: false });
    expect((await casos.registrar(LISTA_BLANCA, { placa: 'PBA1234', propietario: 'Ana' }, ACTOR)).accion).toBe('reactivado');
    expect(repositorio.reactivar).toHaveBeenCalled();
    expect(auditoria.operacion).toHaveBeenCalledWith(ACTOR, 'LISTA_REACTIVADO', 'autorizado', 5, expect.any(String));
  });

  it('guardar con actualizarSiExiste (aprobación de solicitud): amplía el permiso activo', async () => {
    const { casos, repositorio } = preparar({ id: 5, activo: true });
    const r = casos.validar(LISTA_BLANCA, { placa: 'PBA1234', propietario: 'Ana' });
    expect(await casos.guardar(LISTA_BLANCA, r, ACTOR, { actualizarSiExiste: true })).toEqual({ id: 5, accion: 'actualizado' });
    expect(repositorio.actualizar).toHaveBeenCalledWith(LISTA_BLANCA, 5, r);
  });

  it('editar: 404 si no existe; 409 si otra fila tiene la placa', async () => {
    const a = preparar();
    a.repositorio.obtenerActivo.mockResolvedValue(null);
    expect((await fallo(a.casos.editar(LISTA_BLANCA, 5, { placa: 'PBA1234', propietario: 'Ana' }, ACTOR))).tipo).toBe('no_encontrado');
    const b = preparar();
    b.repositorio.existeOtraConPlaca.mockResolvedValue(true);
    expect((await fallo(b.casos.editar(LISTA_BLANCA, 5, { placa: 'PBA1234', propietario: 'Ana' }, ACTOR))).tipo).toBe('conflicto');
  });

  it('lista negra: no avisa a la garita como alta de permiso y exige motivo y nivel válidos', async () => {
    const { casos } = preparar();
    expect((await fallo(casos.registrar(LISTA_NEGRA, { placa: 'PBA1234', motivo: 'Robo', nivel_alerta: 'ALTA' }, ACTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.registrar(LISTA_NEGRA, { placa: 'PBA1234', motivo: 'Vehículo robado', nivel_alerta: 'URGENTE' }, ACTOR))).tipo).toBe('validacion');
  });

  it('retirar: exige motivo y audita', async () => {
    const { casos, auditoria } = preparar();
    expect((await fallo(casos.retirar(LISTA_BLANCA, 5, 'no', ACTOR))).tipo).toBe('validacion');
    await casos.retirar(LISTA_BLANCA, 5, 'Finalizó el contrato', ACTOR);
    expect(auditoria.operacion).toHaveBeenCalledWith(ACTOR, 'LISTA_RETIRO', 'autorizado', 5, 'PBA1234 · Finalizó el contrato');
  });
});
