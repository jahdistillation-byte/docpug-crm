import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// раздаём статические файлы (index.html, style.css, app.js)
app.use(express.static(__dirname));

// тестовый /api/me
app.get("/api/me", (req, res) => {
  res.json({
    ok: true,
    user: {
      name: "Коржов Тимофей",
      tg_user_id: 999999999, // потом подставим реальный
      clinic_id: "docpug"
    }
  });
});

app.listen(8080, () => {
  console.log("Server running: http://localhost:8080");
});
