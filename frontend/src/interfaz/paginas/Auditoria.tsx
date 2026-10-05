import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Archive, Download, KeyRound, Loader2, Search, UserCog, X } from 'lucide-react';
import api, { mensajeError, mensajeErrorDescarga } from '../../infraestructura/api';
import { useConsulta, useRetardado } from '../../aplicacion/hooks';
import type { Pagina } from '../../dominio/tipos';
import { fechaHora, fechaIsoLocal, limiteDia, nombreDescarga, numero } from '../../dominio/formato';
import { descargarBlob } from '../../infraestructura/descargas';
import { validarEntero } from '../../dominio/validacion';
import { LARGO_BUSQUEDA, RETENCION_AUDITORIA } from '../../dominio/reglas';
import { Aviso, Cargando, Confirmar, FilasEsqueleto, Modal, Paginacion, Pestanas, Tarjeta, Vacio } from '../componentes/ui';
import { CampoEntero } from '../componentes/campos';
import { useNotificar } from '../componentes/Notificaciones';

/**
 * Auditoría (solo Administrador): consulta paginada con filtros, detalle de cada registro,
 * exportación CSV y retención.
 *
 * Es de solo inserción (ISO/IEC 27001 A.8.15): la pantalla no ofrece editar ni borrar. La
 * retención traslada los registros antiguos a las tablas de archivo sin eliminarlos, y tanto la
 * exportación como la retención quedan a su vez registradas por la API.
 */

type Fuente = 'operaciones' | 'cuentas' | 'accesos';

const NOMBRE_FUENTE: Record<Fuente, string> = { operaciones: 'Operaciones', cuentas: 'Cuentas de usuario', accesos: 'Inicios de sesión' };

const MOTIVOS_ACCESO: Record<string, string> = {
  ok: 'Inicio de sesión correcto', credenciales: 'Contraseña incorrecta o correo inexistente', bloqueado: 'Cuenta bloqueada',
  bloqueo_por_intentos: 'Bloqueada por intentos fallidos', no_verificado: 'Correo sin verificar', inactivo: 'Cuenta inactiva',
};

const ENTIDADES: Record<string, string> = {
  deteccion: 'Ingreso', lista_negra: 'Lista negra', autorizado: 'Lista blanca', camara: 'Cámara', configuracion: 'Configuración',
  solicitud_acceso: 'Solicitud de acceso', auditoria: 'Auditoría',
};

/** Nombre de cada columna en el detalle (backend/src/dominio/auditoria.ts → CAMPOS_AUDITORIA). */
const ETIQUETA_CAMPO: Record<string, string> = {
  id: 'Identificador', fecha: 'Fecha y hora', accion: 'Acción', detalle: 'Detalle', ip: 'Dirección IP',
  usuario_id: 'Id del usuario', usuario_email: 'Usuario', entidad: 'Elemento', entidad_id: 'Id del elemento',
  actor_id: 'Id de quien actuó', actor_email: 'Realizado por', objetivo_id: 'Id de la cuenta afectada', objetivo_email: 'Cuenta afectada',
  email: 'Correo', exito: 'Resultado', motivo: 'Motivo', user_agent: 'Navegador (user agent)',
};

const legible = (accion: string) => accion.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());

/** Valor legible de una columna; el valor original se muestra junto a la traducción. */
function valorCampo(campo: string, valor: unknown): React.ReactNode {
  if (valor === null || valor === undefined || valor === '') return <span className="texto-secundario">—</span>;
  const texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  switch (campo) {
    case 'fecha': return <>{fechaHora(texto)} <span className="texto-secundario mono">{texto}</span></>;
    case 'exito': return <span className={`insignia ${valor ? 'autorizado' : 'alerta'}`}>{valor ? 'Correcto' : 'Fallido'}</span>;
    case 'accion': return <>{legible(texto)} <span className="texto-secundario mono">{texto}</span></>;
    case 'entidad': return ENTIDADES[texto] ?? texto;
    case 'motivo': return MOTIVOS_ACCESO[texto] ?? texto;
    case 'ip': case 'user_agent': return <span className="mono" style={{ fontSize: 12 }}>{texto}</span>;
    case 'detalle': return <span style={{ whiteSpace: 'pre-wrap' }}>{texto}</span>;
    default: return texto;
  }
}

