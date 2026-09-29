import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, Edit3, History, Plus, Search, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import { useConsulta, useDiferido } from '../lib/hooks';
import type { RegistroLista } from '../lib/tipos';
import { descargarBlob, fecha, fechaIsoLocal, NIVELES_ALERTA, numero } from '../lib/formato';
import { Aviso, Confirmar, FilasEsqueleto, Pestanas, Placa, Segmentado, Tarjeta, Vacio } from '../components/ui';
import { FormularioLista, RUTA_API, TipoLista } from '../components/FormularioLista';
import { useNotificar } from '../components/Notificaciones';

type Vigencia = 'todas' | 'vigentes' | 'por_vencer' | 'vencidas';

/** El plazo de "por vencer" lo define la configuración del sistema (lo calcula la API). */
function vigenciaDe(r: RegistroLista): Exclude<Vigencia, 'todas'> {
  if (!r.vigente) return 'vencidas';
  return r.por_vencer ? 'por_vencer' : 'vigentes';
}

const InsigniaVigencia: React.FC<{ r: RegistroLista }> = ({ r }) => {
  const v = vigenciaDe(r);
  if (v === 'vencidas') return <span className="insignia neutro">Vencida · {fecha(r.fecha_vencimiento)}</span>;
  if (!r.fecha_vencimiento) return <span className="insignia autorizado">Permanente</span>;
  return <span className={`insignia ${v === 'por_vencer' ? 'no_reconocido' : 'autorizado'}`}>Hasta {fecha(r.fecha_vencimiento)}</span>;
};

function aCsv(tipo: TipoLista, filas: RegistroLista[]): Blob {
  const c = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cab = tipo === 'autorizados'
    ? ['Placa', 'Propietario', 'Departamento', 'Tipo', 'Marca', 'Modelo', 'Color', 'Vigente hasta', 'Observaciones', 'Ingresos', 'Registrado por', 'Fecha de registro']
    : ['Placa', 'Motivo', 'Nivel', 'Marca', 'Modelo', 'Color', 'Vigente hasta', 'Observaciones', 'Detecciones', 'Registrado por', 'Fecha de registro'];
  const lineas = filas.map(r => (tipo === 'autorizados'
    ? [r.placa, r.propietario, r.departamento, r.tipo_vehiculo, r.marca, r.modelo, r.color, r.fecha_vencimiento?.slice(0, 10), r.observaciones, r.ingresos, r.registrado_por_email, fecha(r.fecha_registro)]
    : [r.placa, r.motivo, r.nivel_alerta, r.marca, r.modelo, r.color, r.fecha_vencimiento?.slice(0, 10), r.observaciones, r.ingresos, r.registrado_por_email, fecha(r.fecha_registro)]
  ).map(c).join(','));
  return new Blob(['﻿' + [cab.map(c).join(','), ...lineas].join('\n')], { type: 'text/csv;charset=utf-8' });
}

