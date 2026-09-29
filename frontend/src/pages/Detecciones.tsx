import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Filter, RefreshCw, Search, Trash2, X } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta, useRetardado } from '../lib/hooks';
import type { Camara, Deteccion, EstadoValidacion, Pagina } from '../lib/tipos';
import { descargarBlob, ESTADOS, fecha, hora, limiteDia, nombreDescarga, porcentaje } from '../lib/formato';
import { Aviso, FilasEsqueleto, InsigniaEstado, Paginacion, Placa, Tarjeta, Vacio } from '../components/ui';
import { describirVehiculo, ImagenEvidencia, ValidarModal } from '../components/deteccion';
import { VisorZoom } from '../components/ZoomDual';
import { EliminarUno, EliminarVarios } from '../components/EliminarDetecciones';
import { useAuth } from '../context/AuthContext';
import { useNotificar } from '../components/Notificaciones';

/** Marca breve junto a la placa (OK en verde, ALERTA en rojo), como en la versión anterior. */
const MarcaEstado: React.FC<{ d: Deteccion }> = ({ d }) =>
  d.estado_validacion === 'autorizado' ? <span className="marca-estado ok">OK</span>
    : d.estado_validacion === 'alerta' ? <span className="marca-estado alerta">ALERTA</span> : null;

const ESTADOS_FILTRO: (EstadoValidacion | '')[] = ['', 'autorizado', 'pendiente_revision', 'no_reconocido', 'alerta'];

