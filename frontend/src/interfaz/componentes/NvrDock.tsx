import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Camera, ChevronDown, ChevronUp, GripVertical, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import api, { mensajeError } from '../../infraestructura/api';
import { useAuth } from '../../aplicacion/AuthContext';
import { useEvento, useReconexion } from '../../aplicacion/tiempoReal';
import type { Camara } from '../../dominio/tipos';
import { Aviso } from './ui';
import { ReproductorWebRTC, VisorEnVivo } from './envivo';

const CLAVE_NVR = 'anpr_nvr_slots_v1';
const CLAVE_DOCK = 'anpr_nvr_dock_open';

function leerSlots(): (number | null)[] {
  try {
    const valor: unknown = JSON.parse(localStorage.getItem(CLAVE_NVR) || '[]');
    if (!Array.isArray(valor)) return [null, null, null, null];
    return Array.from({ length: 4 }, (_, i) => Number.isInteger(valor[i]) && valor[i] > 0 ? valor[i] as number : null);
  } catch {
    return [null, null, null, null];
  }
}

type NvrDockContexto = { abierto: boolean; alternar: () => void };
const ContextoNvrDock = createContext<NvrDockContexto | null>(null);

export function useNvrDock(): NvrDockContexto {
  const contexto = useContext(ContextoNvrDock);
  if (!contexto) throw new Error('useNvrDock debe usarse dentro de NvrDockProvider');
  return contexto;
}

const CuadriculaNvr: React.FC<{ camaras: Camara[]; motorId: number | null }> = ({ camaras, motorId }) => {
  const [slots, setSlots] = useState<(number | null)[]>(leerSlots);
  const [errorVideo, setErrorVideo] = useState<string | null>(null);
  const guardar = (siguiente: (number | null)[]) => {
    setSlots(siguiente);
    try { localStorage.setItem(CLAVE_NVR, JSON.stringify(siguiente)); } catch { /* almacenamiento no disponible */ }
  };
  const colocar = (id: number, destino: number) => {
    const actual = [...slots];
    const previo = actual.indexOf(id);
    if (previo >= 0 && previo !== destino) [actual[previo], actual[destino]] = [actual[destino], actual[previo]];
    else actual[destino] = id;
    guardar(actual);
  };
  const alSoltar = (e: React.DragEvent, destino: number) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('application/x-anpr-camera'));
    if (Number.isInteger(id) && camaras.some(c => c.id === id)) colocar(id, destino);
  };

  return (
    <div className="nvr-dock-contenido">
      {errorVideo && <Aviso tipo="error">{errorVideo}</Aviso>}
      <div className="nvr-grid">
        {slots.map((id, indice) => {
          const camara = camaras.find(c => c.id === id);
          return (
            <section key={indice} className="nvr-celda" onDragOver={e => e.preventDefault()} onDrop={e => alSoltar(e, indice)}
              aria-label={`Canal NVR ${indice + 1}${camara ? `: ${camara.nombre}` : ', vacío'}`}>
              <header className="nvr-celda-cabecera">
                <span className="fila truncar" style={{ gap: 6, minWidth: 0 }}>
                  <GripVertical size={14} />
                  <strong className="truncar">{camara?.nombre ?? `Canal ${indice + 1}`}</strong>
                  {camara && <span className="nvr-direccion">{camara.direccion === 'salida' ? 'SALIDA' : 'INGRESO'}</span>}
                </span>
                {camara && <button className="btn btn-ghost btn-sm btn-icono" title="Quitar cámara del canal" aria-label="Quitar cámara"
                  onClick={() => guardar(slots.map((s, i) => i === indice ? null : s))}><X size={14} /></button>}
              </header>
              <div className="nvr-video">
                {camara?.activa
                  ? camara.id === motorId
                    ? <VisorEnVivo camaraId={camara.id} vista={Boolean(camara.rtsp_url_vista)} pausado={false} onFallo={m => setErrorVideo(`${camara.nombre}: ${m}`)} />
                    : <ReproductorWebRTC pausado={false} claveReinicio={camara.id}
                      obtener={async () => {
                        const ticket = (await api.post('/monitoreo/ticket', { alcance: 'stream' })).data;
                        const ruta = `cam_${camara.id}${camara.rtsp_url_vista ? '_vista' : ''}`;
                        return { whep: `${ticket.webrtc}/${ruta}/whep?ticket=${encodeURIComponent(ticket.ticket)}` };
                      }}
                      onFallo={m => setErrorVideo(`${camara.nombre}: ${m}`)} />
                  : camara
                    ? <div className="nvr-vacio">Cámara deshabilitada</div>
                    : <div className="nvr-vacio"><Camera size={22} /><span>Arrastre una cámara aquí</span></div>}
              </div>
            </section>
          );
        })}
      </div>
      <span className="texto-secundario nvr-dock-ayuda">Arrastre cámaras desde el menú lateral. Solo la cámara asignada al motor se procesa con ANPR.</span>
    </div>
  );
};

