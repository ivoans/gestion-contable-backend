// tests/helpers/supabaseMock.ts
import { vi } from 'vitest';

/**
 * Respuesta que un builder devuelve al ser awaiteado o al cerrar con .single()/.maybeSingle().
 * Mismo shape que postgrest-js: { data, error, count?, status? }.
 */
export type SupabaseResult<T = any> = {
  data: T | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
  status?: number;
};

/** Programa una respuesta por cada `supabase.from(table)` consumido en orden. */
export type FromCall = {
  table: string;
  /** Resultado terminal del chain (await directo o .single()/.maybeSingle() si no hay override). */
  result: SupabaseResult;
  resultSingle?: SupabaseResult;
  resultMaybeSingle?: SupabaseResult;
};

export type RecordedCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' | null;
  /** Filtros encadenados, en orden. Ej: [['eq','id','xxx'], ['neq','estado','pagado']]. */
  filters: Array<[string, ...any[]]>;
  /** Payload de insert/update/upsert si hubo. */
  payload?: any;
  /** Opción onConflict pasada a upsert (args[1].onConflict), si hubo. */
  onConflict?: string;
  /** Opción ignoreDuplicates pasada a upsert (args[1].ignoreDuplicates), si hubo. */
  ignoreDuplicates?: boolean;
  terminal: 'single' | 'maybeSingle' | 'await' | null;
};

/** Programa una respuesta por cada `supabase.rpc(fn, args)` consumido en orden. */
export type RpcCall = {
  fn: string;
  result: SupabaseResult;
};

export type RecordedRpcCall = {
  fn: string;
  args: any;
};

export type SupabaseMock = {
  client: { from: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof vi.fn> };
  queue: (calls: FromCall[]) => void;
  push: (call: FromCall) => void;
  queueRpc: (calls: RpcCall[]) => void;
  pushRpc: (call: RpcCall) => void;
  calls: RecordedCall[];
  rpcCalls: RecordedRpcCall[];
  reset: () => void;
};

const PASSTHROUGH = [
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'neq', 'lt', 'gt', 'lte', 'gte',
  'in', 'is', 'or', 'order', 'limit', 'range', 'match',
] as const;

const TERMINALS_OP = new Set(['select', 'insert', 'update', 'delete', 'upsert']);

export function createSupabaseMock(initial: FromCall[] = []): SupabaseMock {
  let pending: FromCall[] = [...initial];
  let pendingRpc: RpcCall[] = [];
  const calls: RecordedCall[] = [];
  const rpcCalls: RecordedRpcCall[] = [];

  function makeBuilder(call: FromCall, recorded: RecordedCall) {
    const builder: any = {};

    for (const method of PASSTHROUGH) {
      builder[method] = vi.fn((...args: any[]) => {
        if (TERMINALS_OP.has(method)) {
          // Solo registrar la PRIMERA op del chain. En `insert().select().single()`
          // la op real es 'insert'; el select posterior es proyección, no operación.
          if (recorded.op === null) {
            recorded.op = method as RecordedCall['op'];
          }
          if (method === 'insert' || method === 'update' || method === 'upsert') {
            recorded.payload = args[0];
          }
          if (method === 'upsert') {
            recorded.onConflict = args[1]?.onConflict;
            recorded.ignoreDuplicates = args[1]?.ignoreDuplicates;
          }
        } else {
          recorded.filters.push([method, ...args]);
        }
        return builder;
      });
    }

    builder.single = vi.fn(() => {
      recorded.terminal = 'single';
      return Promise.resolve(call.resultSingle ?? call.result);
    });
    builder.maybeSingle = vi.fn(() => {
      recorded.terminal = 'maybeSingle';
      return Promise.resolve(call.resultMaybeSingle ?? call.result);
    });

    // Thenable: `await supabase.from(...).select(...).eq(...)` resuelve sin .single().
    builder.then = (resolve: (v: SupabaseResult) => any, reject?: (e: any) => any) => {
      recorded.terminal = recorded.terminal ?? 'await';
      return Promise.resolve(call.result).then(resolve, reject);
    };

    return builder;
  }

  const from = vi.fn((table: string) => {
    const next = pending.shift();
    if (!next) {
      throw new Error(
        `[supabaseMock] from('${table}') sin respuesta programada. ` +
        `Calls previas: ${calls.length}. Programá con queue()/push().`,
      );
    }
    if (next.table !== table) {
      throw new Error(
        `[supabaseMock] from('${table}') no matchea programado '${next.table}'.`,
      );
    }
    const recorded: RecordedCall = { table, op: null, filters: [], terminal: null };
    calls.push(recorded);
    return makeBuilder(next, recorded);
  });

  // Mismo patrón de cola que `from`, pero para supabase.rpc(fn, args). Se awaitea
  // directo → resuelve a { data, error }.
  const rpc = vi.fn((fn: string, args: any) => {
    rpcCalls.push({ fn, args });
    const next = pendingRpc.shift();
    if (!next) {
      throw new Error(
        `[supabaseMock] rpc('${fn}') sin respuesta programada. Programá con queueRpc()/pushRpc().`,
      );
    }
    if (next.fn !== fn) {
      throw new Error(`[supabaseMock] rpc('${fn}') no matchea programado '${next.fn}'.`);
    }
    return Promise.resolve(next.result);
  });

  return {
    client: { from, rpc },
    queue: (newCalls) => { pending = [...newCalls]; },
    push: (call) => { pending.push(call); },
    queueRpc: (newCalls) => { pendingRpc = [...newCalls]; },
    pushRpc: (call) => { pendingRpc.push(call); },
    calls,
    rpcCalls,
    reset: () => {
      pending = [];
      pendingRpc = [];
      calls.length = 0;
      rpcCalls.length = 0;
      from.mockClear();
      rpc.mockClear();
    },
  };
}
