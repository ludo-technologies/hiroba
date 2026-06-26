/* Hiroba landing site — waitlist form enhancement.
   The <form> works without JS (native POST to /api/waitlist returns an HTML
   thank-you page). With JS we submit via fetch and show inline status, so the
   user never leaves the page. */
(() => {
  'use strict';

  const form = document.querySelector('.waitlist-form');
  if (!form) return;

  const statusEl = form.querySelector('[data-waitlist-status]');
  const submitBtn = form.querySelector('button[type="submit"]');
  const localeField = form.querySelector('[data-locale-field]');

  const i18n = window.HirobaSiteI18n;
  const locale = i18n?.locale || 'en';
  if (localeField) localeField.value = locale;

  const t = (key, fallback) => i18n?.t?.[key] ?? fallback;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = !message;
    statusEl.classList.remove('is-error', 'is-ok');
    if (kind) statusEl.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = Object.fromEntries(new FormData(form).entries());
    const email = String(data.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      setStatus(t('waitlistErrorEmail', 'Please enter a valid email address.'), 'error');
      form.querySelector('input[name="email"]')?.focus();
      return;
    }

    submitBtn.disabled = true;
    setStatus(t('waitlistSending', 'Sending…'), null);

    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        form.reset();
        if (localeField) localeField.value = locale;
        setStatus(t('waitlistSuccess', 'You’re on the list.'), 'ok');
        submitBtn.disabled = false;
        return;
      }
      // 400 with a message (e.g. bad email) — show it; else generic.
      const msg =
        res.status === 400
          ? t('waitlistErrorEmail', 'Please enter a valid email address.')
          : t('waitlistError', 'Something went wrong. Please try again.');
      setStatus(msg, 'error');
    } catch {
      setStatus(t('waitlistError', 'Something went wrong. Please try again.'), 'error');
    }
    submitBtn.disabled = false;
  });
})();
