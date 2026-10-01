import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, BellRing, Copy, Download, FileJson, FileSpreadsheet, FileText, FlaskConical, RefreshCw,
} from 'lucide-react';
import api, { mensajeError } from '../services/api';
import type { MetricasNotificacion } from '../lib/tipos';

// ─────────────────────────────────────────────────────────────────────────────
// Tipos (espejo de GET /api/evaluacion/resumen)
// ─────────────────────────────────────────────────────────────────────────────
interface Proporcion { valor: number | null; n: number; ic95: [number, number] | null }
interface ResumenGrupo {
  n: number;
  exactitud_placa: Proporcion;
  cer_medio: number | null;
  tasa_no_legible: Proporcion;
  control_acceso: {
    tasa_falsa_aceptacion: Proporcion;
    tasa_falso_rechazo: Proporcion;
    lista_negra_no_detectada: Proporcion;
    falsas_alertas: Proporcion;
  };
  latencia_ms: { n: number; p50: number | null; p95: number | null; max: number | null };
}
interface Evaluacion {
  periodo: { desde: string | null; hasta: string | null };
  modelos: string[];
  total_registros: number;
  validados: number;
  cobertura_validacion: number | null;
  global: ResumenGrupo;
  por_luz: Record<string, ResumenGrupo>;
  por_distancia: Record<string, ResumenGrupo>;
  por_tipo_placa: Record<string, ResumenGrupo>;
  por_formato: Record<string, ResumenGrupo>;
  por_clima: Record<string, ResumenGrupo>;
}
interface Camara { id: number; nombre: string }

const DIMENSIONES: { clave: keyof Evaluacion; titulo: string }[] = [
  { clave: 'por_luz', titulo: 'Condición de luz' },
  { clave: 'por_distancia', titulo: 'Distancia estimada' },
  { clave: 'por_tipo_placa', titulo: 'Tipo de placa (ANT)' },
  { clave: 'por_formato', titulo: 'Formato de placa' },
  { clave: 'por_clima', titulo: 'Clima (anotación manual)' },
];

