/** Looks up a required DOM element by id and fails loudly if it's missing. */
export function requireElement<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Required DOM element #${id} was not found. The page markup is out of sync with the app code.`);
  }
  return el as unknown as T;
}
