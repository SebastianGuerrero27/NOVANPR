import React, { useMemo, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, Play, RadioTower, XCircle } from 'lucide-react';
import api, { mensajeError } from '../services/api';
import type { Camara } from '../lib/tipos';
import { Aviso, Modal } from './ui';
import { ReproductorPrueba } from './envivo';

/**
 * Alta y edición de cámaras. El personal elige el tipo de equipo e ingresa IP, puerto,
 * usuario y contraseña; el enlace RTSP se arma solo (con la contraseña codificada para
 * URL) y se puede probar antes de guardar.
 */

type Perfil = 'hikvision' | 'dahua' | 'celular_rtsp' | 'ip_webcam' | 'generica' | 'manual';

const PERFILES: Record<Perfil, { etiqueta: string; puerto: number; ruta: string; credenciales: 'si' | 'no' | 'opcional'; ayuda: string }> = {
  hikvision: {
    etiqueta: 'Cámara Hikvision', puerto: 554, ruta: '/Streaming/Channels/101', credenciales: 'si',
    ayuda: 'Canal 101 = flujo principal (más nitidez); 102 = flujo secundario (menos consumo). Usuario habitual: admin.',
  },
  dahua: {
    etiqueta: 'Cámara Dahua / Imou', puerto: 554, ruta: '/cam/realmonitor?channel=1&subtype=0', credenciales: 'si',
    ayuda: 'subtype=0 es el flujo principal; subtype=1 el secundario.',
  },
  celular_rtsp: {
    etiqueta: 'Celular · app servidor RTSP (puerto 8554)', puerto: 8554, ruta: '/', credenciales: 'opcional',
    ayuda: 'Apps tipo “RTSP Camera Server” / RootEncoder. Use la IP que muestra la app; el celular y este equipo deben estar en la misma red WiFi. Ingrese usuario y contraseña solo si los activó en la app.',
  },
  ip_webcam: {
    etiqueta: 'Celular · IP Webcam (Android)', puerto: 8080, ruta: '/h264_ulaw.sdp', credenciales: 'opcional',
    ayuda: 'En IP Webcam pulse “Iniciar servidor”. Si configuró usuario y contraseña en la app, ingréselos aquí.',
  },
  generica: {
    etiqueta: 'Cámara IP genérica (ONVIF / RTSP)', puerto: 554, ruta: '/', credenciales: 'opcional',
    ayuda: 'Consulte la ruta RTSP en el manual del fabricante (p. ej. /live, /stream1, /h264).',
  },
  manual: { etiqueta: 'Escribir la URL completa (avanzado)', puerto: 554, ruta: '/', credenciales: 'opcional', ayuda: '' },
};

