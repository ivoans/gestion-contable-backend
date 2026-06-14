// tests/utils/libroIvaParser.test.ts
import { describe, it, expect } from 'vitest';
import { parsearLibroIVA } from '../../src/utils/libroIvaParser';

// Filas reales de ejemplo (datos de prueba). Layout de reporte impreso.
const COMPRAS: unknown[][] = [
  ['THOMAS SONIA INES', 'Hoja Nº:', '0'],
  ['Estudio Contable Impositivo'],
  ['GARIBALDI 639                          CUIT:23-16709214-4'],
  ['Libro IVA Compras Abril de 2026'],
  ['Fecha', 'Cpte.', 'Nº Comp.', 'Proveedor', 'CUIT o Doc.', 'Neto', 'Conc. No Grav.', 'Créd. Fisc.', 'Acrece.', 'Total Operac.'],
  ['Ret./Per./P.Cta.', 'IVA Discrim.', 'Op. Exentas'],
  ['TRANSPORTE', '0.00', '0.00', '0.00', '0.00', '0.00'],
  ['14/03/2026', 'TIQUE F', 'A', '0020-00043417', 'MATEAZZI CLAU', '27-23240873-7', '57053.69', '978.10', '11981.27', '0.00', '70013.06'],
  ['01/04/2026', 'FACTURA', 'A', '0001-04374690', 'SEGUROS RIVAD', '30-50005031-0', '53685.84', '0.00', '11274.03', '0.00', '71942.61'],
  ['1610.58', '5372.16'],
  ['08/04/2026', 'RECIBOS', 'C', '0001-00415065', 'Consejo profe', '30-55795560-3', '23400.00', '0.00', '0.00', '0.00', '23400.00'],
  ['Totales Mensuales:', '134139.53', '978.10', '23255.30', '0.00', '165355.67'],
  ['1610.58', '5372.16', '0.00'],
];

// Mismo layout pero libro de ventas: encabezado "Ventas", títulos con "Déb. Fisc.".
const VENTAS: unknown[][] = [
  ['THOMAS SONIA INES', 'Hoja Nº:', '0'],
  ['Estudio Contable Impositivo'],
  ['GARIBALDI 639                          CUIT:23-16709214-4'],
  ['Libro IVA Ventas Abril de 2026'],
  ['Fecha', 'Cpte.', 'Nº Comp.', 'Cliente', 'CUIT o Doc.', 'Neto', 'Conc. No Grav.', 'Déb. Fisc.', 'Acrece.', 'Total Operac.'],
  ['Ret./Per./P.Cta.', 'IVA Discrim.', 'Op. Exentas'],
  ['TRANSPORTE', '0.00', '0.00', '0.00', '0.00', '0.00'],
  ['14/03/2026', 'FACTURA', 'A', '0020-00043417', 'MATEAZZI CLAU', '27-23240873-7', '57053.69', '978.10', '11981.27', '0.00', '70013.06'],
  ['01/04/2026', 'FACTURA', 'A', '0001-04374690', 'SEGUROS RIVAD', '30-50005031-0', '53685.84', '0.00', '11274.03', '0.00', '71942.61'],
  ['1610.58', '5372.16'],
  ['08/04/2026', 'RECIBOS', 'C', '0001-00415065', 'Consejo profe', '30-55795560-3', '23400.00', '0.00', '0.00', '0.00', '23400.00'],
  ['Totales Mensuales:', '134139.53', '978.10', '23255.30', '0.00', '165355.67'],
  ['1610.58', '5372.16', '0.00'],
];

const clonar = (filas: unknown[][]): unknown[][] => filas.map((f) => [...f]);

