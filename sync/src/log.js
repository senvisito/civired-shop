import { config } from './config.js';

export const log = (...a) => console.log(new Date().toISOString(), ...a);
export const warn = (...a) => console.warn(new Date().toISOString(), 'AVISO', ...a);

/** Aviso por Telegram (opcional). Nunca rompe la sincronización. */
export async function notify(text) {
  log('AVISO>', text);
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `🛒 shop.civired.com\n${text}`.slice(0, 4000) }),
    });
  } catch (e) {
    warn('telegram', e.message);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
