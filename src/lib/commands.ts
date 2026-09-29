type Handler = (arg?: unknown) => void;

const registry = new Map<string, Handler>();

export function registerCommand(id: string, handler: Handler) {
  registry.set(id, handler);
}

export function runCommand(id: string, arg?: unknown): boolean {
  const h = registry.get(id);
  if (!h) {
    console.warn(`[al-navi] unregistered command: ${id}`);
    return false;
  }
  h(arg);
  return true;
}

export function hasCommand(id: string): boolean {
  return registry.has(id);
}
