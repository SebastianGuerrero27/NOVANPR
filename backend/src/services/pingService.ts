import { exec } from 'child_process';

export interface PingResult {
  ip: string;
  success: boolean;
  timeMs?: number;
  message: string;
}

/**
 * Extrae el host o IP de una URL RTSP si el campo IP no está explícito
 */
export function extractHostFromRtsp(rtspUrl?: string): string | null {
  if (!rtspUrl) return null;
  try {
    const match = rtspUrl.match(/rtsp:\/\/(?:[^:@]+:[^@]+@)?([a-zA-Z0-9.-]+)(?::\d+)?/i);
    if (match && match[1]) {
      return match[1];
    }
  } catch {
    // fallback
  }
  return null;
}

/**
 * Realiza un ping ICMP nativo con detección de latencia en milisegundos y TTL
 * Basado en la arquitectura probada de Vigilance Heart
 */
export function pingHost(ipOrHost: string, timeoutMs: number = 1500): Promise<PingResult> {
  return new Promise((resolve) => {
    let cleanIp = (ipOrHost || '').trim();
    if (!cleanIp || cleanIp === '0.0.0.0' || cleanIp === '-' || cleanIp.length < 3) {
      return resolve({
        ip: cleanIp,
        success: false,
        message: 'Dirección IP o Host inválido'
      });
    }

    if (cleanIp.toLowerCase() === 'localhost') cleanIp = '127.0.0.1';

    const isWin = process.platform === 'win32';
    const cmd = isWin 
      ? `ping -n 1 -w ${timeoutMs} ${cleanIp}`
      : `ping -c 1 -W ${Math.max(1, Math.round(timeoutMs / 1000))} ${cleanIp}`;

    const startTime = Date.now();
    exec(cmd, { timeout: timeoutMs + 1000 }, (error, stdout) => {
      const elapsed = Date.now() - startTime;
      const out = stdout || '';
      
      const isSuccess = isWin
        ? (out.includes('TTL=') || out.includes('ttl=')) && 
          !out.includes('inaccesible') && 
          !out.includes('agotado') && 
          !out.includes('Destination host unreachable') &&
          !out.includes('General failure') &&
          !out.includes('Fallo general')
        : (out.includes('1 received') || out.includes('1 packets received') || out.includes('ttl='));

      const message = isSuccess
        ? `Respuesta recibida en ${elapsed}ms (TTL detectado)`
        : out.includes('agotado')
          ? 'Tiempo de espera de solicitud agotado'
          : out.includes('inaccesible')
            ? 'Host de destino inaccesible'
            : 'Sin respuesta al ping ICMP';

      resolve({
        ip: cleanIp,
        success: isSuccess,
        timeMs: isSuccess ? elapsed : undefined,
        message
      });
    });
  });
}
