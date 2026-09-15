import { useEffect } from 'react';

function upsertMeta(attr, key, content) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertCanonical(href) {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

// Updates document.title, meta description, OG/Twitter tags and the
// canonical link on route change -- the SPA otherwise ships one static
// <title>/<meta description> for every route (see AUDIT_REPORT.md-style
// SEO review). Canonical is always self-referencing (current origin +
// pathname), which is the safe default and needs no hardcoded domain.
export default function usePageMeta({ title, description, noindex = false }) {
  useEffect(() => {
    const fullTitle = title ? `${title} - Sniffr` : 'Sniffr - Pet Dating & Social';
    document.title = fullTitle;

    if (description) {
      upsertMeta('name', 'description', description);
      upsertMeta('property', 'og:description', description);
      upsertMeta('name', 'twitter:description', description);
    }

    upsertMeta('property', 'og:title', fullTitle);
    upsertMeta('name', 'twitter:title', fullTitle);
    upsertCanonical(window.location.origin + window.location.pathname);
    upsertMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');
  }, [title, description, noindex]);
}
