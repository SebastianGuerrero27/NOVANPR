import { dominiosPermitidos, generarToken, hashToken } from '../../infraestructura/servicios/seguridad';

describe('seguridad de cuentas', () => {
  const dominiosOriginales = process.env.ALLOWED_EMAIL_DOMAINS;
  afterEach(() => { process.env.ALLOWED_EMAIL_DOMAINS = dominiosOriginales; });

  it('dominios de correo configurables (por defecto solo ecu911.gob.ec)', () => {
    delete process.env.ALLOWED_EMAIL_DOMAINS;
    expect(dominiosPermitidos()).toEqual(['ecu911.gob.ec']);
  });

  it('tokens de un solo uso: se guarda solo el hash SHA-256', () => {
    const { token, hash } = generarToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
    expect(generarToken().token).not.toBe(token);
  });
});
