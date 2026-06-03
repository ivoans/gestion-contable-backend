// tests/utils/validators.test.ts
import { describe, it, expect } from 'vitest';
import { isValidCuit, isValidEmail, normalizeCuit } from '../../src/utils/validators';

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

describe('normalizeCuit', () => {
  it.each([
    ['20-11111111-2', '20111111112'],
    ['20111111112', '20111111112'],
    ['20.11111111.2', '20111111112'],
    ['  20 11111111 2 ', '20111111112'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCuit(input)).toBe(expected);
  });

  it.each([
    ['2011111111', 'menos de 11 dígitos'],
    ['201111111123', 'más de 11 dígitos'],
    ['20-1111111a-2', 'con letras'],
  ])('null si no son 11 dígitos: %s', (input) => {
    expect(normalizeCuit(input)).toBeNull();
  });

  it.each([[null], [undefined], [123], [{}]])('null si no es string: %s', (input) => {
    expect(normalizeCuit(input)).toBeNull();
  });
});

describe('isValidCuit', () => {
  describe('válidos (con o sin separadores)', () => {
    it.each([
      '20-11111111-2',
      '20111111112',
      '27-22222222-8',
      '30-50000003-8',
    ])('%s', (c) => {
      expect(isValidCuit(c)).toBe(true);
    });
  });

  describe('inválidos', () => {
    it.each([
      ['20-11111111-1', 'dígito verificador incorrecto'],
      ['20-1111111-2', 'menos de 11 dígitos'],
      ['201111111120', 'más de 11 dígitos'],
      ['', 'vacío'],
      ['abcdefghijk', 'no numérico'],
    ])('%s (%s)', (c) => {
      expect(isValidCuit(c)).toBe(false);
    });

    it.each([[null], [undefined], [123]])('no-string: %s', (c) => {
      expect(isValidCuit(c)).toBe(false);
    });
  });
});
