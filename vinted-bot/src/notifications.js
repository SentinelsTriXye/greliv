// Envoi des alertes sur Discord (webhook) et/ou Telegram.

const ETIQUETTE_AFFAIRE = { excellente: '🔥 Excellente affaire', bonne: '✅ Bonne affaire', normal: '' };

const couleurEntier = (hex) => Number.parseInt(String(hex || '#09B1BA').replace('#', ''), 16);
const formatPrix = (a) =>
  a.prix == null ? '?' : `${a.prix.toFixed(2).replace('.', ',')} ${a.devise === 'EUR' ? '€' : a.devise}`;

export function messageDiscord(article, categorie = {}) {
  const champs = [
    { name: 'Prix', value: formatPrix(article), inline: true },
    article.taille && { name: 'Taille', value: article.taille, inline: true },
    article.marque && { name: 'Marque', value: article.marque, inline: true },
    article.etat && { name: 'État', value: article.etat, inline: true },
    { name: 'Catégorie', value: article.categorie, inline: true },
    { name: 'Recherche', value: article.recherche, inline: true },
  ].filter(Boolean);
  return {
    username: 'Bot Vinted',
    content: ETIQUETTE_AFFAIRE[article.affaire] || undefined,
    embeds: [
      {
        title: article.titre.slice(0, 250) || 'Article',
        url: article.url,
        color: couleurEntier(categorie.couleur),
        fields: champs,
        image: article.photo ? { url: article.photo } : undefined,
        footer: { text: article.vendeur ? `Vendeur : ${article.vendeur}` : 'Vinted' },
        timestamp: article.publie_le ?? new Date().toISOString(),
      },
    ],
  };
}

export function messageTelegram(article) {
  const echapper = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const lignes = [
    ETIQUETTE_AFFAIRE[article.affaire],
    `<b>${echapper(article.titre)}</b>`,
    `💶 ${formatPrix(article)}${article.taille ? ` · 📏 ${echapper(article.taille)}` : ''}`,
    article.marque && `🏷 ${echapper(article.marque)}${article.etat ? ` · ${echapper(article.etat)}` : ''}`,
    `📂 ${echapper(article.categorie)} › ${echapper(article.recherche)}`,
    `<a href="${article.url}">Voir l'annonce</a>`,
  ].filter(Boolean);
  return lignes.join('\n');
}

export class Notificateur {
  constructor({ fetchImpl = globalThis.fetch, journal = console } = {}) {
    this.fetch = fetchImpl;
    this.journal = journal;
  }

  async envoyer(article, recherche, config) {
    const categorie = config.categories?.[article.categorie] ?? {};
    const webhook =
      recherche.discord_webhook || categorie.discord_webhook || config.notifications?.discord_webhook;
    const tg = { ...config.notifications?.telegram, ...categorie.telegram, ...recherche.telegram };

    const envois = [];
    if (webhook) envois.push(this.discord(webhook, messageDiscord(article, categorie)));
    if (tg.token && tg.chat_id) envois.push(this.telegram(tg, article));
    const resultats = await Promise.allSettled(envois);
    for (const r of resultats)
      if (r.status === 'rejected') this.journal.warn?.(`Notification échouée : ${r.reason.message}`);
  }

  async discord(webhook, corps, essai = 0) {
    const rep = await this.fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
    });
    if (rep.status === 429 && essai < 3) {
      const attente = Number((await rep.json().catch(() => ({}))).retry_after ?? 1);
      await new Promise((r) => setTimeout(r, Math.ceil(attente * 1000)));
      return this.discord(webhook, corps, essai + 1);
    }
    if (!rep.ok) throw new Error(`Discord ${rep.status}`);
  }

  async telegram({ token, chat_id }, article) {
    const base = `https://api.telegram.org/bot${token}`;
    const texte = messageTelegram(article);
    const rep = article.photo
      ? await this.fetch(`${base}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id, photo: article.photo, caption: texte, parse_mode: 'HTML' }),
        })
      : await this.fetch(`${base}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id, text: texte, parse_mode: 'HTML' }),
        });
    if (!rep.ok) throw new Error(`Telegram ${rep.status}`);
  }
}