/** Registro completo con todas las columnas de su fuente. Solo lectura. */
const DetalleRegistro: React.FC<{ fuente: Fuente; id: number; onCerrar: () => void }> = ({ fuente, id, onCerrar }) => {
  const { datos, cargando, error } = useConsulta<Record<string, unknown>>(
    () => api.get(`/auditoria/${fuente}/${id}`).then(r => r.data?.registro ?? r.data), [fuente, id]);
  return (
    <Modal titulo={`Registro de auditoría #${id}`} subtitulo={NOMBRE_FUENTE[fuente]} onCerrar={onCerrar}
      pie={<button className="btn btn-secondary" onClick={onCerrar}>Cerrar</button>}>
      {cargando && !datos ? <Cargando alto={140} /> : error ? <Aviso tipo="error">{error}</Aviso> : datos && (
        <div className="pila" style={{ gap: 14 }}>
          <dl className="definiciones">
            {Object.entries(datos).map(([campo, valor]) => (
              <React.Fragment key={campo}><dt>{ETIQUETA_CAMPO[campo] ?? campo}</dt><dd>{valorCampo(campo, valor)}</dd></React.Fragment>
            ))}
          </dl>
          <Aviso tipo="info">Registro inmutable: no puede editarse ni eliminarse desde el sistema (ISO/IEC 27001 A.8.15).</Aviso>
        </div>
      )}
    </Modal>
  );
};

interface Archivados { operaciones: number; cuentas: number; accesos: number }

