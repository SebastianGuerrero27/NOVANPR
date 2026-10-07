import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, Camera, CheckCircle2, Clock, Eye, FileCheck2, ShieldAlert, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento } from '../../aplicacion/tiempoReal';
import type { Deteccion } from '../../dominio/tipos';
import { fecha, hora, NIVELES_ALERTA } from '../../dominio/formato';
import { formatearPlaca } from '../../dominio/validacion';
import { alCambiarSonido, detenerSonido, fijarSonido, sonarAutorizado, sonarDenegado, sonidoActivo } from '../../infraestructura/avisos';
import { describirVehiculo, ImagenEvidencia, ValidarModal } from './deteccion';
import { FormularioLista } from './FormularioLista';
import { FormularioSolicitud } from './FormularioSolicitud';
import { useNotificar } from './Notificaciones';
import { VisorZoom } from './ZoomDual';
import { useCentroNotificaciones } from '../../aplicacion/notificaciones';

/**
 * Avisos de acceso en tiempo real, visibles en cualquier pantalla del sistema:
 *  - Vehículo NO REGISTRADO o en la LISTA DE ALERTAS → alerta a pantalla completa con fondo
 *    rojo pulsante, sonido de acceso denegado y protocolo para el personal de la garita.
 *  - Vehículo AUTORIZADO → aviso verde con melodía breve (se cierra solo).
 * Solo se avisa de decisiones automáticas recientes; las validaciones manuales no disparan
 * avisos (las hizo el propio personal).
 *
 * Se muestra a quien tiene el permiso avisos:garita (personal del punto de control). "Enterado"
 * registra el reconocimiento (ACK) de las alarmas del paso en el centro de notificaciones, lo
 * que detiene su escalamiento y mide el tiempo de respuesta del personal. Los demás roles (p. ej.
 * el gestor de permisos) reciben estos eventos en el centro de notificaciones.
 */

const VENTANA_S = 120;
const reciente = (d: Deteccion, segundos = VENTANA_S) => Date.now() - new Date(d.fecha_hora_ingreso).getTime() < segundos * 1000;

// La institución no cuenta con barrera o pluma mecánica: el control del acceso es verbal y
// visual por parte del personal en el punto de control.
const PROTOCOLO_NO_REGISTRADO = [
  ['Detener el vehículo en el punto de control', 'Con señal verbal y visual, indique al conductor que se detenga y no avance hacia las instalaciones hasta completar la verificación.'],
  ['Inspección visual', 'Desde un punto seguro, confirme que la placa física coincida con {placa} e identifique a los ocupantes.'],
  ['Solicitar documentos', 'Pida cédula de identidad, matrícula del vehículo y el motivo formal del ingreso.'],
  ['Solicitar la autorización', 'Use “Solicitar autorización”: el gestor de permisos recibe la solicitud al instante y decide el ingreso de un vehículo no registrado.'],
  ['Espera y registro', 'Mientras se verifica, pida al conductor estacionar a un lado sin obstruir el acceso. Si se aprueba, deje constancia en el sistema; si no, indíquele retirarse por la vía de salida.'],
];

const PROTOCOLO_RESTRINGIDO = [
  ['Detener el vehículo en el punto de control', 'Indique al conductor que se detenga: la placa {placa} tiene permiso, pero no es válido en este momento.'],
  ['Verificar identidad', 'Confirme que la placa física coincida con {placa} y pida la identificación del conductor.'],
  ['Consultar al gestor de permisos', 'El gestor de permisos ya fue notificado. Solo el administrador puede autorizar el ingreso por excepción.'],
  ['Registrar la decisión', 'Si se concede la excepción, quedará registrada con su motivo; si no, indique al conductor el horario o la vigencia de su permiso.'],
];

