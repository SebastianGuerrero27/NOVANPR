import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Printer, ShieldAlert } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import { useConsulta } from '../../aplicacion/hooks';
import type { Camara } from '../../dominio/tipos';
import { diaCorto, fecha, fechaHora, fechaIsoLocal, limiteDia, NIVELES_ALERTA, nombreDescarga, numero, porcentaje, SERIES_ESTADO } from '../../dominio/formato';
import { descargarBlob } from '../../infraestructura/descargas';
import { Aviso, Cargando, Kpi, Placa, Segmentado, Tarjeta, Vacio } from '../componentes/ui';
import { BarraDistribucion, BarrasApiladas, BarrasHorizontales, Leyenda } from '../componentes/Graficos';
import { useNotificar } from '../componentes/Notificaciones';

type Periodo = 'hoy' | '7d' | '30d' | 'mes' | 'personalizado';

function rango(p: Periodo, desde: string, hasta: string): { desde: string; hasta: string } {
  const hoy = fechaIsoLocal();
  const menos = (n: number) => fechaIsoLocal(new Date(Date.now() - n * 86400000));
  switch (p) {
    case 'hoy': return { desde: hoy, hasta: hoy };
    case '7d': return { desde: menos(6), hasta: hoy };
    case '30d': return { desde: menos(29), hasta: hoy };
    case 'mes': return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy };
    default: return { desde: desde || menos(6), hasta: hasta || hoy };
  }
}

interface Reporte {
  periodo: { desde: string; hasta: string; camara: number | null };
  totales: { total: number; autorizados: number; alertas: number; no_registrados: number; pendientes: number; validados: number; manuales: number; placas_distintas: number; latencia_media_ms: number | null; confianza_ocr_media: number | null };
  por_dia: { fecha: string; total: number; autorizados: number; alertas: number; no_registrados: number; pendientes: number }[];
  por_hora: { hora: number; total: number }[];
  por_camara: { camara_id: number; camara: string; total: number; autorizados: number; alertas: number; no_registrados: number; pendientes: number }[];
  por_tipo: { tipo: string; total: number }[];
  placas_frecuentes: { placa: string; ingresos: number; ultimo: string; estado: string; propietario: string | null }[];
  validacion_por_usuario: { usuario: string; validaciones: number; correcciones: number }[];
  alertas: { id: number; fecha_hora_ingreso: string; placa: string | null; motivo: string | null; nivel_alerta: string | null; camara: string | null; validado_manualmente: boolean }[];
}

const SERIE_TOTAL = [{ clave: 'total', etiqueta: 'Ingresos', color: '#15315d' }];