const ReproductorNvr: React.FC<{ abierto: boolean; alternar: () => void }> = ({ abierto, alternar }) => {
  const { user, puede } = useAuth();
  const { pathname } = useLocation();
  const [camaras, setCamaras] = useState<Camara[]>([]);
  const [motorId, setMotorId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cargar = useCallback(async () => {
    if (!user || !puede('operacion:monitorear')) return;
    try {
      const [respuestaCamaras, respuestaMotor] = await Promise.all([
        api.get('/camaras'),
        api.get('/monitoreo/estado'),
      ]);
      setCamaras(respuestaCamaras.data);
      setMotorId(respuestaMotor.data?.camara_activa?.id ?? null);
      setError(null);
    } catch (e) {
      setError(mensajeError(e));
    }
  }, [user, puede]);

  useEffect(() => { void cargar(); }, [cargar, pathname]);
  useEvento('camara:actualizada', () => { void cargar(); });
  useEvento('camara:eliminada', () => { void cargar(); });
  useEvento('monitoreo:camara', () => { void cargar(); });
  useReconexion(() => { void cargar(); });

  if (!user || !puede('operacion:monitorear')) return null;
  return (
    <aside className={`nvr-dock${abierto ? ' expandido' : ''}`} aria-label="Mini reproductor NVR">
      <header className="nvr-dock-cabecera">
        <span className="fila" style={{ gap: 8 }}><Camera size={16} /><strong>NVR · 4 canales</strong></span>
        <button className="btn btn-ghost btn-sm btn-icono" onClick={alternar} aria-expanded={abierto}
          aria-label={abierto ? 'Contraer reproductor NVR' : 'Expandir reproductor NVR'}
          title={abierto ? 'Contraer reproductor NVR' : 'Expandir reproductor NVR'}>
          {abierto ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
        </button>
      </header>
      <div className="nvr-dock-cuerpo" aria-hidden={!abierto}>
        {error && <Aviso tipo="error">{error}</Aviso>}
        {camaras.length
          ? <CuadriculaNvr camaras={camaras} motorId={motorId} />
          : !error && <div className="nvr-dock-vacio">Registre cámaras y arrástrelas aquí para verlas.</div>}
      </div>
    </aside>
  );
};

export const NvrDockProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [abierto, setAbierto] = useState(() => {
    try {
      const guardado = localStorage.getItem(CLAVE_DOCK);
      return guardado === null || guardado === '1';
    } catch {
      return true;
    }
  });
  const alternar = () => setAbierto(actual => {
    const siguiente = !actual;
    try { localStorage.setItem(CLAVE_DOCK, siguiente ? '1' : '0'); } catch { /* preferencia no disponible */ }
    return siguiente;
  });
  return (
    <ContextoNvrDock.Provider value={{ abierto, alternar }}>
      {children}
      <ReproductorNvr abierto={abierto} alternar={alternar} />
    </ContextoNvrDock.Provider>
  );
};
