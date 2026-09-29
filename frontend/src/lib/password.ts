/** Política de contraseñas (idéntica a backend/src/services/seguridad.ts). */
export const REGLAS_PASSWORD = [
  { texto: 'Mínimo 10 caracteres', ok: (p: string) => p.length >= 10 },
  { texto: 'Una mayúscula', ok: (p: string) => /[A-Z]/.test(p) },
  { texto: 'Una minúscula', ok: (p: string) => /[a-z]/.test(p) },
  { texto: 'Un número', ok: (p: string) => /\d/.test(p) },
  { texto: 'Un símbolo (#, @, !, …)', ok: (p: string) => /[^A-Za-z0-9]/.test(p) },
];

export const passwordValida = (p: string) => p.length <= 128 && REGLAS_PASSWORD.every(r => r.ok(p));
