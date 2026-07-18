GOOGLE SEARCH CONSOLE SETUP INSTRUCTIONS
==========================================

1. Go to https://search.google.com/search-console
2. Click "Add Property"
3. Enter: https://matzpenkalkali.com
4. Choose "HTML file" verification method
5. Download the verification file Google provides (looks like google1234567890abcdef.html)
6. Place it in the root folder of this project (same folder as index.html)
7. Deploy to Netlify (git push — auto-deploys)
8. Click "Verify" in Search Console
9. Submit sitemap: https://matzpenkalkali.com/sitemap.xml

Alternative: DNS verification
------------------------------
Instead of the HTML file method, you can verify via DNS TXT record
through your domain registrar / Netlify DNS settings. Google will
give you a TXT record value to add — this avoids needing to deploy
a file and survives site rebuilds automatically.

Notes
-----
- GA4 is already installed site-wide with Measurement ID G-CLWP2CD2EC
  (found in index.html and now added to all 6 calculator pages).
- robots.txt and sitemap.xml already exist at the site root and are
  correctly configured — no changes needed there beyond adding the
  2 new calculator URLs (done).
- images/og-image.png is referenced by Open Graph / Twitter Card tags
  across the site but does not currently exist in /images — social
  share previews will show a broken image until this is created
  (1200x630px, Matzpen Kalkali branding).
