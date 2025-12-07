# הוראות העלאה ל-Netlify עם Netlify CMS

## שלב 1: העלאה ל-GitHub

1. פתח חשבון ב-GitHub (אם אין לך): https://github.com
2. צור repository חדש בשם: `matzpen-kalkali-website`
3. בתיקיית הפרויקט, פתח PowerShell/Terminal והרץ:

```bash
# אתחול git (אם עדיין לא עשית)
git init

# הוסף את כל הקבצים
git add .

# צור commit ראשון
git commit -m "Initial commit - מצפן כלכלי website"

# חבר ל-GitHub repository
git remote add origin https://github.com/your-username/matzpen-kalkali-website.git

# העלה את הקבצים
git branch -M main
git push -u origin main
```

## שלב 2: חיבור ל-Netlify

1. היכנס ל-Netlify: https://app.netlify.com
2. היכנס עם חשבון GitHub שלך
3. לחץ על "Add new site" > "Import an existing project"
4. בחר "GitHub" ו-Authorize את Netlify
5. בחר את ה-repository שיצרת: `matzpen-kalkali-website`
6. בהגדרות Build:
   - **Build command**: השאר ריק (אין build process)
   - **Publish directory**: `.` (נקודה)
7. לחץ "Deploy site"

## שלב 3: הפעלת Netlify Identity ו-Git Gateway

1. ב-Netlify Dashboard, לך ל: **Site settings** > **Identity**
2. לחץ על "Enable Identity"
3. בחלק "Registration preferences" - בחר "Invite only" (רק מוזמנים)
4. גלול למטה ולחץ "Enable Git Gateway"
5. חזור ל-**Identity** > **Invite users**
6. הזמן את עצמך (תקבל אימייל עם הזמנה)

## שלב 4: עדכון קובץ config.yml

1. לאחר ה-Deploy, העתק את כתובת האתר שלך (לדוגמה: `https://matzpen-kalkali.netlify.app`)
2. פתח את הקובץ `static/admin/config.yml`
3. החלף את `your-site-name.netlify.app` בכתובת האתר שלך ב-2 מקומות:
   ```yaml
   identity_url: https://matzpen-kalkali.netlify.app/.netlify/identity
   gateway_url: https://matzpen-kalkali.netlify.app/.netlify/git/gateway
   ```
4. Commit והעלה את השינויים:
   ```bash
   git add static/admin/config.yml
   git commit -m "Update Netlify CMS config with site URL"
   git push
   ```

## שלב 5: כניסה לממשק ניהול התוכן

1. גש ל: `https://your-site.netlify.app/admin`
2. התחבר עם האימייל שקיבלת בהזמנה
3. עכשיו תוכל להוסיף ולערוך מאמרים!

## איך להוסיף מאמר חדש:

1. היכנס ל-`/admin`
2. לחץ על "מאמרים" > "New Blog"
3. מלא את השדות:
   - **כותרת**: שם המאמר
   - **תאריך פרסום**: תאריך הפרסום
   - **תיאור קצר**: תיאור למאמר (מופיע בכרטיס המאמר)
   - **תמונת נושא**: העלה תמונה
   - **זמן קריאה**: כמה דקות
   - **ID ייחודי**: למשל `new-article` (אותיות קטנות, ללא רווחים)
   - **תוכן המאמר**: כתוב את המאמר ב-Markdown
4. לחץ "Save"
5. המאמר יתעדכן אוטומטית באתר!

## הערות חשובות:

- כל שינוי שתשמור ב-Netlify CMS יתעדכן אוטומטית ב-GitHub ו-Netlify
- המאמרים נשמרים בתיקייה `_posts/` בפורמט Markdown
- כדי להוסיף סרטונים, השתמש בקטע "מדיה וסרטונים"
- תמונות שתעלה יישמרו בתיקיית `images/`

## תמיכה:

אם יש בעיות, בדוק:
- [תיעוד Netlify CMS](https://www.netlifycms.org/docs/)
- [תיעוד Netlify](https://docs.netlify.com/)
- [Netlify Community Forum](https://answers.netlify.com/)

---

**בהצלחה! 🚀**

