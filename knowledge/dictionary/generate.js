#!/usr/bin/env node
/**
 * generate.js
 * -----------
 * בונה עמוד HTML נפרד לכל מונח (לצורך SEO וקישור ישיר),
 * לפי terms.json + term-template.html.
 *
 * הרצה:  node generate.js
 * פלט:   <slug>/index.html לכל מונח (תחת knowledge/dictionary/<slug>/),
 *        ו-sitemap-fragment.xml
 *
 * הכלל החשוב: תוכן (terms.json) נפרד לגמרי מקוד (הסקריפט הזה +
 * הטמפלט). כדי להוסיף/לערוך מושגים, עורכים רק את terms.json
 * ומריצים שוב את הסקריפט — לא נוגעים ב-HTML.
 *
 * לפני כל commit/deploy כדאי גם להריץ: node test-search.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_PATH = path.join(ROOT, "terms.json");
const TEMPLATE_PATH = path.join(ROOT, "term-template.html");
const OUT_DIR = ROOT; // כל מונח יוצא כ-<slug>/index.html ישירות תחת knowledge/dictionary/
const SITE_BASE = "https://matzpenkalkali.com/knowledge/dictionary";

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toHebrewDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}.${m}.${y}`;
}

function renderRelated(term, termsBySlug, categories) {
  const related = (term.related_terms || [])
    .map((slug) => termsBySlug.get(slug))
    .filter(Boolean);
  if (related.length === 0) return "";

  const cards = related.map((rt) => {
    const cat = categories[rt.category] || {};
    return `<a class="kc-term-card" href="/knowledge/dictionary/${rt.slug}" style="--cat-color:${cat.color || ""}">
      <div class="kc-term-card-cat">${cat.icon || ""} ${escapeHtml(cat.label || "")}</div>
      <h3>${escapeHtml(rt.name)}</h3>
      <p class="kc-term-short">${escapeHtml(rt.short_explanation)}</p>
    </a>`;
  }).join("\n");

  return `<div class="kc-block" style="border-inline-start-color: var(--line);">
    <h2>מושגים קשורים</h2>
    <div class="kc-related-grid">${cards}</div>
  </div>`;
}

function renderCalculator(term) {
  const calcs = term.related_calculator || [];
  if (calcs.length === 0) return "";

  const links = calcs.map((c) =>
    `<a class="kc-calc-link" href="${escapeHtml(c.url)}">🧮 ${escapeHtml(c.label)}</a>`
  ).join("\n");

  return `<div class="kc-calc-cta">
    <h2>מחשבון רלוונטי</h2>
    <div class="kc-calc-links">${links}</div>
  </div>`;
}

function renderSources(term) {
  return (term.sources || [])
    .map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)} ↗</a>`)
    .join("\n");
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const { categories, terms } = data;
  const termsBySlug = new Map(terms.map((t) => [t.slug, t]));

  // בדיקת תקינות בסיסית לפני בנייה — עדיף להיכשל כאן מאשר לפרסם עמוד שבור
  const slugs = terms.map((t) => t.slug);
  const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupSlugs.length) {
    console.error(`שגיאה: slugs כפולים ב-terms.json: ${[...new Set(dupSlugs)].join(", ")}`);
    process.exit(1);
  }
  for (const t of terms) {
    if (!categories[t.category]) {
      console.error(`שגיאה: המונח "${t.slug}" מפנה לקטגוריה לא קיימת "${t.category}"`);
      process.exit(1);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const urls = [];
  const brokenRelated = [];

  for (const term of terms) {
    const cat = categories[term.category] || {};

    for (const rel of term.related_terms || []) {
      if (!termsBySlug.has(rel)) brokenRelated.push(`${term.slug} → ${rel}`);
    }

    let html = template
      .replaceAll("{{SLUG}}", term.slug)
      .replaceAll("{{NAME}}", escapeHtml(term.name))
      .replaceAll("{{CAT_ICON}}", cat.icon || "")
      .replaceAll("{{CAT_LABEL}}", escapeHtml(cat.label || ""))
      .replaceAll("{{SHORT_EXPLANATION}}", escapeHtml(term.short_explanation))
      .replaceAll("{{SIMPLE_EXPLANATION}}", escapeHtml(term.simple_explanation))
      .replaceAll("{{WHY_IT_MATTERS}}", escapeHtml(term.why_it_matters))
      .replaceAll("{{EXAMPLE}}", escapeHtml(term.example))
      .replaceAll("{{COMMON_MISTAKE}}", escapeHtml(term.common_mistake))
      .replaceAll("{{WHAT_TO_CHECK}}", escapeHtml(term.what_to_check))
      .replaceAll("{{SOURCES_HTML}}", renderSources(term))
      .replaceAll("{{CALCULATOR_BLOCK}}", renderCalculator(term))
      .replaceAll("{{RELATED_BLOCK}}", renderRelated(term, termsBySlug, categories))
      .replaceAll("{{LAST_UPDATED_HE}}", toHebrewDate(term.last_updated))
      .replaceAll("{{ALIASES_JSON}}", JSON.stringify(term.aliases || []))
      .replaceAll("{{SHORT_EXPLANATION_JSON}}", JSON.stringify(term.short_explanation || ""))
      .replaceAll(
        "{{NAME_EN_BLOCK}}",
        term.name_en ? `<p class="kc-term-en">${escapeHtml(term.name_en)}</p>` : ""
      );

    const outDir = path.join(OUT_DIR, term.slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");

    urls.push(`${SITE_BASE}/${term.slug}`);
  }

  if (brokenRelated.length) {
    console.warn(`אזהרה: related_terms שמפנים ל-slug לא קיים (יתעלמו מהם בעמוד): ${brokenRelated.join(", ")}`);
  }

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<!-- קטע זה מיועד להשתלב ב-sitemap.xml הראשי של האתר -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>
`;
  fs.writeFileSync(path.join(ROOT, "sitemap-fragment.xml"), sitemap, "utf8");

  console.log(`נוצרו ${terms.length} עמודי מונח, כל אחד כ-<slug>/index.html תחת ${ROOT}`);
  console.log(`נכתב sitemap-fragment.xml עם ${urls.length} כתובות`);
}

main();
