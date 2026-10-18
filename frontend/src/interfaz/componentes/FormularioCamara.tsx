import React, { useMemo, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, Play, RadioTower, XCircle } from 'lucide-react';
import api, { mensajeError } from '../../infraestructura/api';
import type { Camara } from '../../dominio/tipos';
import { type ReglaTexto, errorDe, sinErrores, validarEntero, validarHost, validarTexto } from '../../dominio/validacion';
import { REGLAS_CAMARA } from '../../dominio/reglas';
import { Aviso, Modal } from './ui';
import { CampoEntero, CampoTexto } from './campos';
import { ReproductorPrueba } from './envivo';

/**
 * Alta y edición de cámaras. El personal elige el tipo de equipo e ingresa IP, puerto,
 * usuario y contraseña; el enlace RTSP se arma solo (con la contraseña codificada para
 * URL) y se puede probar antes de guardar.
 *
 * En Hikvision y Dahua se arma también el enlace del flujo secundario (mismo equipo y
 * credenciales) para la vista en vivo: el motor analiza el principal a máxima resolución y el
 * navegador muestra el secundario.
 */

type Perfil = 'hikvision' | 'dahua' | 'generica' | 'manual';

const PERFILES: Record<Perfil, { etiqueta: string; puerto: number; ruta: string; credenciales: 'si' | 'no' | 'opcional'; ayuda: string }> = {
  hikvision: {
    etiqueta: 'Cámara Hikvision', puerto: 554, ruta: '/Streaming/Channels/101', credenciales: 'opcional',
    ayuda: 'Canal 101 = flujo principal; 102 = flujo secundario para vista en vivo. Las credenciales son opcionales si el RTSP de la cámara permite acceso sin autenticación. En la cámara use H.264 o H.265 sin «+».',
  },
  dahua: {
    etiqueta: 'Cámara Dahua / Imou', puerto: 554, ruta: '/cam/realmonitor?channel=1&subtype=0', credenciales: 'opcional',
    ayuda: 'subtype=0 es el flujo principal; subtype=1 el secundario. Las credenciales son opcionales si la cámara acepta RTSP anónimo.',
  },
  generica: {
    etiqueta: 'Cámara IP genérica (ONVIF / RTSP)', puerto: 554, ruta: '/', credenciales: 'opcional',
    ayuda: 'Consulte la ruta RTSP en el manual del fabricante (p. ej. /live, /stream1, /h264).',
  },
  manual: { etiqueta: 'Escribir la URL completa (avanzado)', puerto: 554, ruta: '/', credenciales: 'opcional', ayuda: '' },
};

