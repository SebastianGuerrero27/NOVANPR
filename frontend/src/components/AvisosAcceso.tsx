import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, Camera, CheckCircle2, Eye, ShieldAlert, ShieldCheck, Volume2, VolumeX, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useEvento } from '../lib/tiempoReal';
import type { Deteccion } from '../lib/tipos';
import { fecha, hora, NIVELES_ALERTA } from '../lib/formato';
import { alCambiarSonido, detenerSonido, fijarSonido, sonarAutorizado, sonarDenegado, sonidoActivo } from '../lib/avisos';
import { describirVehiculo, ImagenEvidencia, ValidarModal } from './deteccion';
import { FormularioLista } from './FormularioLista';
import { useNotificar } from './Notificaciones';
import { VisorZoom } from './ZoomDual';

/**
 * Avisos de acceso en tiempo real, visibles en cualquier pantalla del sistema:
 *  - Vehículo NO REGISTRADO o en la LISTA DE ALERTAS → alerta a pantalla completa con fondo
 *    rojo pulsante, sonido de acceso denegado y protocolo para el personal de la garita.
 *  - Vehículo AUTORIZADO → aviso verde con melodía breve (se cierra solo).
 * Solo se avisa de decisiones automáticas recientes; las validaciones manuales no disparan
 * avisos (las hizo el propio personal).
 */

const VENTANA_S = 120;
const reciente = (d: Deteccion, segundos = VENTANA_S) => Date.now() - new Date(d.fecha_hora_ingreso).getTime() < segundos * 1000;

// La institución no cuenta con barrera o pluma mecánica: el control del acceso es verbal y
// visual por parte del personal en el punto de control.
const PROTOCOLO_NO_REGISTRADO = [
  ['Detener el vehículo en el punto de control', 'Con señal verbal y visual, indique al conductor que se detenga y no avance hacia las instalaciones hasta completar la verificación.'],
  ['Inspección visual', 'Desde un punto seguro, confirme que la placa física coincida con {placa} e identifique a los ocupantes.'],
  ['Solicitar documentos', 'Pida cédula de identidad, matrícula del vehículo y el motivo formal del ingreso.'],
  ['Consultar al supervisor', 'Comunique la placa por radio al supervisor de turno: solo él decide el ingreso de un vehículo no registrado.'],
  ['Espera y registro', 'Mientras se verifica, pida al conductor estacionar a un lado sin obstruir el acceso. Si se aprueba, deje constancia en el sistema; si no, indíquele retirarse por la vía de salida.'],
];

const PROTOCOLO_ALERTA = [
  ['Indicar alto sin exponerse', 'Pida al conductor detenerse en el punto de control manteniendo una distancia segura. Si no acata la indicación, no intente detenerlo físicamente.'],
  ['Notificación inmediata', 'Informe por radio al supervisor de turno y a la Central ECU 911 con la placa {placa} y el motivo de la alerta.'],
  ['No confrontar', 'No discuta con los ocupantes ni revele el motivo de la alerta; resguarde su seguridad y la del personal.'],
  ['Observación', 'Registre características del vehículo y de los ocupantes (color, marca, número de personas, dirección de salida).'],
  ['Verificar la lectura', 'Si la placa física no coincide con {placa}, corrija la lectura para que el sistema la reevalúe.'],
];

