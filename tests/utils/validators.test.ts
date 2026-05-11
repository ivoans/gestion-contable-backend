// tests/utils/validators.test.ts
import { describe, it, expect } from 'vitest';
import { isValidEmail } from '../../src/utils/validators';

describe('isValidEmail', () => {
  describe('válidos', () => {
    it.each([
      'a@b.co',
      'user.name+tag@example.com',
      'x@y.z',
      '123@456.78',
      'user_name@sub.domain.com',
      'usuario@dominio.com.ar',
    ])('%s', (e) => {
      expect(isValidEmail(e)).toBe(true);
    });
  });

  describe('inválidos por formato', () => {
    it.each([
      'no-arroba',
      '@sinusuario.com',
      'sinarrobapero@',
      'espacios@dom .com',
      'con espacio@dominio.com',
      'doble@@arroba.com',
      'sin-tld@nada',
      'a@b',
      '',
    ])('%s', (e) => {
      expect(isValidEmail(e)).toBe(false);
    });
  });

  describe('no-string', () => {
    it.each([
      [null],
      [undefined],
      [123],
      [{}],
      [[]],
      [true],
    ])('%s', (e) => {
      expect(isValidEmail(e)).toBe(false);
    });
  });

  it('email > 254 chars → inválido', () => {
    const long = 'a'.repeat(250) + '@x.co';
    expect(isValidEmail(long)).toBe(false);
  });
});
