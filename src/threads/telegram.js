// New-post alerts through a Telegram bot (create one with @BotFather, write to it once, take your chat id).
const API = () => (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');

export async function tgSend(settings, text) {
  if (!settings.tgToken || !settings.tgChat) return false;
  let res;
  try {
    res = await fetch(`${API()}/bot${settings.tgToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ chat_id: settings.tgChat, text: text.slice(0, 3900), disable_web_page_preview: true }),
    });
  } catch (e) { throw new Error(`Telegram недоступен (${e.cause?.code || e.name})`); }
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(`Telegram: ${out.description || `HTTP ${res.status}`}`);
  return true;
}
