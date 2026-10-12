import dns from 'dns/promises';
import net from 'net';

/**
 * Redes a las que el sistema puede conectarse como "cámara" (protección contra SSRF).
 *
 * El backend (diagnóstico RTSP y ping) y MediaMTX (que abre la cámara) se conectan a la dirección
 * que escribe el administrador. Sin un límite, una cuenta de administrador comprometida podría
 * usarlos para alcanzar servicios internos (127.0.0.1, la base de datos, los metadatos de la nube
 * en 169.254.169.254) o cualquier equipo de internet. Antes de guardar, probar o publicar una
 * cámara se resuelve su nombre y cada dirección debe pertenecer a CAMARAS_REDES_PERMITIDAS
 * (CIDR separados por coma). Por omisión, solo redes privadas; en producción conviene limitarlo a
 * la VLAN de cámaras (p. ej. CAMARAS_REDES_PERMITIDAS=10.20.30.0/24).
 *
 * Límite conocido: MediaMTX resuelve el nombre por su cuenta al conectarse (un DNS que cambie la
 * respuesta entre ambas consultas no se detecta); con direcciones IP en la URL no aplica.
 */

const POR_OMISION = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7';
// Nunca, aunque se configuren: dirección no especificada, enlace local (metadatos de la nube) y multidifusión
const PROHIBIDAS = ['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '255.255.255.255/32', '::/128', 'fe80::/10', 'ff00::/8'];

interface Listas { clave: string; permitidas: net.BlockList; prohibidas: net.BlockList; invalidas: string[] }
let listas: Listas | null = null;

function agregar(lista: net.BlockList, cidr: string): boolean {
  const [red, prefijo] = cidr.split('/');
  const tipo = net.isIPv4(red) ? 'ipv4' : net.isIPv6(red) ? 'ipv6' : null;
  const bits = prefijo === undefined ? (tipo === 'ipv4' ? 32 : 128) : Number(prefijo);
  if (!tipo || !Number.isInteger(bits) || bits < 0 || bits > (tipo === 'ipv4' ? 32 : 128)) return false;
  lista.addSubnet(red, bits, tipo);
  return true;
}

function obtenerListas(): Listas {
  const clave = (process.env.CAMARAS_REDES_PERMITIDAS ?? '').trim() || POR_OMISION;
  if (listas?.clave === clave) return listas;
  const permitidas = new net.BlockList();
  const prohibidas = new net.BlockList();
  const invalidas = clave.split(',').map(c => c.trim()).filter(Boolean).filter(c => !agregar(permitidas, c));
  PROHIBIDAS.forEach(c => agregar(prohibidas, c));
  if (invalidas.length) console.warn(`[CAMARAS] CAMARAS_REDES_PERMITIDAS: se ignoran valores no válidos: ${invalidas.join(', ')}`);
  listas = { clave, permitidas, prohibidas, invalidas };
  return listas;
}

/** ¿Puede el sistema conectarse a esta dirección IP como cámara? */
export function direccionPermitida(ip: string): boolean {
  const mapeada = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i); // IPv4 dentro de IPv6
  if (mapeada) return direccionPermitida(mapeada[1]);
  const tipo = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (!tipo) return false;
  const { permitidas, prohibidas } = obtenerListas();
  return !prohibidas.check(ip, tipo) && permitidas.check(ip, tipo);
}

type Resolver = (host: string, opciones: { all: true }) => Promise<{ address: string }[]>;

/**
 * null si el host de la URL (y la IP del ping, si se indica) están en las redes permitidas; si no,
 * el motivo. Un nombre que no se puede resolver no se rechaza aquí: la conexión fallará igual y se
 * vuelve a comprobar antes de cada conexión.
 */
export async function verificarRed(rtspUrl: string, ip: string | null, resolver: Resolver = dns.lookup): Promise<string | null> {
  const hosts = new Set<string>();
  try {
    const host = new URL(rtspUrl).hostname.replace(/^\[|\]$/g, '');
    if (host) hosts.add(host);
  } catch {
    return 'URL RTSP inválida.';
  }
  if (ip && ip.trim()) hosts.add(ip.trim());
  for (const host of hosts) {
    let direcciones: string[];
    if (net.isIP(host)) {
      direcciones = [host];
    } else {
      try {
        direcciones = (await resolver(host, { all: true })).map(d => d.address);
      } catch {
        continue;
      }
    }
    const fuera = direcciones.find(d => !direccionPermitida(d));
    if (fuera) {
      return `La dirección ${host}${fuera !== host ? ` (${fuera})` : ''} está fuera de las redes permitidas para cámaras `
        + '(CAMARAS_REDES_PERMITIDAS).';
    }
  }
  return null;
}

/** Solo para pruebas: vuelve a leer CAMARAS_REDES_PERMITIDAS. */
export function reiniciarRedes(): void {
  listas = null;
}
