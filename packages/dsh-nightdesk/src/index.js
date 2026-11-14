import { NightDeskStore } from './store.js';
import { createTools } from './tools.js';

export const name = 'nightdesk';
export const inject = ['tools'];

export function apply(ctx) {
  const store = new NightDeskStore();
  for (const tool of createTools(store)) ctx.tools.register(tool);
  ctx.effect(() => () => store.close());
}