describe('parsearLibroIVA', () => {
  describe('compras válido', () => {
    const r = parsearLibroIVA(COMPRAS);

    it('detecta tipo, periodo y CUIT del titular', () => {
      expect(r.tipo).toBe('compra');
      expect(r.periodo).toEqual({ anio: 2026, mes: 4 });
      expect(r.cuit).toBe('23167092144');
    });

    it('parsea los 3 registros de detalle (ignora TRANSPORTE)', () => {
      expect(r.registros).toHaveLength(3);
      expect(r.registros[0]).toMatchObject({
        fecha: '2026-03-14',
        tipo_comprobante: 'TIQUE F',
        letra: 'A',
        numero: '0020-00043417',
        contraparte: 'MATEAZZI CLAU',
        cuit_contraparte: '27-23240873-7',
        neto: 57053.69,
        concepto_no_gravado: 978.1,
        iva: 11981.27,
        acrecentamiento: 0,
        total: 70013.06,
        retenciones_percepciones: null,
        op_exentas: null,
      });
    });

    it('asigna la fila secundaria al detalle anterior (SEGUROS)', () => {
      const seguros = r.registros[1];
      expect(seguros.contraparte).toBe('SEGUROS RIVAD');
      expect(seguros.retenciones_percepciones).toBe(1610.58);
      expect(seguros.op_exentas).toBeNull();
    });

    it('captura los totales declarados por el archivo', () => {
      expect(r.totalesArchivo).toEqual({
        neto: 134139.53,
        concepto_no_gravado: 978.1,
        iva: 23255.3,
        acrecentamiento: 0,
        total: 165355.67,
        retenciones_percepciones: 1610.58,
        op_exentas: 0,
      });
    });

    it('valida: las sumas coinciden con los totales declarados', () => {
      expect(r.sumas).toEqual(r.totalesArchivo);
      expect(r.validacion.ok).toBe(true);
      expect(r.validacion.diferencias).toEqual([]);
    });
  });

  describe('ventas válido', () => {
    it('detecta tipo venta con el mismo layout', () => {
      const r = parsearLibroIVA(VENTAS);
      expect(r.tipo).toBe('venta');
      expect(r.periodo).toEqual({ anio: 2026, mes: 4 });
      expect(r.registros).toHaveLength(3);
      expect(r.validacion.ok).toBe(true);
    });
  });

  describe('totales que no cuadran', () => {
    it('marca validacion.ok=false y lista la diferencia', () => {
      const filas = clonar(COMPRAS);
      // Alteramos el neto del primer detalle (col6) sin tocar los totales declarados.
      filas[7][6] = '99999.99';
      const r = parsearLibroIVA(filas);

      expect(r.validacion.ok).toBe(false);
      const difNeto = r.validacion.diferencias.find((d) => d.campo === 'neto');
      expect(difNeto).toBeDefined();
      expect(difNeto?.archivo).toBe(134139.53);
      expect(difNeto?.calculado).toBe(177085.83);
      expect(difNeto?.diff).toBe(-42946.3);
    });
  });

  describe('fila secundaria con 3 valores', () => {
    it('captura op_exentas (y ret) en el registro anterior', () => {
      const filas: unknown[][] = [
        ['Estudio X', 'CUIT:20-11111111-2'],
        ['Libro IVA Compras Abril de 2026'],
        ['Fecha', 'Cpte.', 'Nº Comp.', 'Proveedor', 'CUIT o Doc.', 'Neto', 'Conc. No Grav.', 'Créd. Fisc.', 'Acrece.', 'Total Operac.'],
        ['Ret./Per./P.Cta.', 'IVA Discrim.', 'Op. Exentas'],
        ['01/04/2026', 'FACTURA', 'A', '0001-1', 'PROV', '30-50005031-0', '1000.00', '0.00', '210.00', '0.00', '1210.00'],
        ['10.00', '20.00', '200.00'],
      ];
      const r = parsearLibroIVA(filas);

      expect(r.registros).toHaveLength(1);
      expect(r.registros[0].retenciones_percepciones).toBe(10);
      expect(r.registros[0].op_exentas).toBe(200);
    });
  });

  // Layout REAL del .xls (Excel 2003 XML) exportado por el software contable: el
  // rótulo "Totales Mensuales:" cae en la col3 y los montos vienen corridos respecto
  // al detalle. ret/perc y op_exentas se declaran en la fila secundaria pero no se
  // reconcilian contra el detalle, por eso NO deben bloquear la importación.
  describe('layout corrido del export real (.xls)', () => {
    const COMPRAS_CORRIDO: unknown[][] = [
      ['THOMAS SONIA INES', '', '', '', '', '', '', '', '', 'Hoja Nº:', '0'],
      ['GARIBALDI 639                          CUIT:23-16709214-4'],
      ['Libro IVA Compras Abril de 2026'],
      ['Fecha', 'Cpte.', '', 'Nº Comp.', 'Proveedor', 'CUIT o Doc.', 'Neto', 'Conc. No Grav.', 'Créd. Fisc.', 'Acrece.', 'Total Operac.'],
      ['', '', '', '', '', '', 'Ret./Per./P.Cta.', '', 'IVA Discrim.', '', 'Op. Exentas'],
      ['', '', '', '', 'TRANSPORTE', '0.00', '', '0.00', '0.00', '0.00', '0.00'],
      ['14/03/2026', 'TIQUE F', 'A', '0020-00043417', 'MATEAZZI CLAU', '27-23240873-7', '57053.69', '978.10', '11981.27', '0.00', '70013.06'],
      ['', '', '', 'Totales Mensuales:', '', '57053.69', '978.10', '11981.27', '0.00', '', '70013.06'],
      ['', '', '', '', '', '', '223679.57', '2649405.13', '', '69149.96', ''],
    ];

    const r = parsearLibroIVA(COMPRAS_CORRIDO);

    it('detecta totales con el rótulo en col3 y montos corridos', () => {
      expect(r.totalesArchivo).toMatchObject({
        neto: 57053.69,
        concepto_no_gravado: 978.1,
        iva: 11981.27,
        acrecentamiento: 0,
        total: 70013.06,
        retenciones_percepciones: 223679.57,
        op_exentas: 69149.96,
      });
    });

    it('NO bloquea por ret/perc ni op_exentas; los core-5 cuadran', () => {
      expect(r.registros).toHaveLength(1);
      expect(r.validacion.ok).toBe(true);
      expect(r.validacion.diferencias).toEqual([]);
    });
  });

  describe('sin encabezado de libro IVA', () => {
    it('lanza Error', () => {
      const filas: unknown[][] = [
        ['Estudio Contable'],
        ['Fecha', 'Cpte.', 'Nº Comp.', 'Proveedor'],
        ['01/04/2026', 'FACTURA', 'A', '0001-1'],
      ];
      expect(() => parsearLibroIVA(filas)).toThrow(/no parece un libro IVA válido/);
    });
  });
});