const MASCARA = '******';
const RE_URL = /^rtsps?:\/\/(?:([^:@/]+)(?::([^@]*))?@)?([^:/?#]+)(?::(\d+))?([^#]*)$/i;

// Reglas de la URL y de la IP de backend/src/dominio/camaras.ts (leerUrlRtsp y leerIp)
const LARGO_MAXIMO_RTSP = 255;
const LARGO_MAXIMO_IP = 45;
// eslint-disable-next-line no-control-regex
const RE_URL_RTSP = /^rtsps?:\/\/[^\s<>\u0000-\u001F\u007F]*$/i;
const MENSAJE_URL_RTSP = 'Ingrese una URL RTSP válida (rtsp://…).';

const REGLA_HOST: ReglaTexto = { etiqueta: 'IP o nombre del equipo', tipo: 'libre', max: LARGO_MAXIMO_IP, requerido: true };
const REGLA_RUTA: ReglaTexto = { etiqueta: 'Ruta del flujo', tipo: 'libre', max: 120 };
const REGLA_URL: ReglaTexto = { etiqueta: 'URL RTSP', tipo: 'libre', max: LARGO_MAXIMO_RTSP, requerido: true };
const REGLA_URL_VISTA: ReglaTexto = { etiqueta: 'URL del flujo de vista', tipo: 'libre', max: LARGO_MAXIMO_RTSP };
const reglaUsuario = (requerido: boolean): ReglaTexto => ({ etiqueta: 'Usuario', tipo: 'libre', max: 60, requerido });

/** IP o nombre del equipo: solo letras, números, puntos y guiones (sin rtsp:// ni puerto). */
const filtrarHost = (v: string) => v.replace(/[^A-Za-z0-9.-]/g, '');
/** Partes de una URL o credenciales: sin espacios ni < > */
const sinEspacios = (v: string) => v.replace(/[\s<>]/g, '');

/** Enlace completo: rtsp:// o rtsps://, sin espacios ni caracteres de control, hasta 255 caracteres. */
function errorFormatoRtsp(url: string): string | null {
  if (!RE_URL_RTSP.test(url)) return MENSAJE_URL_RTSP;
  if (url.length > LARGO_MAXIMO_RTSP) return `URL RTSP: máximo ${LARGO_MAXIMO_RTSP} caracteres.`;
  return null;
}

/** Contraseña de la URL, leída como la API (backend/src/dominio/camaras.ts → RE_CREDENCIALES). */
const RE_CREDENCIALES = /^(rtsps?:\/\/[^:/?#]*:)([^/?#]+)(@)/i;

/** IP o nombre del equipo: validarHost y el largo de la columna Camaras.ip. */
function errorIp(host: string): string | null {
  const h = host.trim();
  if (!h) return 'La IP o el nombre del equipo es obligatorio.';
  if (h.length > LARGO_MAXIMO_IP) return `IP o nombre del equipo: máximo ${LARGO_MAXIMO_IP} caracteres.`;
  return errorDe(validarHost(h, 'IP o nombre del equipo'));
}

/** URL RTSP completa (modo avanzado): formato de la API y un host válido. */
function errorUrlRtsp(url: string): string | null {
  const u = url.trim();
  if (!u) return 'La URL RTSP es obligatoria.';
  if (!/^rtsps?:\/\//i.test(u)) return 'La URL debe empezar con rtsp:// o rtsps://.';
  const formato = errorFormatoRtsp(u);
  if (formato) return formato;
  const partes = desarmar(u);
  if (!partes) return 'URL RTSP inválida.';
  return errorDe(validarHost(partes.host, 'Host de la URL'));
}

/**
 * Ruta del flujo secundario del mismo equipo, derivada de la del principal: Hikvision
 * /Streaming/Channels/<canal>01 → <canal>02 (también /ISAPI/…) y Dahua subtype=0 → subtype=1.
 * null si la ruta no es la de un flujo principal reconocible.
 */
export function rutaSecundaria(ruta: string): string | null {
  const hikvision = ruta.match(/^(.*\/Streaming\/Channels\/\d*?)01((?:[/?].*)?)$/i);
  if (hikvision) return `${hikvision[1]}02${hikvision[2]}`;
  const dahua = ruta.match(/^(\/cam\/realmonitor\?(?:.*&)?subtype=)0((?:&.*)?)$/i);
  if (dahua) return `${dahua[1]}1${dahua[2]}`;
  return null;
}

/** Ruta del flujo con la barra inicial ("/" si está vacía). */
const conBarra = (ruta: string) => (ruta.trim() ? (ruta.trim().startsWith('/') ? ruta.trim() : `/${ruta.trim()}`) : '/');

function detectarPerfil(ruta: string): Perfil {
  if (/^\/Streaming\/Channels\//i.test(ruta)) return 'hikvision';
  if (/^\/cam\/realmonitor/i.test(ruta)) return 'dahua';
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
  rechazado: 'El equipo rechazó la conexión: verifique el puerto y que el servicio RTSP de la cámara esté habilitado.',
  sin_respuesta: 'Sin respuesta: verifique la IP, que el equipo esté encendido y en la misma red que este servidor.',
  url_invalida: 'La dirección no es válida.',
  red_no_permitida: 'La dirección está fuera de las redes autorizadas para cámaras (CAMARAS_REDES_PERMITIDAS del servidor). Solicite al responsable de la red que la incluya.',
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

/** URL RTSP completa del modo avanzado: sin espacios, máximo 255 caracteres, error al salir del campo. */
const CampoUrl: React.FC<{ valor: string; error: string | null; onCambiar: (v: string) => void }> = ({ valor, error, onCambiar }) => (
  <CampoTexto id="c-url" className="completo" etiqueta="URL RTSP completa*" valor={valor} onCambiar={onCambiar} error={error}
    regla={REGLA_URL} filtrar={sinEspacios} literal claseControl="mono"
    placeholder="rtsp://usuario:contraseña@192.0.2.10:554/ruta"
    ayuda="Si la contraseña tiene símbolos (@, :, /, #) use los campos del modo guiado: allí se codifican automáticamente." />
);

export const FormularioCamara: React.FC<{ camara?: Camara; onCerrar: () => void; onGuardada: (c: Camara) => void }> = ({ camara, onCerrar, onGuardada }) => {
  const previa = camara ? desarmar(camara.rtsp_url) : null;
  const previaVista = camara?.rtsp_url_vista ? desarmar(camara.rtsp_url_vista) : null;
  // Una vista que no es el flujo secundario del mismo equipo (escrita a mano) se edita en el modo avanzado
  const vistaPropia = Boolean(previa && previaVista && (previaVista.host !== previa.host || previaVista.puerto !== previa.puerto
    || previaVista.usuario !== previa.usuario || previaVista.ruta !== rutaSecundaria(previa.ruta)));
  const [nombre, setNombre] = useState(camara?.nombre ?? '');
  const [ubicacion, setUbicacion] = useState(camara?.ubicacion ?? '');
  const [direccion, setDireccion] = useState<Camara['direccion']>(camara?.direccion ?? 'ingreso');
  const [perfil, setPerfil] = useState<Perfil>(previa ? (vistaPropia ? 'manual' : detectarPerfil(previa.ruta)) : 'hikvision');
  const [host, setHost] = useState(previa?.host ?? '');
  const [puerto, setPuerto] = useState(String(previa?.puerto ?? PERFILES.hikvision.puerto));
  const [ruta, setRuta] = useState(previa?.ruta ?? PERFILES.hikvision.ruta);
  const [usuario, setUsuario] = useState(previa?.usuario ?? '');
  const [clave, setClave] = useState('');
  const [claveTocada, setClaveTocada] = useState(false);
  const [verClave, setVerClave] = useState(false);
  const [urlManual, setUrlManual] = useState(camara?.rtsp_url ?? '');
  // Alta: vista por el flujo secundario activada; edición: como está guardada
  const [usarVista, setUsarVista] = useState(camara ? Boolean(camara.rtsp_url_vista) : true);
  const [urlVistaManual, setUrlVistaManual] = useState(camara?.rtsp_url_vista ?? '');
  const [prueba, setPrueba] = useState<ResultadoDiagnostico | null>(null);
  const [pruebaVista, setPruebaVista] = useState<ResultadoDiagnostico['rtsp'] | null>(null);
  const [errorPrueba, setErrorPrueba] = useState<string | null>(null);
  const [reproducir, setReproducir] = useState(false);
  const [probando, setProbando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = PERFILES[perfil];
  // La API solo conserva la contraseña guardada para el mismo equipo: si cambian la IP o el puerto
  // hay que escribirla de nuevo (así no se puede enviar la contraseña custodiada a otro equipo)
  const otroEquipo = Boolean(previa && perfil !== 'manual'
    && (host.trim().toLowerCase() !== previa.host.toLowerCase() || (Number(puerto) || p.puerto) !== previa.puerto));
  const claveGuardada = Boolean(camara?.tiene_credenciales) && !otroEquipo;

  const cambiarPerfil = (nuevo: Perfil) => {
    setPerfil(nuevo);
    setPrueba(null);
    if (nuevo === 'manual') { setUrlManual(url || urlManual); setUrlVistaManual(urlVista || urlVistaManual); return; }
    setPuerto(String(PERFILES[nuevo].puerto));
    setRuta(PERFILES[nuevo].ruta);
    if (nuevo === 'hikvision' && !usuario) setUsuario('admin');
  };

  const secundaria = perfil === 'manual' ? null : rutaSecundaria(conBarra(ruta));

  /** URLs (principal y de vista) con la contraseña real (para enviar) y enmascaradas (para mostrar). */
  const { url, urlVisible, urlVista, urlVistaVisible } = useMemo(() => {
    const enmascarar = (u: string) => u.replace(RE_CREDENCIALES, `$1${MASCARA}$3`);
    if (perfil === 'manual') {
      return { url: urlManual.trim(), urlVisible: enmascarar(urlManual.trim()), urlVista: urlVistaManual.trim(), urlVistaVisible: enmascarar(urlVistaManual.trim()) };
    }
    if (!host.trim()) return { url: '', urlVisible: '', urlVista: '', urlVistaVisible: '' };
    const u = usuario.trim();
    const c = clave || (claveGuardada && u ? MASCARA : '');
    const auth = u ? `${encodeURIComponent(u)}${c ? `:${c === MASCARA ? MASCARA : encodeURIComponent(c)}` : ''}@` : '';
    const authVisible = u ? `${encodeURIComponent(u)}${c ? `:${MASCARA}` : ''}@` : '';
    const base = (r: string) => `${host.trim()}:${Number(puerto) || p.puerto}${r}`;
    const vista = usarVista && secundaria;
    return {
      url: `rtsp://${auth}${base(conBarra(ruta))}`, urlVisible: `rtsp://${authVisible}${base(conBarra(ruta))}`,
      urlVista: vista ? `rtsp://${auth}${base(vista)}` : '', urlVistaVisible: vista ? `rtsp://${authVisible}${base(vista)}` : '',
    };
  }, [perfil, urlManual, urlVistaManual, host, puerto, ruta, usuario, clave, claveGuardada, p.puerto, usarVista, secundaria]);

  // Mismas reglas que la API: nombre y ubicación alfanuméricos, IP o host válido, puerto 1–65535 y
  // enlace rtsp:// de hasta 255 caracteres. Las credenciales son opcionales en todos los perfiles.
  const guiado = perfil !== 'manual';
  const exigeCredenciales = false;
  const errorHost = guiado ? errorIp(host) : null;
  const errorUrl = guiado ? null : errorUrlRtsp(urlManual);
  const errorEnlace = guiado && url ? errorFormatoRtsp(url) : null;
  const errorVista = guiado ? (urlVista ? errorFormatoRtsp(urlVista) : null) : (urlVistaManual.trim() ? errorUrlRtsp(urlVistaManual) : null);
  const reescribirClave = Boolean(camara?.tiene_credenciales && otroEquipo && usuario.trim() && !clave);
  const errorClave = reescribirClave ? 'Cambió la IP o el puerto: escriba de nuevo la contraseña.' : null;
  const hostValido = guiado ? !errorHost : !errorUrl;
  const valido = sinErrores({
    nombre: errorDe(validarTexto(nombre, REGLAS_CAMARA.nombre)),
    ubicacion: errorDe(validarTexto(ubicacion, REGLAS_CAMARA.ubicacion)),
    host: errorHost,
    url: errorUrl,
    enlace: errorEnlace,
    vista: errorVista,
    puerto: guiado ? errorDe(validarEntero(puerto, { etiqueta: 'Puerto', min: 1, max: 65535, requerido: true })) : null,
    ruta: guiado ? errorDe(validarTexto(ruta, REGLA_RUTA)) : null,
    usuario: guiado ? errorDe(validarTexto(usuario, reglaUsuario(exigeCredenciales))) : null,
    clave: errorClave,
  }) && /^rtsps?:\/\/.+/i.test(url);

  /** Ping y diagnóstico RTSP del flujo principal y, si se usa, del secundario. */
  const probar = async () => {
    setProbando(true);
    setPrueba(null);
    setPruebaVista(null);
    setErrorPrueba(null);
    try {
      const [principal, vista] = await Promise.all([
        api.post('/camaras/probar', { rtsp_url: url, camara_id: camara?.id }),
        urlVista ? api.post('/camaras/probar', { rtsp_url: urlVista, camara_id: camara?.id, vista: true }).catch(() => null) : null,
      ]);
      setPrueba(principal.data);
      setPruebaVista(vista?.data?.rtsp ?? null);
    } catch (e) {
      setErrorPrueba(mensajeError(e));
    } finally { setProbando(false); }
  };

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    const cuerpo = { nombre, ubicacion, direccion, rtsp_url: url, rtsp_url_vista: urlVista || null, ip: perfil === 'manual' ? '' : host.trim() };
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
        <CampoTexto id="c-nombre" etiqueta="Nombre*" valor={nombre} onCambiar={setNombre} regla={REGLAS_CAMARA.nombre}
          placeholder="Ej.: Garita principal - entrada" autoFocus />
        <CampoTexto id="c-ubic" etiqueta="Ubicación*" valor={ubicacion} onCambiar={setUbicacion} regla={REGLAS_CAMARA.ubicacion}
          placeholder="Ej.: Acceso vehicular norte" />
        <div className="campo"><label htmlFor="c-direccion">Tipo de paso*</label>
          <select id="c-direccion" className="select" value={direccion} onChange={e => setDireccion(e.target.value as Camara['direccion'])}>
            <option value="ingreso">Ingreso</option>
            <option value="salida">Salida</option>
          </select>
          <span className="ayuda">Las salidas se registran como eventos independientes y no se bloquean por permisos de ingreso.</span>
        </div>

        <div className="campo completo"><label htmlFor="c-perfil">Tipo de equipo</label>
          <select id="c-perfil" className="select" value={perfil} onChange={e => cambiarPerfil(e.target.value as Perfil)}>
            {(Object.keys(PERFILES) as Perfil[]).map(k => <option key={k} value={k}>{PERFILES[k].etiqueta}</option>)}
          </select>
          {p.ayuda && <span className="ayuda">{p.ayuda}</span>}
        </div>

        {perfil === 'manual' ? (
          <>
            <CampoUrl valor={urlManual} error={errorUrl} onCambiar={v => { setUrlManual(v); setPrueba(null); }} />
            <CampoTexto id="c-url-vista" className="completo" etiqueta="URL del flujo de vista (opcional)" valor={urlVistaManual}
              onCambiar={v => { setUrlVistaManual(v); setPrueba(null); }} error={errorVista}
              regla={REGLA_URL_VISTA} filtrar={sinEspacios} literal claseControl="mono"
              placeholder="rtsp://usuario:contraseña@192.0.2.10:554/Streaming/Channels/102"
              ayuda="Flujo secundario (H.264, baja resolución) que se muestra en el navegador mientras el motor analiza el principal. Vacío: se muestra el principal." />
          </>
        ) : (
          <>
            <CampoTexto id="c-host" etiqueta="IP o nombre del equipo*" valor={host} onCambiar={v => { setHost(v); setPrueba(null); }}
              regla={REGLA_HOST} error={errorHost} filtrar={filtrarHost} literal
              claseControl="mono" placeholder="Ej.: 192.0.2.10" ayuda="Solo números, letras, puntos y guiones (sin rtsp:// ni puerto)." />
            <div className="form-grid" style={{ gridTemplateColumns: '110px 1fr', gap: 10 }}>
              <CampoEntero id="c-puerto" etiqueta="Puerto*" nombre="Puerto" valor={puerto} min={1} max={65535} requerido claseControl="mono"
                onCambiar={v => { setPuerto(v); setPrueba(null); }} />
              <CampoTexto id="c-ruta" etiqueta="Ruta del flujo" valor={ruta} onCambiar={v => { setRuta(v); setPrueba(null); }}
                regla={REGLA_RUTA} filtrar={sinEspacios} literal claseControl="mono" />
            </div>
            <CampoTexto id="c-usuario" etiqueta={`Usuario${exigeCredenciales ? '*' : ' (si el equipo lo pide)'}`} valor={usuario}
              onCambiar={v => { setUsuario(v); setPrueba(null); }} regla={reglaUsuario(exigeCredenciales)} filtrar={sinEspacios} literal autoComplete="off" />
            <div className="campo"><label htmlFor="c-clave">Contraseña{exigeCredenciales && !claveGuardada ? '*' : ''}</label>
              <div style={{ position: 'relative' }}>
                <input id="c-clave" className="input" type={verClave ? 'text' : 'password'} value={clave} onChange={e => { setClave(e.target.value); setPrueba(null); }}
                  onBlur={() => setClaveTocada(true)} maxLength={100} autoComplete="new-password" style={{ paddingRight: 40 }}
                  placeholder={claveGuardada ? 'Guardada · deje vacío para conservarla' : ''} disabled={!usuario.trim()}
                  aria-required={(exigeCredenciales && !claveGuardada) || reescribirClave || undefined}
                  aria-invalid={(claveTocada || reescribirClave) && errorClave ? true : undefined}
                  aria-describedby={(claveTocada || reescribirClave) && errorClave ? 'c-clave-error' : !usuario.trim() ? 'c-clave-ayuda' : undefined} />
                <button type="button" className="btn btn-ghost btn-sm btn-icono" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setVerClave(v => !v)} aria-label={verClave ? 'Ocultar' : 'Mostrar'}>
                  {verClave ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              {(claveTocada || reescribirClave) && errorClave
                ? <span id="c-clave-error" className="error">{errorClave}</span>
                : !usuario.trim() && <span id="c-clave-ayuda" className="ayuda">Ingrese primero el usuario.</span>}
            </div>
            <div className="campo completo">
              <span className="etiqueta-campo">Enlace RTSP generado</span>
              <div className="mono" style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--surface-3)', border: `1px dashed ${errorEnlace ? 'var(--alerta)' : 'var(--border-strong)'}`, fontSize: 12.5, wordBreak: 'break-all', color: url ? 'var(--text)' : 'var(--text-4)' }}>
                {urlVisible || 'Complete la IP para generar el enlace'}
              </div>
              {errorEnlace
                ? <span className="error">{errorEnlace === MENSAJE_URL_RTSP
                  ? 'El enlace tiene espacios o caracteres no permitidos (< >): revise la ruta del flujo.'
                  : `El enlace supera los ${LARGO_MAXIMO_RTSP} caracteres que admite el sistema: acorte la ruta, el usuario o la contraseña.`}</span>
                : <span className="ayuda">La contraseña se guarda cifrada en el servidor y no se muestra a ningún usuario.</span>}
            </div>
            {secundaria && (
              <div className="campo completo">
                <label className="fila" style={{ gap: 8, cursor: 'pointer', flexWrap: 'nowrap' }}>
                  <input type="checkbox" checked={usarVista} onChange={e => { setUsarVista(e.target.checked); setPrueba(null); }} />
                  <span><b>Vista en vivo por el flujo secundario</b> (recomendado)</span>
                </label>
                <span className="ayuda">
                  El motor ANPR analiza el flujo principal a máxima resolución y el navegador muestra el secundario: menos ancho de banda
                  y se reproduce en cualquier navegador aunque el principal esté en H.265. En la cámara configure el secundario en H.264, 640×360.
                </span>
                {usarVista && (
                  <div className="mono" style={{ marginTop: 6, padding: '9px 12px', borderRadius: 8, background: 'var(--surface-3)', border: `1px dashed ${errorVista ? 'var(--alerta)' : 'var(--border-strong)'}`, fontSize: 12.5, wordBreak: 'break-all' }}>
                    {urlVistaVisible || 'Complete la IP para generar el enlace'}
                  </div>
                )}
                {errorVista && <span className="error">El enlace del flujo secundario no es válido o supera los {LARGO_MAXIMO_RTSP} caracteres.</span>}
              </div>
            )}
          </>
        )}

        {prueba && <div className="completo"><PanelDiagnostico resultado={prueba} /></div>}
        {prueba && pruebaVista && (
          <div className="completo">
            {pruebaVista.en_linea
              ? <Aviso tipo="exito"><b>Flujo secundario (vista en vivo):</b> entrega video{pruebaVista.tiempo_ms !== null ? ` · ${pruebaVista.tiempo_ms} ms` : ''}.</Aviso>
              : <Aviso tipo="advertencia"><b>Flujo secundario (vista en vivo):</b> {pruebaVista.mensaje} {DIAGNOSTICO[pruebaVista.diagnostico] ?? ''} Si la
                cámara no tiene habilitado el flujo secundario, actívelo (Configuración › Video › Sub Stream) o desmarque la vista por el flujo secundario.</Aviso>}
          </div>
        )}
        {errorPrueba && <div className="completo"><Aviso tipo="error">{errorPrueba}</Aviso></div>}
        {error && <div className="completo"><Aviso tipo="error">{error}</Aviso></div>}
      </div>
      {reproducir && <ReproductorPrueba titulo={nombre || 'cámara sin guardar'} rtspUrl={url} rtspUrlVista={urlVista || undefined} camaraId={camara?.id}
        onCerrar={() => setReproducir(false)} />}
    </Modal>
  );
};
