let sequence = 0;

export type IdOptions = {
  now?: number;
  random?: () => number;
};

export function createId(prefix: string, options: IdOptions = {}): string {
  const now = options.now ?? Date.now();
  const random = options.random ?? Math.random;
  sequence = (sequence + 1) % 1296;
  const time = now.toString(36);
  const rand = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  const seq = sequence.toString(36).padStart(2, "0");
  return `${prefix}_${time}${seq}${rand}`;
}

export function randomToken(bytes = 24): string {
  const values = new Uint8Array(bytes);
  const cryptoObject = globalThis.crypto;
  cryptoObject.getRandomValues(values);
  let out = "";
  for (const value of values) out += value.toString(16).padStart(2, "0");
  return out;
}