const Detecciones: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const notificar = useNotificar();
  const [validando, setValidando] = useState<Deteccion | null>(null);
  const [zoom, setZoom] = useState<Deteccion | null>(null);
  const [eliminando, setEliminando] = useState<Deteccion | null>(null);
  const [eliminarVarios, setEliminarVarios] = useState(false);
  const esAdmin = useAuth().tieneRol('Admin');
  const [exportando, setExportando] = useState(false);
  const [nuevos, setNuevos] = useState(0);
  const [placaTexto, setPlacaTexto] = useState(params.get('placa') ?? '');
  const placa = useRetardado(placaTexto, 400);

  const filtros = {
    estado: params.get('estado') ?? '',
    camara: params.get('camara') ?? '',
    desde: params.get('desde') ?? '',
    hasta: params.get('hasta') ?? '',
    validado: params.get('validado') ?? '',
    pagina: Number(params.get('pagina') ?? 1),
  };
  const cambiar = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    if (k !== 'pagina') p.delete('pagina');
    setParams(p, { replace: true });
  };
  React.useEffect(() => { if ((params.get('placa') ?? '') !== placa) cambiar('placa', placa); }, [placa]); // eslint-disable-line react-hooks/exhaustive-deps

  const consultaParams = useMemo(() => ({
    placa: params.get('placa') || undefined,
    estado: filtros.estado || undefined,
    camara: filtros.camara || undefined,
    validado: filtros.validado || undefined,
    desde: filtros.desde ? limiteDia(filtros.desde) : undefined,
    hasta: filtros.hasta ? limiteDia(filtros.hasta, true) : undefined,
  }), [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const { datos, cargando, error, recargar, setDatos } = useConsulta<Pagina<Deteccion>>(
    () => api.get('/detecciones', { params: { ...consultaParams, pagina: filtros.pagina, tamano: 25 } }).then(r => r.data),
    [consultaParams, filtros.pagina]);
  const { datos: camaras } = useConsulta<Camara[]>(() => api.get('/camaras').then(r => r.data), []);

  // En vivo: las filas visibles se actualizan; los ingresos nuevos se anuncian sin mover la tabla
  useEvento<Deteccion>('deteccion:nueva', () => setNuevos(n => n + 1));
  useEvento<Deteccion>('deteccion:actualizada', d => setDatos(p => p && { ...p, items: p.items.map(x => (x.id === d.id ? d : x)) }));
  useEvento<{ id: number }>('deteccion:eliminada', ({ id }) => setDatos(p => p && { ...p, items: p.items.filter(x => x.id !== id), total: p.total - 1 }));
  useEvento('deteccion:eliminadas', () => { setNuevos(0); recargar(true); });

  const hayFiltros = Boolean(params.get('placa') || filtros.estado || filtros.camara || filtros.desde || filtros.hasta || filtros.validado);

  const exportar = async () => {
    setExportando(true);
    try {
      const r = await api.get('/detecciones/exportar', { params: consultaParams, responseType: 'blob' });
      descargarBlob(r.data, nombreDescarga(r.headers['content-disposition'], 'ingresos_anpr.csv'));
      notificar('exito', 'Exportación generada', 'El archivo CSV se descargó con los filtros aplicados.');
    } catch (e) {
      notificar('error', 'No se pudo exportar', mensajeError(e));
    } finally {
      setExportando(false);
    }
  };

  return (
    <div className="pagina">
      <div className="pila">
        <Tarjeta>
          <div className="filtros">
            <div className="campo crece">
              <label htmlFor="f-placa">Placa</label>
              <div className="input-icono"><Search size={15} />
                <input id="f-placa" className="input placa-input" value={placaTexto} onChange={e => setPlacaTexto(e.target.value.toUpperCase())} placeholder="Buscar placa" maxLength={10} />
              </div>
            </div>
            <div className="campo">
              <label htmlFor="f-estado">Estado</label>
              <select id="f-estado" className="select" value={filtros.estado} onChange={e => cambiar('estado', e.target.value)}>
                {ESTADOS_FILTRO.map(e => <option key={e} value={e}>{e ? ESTADOS[e].etiqueta : 'Todos'}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="f-camara">Cámara</label>
              <select id="f-camara" className="select" value={filtros.camara} onChange={e => cambiar('camara', e.target.value)}>
                <option value="">Todas</option>
                {camaras?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="f-validado">Validación</label>
              <select id="f-validado" className="select" value={filtros.validado} onChange={e => cambiar('validado', e.target.value)}>
                <option value="">Todas</option>
                <option value="si">Confirmadas por el personal</option>
                <option value="no">Solo automáticas</option>
              </select>
            </div>
            <div className="campo" style={{ minWidth: 140 }}>
              <label htmlFor="f-desde">Desde</label>
              <input id="f-desde" type="date" className="input" value={filtros.desde} max={filtros.hasta || undefined} onChange={e => cambiar('desde', e.target.value)} />
            </div>
            <div className="campo" style={{ minWidth: 140 }}>
              <label htmlFor="f-hasta">Hasta</label>
              <input id="f-hasta" type="date" className="input" value={filtros.hasta} min={filtros.desde || undefined} onChange={e => cambiar('hasta', e.target.value)} />
            </div>
            {hayFiltros && <button className="btn btn-ghost" onClick={() => { setPlacaTexto(''); setParams({}, { replace: true }); }}><X size={15} /> Limpiar</button>}
          </div>
        </Tarjeta>

        {nuevos > 0 && (
          <Aviso tipo="info">
            <span className="fila" style={{ justifyContent: 'space-between', width: '100%' }}>
              {nuevos === 1 ? 'Se registró 1 ingreso nuevo.' : `Se registraron ${nuevos} ingresos nuevos.`}
              <button className="btn btn-sm btn-secondary" onClick={() => { setNuevos(0); cambiar('pagina', ''); recargar(); }}><RefreshCw size={13} /> Mostrar</button>
            </span>
          </Aviso>
        )}
        {error && <Aviso tipo="error">{error}</Aviso>}

        <Tarjeta titulo="Ingresos registrados" subtitulo={datos ? `${datos.total.toLocaleString('es-EC')} registros${hayFiltros ? ' con los filtros aplicados' : ''}` : undefined}
          acciones={<>
            <button className="btn btn-secondary btn-sm" onClick={exportar} disabled={exportando || !datos?.total}><Download size={14} /> {exportando ? 'Exportando…' : 'Exportar CSV'}</button>
            {esAdmin && <button className="btn btn-danger btn-sm" onClick={() => setEliminarVarios(true)} disabled={!datos?.total}>
              <Trash2 size={14} /> {hayFiltros ? 'Eliminar filtrados' : 'Eliminar todos'}</button>}
          </>}
          sinPadding>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead><tr>
                <th style={{ width: 78 }}>Evidencia</th><th>Placa</th><th>Fecha y hora</th><th>Estado</th><th>Cámara</th>
                <th className="ocultar-movil">Vehículo / titular</th><th className="num ocultar-movil">Confianza OCR</th><th>Validación</th>{esAdmin && <th />}
              </tr></thead>
              <tbody>
                {cargando && !datos ? <FilasEsqueleto columnas={esAdmin ? 9 : 8} /> : datos?.items.map(d => (
                  <tr key={d.id} className={`clic${d.estado_validacion === 'autorizado' ? ' fila-autorizado' : d.estado_validacion === 'alerta' ? ' fila-alerta' : ''}`} onClick={() => navigate(`/detecciones/${d.id}`)}>
                    <td onClick={e => { e.stopPropagation(); if (d.imagen_placa || d.imagen_vehiculo) setZoom(d); }} className="miniatura-zoom" title="Ampliar evidencia">
                      <ImagenEvidencia ruta={d.imagen_placa || d.imagen_vehiculo} alt="" alto={40} ajuste="contain" fondoOscuro /></td>
                    <td className="nowrap"><Placa valor={d.placa} /> <MarcaEstado d={d} /></td>
                    <td className="nowrap"><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{hora(d.fecha_hora_ingreso)}</strong><span className="secundario">{fecha(d.fecha_hora_ingreso)}</span></td>
                    <td><InsigniaEstado estado={d.estado_validacion} procesando={d.estado_procesamiento === 'pendiente_ocr'} /></td>
                    <td>{d.camara ? <>{d.camara.nombre}<span className="secundario">{d.camara.ubicacion}</span></> : <span className="texto-secundario">{d.fuente === 'manual' ? 'Registro manual' : '—'}</span>}</td>
                    <td className="ocultar-movil" style={{ maxWidth: 240 }}>
                      <span className="truncar" style={{ display: 'block' }}>{d.alerta ? <b style={{ color: 'var(--alerta)' }}>{d.alerta.motivo}</b> : d.autorizado?.propietario ?? describirVehiculo(d)}</span>
                      {d.autorizado?.departamento && <span className="secundario">{d.autorizado.departamento}</span>}
                    </td>
                    <td className="num ocultar-movil">{porcentaje(d.confianza_ocr)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      {d.validado_manualmente
                        ? <span className="texto-secundario" title={d.validacion?.usuario?.email}>{d.validacion?.usuario?.nombre ?? 'Personal'}</span>
                        : d.estado_validacion === 'pendiente_revision' && d.estado_procesamiento !== 'pendiente_ocr'
                          ? <button className="btn btn-navy btn-sm" onClick={() => setValidando(d)}>Validar</button>
                          : <button className="btn btn-ghost btn-sm" onClick={() => setValidando(d)}>Corregir</button>}
                    </td>
                    {esAdmin && (
                      <td className="acciones-celda" onClick={e => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-sm btn-icono" title="Eliminar registro" aria-label="Eliminar registro" onClick={() => setEliminando(d)}>
                          <Trash2 size={15} color="var(--alerta)" /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {datos && datos.items.length === 0 && (
            <Vacio titulo={hayFiltros ? 'Sin resultados' : 'Aún no hay ingresos registrados'} icono={hayFiltros ? <Filter size={22} /> : undefined}
              texto={hayFiltros ? 'Ningún ingreso coincide con los filtros. Pruebe ampliando el rango de fechas.' : 'Los pasos vehiculares aparecerán aquí en cuanto el motor ANPR los registre.'} />
          )}
          {datos && datos.total > 0 && <Paginacion pagina={datos.pagina} tamano={datos.tamano} total={datos.total} onCambiar={p => cambiar('pagina', String(p))} />}
        </Tarjeta>
      </div>
      {zoom && <VisorZoom d={zoom} onCerrar={() => setZoom(null)} />}
      {eliminando && <EliminarUno d={eliminando} onCerrar={() => setEliminando(null)} />}
      {eliminarVarios && datos && (
        <EliminarVarios total={datos.total} filtros={consultaParams} onCerrar={() => setEliminarVarios(false)} onHecho={() => recargar(true)}
          descripcion={hayFiltros ? 'Registros que cumplen los filtros aplicados' : 'Todos los registros de ingreso del sistema'} />
      )}
      {validando && <ValidarModal d={validando} onCerrar={() => setValidando(null)} onValidada={d => setDatos(p => p && { ...p, items: p.items.map(x => (x.id === d.id ? d : x)) })} />}
    </div>
  );
};

export default Detecciones;