const Auditoria: React.FC = () => {
  const notificar = useNotificar();
  const [params, setParams] = useSearchParams();
  const fuente = (['operaciones', 'cuentas', 'accesos'].includes(params.get('fuente') ?? '') ? params.get('fuente') : 'operaciones') as Fuente;
  const [texto, setTexto] = useState(params.get('q') ?? '');
  const q = useRetardado(texto, 400);
  const desde = params.get('desde') ?? '';
  const hasta = params.get('hasta') ?? '';
  const resultado = params.get('resultado') ?? '';
  const pagina = Number(params.get('pagina') ?? 1);
  const [detalle, setDetalle] = useState<{ fuente: Fuente; id: number } | null>(null);
  const [exportando, setExportando] = useState(false);
  const [retencion, setRetencion] = useState(false);
  const [dias, setDias] = useState(String(RETENCION_AUDITORIA.omision));
  const [archivado, setArchivado] = useState<{ dias: number; archivados: Archivados } | null>(null);

  const cambiar = (cambios: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(cambios)) { if (v) p.set(k, v); else p.delete(k); }
    if (!('pagina' in cambios)) p.delete('pagina');
    setParams(p, { replace: true });
  };
  React.useEffect(() => { if ((params.get('q') ?? '') !== q) cambiar({ q }); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mismos filtros para el listado y la exportación
  const filtros = useMemo(() => ({
    fuente, q: params.get('q') || undefined, resultado: resultado || undefined,
    desde: desde ? limiteDia(desde) : undefined, hasta: hasta ? limiteDia(hasta, true) : undefined,
  }), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const consulta = useMemo(() => ({ ...filtros, pagina, tamano: 30 }), [filtros, pagina]);
  const { datos, cargando, error, recargar } = useConsulta<Pagina<any>>(() => api.get('/auditoria', { params: consulta }).then(r => r.data), [consulta]);
  const hayFiltros = Boolean(params.get('q') || desde || hasta || resultado);

  const exportar = async () => {
    setExportando(true);
    try {
      const r = await api.get('/auditoria/exportar', { params: filtros, responseType: 'blob' });
      descargarBlob(r.data, nombreDescarga(r.headers['content-disposition'], `auditoria_${fuente}_${fechaIsoLocal()}.csv`));
      notificar('exito', 'Exportación generada', 'El CSV tiene los registros que cumplen los filtros. La exportación quedó registrada en la auditoría.');
    } catch (e) {
      notificar('error', 'No se pudo exportar', await mensajeErrorDescarga(e));
    } finally {
      setExportando(false);
    }
  };

  const diasValidos = validarEntero(dias, { etiqueta: 'Días', min: RETENCION_AUDITORIA.min, max: RETENCION_AUDITORIA.max, requerido: true }).ok;
  const aplicarRetencion = async () => {
    try {
      const r = await api.post('/auditoria/retencion', { dias: Number(dias) });
      const a: Archivados = { operaciones: 0, cuentas: 0, accesos: 0, ...r.data?.archivados };
      setArchivado({ dias: Number(dias), archivados: a });
      notificar('exito', 'Retención aplicada', `${numero(a.operaciones + a.cuentas + a.accesos)} registros trasladados al archivo.`);
      recargar(true);
    } catch (e) { throw new Error(mensajeError(e)); }
  };

  return (
    <div className="pagina">
      <div className="pila">
        <Aviso tipo="info">
          Los registros de auditoría son de solo inserción: no existe opción para editarlos ni eliminarlos (ISO/IEC 27001 A.8.15).
          La retención los traslada al archivo sin borrarlos, y tanto la exportación como la retención quedan registradas.
        </Aviso>
        {archivado && (
          <Aviso tipo="exito">
            <span className="fila" style={{ justifyContent: 'space-between', width: '100%', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <span>
                Retención aplicada: se trasladaron al archivo <b>{numero(archivado.archivados.operaciones)}</b> operaciones,{' '}
                <b>{numero(archivado.archivados.cuentas)}</b> registros de cuentas y <b>{numero(archivado.archivados.accesos)}</b> inicios
                de sesión con más de {numero(archivado.dias)} días. Se conservan en las tablas de archivo.
              </span>
              <button className="btn btn-ghost btn-sm btn-icono" onClick={() => setArchivado(null)} aria-label="Cerrar aviso"><X size={14} /></button>
            </span>
          </Aviso>
        )}
        <Pestanas<Fuente> valor={fuente} onCambiar={f => { setTexto(''); setParams({ fuente: f }, { replace: true }); }} opciones={[
          { valor: 'operaciones', etiqueta: NOMBRE_FUENTE.operaciones, icono: <Activity size={15} /> },
          { valor: 'cuentas', etiqueta: NOMBRE_FUENTE.cuentas, icono: <UserCog size={15} /> },
          { valor: 'accesos', etiqueta: NOMBRE_FUENTE.accesos, icono: <KeyRound size={15} /> },
        ]} />
        <Tarjeta>
          <div className="filtros">
            <div className="campo crece"><label htmlFor="a-q">Buscar</label>
              <div className="input-icono"><Search size={15} /><input id="a-q" className="input" value={texto} onChange={e => setTexto(e.target.value)}
                maxLength={LARGO_BUSQUEDA} placeholder={fuente === 'accesos' ? 'Correo, motivo o IP' : 'Usuario, acción o detalle'} /></div></div>
            {fuente === 'accesos' && (
              <div className="campo"><label htmlFor="a-res">Resultado</label>
                <select id="a-res" className="select" value={resultado} onChange={e => cambiar({ resultado: e.target.value })}>
                  <option value="">Todos</option><option value="exito">Correctos</option><option value="fallo">Fallidos</option>
                </select></div>
            )}
            <div className="campo" style={{ minWidth: 140 }}><label htmlFor="a-desde">Desde</label>
              <input id="a-desde" type="date" className="input" value={desde} max={hasta || undefined} onChange={e => cambiar({ desde: e.target.value })} /></div>
            <div className="campo" style={{ minWidth: 140 }}><label htmlFor="a-hasta">Hasta</label>
              <input id="a-hasta" type="date" className="input" value={hasta} min={desde || undefined} onChange={e => cambiar({ hasta: e.target.value })} /></div>
            {hayFiltros && <button className="btn btn-ghost" onClick={() => { setTexto(''); setParams({ fuente }, { replace: true }); }}><X size={15} /> Limpiar</button>}
          </div>
        </Tarjeta>
        {error && <Aviso tipo="error">{error}</Aviso>}
        <Tarjeta titulo={fuente === 'operaciones' ? 'Acciones sobre ingresos, listas, cámaras y configuración' : fuente === 'cuentas' ? 'Acciones sobre cuentas de usuario' : 'Intentos de inicio de sesión'}
          subtitulo="Seleccione un registro para ver todas sus columnas. Registro inalterable: no puede editarse ni borrarse."
          acciones={<>
            <button className="btn btn-secondary btn-sm" onClick={exportar} disabled={exportando || !datos?.total}
              title="Descarga los registros que cumplen los filtros actuales">
              {exportando ? <Loader2 size={14} className="girar" /> : <Download size={14} />} Exportar CSV
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setDias(String(RETENCION_AUDITORIA.omision)); setRetencion(true); }}
              title="Traslada al archivo los registros más antiguos que el plazo indicado">
              <Archive size={14} /> Retención
            </button>
          </>} sinPadding>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead>
                {fuente === 'accesos'
                  ? <tr><th>Fecha</th><th>Correo</th><th>Resultado</th><th>IP</th><th className="ocultar-movil">Navegador</th></tr>
                  : <tr><th>Fecha</th><th>Usuario</th><th>Acción</th>{fuente === 'operaciones' ? <th>Elemento</th> : <th>Cuenta afectada</th>}<th>Detalle</th><th className="ocultar-movil">IP</th></tr>}
              </thead>
              <tbody>
                {cargando && !datos ? <FilasEsqueleto columnas={6} /> : datos?.items.map(x => {
                  // La fila abre el detalle (clic, Enter o espacio)
                  const abrir = {
                    className: 'clic', tabIndex: 0, title: 'Ver el registro completo',
                    onClick: () => setDetalle({ fuente, id: x.id }),
                    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetalle({ fuente, id: x.id }); } },
                  };
                  return fuente === 'accesos' ? (
                    <tr key={x.id} {...abrir}>
                      <td className="nowrap">{fechaHora(x.fecha)}</td><td>{x.email}</td>
                      <td><span className={`insignia ${x.exito ? 'autorizado' : 'alerta'}`}>{MOTIVOS_ACCESO[x.motivo] ?? x.motivo}</span></td>
                      <td className="mono" style={{ fontSize: 12 }}>{x.ip || '—'}</td>
                      <td className="ocultar-movil truncar" style={{ maxWidth: 260 }} title={x.user_agent}>{x.user_agent || '—'}</td>
                    </tr>
                  ) : (
                    <tr key={x.id} {...abrir}>
                      <td className="nowrap">{fechaHora(x.fecha)}</td><td>{x.actor ?? <span className="texto-secundario">sistema</span>}</td>
                      <td><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{legible(x.accion)}</strong></td>
                      <td>{fuente === 'operaciones' ? <>{ENTIDADES[x.entidad] ?? x.entidad}{x.entidad_id ? <span className="secundario">#{x.entidad_id}</span> : null}</> : x.objetivo ?? '—'}</td>
                      <td style={{ maxWidth: 380 }}>{x.detalle ?? '—'}</td>
                      <td className="mono ocultar-movil" style={{ fontSize: 12 }}>{x.ip || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {datos && datos.items.length === 0 && <Vacio titulo="Sin registros" texto={hayFiltros ? 'Ningún registro coincide con los filtros.' : 'Aún no hay eventos de este tipo.'} />}
          {datos && datos.total > 0 && <Paginacion pagina={datos.pagina} tamano={datos.tamano} total={datos.total} onCambiar={p => cambiar({ pagina: String(p) })} />}
        </Tarjeta>
      </div>

      {detalle && <DetalleRegistro fuente={detalle.fuente} id={detalle.id} onCerrar={() => setDetalle(null)} />}
      {retencion && (
        <Confirmar titulo="Retención de la auditoría" textoBoton="Archivar registros" puedeConfirmar={diasValidos}
          mensaje={<div className="pila" style={{ gap: 12 }}>
            <p>Los registros con más antigüedad que el plazo indicado se <b>trasladan a las tablas de archivo</b>: no se eliminan, conservan
              todas sus columnas y siguen disponibles para una revisión.</p>
            <p className="texto-secundario">Se aplica a operaciones, cuentas e inicios de sesión en una sola transacción, y la operación
              queda registrada en la auditoría con su usuario y la cantidad de registros archivados.</p>
            <CampoEntero id="ret-dias" etiqueta="Archivar los registros con más de (días)*" nombre="Días de retención" valor={dias} onCambiar={setDias}
              min={RETENCION_AUDITORIA.min} max={RETENCION_AUDITORIA.max} requerido autoFocus
              ayuda={`Entre ${numero(RETENCION_AUDITORIA.min)} (1 año) y ${numero(RETENCION_AUDITORIA.max)} (10 años).`} />
          </div>}
          onConfirmar={aplicarRetencion} onCerrar={() => setRetencion(false)} />
      )}
    </div>
  );
};

export default Auditoria;