const PROTOCOLO_ALERTA = [
  ['Indicar alto sin exponerse', 'Pida al conductor detenerse en el punto de control manteniendo una distancia segura. Si no acata la indicación, no intente detenerlo físicamente.'],
  ['Notificación inmediata', 'Informe por radio al administrador y a la Central ECU 911 con la placa {placa} y el motivo de la alerta.'],
  ['No confrontar', 'No discuta con los ocupantes ni revele el motivo de la alerta; resguarde su seguridad y la del personal.'],
  ['Observación', 'Registre características del vehículo y de los ocupantes (color, marca, número de personas, dirección de salida).'],
  ['Verificar la lectura', 'Si la placa física no coincide con {placa}, corrija la lectura para que el sistema la reevalúe.'],
];

const TITULO_RESTRICCION: Record<string, string> = {
  fuera_horario: 'Acceso no autorizado: fuera del horario del permiso',
  no_iniciada: 'Acceso no autorizado: el permiso aún no está vigente',
  vencida: 'Acceso no autorizado: permiso vencido',
};

const ModalNoAutorizado: React.FC<{
  d: Deteccion; pendientes: number; onCerrar: () => void; onValidar: () => void;
  onAutorizar?: () => void; onSolicitar?: () => void; onExcepcion?: () => void;
}> = ({ d, pendientes, onCerrar, onValidar, onAutorizar, onSolicitar, onExcepcion }) => {
    const navigate = useNavigate();
    const [sonido, setSonido] = useState(sonidoActivo());
    const [zoom, setZoom] = useState(false);
    const boton = useRef<HTMLButtonElement>(null);
    const esAlerta = d.estado_validacion === 'alerta';
    const restringido = !esAlerta && d.restriccion_acceso ? d.restriccion_acceso : null;
    const nivel = d.alerta ? NIVELES_ALERTA[d.alerta.nivel]?.etiqueta ?? d.alerta.nivel : null;
    const protocolo = esAlerta ? PROTOCOLO_ALERTA : restringido ? PROTOCOLO_RESTRINGIDO : PROTOCOLO_NO_REGISTRADO;
    useEffect(() => { boton.current?.focus(); return alCambiarSonido(setSonido); }, []);

    return (
      <div className="alerta-acceso-fondo" role="alertdialog" aria-modal="true" aria-labelledby="alerta-acceso-titulo">
        <div className="alerta-acceso">
          <header className="alerta-acceso-cabecera">
            <span className="alerta-acceso-icono"><AlertOctagon size={26} strokeWidth={2.5} /></span>
            <div style={{ minWidth: 0 }}>
              <h2 id="alerta-acceso-titulo">
                {esAlerta ? 'Alerta de seguridad: vehículo en lista negra' : restringido ? TITULO_RESTRICCION[restringido] : 'Acceso no autorizado: vehículo no registrado'}
                {nivel && <span className="alerta-acceso-nivel">NIVEL {nivel.toUpperCase()}</span>}
              </h2>
              <p>Sistema ANPR ECU 911 · {d.camara ? `${d.camara.nombre} (${d.camara.ubicacion})` : 'Acceso vehicular'} · {hora(d.fecha_hora_ingreso)}</p>
            </div>
            <button className="alerta-acceso-cerrar" onClick={() => { const n = !sonido; fijarSonido(n); if (!n) detenerSonido(); }}
              title={sonido ? 'Silenciar avisos' : 'Activar sonido'} aria-label={sonido ? 'Silenciar avisos' : 'Activar sonido'}>
              {sonido ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            <button className="alerta-acceso-cerrar" onClick={onCerrar} aria-label="Cerrar"><X size={18} /></button>
          </header>

          <div className="alerta-acceso-cuerpo">
            <div className="pila" style={{ gap: 14 }}>
              <div className="alerta-placa">
                <span className="pais">REPÚBLICA DEL ECUADOR</span>
                <span className="numero">{d.placa ?? 'SIN LECTURA'}</span>
                <span className="pie"><span>ANT</span><span>{esAlerta ? 'EN LISTA NEGRA' : restringido ? 'PERMISO RESTRINGIDO' : 'NO AUTORIZADO'}</span></span>
              </div>
              <dl className="alerta-ficha">
                <dt>Motivo</dt><dd className="destacado">{esAlerta ? d.alerta?.motivo ?? 'Placa en la lista negra'
                  : restringido ? d.motivo_revision ?? TITULO_RESTRICCION[restringido] : 'No consta en la lista blanca'}</dd>
                {restringido && d.autorizado && <><dt>Titular del permiso</dt><dd>{d.autorizado.propietario}{d.autorizado.departamento ? ` · ${d.autorizado.departamento}` : ''}</dd></>}
                <dt>Vehículo</dt><dd>{describirVehiculo(d)}</dd>
                <dt>Fecha y hora</dt><dd>{fecha(d.fecha_hora_ingreso)} · {hora(d.fecha_hora_ingreso)}</dd>
                <dt>Registro</dt><dd>#{d.id}</dd>
              </dl>
              {d.verificacion_vehiculo === 'no_coincide' && (
                <div className="alerta-nota">El vehículo observado no coincide con el registrado ({d.verificacion_detalle}): posible placa clonada o lectura errónea.</div>
              )}
              <div className="grid-2" style={{ gap: 10 }}>
                <div><span className="alerta-etiqueta"><Eye size={13} /> Recorte de placa</span>
                  <ImagenEvidencia ruta={d.imagen_placa} alt="Recorte de placa" alto={96} ajuste="contain" fondoOscuro onClick={() => setZoom(true)} /></div>
                <div><span className="alerta-etiqueta"><Camera size={13} /> Vehículo</span>
                  <ImagenEvidencia ruta={d.imagen_vehiculo} alt="Vehículo" alto={96} fondoOscuro onClick={() => setZoom(true)} /></div>
              </div>
            </div>

            <div className="alerta-protocolo">
              <h3><ShieldAlert size={18} /> Protocolo para el personal de seguridad</h3>
              <ol>
                {protocolo.map(([t, x], i) => (
                  <li key={t}><span className="paso">{i + 1}</span><div><strong>{t}</strong><p>{x.replace('{placa}', d.placa ?? 'la leída por el sistema')}</p></div></li>
                ))}
              </ol>
            </div>
          </div>

          <footer className="alerta-acceso-pie">
            {pendientes > 0 && <span className="alerta-pendientes">{pendientes} {pendientes === 1 ? 'aviso más en espera' : 'avisos más en espera'}</span>}
            <button className="btn btn-sm alerta-boton-secundario" onClick={() => { onCerrar(); navigate(`/detecciones/${d.id}`); }}>Ver detalle</button>
            <button className="btn btn-sm alerta-boton-secundario" onClick={onValidar}>Corregir lectura</button>
            {onExcepcion && restringido && <button className="btn btn-sm alerta-boton-secundario" onClick={onExcepcion}><Clock size={14} /> Autorizar por excepción</button>}
            {onAutorizar && !esAlerta && !restringido && <button className="btn btn-sm alerta-boton-secundario" onClick={onAutorizar}><ShieldCheck size={14} /> Autorizar vehículo</button>}
            {onSolicitar && !esAlerta && <button className="btn btn-sm alerta-boton-secundario" onClick={onSolicitar}><FileCheck2 size={14} /> Solicitar autorización</button>}
            <button ref={boton} className="btn alerta-boton-principal" onClick={onCerrar}><CheckCircle2 size={16} /> Enterado</button>
          </footer>
        </div>
        {zoom && <VisorZoom d={d} onCerrar={() => setZoom(false)} />}
      </div>
    );
  };

const AvisoAutorizado: React.FC<{ d: Deteccion; onCerrar: () => void; onConfirmar: (d: Deteccion) => void }> = ({ d, onCerrar, onConfirmar }) => {
  const navigate = useNavigate();
  const confirmar = d.estado_validacion === 'pendiente_revision';
  // El aviso de confirmación permanece hasta que el personal actúe; el de autorizado se cierra solo
  useEffect(() => {
    if (confirmar) return;
    const t = window.setTimeout(onCerrar, 6000);
    return () => window.clearTimeout(t);
  }, [onCerrar, confirmar]);
  if (confirmar) {
    return (
      <div className="aviso-autorizado confirmar" role="alert">
        <span className="icono"><ShieldCheck size={24} /></span>
        <div style={{ minWidth: 0 }}>
          <strong>CONFIRME EL INGRESO</strong>
          <span className="placa">{formatearPlaca(d.placa)}</span>
          <span className="detalle" style={{ whiteSpace: 'normal' }}>{d.motivo_revision}</span>
          <button className="btn btn-sm btn-exito" style={{ marginTop: 8 }} onClick={() => { onCerrar(); onConfirmar(d); }}>Confirmar placa</button>
        </div>
        <button onClick={e => { e.stopPropagation(); onCerrar(); }} aria-label="Cerrar"><X size={15} /></button>
      </div>
    );
  }
  return (
    <div className="aviso-autorizado" role="status" onClick={() => { onCerrar(); navigate(`/detecciones/${d.id}`); }}>
      <span className="icono"><ShieldCheck size={24} /></span>
      <div style={{ minWidth: 0 }}>
        <strong>ACCESO AUTORIZADO{d.validado_manualmente ? ' · CONFIRMADO' : ''}</strong>
        <span className="placa">{formatearPlaca(d.placa)}</span>
        <span className="detalle">{d.autorizado?.propietario ?? 'Padrón institucional'}{d.autorizado?.departamento ? ` · ${d.autorizado.departamento}` : ''}</span>
        <span className="detalle">{d.camara?.nombre ?? 'Acceso'} · {hora(d.fecha_hora_ingreso)}</span>
      </div>
      <button onClick={e => { e.stopPropagation(); onCerrar(); }} aria-label="Cerrar"><X size={15} /></button>
    </div>
  );
};

export const AvisosAcceso: React.FC = () => {
  const { puede } = useAuth();
  const notificar = useNotificar();
  const { reconocerDeteccion } = useCentroNotificaciones();
  const [cola, setCola] = useState<Deteccion[]>([]);
  const [autorizados, setAutorizados] = useState<Deteccion[]>([]);
  const [validando, setValidando] = useState<Deteccion | null>(null);
  const [excepcion, setExcepcion] = useState<Deteccion | null>(null);
  const [autorizando, setAutorizando] = useState<Deteccion | null>(null);
  const [solicitando, setSolicitando] = useState<Deteccion | null>(null);
  const avisados = useRef(new Set<string>());
  const garita = puede('avisos:garita');

  const procesar = (d: Deteccion) => {
    if (!garita || d.estado_procesamiento !== 'procesado') return;
    const clave = `${d.id}:${d.estado_validacion}:${d.validado_manualmente ? 'm' : 'a'}`;
    if (avisados.current.has(clave)) return;
    // Autorizado confirmado por el personal: también suena (el guardia deja pasar al vehículo)
    if (d.validado_manualmente) {
      if (d.estado_validacion === 'autorizado' && reciente(d, 900)) {
        avisados.current.add(clave);
        setAutorizados(a => [d, ...a.filter(x => x.id !== d.id)].slice(0, 3));
        sonarAutorizado();
      }
      return;
    }
    if (!reciente(d)) return;
    // Placa del padrón con confianza insuficiente (o vehículo distinto): pedir confirmación
    if (d.estado_validacion === 'pendiente_revision' && d.autorizado && d.motivo_revision) {
      avisados.current.add(clave);
      setAutorizados(a => [d, ...a.filter(x => x.id !== d.id)].slice(0, 3));
      return;
    }
    if (d.estado_validacion === 'alerta' || d.estado_validacion === 'no_reconocido') {
      avisados.current.add(clave);
      setCola(c => [...c.filter(x => x.id !== d.id), d]);
      sonarDenegado();
    } else if (d.estado_validacion === 'autorizado') {
      avisados.current.add(clave);
      setAutorizados(a => [d, ...a.filter(x => x.id !== d.id)].slice(0, 3));
      sonarAutorizado();
    }
  };

  useEvento<Deteccion>('deteccion:actualizada', procesar);
  useEvento<Deteccion>('deteccion:alerta', procesar);
  // Si el personal corrige la lectura o se elimina el registro, el aviso deja de tener sentido
  useEvento<Deteccion>('deteccion:actualizada', d => { if (d.validado_manualmente) setCola(c => c.filter(x => x.id !== d.id)); });
  useEvento<{ id: number }>('deteccion:eliminada', ({ id }) => setCola(c => c.filter(x => x.id !== id)));
  useEvento('deteccion:eliminadas', () => { setCola([]); setAutorizados([]); });

  const actual = cola[0];
  // Cerrar el aviso = el personal lo atendió: ACK de las alarmas del paso (detiene el escalamiento)
  const reconocer = (d: Deteccion) => { void reconocerDeteccion(d.id).catch(() => undefined); };
  const cerrarActual = () => {
    if (actual) reconocer(actual);
    detenerSonido();
    setCola(c => c.slice(1));
    if (cola.length > 1) sonarDenegado();
  };
  const abrir = (accion: (d: Deteccion) => void) => () => { if (!actual) return; reconocer(actual); detenerSonido(); accion(actual); };
  const gestionaPadron = puede('padron:gestionar');
  if (!garita) return null;

  return (
    <>
      {autorizados.length > 0 && (
        <div className="avisos-autorizados">
          {autorizados.map(d => <AvisoAutorizado key={`${d.id}-${d.estado_validacion}`} d={d} onConfirmar={setValidando}
            onCerrar={() => setAutorizados(a => a.filter(x => x.id !== d.id || x.estado_validacion !== d.estado_validacion))} />)}
        </div>
      )}
      {actual && !validando && !autorizando && !solicitando && !excepcion && (
        <ModalNoAutorizado d={actual} pendientes={cola.length - 1} onCerrar={cerrarActual}
          onValidar={abrir(setValidando)}
          onAutorizar={gestionaPadron && actual.placa ? abrir(setAutorizando) : undefined}
          onSolicitar={!gestionaPadron && puede('solicitudes:crear') && actual.placa ? abrir(setSolicitando) : undefined}
          onExcepcion={puede('accesos:excepcion') && actual.placa ? abrir(setExcepcion) : undefined} />
      )}
      {validando && <ValidarModal d={validando} onCerrar={() => setValidando(null)}
        onValidada={d => setCola(c => c.filter(x => x.id !== d.id))} />}
      {excepcion && <ValidarModal d={excepcion} excepcion onCerrar={() => setExcepcion(null)}
        onValidada={d => setCola(c => c.filter(x => x.id !== d.id))} />}
      {solicitando && (
        <FormularioSolicitud
          inicial={{ placa: solicitando.placa, marca: solicitando.vehiculo.marca, modelo: solicitando.vehiculo.modelo, color: solicitando.vehiculo.color, tipo_vehiculo: solicitando.tipo_vehiculo, deteccion_id: solicitando.id }}
          onCerrar={() => setSolicitando(null)}
          onEnviada={s => {
            notificar('exito', `Solicitud #${s.id} enviada`, 'El gestor de permisos fue notificado. Mantenga el vehículo en espera.');
            setCola(c => c.filter(x => x.id !== solicitando.id));
            setSolicitando(null);
          }} />
      )}
      {autorizando && autorizando.placa && (
        <FormularioLista tipo="autorizados"
          inicial={{ placa: autorizando.placa, marca: autorizando.vehiculo.marca, modelo: autorizando.vehiculo.modelo, color: autorizando.vehiculo.color, tipo_vehiculo: autorizando.tipo_vehiculo }}
          onCerrar={() => setAutorizando(null)}
          onGuardado={() => {
            notificar('exito', `${formatearPlaca(autorizando.placa)} agregado al padrón de autorizados`, 'Valide este ingreso para registrarlo como autorizado.');
            setCola(c => c.filter(x => x.id !== autorizando.id));
            setValidando(autorizando);
            setAutorizando(null);
          }} />
      )}
    </>
  );
};
