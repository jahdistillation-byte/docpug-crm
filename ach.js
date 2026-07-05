function getVeterinaryAchievements(stats) {
  const list = [
    ach("first_visit", "Перший крок", "Провести перший прийом", "career", "common", 1, stats.totalVisits, 50, "⚪"),
    ach("career_25", "Практикант", "25 прийомів", "career", "common", 25, stats.totalVisits, 100, "🥉"),
    ach("career_100", "Досвідчений ветеринар", "100 прийомів", "career", "uncommon", 100, stats.totalVisits, 200, "🟢"),
    ach("career_500", "Майстер ветеринарії", "500 прийомів", "career", "rare", 500, stats.totalVisits, 400, "🔵"),
    ach("career_1000", "Експерт ветеринарії", "1000 прийомів", "career", "epic", 1000, stats.totalVisits, 800, "🟣"),
    ach("career_2500", "Легенда ветеринарії", "2500 прийомів", "career", "legendary", 2500, stats.totalVisits, 1500, "👑"),

    ach("dog_50", "Друг собак", "50 прийомів собак", "dogs", "common", 50, stats.dogVisits, 120, "🐶"),
    ach("dog_250", "Знавець собак", "250 прийомів собак", "dogs", "uncommon", 250, stats.dogVisits, 250, "🐶"),
    ach("dog_1000", "Кінологічний експерт", "1000 прийомів собак", "dogs", "epic", 1000, stats.dogVisits, 600, "🐶"),
    ach("dog_2500", "Повелитель собак", "2500 прийомів собак", "dogs", "legendary", 2500, stats.dogVisits, 1200, "👑"),

    ach("cat_50", "Друг котів", "50 прийомів котів", "cats", "common", 50, stats.catVisits, 120, "🐱"),
    ach("cat_250", "Знавець котів", "250 прийомів котів", "cats", "uncommon", 250, stats.catVisits, 250, "🐱"),
    ach("cat_1000", "Котячий шептун", "1000 прийомів котів", "cats", "epic", 1000, stats.catVisits, 600, "🐱"),
    ach("cat_2500", "Повелитель котів", "2500 прийомів котів", "cats", "legendary", 2500, stats.catVisits, 1200, "👑"),

    ach("rev_100k", "Перші 100 000", "100 000 грн виручки", "finance", "uncommon", 100000, stats.revenue, 250, "💵"),
    ach("rev_1m", "Мільйонний оборот", "1 000 000 грн виручки", "finance", "rare", 1000000, stats.revenue, 700, "💰"),
    ach("rev_10m", "Десятимільйонний оборот", "10 000 000 грн виручки", "finance", "legendary", 10000000, stats.revenue, 2000, "💎"),

    ach("vaccine_100", "Імунний захисник", "100 вакцинацій", "vaccine", "uncommon", 100, stats.vaccineVisits, 250, "💉"),
    ach("vaccine_1000", "Майстер профілактики", "1000 вакцинацій", "vaccine", "epic", 1000, stats.vaccineVisits, 900, "🛡"),

    ach("surgery_1", "Перший скальпель", "Перша операція", "surgery", "common", 1, stats.surgeryVisits, 100, "🔪"),
    ach("surgery_100", "Хірург", "100 операцій", "surgery", "rare", 100, stats.surgeryVisits, 500, "⚕️"),
    ach("surgery_500", "Майстер скальпеля", "500 операцій", "surgery", "legendary", 500, stats.surgeryVisits, 1500, "👑"),

    ach("activity_7", "Безперервна практика", "7 змін поспіль без вихідного", "activity", "rare", 7, stats.consecutiveShifts, 400, "🔥"),
    ach("activity_15", "Надійний спеціаліст", "15 змін поспіль без вихідного", "activity", "epic", 15, stats.consecutiveShifts, 800, "⚡"),

    ach("collection_5", "Колекціонер досвіду I", "Відкрити 5 досягнень", "collection", "common", 5, 0, 200, "🏅"),
    ach("collection_10", "Колекціонер досвіду II", "Відкрити 10 досягнень", "collection", "uncommon", 10, 0, 400, "🏅"),
    ach("collection_20", "Колекціонер досвіду III", "Відкрити 20 досягнень", "collection", "epic", 20, 0, 900, "🏆"),
    ach("collection_30", "Жива легенда", "Відкрити всі 30 досягнень", "collection", "mythic", 30, 0, 2500, "👑"),
  ];

  const unlockedBeforeCollection = list.filter((a) => a.category !== "collection" && a.unlocked).length;

  return list.map((a) => {
    if (a.category !== "collection") return a;

    const current = unlockedBeforeCollection;
    const progress = Math.min(100, Math.round((current / a.target) * 100));

    return {
      ...a,
      current,
      progress,
      unlocked: current >= a.target,
    };
  });
}

