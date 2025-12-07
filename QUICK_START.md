# ⚡ התחלה מהירה - 5 שלבים

## 1️⃣ צור Repository ב-GitHub
- לך ל-github.com
- לחץ "New repository"
- שם: `matzpen-kalkali-website`
- לחץ "Create"

## 2️⃣ העלה את הקבצים ל-GitHub
**דרך GitHub Desktop** (הכי קל):
- הורד: https://desktop.github.com/
- הוסף את התיקייה `תיקונים`
- לחץ "Publish repository"

**או דרך שורת פקודה**:
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/matzpen-kalkali-website.git
git push -u origin main
```

## 3️⃣ חבר ל-Netlify
- לך ל-app.netlify.com
- "Add new site" > "Import from GitHub"
- בחר את ה-repository שלך
- Build command: **השאר ריק**
- Publish directory: `.` (נקודה)
- לחץ "Deploy"

## 4️⃣ הפעל Identity
- Netlify Dashboard > Site settings > Identity
- לחץ "Enable Identity"
- לחץ "Enable Git Gateway"
- Identity > Invite users > הזמן את עצמך
- הוסף Role: `admin` לעצמך

## 5️⃣ עדכן config.yml
- פתח `static/admin/config.yml`
- החלף `your-site-name.netlify.app` בכתובת האתר שלך (ב-2 מקומות)
- Commit והעלה שוב

## ✅ סיימת!
- גש ל: `https://your-site.netlify.app/admin`
- התחבר והתחל להוסיף מאמרים!

---
📖 **להוראות מפורטות**: קרא את `DEPLOY_INSTRUCTIONS.md`