const ModalNoAutorizado: React.FC<{ d: Deteccion; pendientes: number; onCerrar: () => void; onValidar: () => void; onAutorizar?: () => void }> =
  ({ d, pendientes, onCerrar, onValidar, onAutorizar }) => {
    const navigate = useNavigate();
    const [sonido, setSonido] = useState(sonidoActivo());
    const [zoom, setZoom] = useState(false);
    const boton = useRef<HTMLButtonElement>(null);
    const esAlerta = d.estado_validacion === 'alerta';
    const nivel = d.alerta ? NIVELES_ALERTA[d.alerta.nivel]?.etiqueta ?? d.alerta.nivel : null;
    const protocolo = esAlerta ? PROTOCOLO_ALERTA : PROTOCOLO_NO_REGISTRADO;
    useEffect(() => { boton.current?.focus(); return alCambiarSonido(setSonido); }, []);

    return (
      <div className="alerta-acceso-fondo" role="alertdialog" aria-modal="true" aria-labelledby="alerta-acceso-titulo">
        <div className="alerta-acceso">
          <header className="alerta-acceso-cabecera">
            <span className="alerta-acceso-icono"><AlertOctagon size={26} strokeWidth={2.5} /></span>
            <div style={{ minWidth: 0 }}>
              <h2 id="alerta-acceso-titulo">
                {esAlerta ? 'Alerta de seguridad: vehículo en lista de alertas' : 'Acceso no autorizado: vehículo no registrado'}
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
                <span className="pie"><span>ANT</span><span>{esAlerta ? 'EN LISTA DE ALERTAS' : 'NO AUTORIZADO'}</span></span>
              </div>
              <dl className="alerta-ficha">
                <dt>Motivo</dt><dd className="destacado">{esAlerta ? d.alerta?.motivo ?? 'Placa en la lista de alertas' : 'No consta en el padrón de vehículos autorizados'}</dd>
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
            {onAutorizar && !esAlerta && <button className="btn btn-sm alerta-boton-secundario" onClick={onAutorizar}><ShieldCheck size={14} /> Autorizar vehículo</button>}
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
          <span className="placa">{d.placa}</span>
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
        <span className="placa">{d.placa}</span>
        <span className="detalle">{d.autorizado?.propietario ?? 'Padrón institucional'}{d.autorizado?.departamento ? ` · ${d.autorizado.departamento}` : ''}</span>
        <span className="detalle">{d.camara?.nombre ?? 'Acceso'} · {hora(d.fecha_hora_ingreso)}</span>
      </div>
      <button onClick={e => { e.stopPropagation(); onCerrar(); }} aria-label="Cerrar"><X size={15} /></button>
    </div>
  );
};

export const AvisosAcceso: React.FC = () => {
  const { tieneRol } = useAuth();
  const notificar = useNotificar();
  const [cola, setCola] = useState<Deteccion[]>([]);
  const [autorizados, setAutorizados] = useState<Deteccion[]>([]);
  const [validando, setValidando] = useState<Deteccion | null>(null);
  const [autorizando, setAutorizando] = useState<Deteccion | null>(null);
  const avisados = useRef(new Set<string>());

  const procesar = (d: Deteccion) => {
    if (d.estado_procesamiento !== 'procesado') return;
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
  const cerrarActual = () => { detenerSonido(); setCola(c => c.slice(1)); if (cola.length > 1) sonarDenegado(); };

  return (
    <>
      {autorizados.length > 0 && (
        <div className="avisos-autorizados">
          {autorizados.map(d => <AvisoAutorizado key={`${d.id}-${d.estado_validacion}`} d={d} onConfirmar={setValidando}
            onCerrar={() => setAutorizados(a => a.filter(x => x.id !== d.id || x.estado_validacion !== d.estado_validacion))} />)}
        </div>
      )}
      {actual && !validando && !autorizando && (
        <ModalNoAutorizado d={actual} pendientes={cola.length - 1} onCerrar={cerrarActual}
          onValidar={() => { detenerSonido(); setValidando(actual); }}
          onAutorizar={tieneRol('Admin', 'Supervisor') && actual.placa ? () => { detenerSonido(); setAutorizando(actual); } : undefined} />
      )}
      {validando && <ValidarModal d={validando} onCerrar={() => setValidando(null)}
        onValidada={d => setCola(c => c.filter(x => x.id !== d.id))} />}
      {autorizando && autorizando.placa && (
        <FormularioLista tipo="autorizados"
          inicial={{ placa: autorizando.placa, marca: autorizando.vehiculo.marca, modelo: autorizando.vehiculo.modelo, color: autorizando.vehiculo.color, tipo_vehiculo: autorizando.tipo_vehiculo }}
          onCerrar={() => setAutorizando(null)}
          onGuardado={() => {
            notificar('exito', `${autorizando.placa} agregado al padrón de autorizados`, 'Valide este ingreso para registrarlo como autorizado.');
            setCola(c => c.filter(x => x.id !== autorizando.id));
            setValidando(autorizando);
            setAutorizando(null);
          }} />
      )}
    </>
  );
};
