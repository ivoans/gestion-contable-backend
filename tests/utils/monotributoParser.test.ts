import { describe, it, expect } from 'vitest';
import { parsearMonotributo, MonotributoParseError } from '../../src/utils/monotributoParser';

// Encabezado real (recortado) del export AFIP "Mis Comprobantes Emitidos".
const HEADER = [
  'Fecha', 'Tipo', 'Punto de Venta', 'Número Desde', 'Número Hasta', 'Cód. Autorización',
  'Tipo Doc. Receptor', 'Nro. Doc. Receptor', 'Denominación Receptor', 'Tipo Cambio', 'Moneda',
  'Neto Grav. IVA 0%', 'IVA 2,5%', 'Neto Grav. IVA 2,5%', 'IVA 5%', 'Neto Grav. IVA 5%',
  'IVA 10,5%', 'Neto Grav. IVA 10,5%', 'IVA 21%', 'Neto Grav. IVA 21%', 'IVA 27%',
  'Neto Grav. IVA 27%', 'Neto Gravado Total', 'Neto No Gravado', 'Op. Exentas', 'Otros Tributos',
  'Total IVA', 'Imp. Total',
];

// Arma una fila de detalle mínima: solo importan Fecha (0), Tipo (1) e Imp. Total (27).
function fila(fecha: string, tipo: string, impTotal: string): string[] {
  const r = new Array(28).fill('');
  r[0] = fecha;
  r[1] = tipo;
  r[27] = impTotal;
  return r;
}

describe('parsearMonotributo', () => {
  it('suma Imp. Total por mes y extrae el CUIT del título', () => {
    const filas = [
      ['Mis Comprobantes Emitidos - CUIT 20231414143'],
      HEADER,
      fila('01/05/2026', '11 - Factura C', '17500'),
      fila('02/05/2026', '11 - Factura C', '5800'),
      fila('03/05/2026', '11 - Factura C', '5500'),
    ];
    const res = parsearMonotributo(filas);
    expect(res.cuit).toBe('20231414143');
    expect(res.periodos).toHaveLength(1);
    expect(res.periodos[0]).toMatchObject({
      anio: 2026, mes: 5, periodo: '2026-05-01', monto: 28800, comprobantes: 3,
    });
  });

  it('las notas de crédito restan', () => {
    const filas = [
      ['Mis Comprobantes Emitidos'],
      HEADER,
      fila('01/05/2026', '11 - Factura C', '17500'),
      fila('05/05/2026', '13 - Nota de Crédito C', '2500'),
    ];
    const res = parsearMonotributo(filas);
    expect(res.periodos[0].monto).toBe(15000);
    expect(res.periodos[0].comprobantes).toBe(2);
  });

  it('agrupa por mes cuando el export abarca varios', () => {
    const filas = [
      ['Mis Comprobantes Emitidos'],
      HEADER,
      fila('30/04/2026', '11 - Factura C', '10000'),
      fila('01/05/2026', '11 - Factura C', '20000'),
      fila('31/05/2026', '11 - Factura C', '5000'),
    ];
    const res = parsearMonotributo(filas);
    expect(res.periodos).toHaveLength(2);
    expect(res.periodos.map((p) => [p.periodo, p.monto])).toEqual([
      ['2026-04-01', 10000],
      ['2026-05-01', 25000],
    ]);
  });

  it('parsea montos en formato es-AR (1.234,56)', () => {
    const filas = [
      ['Mis Comprobantes Emitidos'],
      HEADER,
      fila('01/05/2026', '11 - Factura C', '1.234,56'),
      fila('02/05/2026', '11 - Factura C', '17.500'),
    ];
    const res = parsearMonotributo(filas);
    expect(res.periodos[0].monto).toBe(18734.56);
  });

  it('tira error si no encuentra encabezados', () => {
    expect(() => parsearMonotributo([['cualquier cosa'], ['otra']])).toThrow(MonotributoParseError);
  });

  it('tira error si no hay comprobantes con fecha válida', () => {
    expect(() => parsearMonotributo([['Mis Comprobantes'], HEADER])).toThrow(MonotributoParseError);
  });
});
