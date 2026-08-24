/**
 * מנוע החיפוש של מאגר הידע — מצפן כלכלי
 * ------------------------------------------------
 * לא מסתמך על התאמה מדויקת בלבד (term.name.includes(q)).
 * הוא בודק, לפי סדר עדיפות יורד:
 *   1. התאמה מדויקת בשם / שם באנגלית / כינוי
 *   2. התאמת "מתחיל ב-" בשם / כינוי / מילת מפתח
 *   3. הכלה (substring) בשם / כינוי / מילת מפתח / הסבר קצר
 *   4. התאמה מקורבת (typo-tolerant) במרחק עריכה קטן על שם/כינוי/מילת מפתח
 * כל מונח יכול "לזכות" רק בציון הכי גבוה שהוא השיג, וממויין לפי זה.
 */

// --- נירמול טקסט בעברית/אנגלית: מקל על "אותה מילה בכתיבה שונה" ---
function normalize(str) {
  if (!str) return "";
  return str
    .toString()
    .trim()
    .toLowerCase()
    // אותיות סופיות -> אותיות רגילות, כדי ש"פרים" ו"פרימ" וכו' יתקרבו
    .replace(/ך/g, "כ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ף/g, "פ")
    .replace(/ץ/g, "צ")
    // ניקוד (אם קיים) והתווים המיוחדים הנפוצים
    .replace(/[֑-ׇ]/g, "")
    .replace(/[""'׳״\-_.,/\\()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// מרחק עריכה (Levenshtein) — משמש רק לטיפול בשגיאות כתיב קלות,
// לא לחיפוש חופשי כללי (זה היה מייצר יותר "רעש" מתועלת).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // מחיקה
        dp[i][j - 1] + 1,      // הוספה
        dp[i - 1][j - 1] + cost // החלפה
      );
    }
  }
  return dp[m][n];
}

// כל מחרוזות החיפוש הרלוונטיות למונח, מנורמלות מראש
function buildSearchFields(term) {
  const names = [term.name, term.name_en, ...(term.aliases || [])];
  const keywords = term.keywords || [];
  return {
    names: names.filter(Boolean).map(normalize),
    keywords: keywords.filter(Boolean).map(normalize),
    shortExplanation: normalize(term.short_explanation),
  };
}

/**
 * מחפש מונחים במאגר.
 * @param {Array} terms - מערך המונחים (term.terms מתוך terms.json)
 * @param {string} query - שאילתת החיפוש הגולמית
 * @param {object} [opts]
 * @param {string} [opts.category] - סינון לפי קטגוריה (או null לכל הקטגוריות)
 * @param {number} [opts.limit] - מספר תוצאות מרבי
 * @returns {Array} מונחים ממויינים לפי רלוונטיות
 */
function searchTerms(terms, query, opts = {}) {
  const { category = null, limit = 20 } = opts;
  const q = normalize(query);

  let pool = terms;
  if (category) pool = pool.filter((t) => t.category === category);

  if (!q) {
    // אין שאילתה: החזר את המאגר (מסונן לפי קטגוריה אם צוינה) בסדר המקורי
    return pool.slice(0, limit);
  }

  const scored = [];

  for (const term of pool) {
    const fields = buildSearchFields(term);
    let score = 0;

    // 1. התאמה מדויקת בשם/כינוי
    if (fields.names.includes(q)) {
      score = 100;
    }
    // 2. "מתחיל ב-" בשם/כינוי/מילת מפתח
    else if (
      fields.names.some((n) => n.startsWith(q)) ||
      fields.keywords.some((k) => k.startsWith(q))
    ) {
      score = 80;
    }
    // 3. הכלה בשם/כינוי/מילת מפתח
    else if (
      fields.names.some((n) => n.includes(q)) ||
      fields.keywords.some((k) => k.includes(q))
    ) {
      score = 60;
    }
    // 3.5. הכלה בהסבר הקצר (רלוונטי, אבל פחות ממושג שמכיל את המילה בשמו)
    else if (fields.shortExplanation.includes(q)) {
      score = 40;
    }
    // 4. התאמה מקורבת לשגיאות כתיב, רק על מחרוזות קצרות-בינוניות.
    // כדי למנוע "רעש" (למשל "שכיר" מתאים בטעות ל-"שפיצר"), הסף תלוי
    // גם באורך המילה המועמדת וגם בהפרש האורך בינה לבין השאילתה.
    else if (q.length >= 3) {
      const candidateWords = new Set();
      for (const c of [...fields.names, ...fields.keywords]) {
        candidateWords.add(c);
        c.split(" ").forEach((w) => candidateWords.add(w));
      }
      const close = [...candidateWords].some((w) => {
        if (w.length < 4) return false; // מילים קצרות מדי -> יותר מדי התאמות שווא
        if (Math.abs(w.length - q.length) > 2) return false; // אורך שונה מדי
        const threshold = q.length <= 5 ? 1 : 2;
        return editDistance(w, q) <= threshold;
      });
      if (close) score = 25;
    }

    if (score > 0) scored.push({ term, score });
  }

  scored.sort((a, b) => b.score - a.score || a.term.name.localeCompare(b.term.name, "he"));
  return scored.slice(0, limit).map((s) => s.term);
}

// חשיפה גם ל-<script> רגיל (window) וגם ל-Node (עבור generate.js / בדיקות)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { searchTerms, normalize, editDistance };
}
if (typeof window !== "undefined") {
  window.KnowledgeSearch = { searchTerms, normalize, editDistance };
}