const Reportes: React.FC = () => {
  const notificar = useNotificar();
  const [periodo, setPeriodo] = useState<Periodo>('7d');
  const [desdeP, setDesdeP] = useState('');
  const [hastaP, setHastaP] = useState('');
  const [camara, setCamara] = useState('');
  const [exportando, setExportando] = useState(false);
  const r = rango(periodo, desdeP, hastaP);
  const params = useMemo(() => ({ desde: limiteDia(r.desde), hasta: limiteDia(r.hasta, true), camara: camara || undefined }), [r.desde, r.hasta, camara]);

  const { datos, cargando, error } = useConsulta<Reporte>(() => api.get('/reportes', { params }).then(x => x.data), [params]);
  const { datos: camaras } = useConsulta<Camara[]>(() => api.get('/camaras').then(x => x.data), []);
  const t = datos?.totales;
  const unDia = r.desde === r.hasta;

  const exportar = async () => {
    setExportando(true);
    try {
      const x = await api.get('/detecciones/exportar', { params, responseType: 'blob' });
      descargarBlob(x.data, nombreDescarga(x.headers['content-disposition'], `ingresos_${r.desde}_${r.hasta}.csv`));
    } catch (e) {
      notificar('error', 'No se pudo exportar', mensajeError(e));
    } finally {
      setExportando(false);
    }
  };

  const nombreCamara = camara ? camaras?.find(c => String(c.id) === camara)?.nombre : 'Todas las cámaras';

  return (
    <div className="pagina">
      <div className="pila">
        <Tarjeta className="no-imprimir">
          <div className="filtros">
            <div className="campo">
              <span className="etiqueta-campo">Período</span>
              <Segmentado<Periodo> valor={periodo} onCambiar={setPeriodo} opciones={[
                { valor: 'hoy', etiqueta: 'Hoy' }, { valor: '7d', etiqueta: '7 días' }, { valor: '30d', etiqueta: '30 días' },
                { valor: 'mes', etiqueta: 'Este mes' }, { valor: 'personalizado', etiqueta: 'Personalizado' },
              ]} />
            </div>
            {periodo === 'personalizado' && <>
              <div className="campo" style={{ minWidth: 140 }}><label htmlFor="r-desde">Desde</label>
                <input id="r-desde" type="date" className="input" value={desdeP || r.desde} max={hastaP || fechaIsoLocal()} onChange={e => setDesdeP(e.target.value)} /></div>
              <div className="campo" style={{ minWidth: 140 }}><label htmlFor="r-hasta">Hasta</label>
                <input id="r-hasta" type="date" className="input" value={hastaP || r.hasta} min={desdeP || undefined} max={fechaIsoLocal()} onChange={e => setHastaP(e.target.value)} /></div>
            </>}
            <div className="campo"><label htmlFor="r-camara">Cámara</label>
              <select id="r-camara" className="select" value={camara} onChange={e => setCamara(e.target.value)}>
                <option value="">Todas</option>{camaras?.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select></div>
            <div className="fila" style={{ marginLeft: 'auto' }}>
              <button className="btn btn-secondary" onClick={() => window.print()} disabled={!datos}><Printer size={15} /> Imprimir</button>
              <button className="btn btn-navy" onClick={exportar} disabled={exportando || !t?.total}><Download size={15} /> {exportando ? 'Exportando…' : 'Exportar detalle CSV'}</button>
            </div>
          </div>
        </Tarjeta>

        <div className="solo-imprimir">
          <h2 style={{ fontSize: 18 }}>Reporte de ingresos vehiculares · Sistema ANPR ECU 911</h2>
          <p className="texto-secundario">Período: {fecha(`${r.desde}T12:00:00-05:00`)} – {fecha(`${r.hasta}T12:00:00-05:00`)} · {nombreCamara} · generado {fechaHora(new Date())}</p>
        </div>

        {error && <Aviso tipo="error">{error}</Aviso>}
        {cargando && !datos ? <Cargando alto={300} /> : datos && t && (
          t.total === 0 ? <Tarjeta><Vacio titulo="Sin ingresos en el período" texto="Pruebe otro rango de fechas o cámara." /></Tarjeta> : (
            <>
              <div className="grid-kpi">
                <Kpi etiqueta="Ingresos" valor={numero(t.total)} pie={`${numero(t.placas_distintas)} placas distintas`} />
                <Kpi etiqueta="Autorizados" valor={numero(t.autorizados)} color="var(--autorizado)" pie={porcentaje(t.autorizados / t.total, 0)} />
                <Kpi etiqueta="Alertas" valor={numero(t.alertas)} color="var(--alerta)" pie={porcentaje(t.alertas / t.total, 1)} />
                <Kpi etiqueta="Confirmados por el personal" valor={numero(t.validados)} pie={`${numero(t.manuales)} registros manuales`} />
                <Kpi etiqueta="Tiempo de lectura" valor={t.latencia_media_ms !== null ? `${numero(Math.round(t.latencia_media_ms))} ms` : '—'}
                  pie={t.confianza_ocr_media !== null ? `Confianza OCR media ${porcentaje(t.confianza_ocr_media)}` : 'Sin lecturas automáticas'} />
              </div>

              <Tarjeta titulo={unDia ? 'Ingresos por hora' : 'Ingresos por día'} subtitulo={unDia ? 'Total del día' : 'Por estado de la decisión'} acciones={unDia ? undefined : <Leyenda series={SERIES_ESTADO} />}>
                {unDia
                  ? <BarrasApiladas datos={datos.por_hora} series={SERIE_TOTAL} etiquetaX={d => String(d.hora).padStart(2, '0')} cadaEtiqueta={2} />
                  : <BarrasApiladas datos={datos.por_dia} series={SERIES_ESTADO} etiquetaX={d => (datos.por_dia.length > 14 ? d.fecha.slice(8) : diaCorto(d.fecha))}
                      tituloTip={d => fecha(`${d.fecha}T12:00:00-05:00`)} cadaEtiqueta={Math.ceil(datos.por_dia.length / 16)} />}
              </Tarjeta>

              <div className="grid-2">
                <Tarjeta titulo="Distribución por estado"><BarraDistribucion valores={t as any} series={SERIES_ESTADO} /></Tarjeta>
                {!unDia && (
                  <Tarjeta titulo="Horas de mayor afluencia" subtitulo="Total del período por hora del día">
                    <BarrasApiladas datos={datos.por_hora} series={SERIE_TOTAL} etiquetaX={d => String(d.hora).padStart(2, '0')} alto={170} cadaEtiqueta={3} />
                  </Tarjeta>
                )}
                <Tarjeta titulo="Por cámara" acciones={<Leyenda series={SERIES_ESTADO} />}>
                  <BarrasHorizontales series={SERIES_ESTADO} filas={datos.por_camara.map(c => ({ etiqueta: c.camara, total: c.total, valores: c as any }))} />
                </Tarjeta>
                <Tarjeta titulo="Por tipo de vehículo">
                  <BarrasHorizontales series={SERIE_TOTAL} filas={datos.por_tipo.map(x => ({ etiqueta: x.tipo, total: x.total, valores: { total: x.total } }))} />
                </Tarjeta>
              </div>

              <div className="grid-2">
                <Tarjeta titulo="Placas más frecuentes" sinPadding>
                  <div className="tabla-contenedor"><table className="tabla"><thead><tr><th>Placa</th><th>Titular (padrón)</th><th className="num">Ingresos</th><th>Último</th></tr></thead><tbody>
                    {datos.placas_frecuentes.map(p => (
                      <tr key={p.placa}><td><Link to={`/detecciones?placa=${p.placa}`} style={{ textDecoration: 'none' }}><Placa valor={p.placa} /></Link></td>
                        <td>{p.propietario ?? <span className="texto-secundario">No registrado</span>}</td><td className="num">{numero(p.ingresos)}</td><td className="nowrap">{fechaHora(p.ultimo)}</td></tr>
                    ))}
                  </tbody></table></div>
                </Tarjeta>
                <Tarjeta titulo="Validación por el personal" subtitulo="Confirmaciones y correcciones de lectura" sinPadding>
                  {datos.validacion_por_usuario.length === 0 ? <Vacio titulo="Sin validaciones en el período" /> : (
                    <div className="tabla-contenedor"><table className="tabla"><thead><tr><th>Usuario</th><th className="num">Validaciones</th><th className="num">Correcciones</th></tr></thead><tbody>
                      {datos.validacion_por_usuario.map(v => <tr key={v.usuario}><td>{v.usuario}</td><td className="num">{numero(v.validaciones)}</td><td className="num">{numero(v.correcciones)}</td></tr>)}
                    </tbody></table></div>
                  )}
                </Tarjeta>
              </div>

              <Tarjeta titulo="Alertas del período" subtitulo={`${numero(datos.alertas.length)} eventos${datos.alertas.length === 50 ? ' (últimos 50)' : ''}`} sinPadding>
                {datos.alertas.length === 0 ? <Vacio titulo="Sin alertas en el período" icono={<ShieldAlert size={22} />} /> : (
                  <div className="tabla-contenedor"><table className="tabla"><thead><tr><th>Fecha</th><th>Placa</th><th>Motivo</th><th>Nivel</th><th>Cámara</th></tr></thead><tbody>
                    {datos.alertas.map(a => (
                      <tr key={a.id}><td className="nowrap"><Link to={`/detecciones/${a.id}`}>{fechaHora(a.fecha_hora_ingreso)}</Link></td><td><Placa valor={a.placa} /></td>
                        <td>{a.motivo ?? '—'}</td><td>{a.nivel_alerta && <span className={`insignia ${NIVELES_ALERTA[a.nivel_alerta]?.clase}`}>{NIVELES_ALERTA[a.nivel_alerta]?.etiqueta}</span>}</td><td>{a.camara ?? '—'}</td></tr>
                    ))}
                  </tbody></table></div>
                )}
              </Tarjeta>
            </>
          )
        )}
      </div>
    </div>
  );
};

export default Reportes;
