import React, { useEffect, useMemo, useState } from 'react';
import { Cpu, Globe, Mail, RotateCcw, Save, Server } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import { useConsulta } from '../lib/hooks';
import type { EstadoAnpr } from '../lib/tipos';
import { fechaHora, numero } from '../lib/formato';
import { Aviso, Cargando, Interruptor, Tarjeta } from '../components/ui';
import { useNotificar } from '../components/Notificaciones';

interface Parametro {
  clave: string; tipo: 'booleano' | 'entero' | 'lista' | 'texto' | 'opcion'; etiqueta: string; descripcion: string; grupo: string;
  min?: number; max?: number; opciones?: { valor: string; etiqueta: string }[]; valor: string; origen: 'sistema' | 'entorno' | 'omision';
  actualizado_por: string | null; fecha_actualizacion: string | null;
}
interface RespuestaConfig {
  parametros: Parametro[];
  entorno: { zona_horaria: string; correo_configurado: boolean; remitente_correo: string | null; frontend_url: string | null; entorno: string; anpr: EstadoAnpr };
}

const ORIGEN: Record<Parametro['origen'], string> = { sistema: 'Definido en esta pantalla', entorno: 'Variable de entorno del servidor', omision: 'Valor por omisión' };

const Configuracion: React.FC = () => {
  const notificar = useNotificar();
  const { datos, cargando, error, setDatos } = useConsulta<RespuestaConfig>(() => api.get('/configuracion').then(r => r.data), []);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  useEffect(() => { if (datos) setValores(Object.fromEntries(datos.parametros.map(p => [p.clave, p.valor]))); }, [datos]);
  const cambios = useMemo(() => (datos?.parametros ?? []).filter(p => valores[p.clave] !== undefined && valores[p.clave] !== p.valor), [datos, valores]);
  const grupos = useMemo(() => [...new Set((datos?.parametros ?? []).map(p => p.grupo))], [datos]);

  const guardar = async () => {
    setGuardando(true);
    setErrorGuardar(null);
    try {
      const r = await api.put('/configuracion', { valores: Object.fromEntries(cambios.map(p => [p.clave, valores[p.clave]])) });
      setDatos(d => d && { ...d, parametros: r.data.parametros });
      notificar('exito', r.data.message, 'Los cambios quedan registrados en la auditoría.');
    } catch (e) {
      setErrorGuardar(mensajeError(e));
    } finally { setGuardando(false); }
  };

  if (cargando && !datos) return <div className="pagina"><Cargando alto={300} /></div>;
  if (!datos) return <div className="pagina"><Aviso tipo="error">{error ?? 'No se pudo cargar la configuración.'}</Aviso></div>;
  const e = datos.entorno;

  return (
    <div className="pagina" style={{ maxWidth: 1200 }}>
      <div className="grid-principal" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <div className="pila">
          {grupos.map(g => (
            <Tarjeta key={g} titulo={g} sinPadding>
              {datos.parametros.filter(p => p.grupo === g).map((p, i) => (
                <div key={p.clave} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(180px, 260px)', gap: 16, padding: '16px 20px', borderTop: i ? '1px solid var(--border)' : undefined, alignItems: 'center' }}>
                  <div>
                    <label htmlFor={`cfg-${p.clave}`} style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text)' }}>{p.etiqueta}</label>
                    <p className="texto-secundario" style={{ marginTop: 2 }}>{p.descripcion}</p>
                    <p style={{ fontSize: 11.5, color: 'var(--text-4)', marginTop: 4 }}>
                      {ORIGEN[p.origen]}{p.actualizado_por && ` · ${p.actualizado_por}, ${fechaHora(p.fecha_actualizacion)}`}
                    </p>
                  </div>
                  <div style={{ justifySelf: p.tipo === 'booleano' ? 'end' : 'stretch' }}>
                    {p.tipo === 'booleano' ? (
                      <Interruptor activo={valores[p.clave] === 'true'} onCambiar={v => setValores({ ...valores, [p.clave]: String(v) })} etiqueta={p.etiqueta} />
                    ) : p.tipo === 'opcion' ? (
                      <select id={`cfg-${p.clave}`} className="select" value={valores[p.clave] ?? ''} onChange={ev => setValores({ ...valores, [p.clave]: ev.target.value })}>
                        {p.opciones?.map(o => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
                      </select>
                    ) : (
                      <input id={`cfg-${p.clave}`} className="input" type={p.tipo === 'entero' ? 'number' : 'text'} min={p.min} max={p.max}
                        value={valores[p.clave] ?? ''} onChange={ev => setValores({ ...valores, [p.clave]: ev.target.value })} />
                    )}
                    {p.tipo === 'entero' && <span className="texto-secundario" style={{ fontSize: 11.5 }}>Entre {p.min} y {p.max}</span>}
                  </div>
                </div>
              ))}
            </Tarjeta>
          ))}
          {errorGuardar && <Aviso tipo="error">{errorGuardar}</Aviso>}
          <div className="fila" style={{ justifyContent: 'flex-end', position: 'sticky', bottom: 16 }}>
            {cambios.length > 0 && <span className="texto-secundario">{cambios.length} {cambios.length === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}</span>}
            <button className="btn btn-secondary" disabled={!cambios.length || guardando} onClick={() => setValores(Object.fromEntries(datos.parametros.map(p => [p.clave, p.valor])))}><RotateCcw size={15} /> Descartar</button>
            <button className="btn btn-navy" disabled={!cambios.length || guardando} onClick={guardar}><Save size={15} /> {guardando ? 'Guardando…' : 'Guardar configuración'}</button>
          </div>
        </div>

        <div className="pila">
          <Tarjeta titulo="Motor ANPR" acciones={<Cpu size={17} color="var(--text-3)" />}>
            <dl className="definiciones">
              <dt>Estado</dt><dd><span className="fila" style={{ gap: 6 }}><span className={`punto ${e.anpr.en_linea ? 'verde' : 'rojo'}`} />{e.anpr.en_linea ? 'En línea' : e.anpr.error ?? 'Fuera de línea'}</span></dd>
              {e.anpr.en_linea && <>
                <dt>Captura</dt><dd>{numero(e.anpr.fps_captura ?? 0)} fps · análisis {numero(e.anpr.fps_procesamiento ?? 0)} fps</dd>
                <dt>Detector</dt><dd className="mono" style={{ fontSize: 12 }}>{e.anpr.detector ?? '—'}</dd>
                <dt>OCR</dt><dd className="mono" style={{ fontSize: 12 }}>{e.anpr.ocr ?? '—'}</dd>
                <dt>Verificador</dt><dd className="mono" style={{ fontSize: 12 }}>{e.anpr.verificador ?? '—'}</dd>
              </>}
            </dl>
            <p className="texto-secundario" style={{ marginTop: 12 }}>Los umbrales y modelos del motor se configuran en services/anpr/.env y requieren reiniciar el servicio.</p>
          </Tarjeta>
          <Tarjeta titulo="Correo electrónico" acciones={<Mail size={17} color="var(--text-3)" />}>
            <dl className="definiciones">
              <dt>SMTP</dt><dd><span className="fila" style={{ gap: 6 }}><span className={`punto ${e.correo_configurado ? 'verde' : 'ambar'}`} />{e.correo_configurado ? 'Configurado' : 'Sin configurar'}</span></dd>
              <dt>Remitente</dt><dd>{e.remitente_correo ?? '—'}</dd>
            </dl>
            {!e.correo_configurado && <Aviso tipo="advertencia" style={{ marginTop: 12 }}>Sin SMTP los enlaces de verificación y recuperación solo se escriben en el registro del servidor.</Aviso>}
          </Tarjeta>
          <Tarjeta titulo="Servidor" acciones={<Server size={17} color="var(--text-3)" />}>
            <dl className="definiciones">
              <dt>Entorno</dt><dd>{e.entorno}</dd>
              <dt>Zona horaria</dt><dd>{e.zona_horaria}</dd>
              <dt>URL pública</dt><dd className="mono" style={{ fontSize: 12 }}><Globe size={12} style={{ verticalAlign: -1 }} /> {e.frontend_url ?? '—'}</dd>
            </dl>
          </Tarjeta>
        </div>
      </div>
    </div>
  );
};

export default Configuracion;