const ACCENT = '#2563eb';
const INK = '#0f172a';
const INK_2 = '#475569';
const MUTED = '#94a3b8';
const BORDER = '#e2e8f0';

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`);
const ic = (p: Proporcion) => (p.ic95 ? `[${(p.ic95[0] * 100).toFixed(1)}, ${(p.ic95[1] * 100).toFixed(1)}]` : '');
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const hoy = () => new Date().toISOString().slice(0, 10);
const haceDias = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);

function descargar(nombre: string, contenido: BlobPart, tipo: string) {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

// Tabla en Markdown lista para pegar en el artículo / tesis
function tablaMarkdown(ev: Evaluacion): string {
  const fila = (nombre: string, g: ResumenGrupo) =>
    `| ${nombre} | ${g.n} | ${pct(g.exactitud_placa.valor)} ${ic(g.exactitud_placa)} | ${g.cer_medio?.toFixed(3) ?? '—'} | ` +
    `${pct(g.control_acceso.tasa_falsa_aceptacion.valor)} | ${pct(g.control_acceso.tasa_falso_rechazo.valor)} | ` +
    `${pct(g.control_acceso.lista_negra_no_detectada.valor)} | ${ms(g.latencia_ms.p95)} |`;
  const lineas = [
    `Periodo: ${ev.periodo.desde ?? 'inicio'} a ${ev.periodo.hasta ?? 'hoy'} · Registros: ${ev.total_registros} · ` +
      `Validados: ${ev.validados} (cobertura ${pct(ev.cobertura_validacion)})`,
    `Modelos: ${ev.modelos.join('; ')}`,
    '',
    '| Grupo | n | Exactitud placa [IC 95 % Wilson] | CER | Falsa aceptación | Falso rechazo | Lista negra no detectada | Latencia p95 |',
    '|---|---|---|---|---|---|---|---|',
    fila('Global', ev.global),
  ];
  for (const d of DIMENSIONES) {
    for (const [k, g] of Object.entries(ev[d.clave] as Record<string, ResumenGrupo>)) lineas.push(fila(`${d.titulo}: ${k}`, g));
  }
  return lineas.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Componentes
// ─────────────────────────────────────────────────────────────────────────────
const Tarjeta: React.FC<{ titulo: string; valor: string; detalle?: string; alerta?: boolean; ayuda: string }> = (
  { titulo, valor, detalle, alerta, ayuda },
) => (
  <div
    className="shadow-premium"
    title={ayuda}
    style={{ padding: '14px 18px', borderRadius: '10px', background: '#fff', border: `1px solid ${alerta ? '#fecaca' : BORDER}` }}
  >
    <div style={{ fontSize: '11px', fontWeight: 800, color: INK_2, textTransform: 'uppercase', letterSpacing: '0.5px', display: 'flex', gap: 6, alignItems: 'center' }}>
      {alerta && <AlertTriangle size={13} color="#dc2626" aria-label="Atención" />}
      {titulo}
    </div>
    <div style={{ fontSize: '24px', fontWeight: 900, color: INK, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>{valor}</div>
    {detalle && <div style={{ fontSize: '11px', color: MUTED, marginTop: '2px' }}>{detalle}</div>}
  </div>
);

/** Barras horizontales de exactitud con intervalo de confianza (una sola serie). */
const GraficoExactitud: React.FC<{ grupos: [string, ResumenGrupo][] }> = ({ grupos }) => {
  if (!grupos.length) return <div style={{ fontSize: 12, color: MUTED, padding: '8px 0' }}>Sin datos validados en este grupo.</div>;
  return (
    <div role="img" aria-label="Exactitud por placa con intervalo de confianza del 95 %" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {grupos.map(([nombre, g]) => {
        const v = g.exactitud_placa.valor ?? 0;
        const [lo, hi] = g.exactitud_placa.ic95 ?? [v, v];
        return (
          <div
            key={nombre}
            title={`${nombre}: exactitud ${pct(v)} · IC 95 % ${ic(g.exactitud_placa)} · n = ${g.n}`}
            style={{ display: 'grid', gridTemplateColumns: '130px 1fr 150px', alignItems: 'center', gap: 12, cursor: 'default' }}
          >
            <span style={{ fontSize: 12, color: INK_2, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nombre}</span>
            <div style={{ position: 'relative', height: 18 }}>
              <div style={{ position: 'absolute', inset: '7px 0', background: '#f1f5f9', borderRadius: 4 }} />
              <div style={{ position: 'absolute', left: 0, top: 4, height: 10, width: `${v * 100}%`, background: ACCENT, borderRadius: '0 4px 4px 0' }} />
              {/* Intervalo de confianza */}
              <div style={{ position: 'absolute', top: 8, height: 2, left: `${lo * 100}%`, width: `${Math.max(0, hi - lo) * 100}%`, background: INK }} />
              <div style={{ position: 'absolute', top: 4, height: 10, width: 2, left: `calc(${lo * 100}% - 1px)`, background: INK }} />
              <div style={{ position: 'absolute', top: 4, height: 10, width: 2, left: `calc(${hi * 100}% - 1px)`, background: INK }} />
            </div>
            <span style={{ fontSize: 12, color: INK, fontVariantNumeric: 'tabular-nums' }}>
              <b>{pct(v)}</b> <span style={{ color: MUTED }}>n={g.n}</span>
            </span>
          </div>
        );
      })}
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 150px', gap: 12, fontSize: 10, color: MUTED }}>
        <span />
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>0 %</span><span>50 %</span><span>100 %</span></div>
        <span>▬ intervalo 95 %</span>
      </div>
    </div>
  );
};

const TablaGrupos: React.FC<{ grupos: [string, ResumenGrupo][] }> = ({ grupos }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
      <thead>
        <tr style={{ background: '#f8fafc', color: INK_2, textAlign: 'left' }}>
          {['Grupo', 'n', 'Exactitud [IC 95 %]', 'CER', 'No legibles', 'Falsa aceptación', 'Falso rechazo', 'Lista negra no detectada', 'Latencia p95'].map(h => (
            <th key={h} style={{ padding: '8px 10px', fontWeight: 800, borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grupos.map(([nombre, g]) => (
          <tr key={nombre} style={{ borderBottom: `1px solid ${BORDER}`, color: INK }}>
            <td style={{ padding: '7px 10px', fontWeight: 700 }}>{nombre}</td>
            <td style={{ padding: '7px 10px' }}>{g.n}</td>
            <td style={{ padding: '7px 10px' }}>{pct(g.exactitud_placa.valor)} <span style={{ color: MUTED }}>{ic(g.exactitud_placa)}</span></td>
            <td style={{ padding: '7px 10px' }}>{g.cer_medio?.toFixed(3) ?? '—'}</td>
            <td style={{ padding: '7px 10px' }}>{pct(g.tasa_no_legible.valor)}</td>
            <td style={{ padding: '7px 10px' }}>{pct(g.control_acceso.tasa_falsa_aceptacion.valor)} <span style={{ color: MUTED }}>n={g.control_acceso.tasa_falsa_aceptacion.n}</span></td>
            <td style={{ padding: '7px 10px' }}>{pct(g.control_acceso.tasa_falso_rechazo.valor)} <span style={{ color: MUTED }}>n={g.control_acceso.tasa_falso_rechazo.n}</span></td>
            <td style={{ padding: '7px 10px' }}>{pct(g.control_acceso.lista_negra_no_detectada.valor)} <span style={{ color: MUTED }}>n={g.control_acceso.lista_negra_no_detectada.n}</span></td>
            <td style={{ padding: '7px 10px' }}>{ms(g.latencia_ms.p95)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Comando: React.FC<{ texto: string }> = ({ texto }) => {
  const [copiado, setCopiado] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <code style={{ flex: 1, background: '#0f172a', color: '#e2e8f0', padding: '8px 12px', borderRadius: 6, fontSize: 11.5, overflowX: 'auto', whiteSpace: 'nowrap' }}>{texto}</code>
      <button
        className="btn btn-secondary"
        style={{ padding: '6px 10px', fontSize: 11, gap: 4 }}
        onClick={() => { navigator.clipboard.writeText(texto); setCopiado(true); setTimeout(() => setCopiado(false), 1500); }}
      >
        <Copy size={12} /> {copiado ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────
const ETIQ_SEV: Record<string, string> = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja' };
const seg = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toFixed(1)} s`);

