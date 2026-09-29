import { dominiosPermitidos, generarToken, hashToken, normalizarEmail, validarEmail, validarNombre, validarPassword } from '../../services/seguridad';

describe('seguridad de cuentas', () => {
  const dominiosOriginales = process.env.ALLOWED_EMAIL_DOMAINS;
  afterEach(() => { process.env.ALLOWED_EMAIL_DOMAINS = dominiosOriginales; });

  it('política de contraseñas: 10+ caracteres con mayúscula, minúscula, número y símbolo', () => {
    expect(validarPassword('Segura#2026ab')).toBeNull();
    expect(validarPassword('corta1!A')).toMatch(/10 caracteres/);
    expect(validarPassword('sinmayuscula#2026')).toMatch(/mayúscula/);
    expect(validarPassword('SinSimbolo2026ab')).toMatch(/símbolo/);
  });

  it('dominios de correo configurables (por defecto solo ecu911.gob.ec)', () => {
    delete process.env.ALLOWED_EMAIL_DOMAINS;
    expect(dominiosPermitidos()).toEqual(['ecu911.gob.ec']);
    expect(validarEmail('ana.perez@ecu911.gob.ec')).toBeNull();
    expect(validarEmail('ana@gmail.com')).toMatch(/Solo se aceptan/);

    process.env.ALLOWED_EMAIL_DOMAINS = 'ecu911.gob.ec, @gmail.com';
    expect(validarEmail('ana@gmail.com')).toBeNull();
    expect(validarEmail('no-es-correo')).toMatch(/inválido/);
  });

  it('normaliza el correo y valida el nombre', () => {
    expect(normalizarEmail('  Ana.Perez@ECU911.gob.ec ')).toBe('ana.perez@ecu911.gob.ec');
    expect(validarNombre('Ana')).not.toBeNull();
    expect(validarNombre('Ana Pérez')).toBeNull();
  });

  it('tokens de un solo uso: se guarda solo el hash SHA-256', () => {
    const { token, hash } = generarToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
    expect(generarToken().token).not.toBe(token);
  });
});