function ach(id, name, description, category, rarity, target, current, xp, icon) {
  const safeCurrent = Number(current || 0);
  const safeTarget = Number(target || 1);
  const progress = Math.min(100, Math.round((safeCurrent / safeTarget) * 100));

  return {
    id,
    name,
    description,
    category,
    rarity,
    target: safeTarget,
    current: safeCurrent,
    progress,
    unlocked: safeCurrent >= safeTarget,
    xp,
    icon,
  };
}
function countVisitsBySpecies(visits, words) {
  return visits.filter((v) => {
    const txt = [
      v.species,
      v.pet_species,
      v.patient_species,
      v.pet?.species,
      v.patient?.species,
    ].filter(Boolean).join(" ").toLowerCase();

    return words.some((w) => txt.includes(w));
  }).length;
}

function countVisitsByText(visits, words) {
  return visits.filter((v) => {
    const txt = [
      v.note,
      v.rx,
      v.dx,
      v.diagnosis,
      JSON.stringify(v.services || v.services_json || []),
    ].filter(Boolean).join(" ").toLowerCase();

    return words.some((w) => txt.includes(w));
  }).length;
}
function calculateCareerLevel(xp) {
  const level = Math.max(1, Math.floor(Math.sqrt(Number(xp || 0) / 120)) + 1);
  const currentLevelXp = Math.pow(level - 1, 2) * 120;
  const nextLevelXp = Math.pow(level, 2) * 120;
  const xpInLevel = Math.max(0, Number(xp || 0) - currentLevelXp);
  const neededForNext = nextLevelXp - currentLevelXp;
  const progressPercent = Math.min(100, Math.round((xpInLevel / neededForNext) * 100));

  return {
    level,
    nextLevelXp,
    xpInLevel,
    neededForNext,
    progressPercent,
  };
}

function getCareerTitle(totalVisits) {
  if (totalVisits >= 2500) return "Легенда ветеринарії";
  if (totalVisits >= 1000) return "Експерт ветеринарії";
  if (totalVisits >= 500) return "Майстер ветеринарії";
  if (totalVisits >= 100) return "Досвідчений ветеринар";
  if (totalVisits >= 25) return "Практикант";
  if (totalVisits >= 1) return "Перший крок";
  return "Новий спеціаліст";
}

function getCareerIcon(totalVisits) {
  if (totalVisits >= 2500) return "👑";
  if (totalVisits >= 1000) return "🟣";
  if (totalVisits >= 500) return "🔵";
  if (totalVisits >= 100) return "🟢";
  if (totalVisits >= 25) return "🥉";
  if (totalVisits >= 1) return "⚪";
  return "✨";
}
function renderAchievementCard(a) {
  return `
    <div class="achievementCard ${a.unlocked ? "unlocked" : "locked"} rarity-${escapeHtml(a.rarity)}">
      <div class="achievementIcon">${a.icon}</div>

      <div class="achievementBody">
        <div class="achievementTop">
          <b>${escapeHtml(a.name)}</b>
          <span>${escapeHtml(achievementRarityLabel(a.rarity))}</span>
        </div>

        <p>${escapeHtml(a.description)}</p>

        <div class="achievementProgress">
          <div>
            <span>${a.current.toLocaleString("uk-UA")} / ${a.target.toLocaleString("uk-UA")}</span>
            <b>${a.progress}%</b>
          </div>
          <i><em style="width:${a.progress}%"></em></i>
        </div>
      </div>

      <div class="achievementXp">+${Number(a.xp || 0)} XP</div>
    </div>
  `;
}

function achievementRarityLabel(rarity) {
  const map = {
    common: "Звичайне",
    uncommon: "Незвичайне",
    rare: "Рідкісне",
    epic: "Епічне",
    legendary: "Легендарне",
    mythic: "Міфічне",
  };

  return map[rarity] || "Досягнення";
}