/**
 * Desempeño del canal de alarmas para el artículo: tiempo de reconocimiento (TTA, mediana y
 * p95) por prioridad, tasa de escalamiento, agrupación de repeticiones y tasa de alarmas por
 * hora frente a los umbrales de ISA-18.2 (≤ 6 alarmas/h en régimen estable; avalancha > 10
 * alarmas en 10 min). La latencia de extremo a extremo se publica en Prometheus
 * (anpr_notificacion_latencia_seconds).
 */
const MetricasAlarmas: React.FC = () => {
  const [dias, setDias] = useState(7);
  const [m, setM] = useState<MetricasNotificacion | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get('/notificaciones/metricas', { params: { dias } }).then(r => { setM(r.data); setError(null); }).catch(e => setError(mensajeError(e)));
  }, [dias]);
  const total = m?.por_severidad.reduce((a, f) => a + f.emitidas, 0) ?? 0;
  const conAck = m?.por_severidad.reduce((a, f) => a + f.con_ack, 0) ?? 0;
  const escaladas = m?.por_severidad.reduce((a, f) => a + f.escaladas, 0) ?? 0;
  const agrupadas = m?.por_severidad.reduce((a, f) => a + f.repeticiones_agrupadas, 0) ?? 0;
  return (
    <div className="shadow-premium" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, fontWeight: 900, color: INK, display: 'flex', gap: 8, alignItems: 'center' }}>
          <BellRing size={17} /> Canal de alarmas · gestión de alarmas ISA-18.2
        </h3>
        <select className="select" style={{ width: 'auto' }} value={dias} onChange={e => setDias(Number(e.target.value))} aria-label="Período">
          <option value={1}>Últimas 24 h</option><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option>
        </select>
      </div>
      {error && <div style={{ color: 'var(--alerta)', fontSize: 12.5 }}>{error}</div>}
      {m && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <Tarjeta titulo="Alarmas por hora" valor={m.alarmas_por_hora.toFixed(2)} detalle={`${total} en ${m.dias} ${m.dias === 1 ? 'día' : 'días'}`}
              alerta={m.alarmas_por_hora > 6} ayuda="ISA-18.2 recomienda no superar ~6 alarmas por hora por operador en régimen estable." />
            <Tarjeta titulo="Escalamiento" valor={conAck ? pct(escaladas / conAck) : '—'} detalle={`${escaladas} de ${conAck} con ACK`}
              alerta={conAck > 0 && escaladas / conAck > 0.1} ayuda="Proporción de alarmas que nadie reconoció a tiempo y se escalaron al supervisor." />
            <Tarjeta titulo="Repeticiones agrupadas" valor={String(agrupadas)} detalle={total ? `${(agrupadas / (total + agrupadas) * 100).toFixed(0)} % de los eventos` : '—'}
              ayuda="Eventos repetidos absorbidos por la supresión de avalanchas (misma placa dentro de la ventana)." />
            <Tarjeta titulo="Ventanas de avalancha" valor={String(m.ventanas_avalancha_10min)} detalle="> 10 alarmas altas/críticas en 10 min"
              alerta={m.ventanas_avalancha_10min > 0} ayuda="Periodos de 10 minutos con más de 10 alarmas de prioridad alta o crítica." />
          </div>
          <div className="tabla-contenedor">
            <table className="tabla">
              <thead><tr><th>Prioridad</th><th className="num">Emitidas</th><th className="num">Requieren ACK</th><th className="num">Reconocidas</th>
                <th className="num">Escaladas</th><th className="num">TTA mediana</th><th className="num">TTA p95</th></tr></thead>
              <tbody>
                {m.por_severidad.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', color: MUTED }}>Sin alarmas en el período</td></tr>
                  : m.por_severidad.map(f => (
                    <tr key={f.severidad}><td>{ETIQ_SEV[f.severidad] ?? f.severidad}</td><td className="num">{f.emitidas}</td><td className="num">{f.con_ack}</td>
                      <td className="num">{f.reconocidas}</td><td className="num">{f.escaladas}</td><td className="num">{seg(f.tta_mediana_s)}</td><td className="num">{seg(f.tta_p95_s)}</td></tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

const Evaluacion: React.FC = () => {
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [camaraId, setCamaraId] = useState('');
  const [camaras, setCamaras] = useState<Camara[]>([]);
  const [datos, setDatos] = useState<Evaluacion | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dimension, setDimension] = useState<keyof Evaluacion>('por_luz');

  const params = useMemo(() => ({ desde, hasta, ...(camaraId ? { camara_id: camaraId } : {}) }), [desde, hasta, camaraId]);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await api.get('/evaluacion/resumen', { params });
      setDatos(res.data);
    } catch (e: any) {
      setError(e.response?.data?.error || 'No se pudieron cargar las métricas de evaluación.');
    } finally {
      setCargando(false);
    }
  }, [params]);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    api.get('/camaras').then(r => Array.isArray(r.data) && setCamaras(r.data)).catch(() => undefined);
  }, []);

  const exportarCSV = async () => {
    const res = await api.get('/evaluacion/export.csv', { params, responseType: 'blob' });
    descargar(`evaluacion_anpr_${desde}_${hasta}.csv`, res.data, 'text/csv');
  };

  const g = datos?.global;
  const coberturaBaja = datos?.cobertura_validacion !== null && datos?.cobertura_validacion !== undefined && datos.cobertura_validacion < 0.95;
  const gruposDim = datos ? Object.entries(datos[dimension] as Record<string, ResumenGrupo>).sort((a, b) => b[1].n - a[1].n) : [];
  const archivoCsv = `evaluacion_anpr_${desde}_${hasta}.csv`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
      {/* 1. Encabezado y exportación */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 900, color: INK, letterSpacing: '-0.3px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <BarChart3 size={22} /> Evaluación del Sistema
          </h2>
          <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
            Exactitud medida contra las placas confirmadas por el operador · intervalos de confianza al 95 %.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={cargar} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 700, gap: 6 }}>
            <RefreshCw size={14} /> Actualizar
          </button>
          <button onClick={exportarCSV} disabled={!datos} className="btn btn-primary"
            style={{ background: '#16a34a', borderColor: '#16a34a', color: 'white', fontWeight: 800, padding: '8px 14px', fontSize: '12px', gap: 6 }}>
            <FileSpreadsheet size={15} /> Exportar CSV
          </button>
          <button onClick={() => datos && descargar(`tabla_evaluacion_${desde}_${hasta}.md`, tablaMarkdown(datos), 'text/markdown')}
            disabled={!datos} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 700, gap: 6 }}>
            <FileText size={15} /> Tabla para el artículo
          </button>
          <button onClick={() => datos && descargar(`evaluacion_${desde}_${hasta}.json`, JSON.stringify(datos, null, 2), 'application/json')}
            disabled={!datos} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 700, gap: 6 }}>
            <FileJson size={15} /> JSON
          </button>
        </div>
      </div>

      {/* 2. Filtros */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 16px' }}>
        {[
          { label: 'Desde', value: desde, set: setDesde },
          { label: 'Hasta', value: hasta, set: setHasta },
        ].map(f => (
          <label key={f.label} style={{ display: 'flex', flexDirection: 'column', fontSize: 11, fontWeight: 700, color: INK_2, gap: 4 }}>
            {f.label}
            <input type="date" className="input" value={f.value} onChange={e => f.set(e.target.value)} style={{ padding: '6px 8px', fontSize: 12 }} />
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 11, fontWeight: 700, color: INK_2, gap: 4 }}>
          Cámara
          <select className="input" value={camaraId} onChange={e => setCamaraId(e.target.value)} style={{ padding: '6px 8px', fontSize: 12, minWidth: 180 }}>
            <option value="">Todas</option>
            {camaras.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        {[7, 30, 90].map(d => (
          <button key={d} className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: 11 }} onClick={() => { setDesde(haceDias(d)); setHasta(hoy()); }}>
            Últimos {d} días
          </button>
        ))}
      </div>

      {error && <div style={{ padding: 12, borderRadius: 8, background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>{error}</div>}
      {cargando && !datos && <div style={{ fontSize: 13, color: INK_2 }}>Calculando métricas…</div>}

      {datos && g && (
        <>
          {/* 3. Aviso de cobertura (sesgo de selección) */}
          {coberturaBaja && (
            <div role="alert" style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12.5 }}>
              <AlertTriangle size={18} style={{ flexShrink: 0 }} />
              <div>
                <b>Cobertura de validación {pct(datos.cobertura_validacion)} (&lt; 95 %).</b> El operador no confirmó todos los pasos
                vehiculares del periodo; si solo valida los dudosos, las métricas quedan sesgadas. Para la tesis, valide todos los
                registros, también los correctos (confirmando la misma placa).
              </div>
            </div>
          )}

          {/* 4. Indicadores globales */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
            <Tarjeta titulo="Pasos validados" valor={`${datos.validados} / ${datos.total_registros}`} detalle={`Cobertura ${pct(datos.cobertura_validacion)}`}
              alerta={coberturaBaja} ayuda="Registros confirmados por el operador sobre el total del periodo." />
            <Tarjeta titulo="Exactitud por placa" valor={pct(g.exactitud_placa.valor)} detalle={`IC 95 % ${ic(g.exactitud_placa)}`}
              ayuda="Porcentaje de pasos en que la lectura automática coincide exactamente con la placa confirmada." />
            <Tarjeta titulo="Error por carácter (CER)" valor={g.cer_medio?.toFixed(3) ?? '—'} detalle="Distancia de edición / longitud"
              ayuda="Promedio de caracteres erróneos por placa, normalizado por su longitud." />
            <Tarjeta titulo="No legibles" valor={pct(g.tasa_no_legible.valor)} detalle={`IC 95 % ${ic(g.tasa_no_legible)}`}
              ayuda="Pasos en los que el sistema no produjo una lectura." />
            <Tarjeta titulo="Falsa aceptación" valor={pct(g.control_acceso.tasa_falsa_aceptacion.valor)}
              detalle={`n = ${g.control_acceso.tasa_falsa_aceptacion.n} no autorizados`} alerta={(g.control_acceso.tasa_falsa_aceptacion.valor ?? 0) > 0}
              ayuda="Vehículos NO autorizados a los que el sistema dio acceso automáticamente." />
            <Tarjeta titulo="Falso rechazo" valor={pct(g.control_acceso.tasa_falso_rechazo.valor)}
              detalle={`n = ${g.control_acceso.tasa_falso_rechazo.n} autorizados`}
              ayuda="Vehículos autorizados que el sistema no reconoció como tales." />
            <Tarjeta titulo="Lista negra no detectada" valor={pct(g.control_acceso.lista_negra_no_detectada.valor)}
              detalle={`n = ${g.control_acceso.lista_negra_no_detectada.n} en lista negra`} alerta={(g.control_acceso.lista_negra_no_detectada.valor ?? 0) > 0}
              ayuda="Vehículos de la lista negra que pasaron sin alerta automática." />
            <Tarjeta titulo="Latencia p50 / p95" valor={`${ms(g.latencia_ms.p50)}`} detalle={`p95 ${ms(g.latencia_ms.p95)} · máx ${ms(g.latencia_ms.max)}`}
              ayuda="Tiempo desde que aparece el vehículo hasta que su lectura queda registrada." />
          </div>

          {/* 5. Desglose por condición */}
          <div className="shadow-premium" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ fontSize: 15, fontWeight: 900, color: INK }}>Exactitud por placa según condición</h3>
              <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {DIMENSIONES.map(d => (
                  <button key={d.clave} role="tab" aria-selected={dimension === d.clave} onClick={() => setDimension(d.clave)}
                    className="btn btn-secondary"
                    style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700,
                      background: dimension === d.clave ? INK : undefined, color: dimension === d.clave ? '#fff' : undefined }}>
                    {d.titulo}
                  </button>
                ))}
              </div>
            </div>
            <GraficoExactitud grupos={gruposDim} />
            <TablaGrupos grupos={gruposDim} />
          </div>

          {/* 6. Modelos del periodo */}
          <div style={{ fontSize: 12, color: INK_2, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '12px 16px' }}>
            <b style={{ color: INK }}>Modelos que produjeron las lecturas del periodo:</b>{' '}
            {datos.modelos.length ? datos.modelos.join(' · ') : '—'}
          </div>
        </>
      )}

      {/* 7. Canal de alarmas (centro de notificaciones) */}
      <MetricasAlarmas />

      {/* 8. Análisis estadístico avanzado */}
      <div className="shadow-premium" style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 900, color: INK, display: 'flex', gap: 8, alignItems: 'center' }}>
          <FlaskConical size={17} /> Análisis estadístico avanzado
        </h3>
        <p style={{ fontSize: 12.5, color: INK_2, lineHeight: 1.6 }}>
          Esta pantalla muestra intervalos de Wilson. Para el artículo, exporte el CSV y ejecute en una terminal (carpeta
          <code> services/anpr</code>) el análisis con bootstrap, la comparación de sistemas con McNemar y las ablaciones.
        </p>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: INK_2 }}>1. Métricas con IC por bootstrap (reemplace RUTA por la carpeta donde se descargó el CSV):</div>
        <Comando texto={`.venv/Scripts/python scripts/estadistica.py operacion --csv RUTA/${archivoCsv}`} />
        <div style={{ fontSize: 11.5, fontWeight: 700, color: INK_2 }}>2. Aporte de cada componente (ablaciones con McNemar):</div>
        <Comando texto=".venv/Scripts/python scripts/run_ablations.py --save-preds ../../dataset/preds" />
        <div style={{ fontSize: 11.5, fontWeight: 700, color: INK_2 }}>3. ¿Un modelo es significativamente mejor que otro?</div>
        <Comando texto=".venv/Scripts/python scripts/estadistica.py comparar --a preds_A.csv --b preds_B.csv" />
        <div style={{ fontSize: 11, color: MUTED, display: 'flex', gap: 6, alignItems: 'center' }}>
          <Download size={12} /> Procedimiento completo en docs/EXPERIMENTO_MODELOS.md (secciones 5 a 7).
        </div>
      </div>
    </div>
  );
};

export default Evaluacion;
