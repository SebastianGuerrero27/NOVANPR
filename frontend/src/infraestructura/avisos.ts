/**
 * Preferencias y sonidos de los avisos de acceso (compartidos por todas las pantallas).
 *  - Acceso no autorizado / lista de alertas: sonido institucional de "acceso denegado".
 *  - Acceso autorizado: melodía ascendente breve (Do5 → Mi5 → Sol5 → Do6).
 */
const CLAVE_SONIDO = 'anpr_sonido_alertas';
const EVENTO = 'anpr:preferencia-sonido';

export function sonidoActivo(): boolean {
  try { return localStorage.getItem(CLAVE_SONIDO) !== '0'; } catch { return true; }
}

export function fijarSonido(activo: boolean) {
  try { localStorage.setItem(CLAVE_SONIDO, activo ? '1' : '0'); } catch { /* sin almacenamiento */ }
  window.dispatchEvent(new CustomEvent(EVENTO, { detail: activo }));
}

export function alCambiarSonido(fn: (activo: boolean) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENTO, h);
  return () => window.removeEventListener(EVENTO, h);
}

let contexto: AudioContext | null = null;

/**
 * Los navegadores solo permiten sonido después de una interacción del usuario: con el primer
 * clic o tecla en la página se crea y activa el contexto de audio para que los avisos que
 * llegan después por tiempo real suenen de inmediato.
 */
if (typeof window !== 'undefined') {
  const desbloquear = () => {
    try {
      contexto ??= new (window.AudioContext || (window as any).webkitAudioContext)();
      contexto.resume().catch(() => undefined);
      const a = new Audio('/acceso_denegado.mp3');
      a.muted = true;
      a.play().then(() => a.pause()).catch(() => undefined);
    } catch { /* sin audio */ }
    window.removeEventListener('pointerdown', desbloquear);
    window.removeEventListener('keydown', desbloquear);
  };
  window.addEventListener('pointerdown', desbloquear);
  window.addEventListener('keydown', desbloquear);
}
function audio(): AudioContext | null {
  try {
    contexto ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (contexto.state === 'suspended') contexto.resume().catch(() => undefined);
    return contexto;
  } catch {
    return null;
  }
}

export function sonarAutorizado() {
  if (!sonidoActivo()) return;
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  [
    { f: 523.25, ini: 0, dur: 0.35, vol: 0.2 },
    { f: 659.25, ini: 0.22, dur: 0.4, vol: 0.22 },
    { f: 783.99, ini: 0.48, dur: 1.1, vol: 0.25 },
    { f: 1046.5, ini: 0.7, dur: 1.05, vol: 0.22 },
  ].forEach(n => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(n.f, t + n.ini);
    g.gain.setValueAtTime(0.001, t + n.ini);
    g.gain.linearRampToValueAtTime(n.vol, t + n.ini + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.ini + n.dur);
    o.connect(g).connect(ctx.destination);
    o.start(t + n.ini);
    o.stop(t + n.ini + n.dur);
  });
}

let reproduciendo: HTMLAudioElement | null = null;

export function sonarDenegado() {
  if (!sonidoActivo()) return;
  reproduciendo?.pause();
  const a = new Audio('/acceso_denegado.mp3');
  a.volume = 1;
  reproduciendo = a;
  a.play().catch(() => {
    // Respaldo sintetizado si el navegador bloquea el archivo
    const ctx = audio();
    if (!ctx) return;
    [0, 0.35].forEach(ini => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + ini);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + ini + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + ini);
      o.stop(ctx.currentTime + ini + 0.3);
    });
  });
}

export function detenerSonido() {
  reproduciendo?.pause();
  reproduciendo = null;
}

/** Aviso breve de dos tonos para notificaciones importantes fuera de la garita (gestor, administrador). */
export function sonarAviso() {
  if (!sonidoActivo()) return;
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;
  [{ f: 880, ini: 0 }, { f: 660, ini: 0.18 }].forEach(n => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(n.f, t + n.ini);
    g.gain.setValueAtTime(0.001, t + n.ini);
    g.gain.linearRampToValueAtTime(0.18, t + n.ini + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + n.ini + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(t + n.ini);
    o.stop(t + n.ini + 0.4);
  });
}
