import { AppError } from "./result.ts";

export class SchemaError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly received: string;

  constructor(path: string, expected: string, received: unknown) {
    const shown = received === null ? "null" : Array.isArray(received) ? "array" : typeof received;
    super(`${path || "(root)"}: expected ${expected}, received ${shown}`);
    this.name = "SchemaError";
    this.path = path || "(root)";
    this.expected = expected;
    this.received = shown;
  }
}

export type Validator<T> = {
  readonly description: string;
  readonly isOptional: boolean;
  parse(input: unknown, path?: string): T;
};

type Base<T> = {
  description: string;
  isOptional: boolean;
  parse(input: unknown, path?: string): T;
};

function make<T>(description: string, parse: (input: unknown, path: string) => T, isOptional = false): Validator<T> {
  const validator: Base<T> = {
    description,
    isOptional,
    parse(input: unknown, path = ""): T {
      return parse(input, path);
    },
  };
  const extended = validator as Base<T> & {
    optional(): Validator<T | undefined>;
    describe(): string;
  };
  extended.optional = () => make<T | undefined>(`${description}?`, (input, p) => {
    if (input === undefined) return undefined;
    return parse(input, p);
  }, true);
  extended.describe = () => description;
  return extended;
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export type StringOptions = {
  min?: number;
  max?: number;
  pattern?: RegExp;
  trim?: boolean;
};

export function string(options: StringOptions = {}): Validator<string> {
  const { min = 0, max = 100000, pattern, trim = false } = options;
  return make<string>(`string(${min}..${max})`, (input, path) => {
    if (typeof input !== "string") throw new SchemaError(path, "string", input);
    const value = trim ? input.trim() : input;
    if (value.length < min) throw new SchemaError(path, `string with at least ${min} chars`, value);
    if (value.length > max) throw new SchemaError(path, `string with at most ${max} chars`, value);
    if (pattern && !pattern.test(value)) throw new SchemaError(path, `string matching ${pattern}`, value);
    return value;
  });
}

export type NumberOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
};

export function number(options: NumberOptions = {}): Validator<number> {
  const { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, integer = false } = options;
  return make<number>(`number(${min}..${max})`, (input, path) => {
    if (typeof input !== "number" || Number.isNaN(input) || !Number.isFinite(input)) {
      throw new SchemaError(path, "finite number", input);
    }
    if (integer && !Number.isInteger(input)) throw new SchemaError(path, "integer", input);
    if (input < min) throw new SchemaError(path, `number >= ${min}`, input);
    if (input > max) throw new SchemaError(path, `number <= ${max}`, input);
    return input;
  });
}

export function boolean(): Validator<boolean> {
  return make<boolean>("boolean", (input, path) => {
    if (typeof input !== "boolean") throw new SchemaError(path, "boolean", input);
    return input;
  });
}

export function literal<T extends string | number | boolean | null>(value: T): Validator<T> {
  return make<T>(`literal(${JSON.stringify(value)})`, (input, path) => {
    if (input !== value) throw new SchemaError(path, `literal ${JSON.stringify(value)}`, input);
    return value;
  });
}

export function any(): Validator<unknown> {
  return make<unknown>("any", (input) => input);
}

export function unknown(): Validator<unknown> {
  return any();
}

export function arrayOf<T>(item: Validator<T>, options: { min?: number; max?: number } = {}): Validator<T[]> {
  const { min = 0, max = 100000 } = options;
  return make<T[]>(`array(${item.description})`, (input, path) => {
    if (!Array.isArray(input)) throw new SchemaError(path, "array", input);
    if (input.length < min) throw new SchemaError(path, `array with at least ${min} items`, input);
    if (input.length > max) throw new SchemaError(path, `array with at most ${max} items`, input);
    return input.map((entry, index) => item.parse(entry, `${path}[${index}]`));
  });
}

export function union<T>(items: Array<Validator<T>>): Validator<T> {
  return make<T>(`union(${items.map((i) => i.description).join(" | ")})`, (input, path) => {
    for (const item of items) {
      try {
        return item.parse(input, path);
      } catch {
        // try next
      }
    }
    throw new SchemaError(path, `one of ${items.map((i) => i.description).join(" | ")}`, input);
  });
}

export function recordOf<T>(value: Validator<T>): Validator<Record<string, T>> {
  return make<Record<string, T>>(`record(${value.description})`, (input, path) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new SchemaError(path, "object", input);
    }
    const result: Record<string, T> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      result[key] = value.parse(entry, join(path, key));
    }
    return result;
  });
}

export type Shape = Record<string, Validator<unknown>>;

type InferShape<S extends Shape> = {
  [K in keyof S]: S[K] extends Validator<infer T> ? T : never;
};

export function object<S extends Shape>(shape: S, options: { strict?: boolean } = {}): Validator<InferShape<S>> {
  const strict = options.strict !== false;
  const keys = Object.keys(shape);
  return make<InferShape<S>>(`object(${keys.join(",")})`, (input, path) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new SchemaError(path, "object", input);
    }
    const source = input as Record<string, unknown>;
    if (strict) {
      for (const key of Object.keys(source)) {
        if (!(key in shape)) {
          throw new SchemaError(join(path, key), "no unknown keys", source[key]);
        }
      }
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const validator = shape[key];
      const value = source[key];
      if (value === undefined && validator.isOptional) {
        result[key] = undefined;
        continue;
      }
      result[key] = validator.parse(value, join(path, key));
    }
    return result as InferShape<S>;
  });
}

export function partial<S extends Shape>(shape: S): Validator<Partial<InferShape<S>>> {
  const wrapped: Shape = {};
  for (const [key, validator] of Object.entries(shape)) {
    wrapped[key] = (validator as Validator<unknown> & { optional(): Validator<unknown> }).optional();
  }
  return object(wrapped, { strict: true }) as unknown as Validator<Partial<InferShape<S>>>;
}

export function validate<T>(validator: Validator<T>, input: unknown): T {
  try {
    return validator.parse(input);
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new AppError("VALIDATION", error.message, { path: error.path, expected: error.expected });
    }
    throw error;
  }
}

export const S = {
  string,
  number,
  boolean,
  literal,
  any,
  unknown,
  arrayOf,
  union,
  recordOf,
  object,
  partial,
  validate,
};