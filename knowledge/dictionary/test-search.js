#!/usr/bin/env node
/**
 * test-search.js
 * ---------------
 * בדיקת רגרסיה למנוע החיפוש (search.js). מריצים אחרי כל שינוי במנוע
 * או בתוכן terms.json, ולפני כל deploy:
 *
 *   node test-search.js
 *
 * בודק גם: 8 שאילתות המבחן מהמפרט, וגם תקינות מבנית (slug כפול,
 * related_terms שמצביע ל-slug לא קיים).
 */

const fs = require("fs");
const path = require("path");
const { searchTerms } = require("./search.js");

const ROOT = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "terms.json"), "utf8"));
const { terms } = data;

let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

console.log("── טבלת רגרסיה: חיפוש ──");
const REGRESSION = [
  ["שפיצר", "shpitzer"],
  ["LTV", "ltv-shiur-mimun"],
  ["ריבית בנק ישראל", "ribit-prime"],
  ["נסדק", "okev-madadei-meniot"],
  ["עוקב נאסדק", "okev-madadei-meniot"],
  ["גרייס", "grace-tekufat-grace"],
  ["ETF", "keren-sal-etf"],
  ["פריים", "ribit-prime"],
];
for (const [query, expectedSlug] of REGRESSION) {
  const results = searchTerms(terms, query, { limit: 5 });
  const top = results[0];
  check(
    `"${query}" → ${expectedSlug}` + (top ? ` (קיבלנו: ${top.slug})` : " (אין תוצאות)"),
    top && top.slug === expectedSlug
  );
}

console.log("\n── תקינות מבנית ──");

const slugs = terms.map((t) => t.slug);
const dupSlugs = slugs.filter((s, i) => slugs.indexOf(s) !== i);
check(`אין slugs כפולים${dupSlugs.length ? " (כפולים: " + [...new Set(dupSlugs)].join(", ") + ")" : ""}`, dupSlugs.length === 0);

const slugSet = new Set(slugs);
const brokenRelated = [];
for (const t of terms) {
  for (const rel of t.related_terms || []) {
    if (!slugSet.has(rel)) brokenRelated.push(`${t.slug} → ${rel}`);
  }
}
check(`אין related_terms שבורים${brokenRelated.length ? " (" + brokenRelated.join(", ") + ")" : ""}`, brokenRelated.length === 0);

const REQUIRED_FIELDS = [
  "slug", "name", "category", "short_explanation", "simple_explanation",
  "why_it_matters", "example", "common_mistake", "what_to_check", "last_updated",
];
const missingFields = [];
for (const t of terms) {
  for (const f of REQUIRED_FIELDS) {
    if (!t[f]) missingFields.push(`${t.slug || "(ללא slug)"} חסר שדה "${f}"`);
  }
  if (!data.categories[t.category]) missingFields.push(`${t.slug}: קטגוריה "${t.category}" לא קיימת ב-categories`);
}
check(`כל השדות החובה קיימים${missingFields.length ? " (" + missingFields.join("; ") + ")" : ""}`, missingFields.length === 0);

console.log(`\n${terms.length} מונחים נבדקו.`);

if (failed > 0) {
  console.log(`\n${failed} בדיקות נכשלו.`);
  process.exit(1);
} else {
  console.log("\nכל הבדיקות עברו בהצלחה.");
  process.exit(0);
}