const MASCARA = '******';
const RE_URL = /^rtsps?:\/\/(?:([^:@/]+)(?::([^@]*))?@)?([^:/?#]+)(?::(\d+))?([^#]*)$/i;

function detectarPerfil(puerto: number, ruta: string): Perfil {
  if (/^\/Streaming\/Channels\//i.test(ruta)) return 'hikvision';
  if (/^\/cam\/realmonitor/i.test(ruta)) return 'dahua';
  if (/\.sdp$/i.test(ruta) && puerto === 8080) return 'ip_webcam';
  if (puerto === 8554) return 'celular_rtsp';
  return 'generica';
}

function desarmar(url: string) {
  const m = url.match(RE_URL);
  if (!m) return null;
  const dec = (s?: string) => { try { return s ? decodeURIComponent(s) : ''; } catch { return s ?? ''; } };
  return { usuario: dec(m[1]), clave: m[2] ?? '', host: m[3], puerto: Number(m[4]) || 554, ruta: m[5] || '/' };
}

const DIAGNOSTICO: Record<string, string> = {
  requiere_credenciales: 'La cámara pide usuario y contraseña: complételos y vuelva a probar.',
  credenciales_invalidas: 'Usuario o contraseña incorrectos.',
  ruta_no_encontrada: 'El equipo responde, pero la ruta del flujo no existe. Revise la ruta o el tipo de equipo.',
  rechazado: 'El equipo rechazó la conexión: verifique el puerto y que el servidor RTSP esté iniciado (en el celular, que la app esté transmitiendo).',
  sin_respuesta: 'Sin respuesta: verifique la IP, que el equipo esté encendido y en la misma red que este servidor.',
  url_invalida: 'La dirección no es válida.',
};

export interface ResultadoDiagnostico {
  ping: { host: string; responde: boolean; tiempo_ms: number | null; mensaje: string } | null;
  rtsp: { en_linea: boolean; diagnostico: string; mensaje: string; tiempo_ms: number | null; servidor?: string | null; puerto: number | null };
}

/** Resultado del Ping (red) y del diagnóstico RTSP (servicio de video), con la causa probable. */
export const PanelDiagnostico: React.FC<{ resultado: ResultadoDiagnostico }> = ({ resultado }) => {
  const { ping, rtsp } = resultado;
  const Fila: React.FC<{ ok: boolean; titulo: string; detalle: React.ReactNode }> = ({ ok, titulo, detalle }) => (
    <div className="fila" style={{ alignItems: 'flex-start', gap: 10, flexWrap: 'nowrap' }}>
      {ok ? <CheckCircle2 size={18} color="var(--autorizado)" style={{ flexShrink: 0 }} /> : <XCircle size={18} color="var(--alerta)" style={{ flexShrink: 0 }} />}
      <div><strong style={{ fontSize: 13 }}>{titulo}</strong><div className="texto-secundario">{detalle}</div></div>
    </div>
  );
  return (
    <div className="pila" style={{ gap: 12 }}>
      <Fila ok={Boolean(ping?.responde)} titulo={`Ping · red${ping ? ` (${ping.host})` : ''}`}
        detalle={ping ? (ping.responde ? `Responde${ping.tiempo_ms !== null ? ` en ${ping.tiempo_ms} ms` : ''}` : ping.mensaje) : 'Host inválido'} />
      <Fila ok={rtsp.en_linea} titulo={`RTSP · servicio de video${rtsp.puerto ? ` (puerto ${rtsp.puerto})` : ''}`}
        detalle={<>{rtsp.mensaje}{rtsp.tiempo_ms !== null && rtsp.en_linea ? ` · ${rtsp.tiempo_ms} ms` : ''}{rtsp.servidor ? ` · ${rtsp.servidor}` : ''}</>} />
      {!rtsp.en_linea && DIAGNOSTICO[rtsp.diagnostico] && <Aviso tipo="advertencia">{DIAGNOSTICO[rtsp.diagnostico]}</Aviso>}
      {!ping?.responde && rtsp.en_linea && <p className="texto-secundario">El equipo no responde al ping pero sí al RTSP: es normal si bloquea ICMP.</p>}
      {rtsp.en_linea && <Aviso tipo="exito">La cámara entrega el flujo. Use <b>Play</b> para confirmar que el video se está recibiendo.</Aviso>}
    </div>
  );
};

export const FormularioCamara: React.FC<{ camara?: Camara; onCerrar: () => void; onGuardada: (c: Camara) => void }> = ({ camara, onCerrar, onGuardada }) => {
  const previa = camara ? desarmar(camara.rtsp_url) : null;
  const [nombre, setNombre] = useState(camara?.nombre ?? '');
  const [ubicacion, setUbicacion] = useState(camara?.ubicacion ?? '');
  const [perfil, setPerfil] = useState<Perfil>(previa ? detectarPerfil(previa.puerto, previa.ruta) : 'hikvision');
  const [host, setHost] = useState(previa?.host ?? '');
  const [puerto, setPuerto] = useState(String(previa?.puerto ?? PERFILES.hikvision.puerto));
  const [ruta, setRuta] = useState(previa?.ruta ?? PERFILES.hikvision.ruta);
  const [usuario, setUsuario] = useState(previa?.usuario ?? '');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [urlManual, setUrlManual] = useState(camara?.rtsp_url ?? '');
  const [prueba, setPrueba] = useState<ResultadoDiagnostico | null>(null);
  const [errorPrueba, setErrorPrueba] = useState<string | null>(null);
  const [reproducir, setReproducir] = useState(false);
  const [probando, setProbando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claveGuardada = Boolean(camara?.tiene_credenciales);
  const p = PERFILES[perfil];

  const cambiarPerfil = (nuevo: Perfil) => {
    setPerfil(nuevo);
    setPrueba(null);
    if (nuevo === 'manual') { setUrlManual(url || urlManual); return; }
    setPuerto(String(PERFILES[nuevo].puerto));
    setRuta(PERFILES[nuevo].ruta);
    if (nuevo === 'hikvision' && !usuario) setUsuario('admin');
  };

  /** URL con la contraseña real (para enviar) y versión enmascarada (para mostrar). */
  const { url, urlVisible } = useMemo(() => {
    if (perfil === 'manual') return { url: urlManual.trim(), urlVisible: urlManual.trim().replace(/(:\/\/[^:@/]+:)[^@]+@/, `$1${MASCARA}@`) };
    if (!host.trim()) return { url: '', urlVisible: '' };
    const r = ruta.trim() ? (ruta.trim().startsWith('/') ? ruta.trim() : `/${ruta.trim()}`) : '/';
    const u = usuario.trim();
    const c = clave || (claveGuardada && u ? MASCARA : '');
    const auth = u ? `${encodeURIComponent(u)}${c ? `:${c === MASCARA ? MASCARA : encodeURIComponent(c)}` : ''}@` : '';
    const authVisible = u ? `${encodeURIComponent(u)}${c ? `:${MASCARA}` : ''}@` : '';
    const base = `${host.trim()}:${Number(puerto) || p.puerto}${r}`;
    return { url: `rtsp://${auth}${base}`, urlVisible: `rtsp://${authVisible}${base}` };
  }, [perfil, urlManual, host, puerto, ruta, usuario, clave, claveGuardada, p.puerto]);

  const hostValido = perfil === 'manual' || /^[a-zA-Z0-9.-]+$/.test(host.trim());
  const valido = nombre.trim().length >= 3 && ubicacion.trim().length >= 3 && /^rtsps?:\/\/.+/i.test(url) && hostValido
    && (perfil === 'manual' || (Number(puerto) > 0 && Number(puerto) < 65536));

  const probar = async () => {
    setProbando(true);
    setPrueba(null);
    setErrorPrueba(null);
    try {
      setPrueba((await api.post('/camaras/probar', { rtsp_url: url, camara_id: camara?.id })).data);
    } catch (e) {
      setErrorPrueba(mensajeError(e));
    } finally { setProbando(false); }
  };

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    const cuerpo = { nombre, ubicacion, rtsp_url: url, ip: perfil === 'manual' ? '' : host.trim() };
    try {
      const r = camara ? await api.put(`/camaras/${camara.id}`, cuerpo) : await api.post('/camaras', cuerpo);
      onGuardada(r.data.camera);
    } catch (e) {
      setError(mensajeError(e));
      setEnviando(false);
    }
  };

  return (
    <Modal titulo={camara ? 'Editar cámara' : 'Registrar cámara'} subtitulo="El enlace RTSP se genera con los datos del equipo" onCerrar={onCerrar} bloquear={enviando} tamano="ancho"
      pie={<>
        <button className="btn btn-secondary" onClick={onCerrar} disabled={enviando}>Cancelar</button>
        <button className="btn btn-secondary" onClick={probar} disabled={!url || !hostValido || probando || enviando}>
          {probando ? <Loader2 size={14} className="girar" /> : <RadioTower size={14} />} Ping</button>
        <button className="btn btn-secondary" onClick={() => setReproducir(true)} disabled={!url || !hostValido || enviando}><Play size={14} /> Play</button>
        <button className="btn btn-navy" onClick={guardar} disabled={!valido || enviando}>{enviando && <Loader2 size={14} className="girar" />} Guardar</button>
      </>}>
      <div className="form-grid">
        <div className="campo"><label htmlFor="c-nombre">Nombre*</label>
          <input id="c-nombre" className="input" value={nombre} onChange={e => setNombre(e.target.value)} maxLength={100} placeholder="Ej.: Garita principal – entrada" autoFocus /></div>
        <div className="campo"><label htmlFor="c-ubic">Ubicación*</label>
          <input id="c-ubic" className="input" value={ubicacion} onChange={e => setUbicacion(e.target.value)} maxLength={150} placeholder="Ej.: Acceso vehicular norte" /></div>

        <div className="campo completo"><label htmlFor="c-perfil">Tipo de equipo</label>
          <select id="c-perfil" className="select" value={perfil} onChange={e => cambiarPerfil(e.target.value as Perfil)}>
            {(Object.keys(PERFILES) as Perfil[]).map(k => <option key={k} value={k}>{PERFILES[k].etiqueta}</option>)}
          </select>
          {p.ayuda && <span className="ayuda">{p.ayuda}</span>}
        </div>

        {perfil === 'manual' ? (
          <div className="campo completo"><label htmlFor="c-url">URL RTSP completa*</label>
            <input id="c-url" className="input mono" value={urlManual} onChange={e => { setUrlManual(e.target.value); setPrueba(null); }} maxLength={255}
              spellCheck={false} autoCapitalize="none" placeholder="rtsp://usuario:contraseña@192.168.1.64:554/ruta" />
            <span className="ayuda">Si la contraseña tiene símbolos (@, :, /, #) use los campos del modo guiado: allí se codifican automáticamente.</span></div>
        ) : (
          <>
            <div className="campo"><label htmlFor="c-host">IP o nombre del equipo*</label>
              <input id="c-host" className="input mono" value={host} onChange={e => { setHost(e.target.value.trim()); setPrueba(null); }} maxLength={100}
                spellCheck={false} autoCapitalize="none" placeholder="192.168.0.102" />
              {!hostValido && <span className="error">Solo números, letras, puntos y guiones (sin rtsp:// ni puerto).</span>}</div>
            <div className="form-grid" style={{ gridTemplateColumns: '110px 1fr', gap: 10 }}>
              <div className="campo"><label htmlFor="c-puerto">Puerto*</label>
                <input id="c-puerto" className="input mono" type="number" min={1} max={65535} value={puerto} onChange={e => { setPuerto(e.target.value); setPrueba(null); }} /></div>
              <div className="campo"><label htmlFor="c-ruta">Ruta del flujo</label>
                <input id="c-ruta" className="input mono" value={ruta} onChange={e => { setRuta(e.target.value); setPrueba(null); }} maxLength={120} spellCheck={false} autoCapitalize="none" /></div>
            </div>
            <div className="campo"><label htmlFor="c-usuario">Usuario{p.credenciales === 'si' ? '*' : ' (si el equipo lo pide)'}</label>
              <input id="c-usuario" className="input" value={usuario} onChange={e => { setUsuario(e.target.value); setPrueba(null); }} maxLength={60} autoComplete="off" spellCheck={false} autoCapitalize="none" /></div>
            <div className="campo"><label htmlFor="c-clave">Contraseña{p.credenciales === 'si' && !claveGuardada ? '*' : ''}</label>
              <div style={{ position: 'relative' }}>
                <input id="c-clave" className="input" type={verClave ? 'text' : 'password'} value={clave} onChange={e => { setClave(e.target.value); setPrueba(null); }}
                  maxLength={100} autoComplete="new-password" style={{ paddingRight: 40 }}
                  placeholder={claveGuardada ? 'Guardada · deje vacío para conservarla' : ''} disabled={!usuario.trim()} />
                <button type="button" className="btn btn-ghost btn-sm btn-icono" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setVerClave(v => !v)} aria-label={verClave ? 'Ocultar' : 'Mostrar'}>
                  {verClave ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              {!usuario.trim() && <span className="ayuda">Ingrese primero el usuario.</span>}
            </div>
            <div className="campo completo">
              <span className="etiqueta-campo">Enlace RTSP generado</span>
              <div className="mono" style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--surface-3)', border: '1px dashed var(--border-strong)', fontSize: 12.5, wordBreak: 'break-all', color: url ? 'var(--text)' : 'var(--text-4)' }}>
                {urlVisible || 'Complete la IP para generar el enlace'}
              </div>
              <span className="ayuda">La contraseña se guarda en el servidor y no se muestra a otros usuarios.</span>
            </div>
          </>
        )}

        {prueba && <div className="completo"><PanelDiagnostico resultado={prueba} /></div>}
        {errorPrueba && <div className="completo"><Aviso tipo="error">{errorPrueba}</Aviso></div>}
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
      {reproducir && <ReproductorPrueba titulo={nombre || 'cámara sin guardar'} rtspUrl={url} camaraId={camara?.id} onCerrar={() => setReproducir(false)} />}
    </Modal>
  );
};