const Listas: React.FC = () => {
  const { tipo: tipoRuta } = useParams();
  const tipo: TipoLista = tipoRuta === 'alertas' ? 'alertas' : 'autorizados';
  const { tieneRol } = useAuth();
  const navigate = useNavigate();
  const notificar = useNotificar();
  const puedeEditar = tieneRol('Admin', 'Supervisor');
  const [busqueda, setBusqueda] = useState('');
  const [vigencia, setVigencia] = useState<Vigencia>('todas');
  const [editando, setEditando] = useState<RegistroLista | 'nuevo' | null>(null);
  const [retirando, setRetirando] = useState<RegistroLista | null>(null);

  const { datos, cargando, error, recargar } = useConsulta<RegistroLista[]>(() => api.get(RUTA_API[tipo]).then(r => r.data), [tipo]);
  const diferido = useDiferido(() => recargar(true), 800);
  useEvento<{ lista: string }>('listas:actualizadas', e => { if (e.lista === (tipo === 'alertas' ? 'lista_negra' : 'autorizado')) diferido(); });

  const conteo = useMemo(() => {
    const c = { todas: 0, vigentes: 0, por_vencer: 0, vencidas: 0 };
    for (const r of datos ?? []) { c.todas++; c[vigenciaDe(r)]++; }
    return c;
  }, [datos]);

  const filas = useMemo(() => {
    const q = busqueda.trim().toUpperCase();
    const qPlaca = q.replace(/[^A-Z0-9]/g, '');
    return (datos ?? []).filter(r => (vigencia === 'todas' || vigenciaDe(r) === vigencia) && (!q
      || (qPlaca && r.placa.includes(qPlaca))
      || [r.propietario, r.departamento, r.motivo, r.marca, r.modelo, r.observaciones].some(x => x?.toUpperCase().includes(q))));
  }, [datos, busqueda, vigencia]);

  return (
    <div className="pagina">
      <div className="pila">
        <Pestanas<TipoLista> valor={tipo} onCambiar={t => navigate(`/listas/${t}`)}
          opciones={[
            { valor: 'autorizados', etiqueta: 'Vehículos autorizados', icono: <ShieldCheck size={15} /> },
            { valor: 'alertas', etiqueta: 'Lista de alertas', icono: <ShieldAlert size={15} /> },
          ]} />

        {!puedeEditar && <Aviso tipo="info">Consulta de solo lectura. Las altas y cambios los realizan el administrador o el supervisor.</Aviso>}
        {error && <Aviso tipo="error">{error}</Aviso>}

        <Tarjeta
          titulo={tipo === 'autorizados' ? 'Padrón de vehículos autorizados' : 'Placas con alerta de seguridad'}
          subtitulo={tipo === 'autorizados'
            ? 'Solo una coincidencia exacta de placa vigente concede el ingreso automático.'
            : 'Se alerta incluso ante lecturas aproximadas (confusiones típicas del OCR como 0/O u 8/B).'}
          acciones={<>
            <button className="btn btn-secondary btn-sm" disabled={!filas.length} onClick={() => descargarBlob(aCsv(tipo, filas), `${tipo === 'autorizados' ? 'vehiculos_autorizados' : 'lista_alertas'}_${fechaIsoLocal()}.csv`)}>
              <Download size={14} /> Exportar
            </button>
            {puedeEditar && <button className={`btn btn-sm ${tipo === 'autorizados' ? 'btn-navy' : 'btn-primary'}`} onClick={() => setEditando('nuevo')}><Plus size={14} /> Agregar</button>}
          </>}
          sinPadding>
          <div className="filtros" style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div className="campo crece" style={{ maxWidth: 380 }}>
              <div className="input-icono"><Search size={15} />
                <input className="input" value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder={tipo === 'autorizados' ? 'Placa, propietario, departamento…' : 'Placa, motivo, marca…'} aria-label="Buscar" />
              </div>
            </div>
            <Segmentado<Vigencia> valor={vigencia} onCambiar={setVigencia} opciones={[
              { valor: 'todas', etiqueta: `Todas (${conteo.todas})` },
              { valor: 'vigentes', etiqueta: `Vigentes (${conteo.vigentes})` },
              { valor: 'por_vencer', etiqueta: `Por vencer (${conteo.por_vencer})` },
              { valor: 'vencidas', etiqueta: `Vencidas (${conteo.vencidas})` },
            ]} />
          </div>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead><tr>
                <th>Placa</th>
                {tipo === 'autorizados' ? <><th>Propietario / responsable</th><th className="ocultar-movil">Vehículo</th></> : <><th>Motivo</th><th>Nivel</th></>}
                <th>Vigencia</th><th className="num ocultar-movil">{tipo === 'autorizados' ? 'Ingresos' : 'Detecciones'}</th>
                <th className="ocultar-movil">Registro</th>{puedeEditar && <th />}
              </tr></thead>
              <tbody>
                {cargando && !datos ? <FilasEsqueleto columnas={puedeEditar ? 7 : 6} /> : filas.map(r => (
                  <tr key={r.id} className={r.vigente ? '' : 'inactivo'}>
                    <td><Placa valor={r.placa} /></td>
                    {tipo === 'autorizados' ? (
                      <>
                        <td><strong style={{ color: 'var(--text)', fontWeight: 600 }}>{r.propietario}</strong>{(r.departamento || r.observaciones) && <span className="secundario truncar" style={{ maxWidth: 280 }} title={r.observaciones ?? ''}>{[r.departamento, r.observaciones].filter(Boolean).join(' · ')}</span>}</td>
                        <td className="ocultar-movil">{[r.tipo_vehiculo, [r.marca, r.modelo].filter(Boolean).join(' '), r.color].filter(Boolean).join(' · ') || '—'}</td>
                      </>
                    ) : (
                      <>
                        <td style={{ maxWidth: 320 }}><span style={{ color: 'var(--text)', fontWeight: 600 }}>{r.motivo}</span>
                          <span className="secundario truncar">{[[r.marca, r.modelo].filter(Boolean).join(' '), r.color, r.observaciones].filter(Boolean).join(' · ')}</span></td>
                        <td><span className={`insignia ${NIVELES_ALERTA[r.nivel_alerta ?? 'ALTA'].clase}`}>{NIVELES_ALERTA[r.nivel_alerta ?? 'ALTA'].etiqueta}</span></td>
                      </>
                    )}
                    <td><InsigniaVigencia r={r} /></td>
                    <td className="num ocultar-movil">{r.ingresos > 0 ? <Link to={`/detecciones?placa=${r.placa}`} title="Ver ingresos">{numero(r.ingresos)}</Link> : '0'}</td>
                    <td className="ocultar-movil"><span className="texto-secundario">{fecha(r.fecha_registro)}</span><span className="secundario">{r.registrado_por_email ?? '—'}</span></td>
                    {puedeEditar && (
                      <td className="acciones-celda">
                        <Link className="btn btn-ghost btn-sm btn-icono" to={`/detecciones?placa=${r.placa}`} title="Historial de la placa" aria-label="Historial"><History size={15} /></Link>
                        <button className="btn btn-ghost btn-sm btn-icono" onClick={() => setEditando(r)} title="Editar" aria-label="Editar"><Edit3 size={15} /></button>
                        <button className="btn btn-ghost btn-sm btn-icono" onClick={() => setRetirando(r)} title="Retirar de la lista" aria-label="Retirar"><Trash2 size={15} color="var(--alerta)" /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {datos && filas.length === 0 && (
            <Vacio titulo={datos.length ? 'Sin coincidencias' : tipo === 'autorizados' ? 'El padrón está vacío' : 'No hay placas con alerta'}
              texto={datos.length ? 'Ajuste la búsqueda o el filtro de vigencia.' : puedeEditar ? 'Use “Agregar” para registrar el primero.' : undefined} />
          )}
        </Tarjeta>
      </div>

      {editando && (
        <FormularioLista tipo={tipo} registro={editando === 'nuevo' ? undefined : editando} onCerrar={() => setEditando(null)}
          onGuardado={() => { setEditando(null); recargar(true); notificar('exito', editando === 'nuevo' ? 'Registro agregado' : 'Cambios guardados'); }} />
      )}
      {retirando && (
        <Confirmar titulo="Retirar de la lista" pedirMotivo peligro textoBoton="Retirar"
          mensaje={<>La placa <b>{retirando.placa}</b> dejará de {tipo === 'autorizados' ? 'tener ingreso automático' : 'generar alertas'}. El historial de ingresos se conserva.</>}
          onConfirmar={async motivo => {
            try { await api.delete(`${RUTA_API[tipo]}/${retirando.id}`, { data: { motivo } }); } catch (e) { throw new Error(mensajeError(e)); }
            recargar(true);
            notificar('exito', `${retirando.placa} retirada de la lista`);
          }}
          onCerrar={() => setRetirando(null)} />
      )}
    </div>
  );
};

export default Listas;
