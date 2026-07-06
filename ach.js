// ==========================================================================
// Doc.PUG CRM — Achievements / Career System
// Чистая версия: титулы, рамки, награды, dev unlock
// ==========================================================================

function buildStaffCareer(state) {
  const dashboard = state.dashboard || {};
  const visits = dashboard.live_staff_visits || [];
  const baseRevenue = Number(state.revenue || dashboard.revenue || 0);

  const devUnlockAll = localStorage.getItem("DEV_UNLOCK_ALL_ACHIEVEMENTS") === "1";

  const stats = {
    totalVisits: devUnlockAll ? 3000 : visits.length,
    dogVisits: devUnlockAll ? 3000 : countVisitsBySpecies(visits, ["dog", "соб", "пес", "пёс"]),
    catVisits: devUnlockAll ? 3000 : countVisitsBySpecies(visits, ["cat", "кіт", "кот", "кош"]),
    revenue: devUnlockAll ? 100000000 : baseRevenue,
    vaccineVisits: devUnlockAll ? 1200 : countVisitsByText(visits, ["вакцин", "щепл", "vaccine"]),
    surgeryVisits: devUnlockAll ? 700 : countVisitsByText(visits, ["операц", "хірург", "хирург", "surgery"]),
    consecutiveShifts: devUnlockAll ? 20 : 0,
  };

  const achievements = getVeterinaryAchievements(stats);

  const unlockedCount = achievements.reduce((sum, a) => {
    return sum + Number(a.unlockedSteps || 0);
  }, 0);

  const xpFromVisits = stats.totalVisits * 10;
  const xpFromAchievements = achievements.reduce((sum, a) => {
    return sum + Number(a.xp || 0);
  }, 0);

  const xp = xpFromVisits + xpFromAchievements;
  const level = calculateCareerLevel(xp);

  const careerProfile = buildCareerProfile({
    staffId: state.doc?.id || "unknown",
    achievements,
    totalVisits: stats.totalVisits,
  });

  return {
    xp,
    level: level.level,
    xpInLevel: level.xpInLevel,
    neededForNext: level.neededForNext,
    nextLevelXp: level.nextLevelXp,
    progressPercent: level.progressPercent,

    title: careerProfile.selectedTitle?.label || "Новий спеціаліст",
    levelIcon: careerProfile.selectedTitle?.icon || "✨",
    activeFrame: careerProfile.selectedFrame?.id === "none" ? "" : careerProfile.selectedFrame?.id || "",

    achievements,
    unlockedCount,
    clinicRank: "—",

    availableTitles: careerProfile.availableTitles,
    availableFrames: careerProfile.availableFrames,
    selectedTitle: careerProfile.selectedTitle,
    selectedFrame: careerProfile.selectedFrame,
  };
}

function getVeterinaryAchievements(stats) {
  const tracks = [
    trackAch("career", "📖", "Шлях ветеринара", stats.totalVisits, [
      step("Перший крок", "Провести перший прийом", 1, "common", 50, "⚪", { title: true, frame: "common" }),
      step("Практикант", "25 прийомів", 25, "common", 100, "🥉", { title: true, frame: "bronze" }),
      step("Досвідчений ветеринар", "100 прийомів", 100, "uncommon", 200, "🟢", { title: true, frame: "uncommon" }),
      step("Майстер ветеринарії", "500 прийомів", 500, "rare", 400, "🔵", { title: true, frame: "rare" }),
      step("Експерт ветеринарії", "1000 прийомів", 1000, "epic", 800, "🟣", { title: true, frame: "epic" }),
      step("Легенда ветеринарії", "2500 прийомів", 2500, "legendary", 1500, "👑", { title: true, frame: "legendary" }),
    ]),

    trackAch("dogs", "🐶", "Робота з собаками", stats.dogVisits, [
      step("Базовий досвід із собаками", "50 прийомів собак", 50, "common", 80, "🐶", { title: true }),
      step("Досвід роботи з собаками", "250 прийомів собак", 250, "uncommon", 160, "🐶", { title: true }),
      step("Експерт з собак", "1000 прийомів собак", 1000, "epic", 350, "🐶", { title: true }),
      step("Провідний спеціаліст з собак", "2500 прийомів собак", 2500, "legendary", 700, "🐶", { title: true, frame: "dogs" }),
    ]),

    trackAch("cats", "🐱", "Робота з котами", stats.catVisits, [
      step("Базовий досвід із котами", "50 прийомів котів", 50, "common", 80, "🐱", { title: true }),
      step("Досвід роботи з котами", "250 прийомів котів", 250, "uncommon", 160, "🐱", { title: true }),
      step("Експерт з котів", "1000 прийомів котів", 1000, "epic", 350, "🐱", { title: true }),
      step("Провідний спеціаліст з котів", "2500 прийомів котів", 2500, "legendary", 700, "👑", { title: true, frame: "legendary" }),
    ]),

    trackAch("finance", "💰", "Фінансовий внесок", stats.revenue, [
      step("Перші 100 000 грн", "100 000 грн виручки", 100000, "uncommon", 100, "💵", { badge: true }),
      step("Стабільний внесок", "1 000 000 грн виручки", 1000000, "rare", 250, "💰", { badge: true }),
      step("Високий фінансовий результат", "10 000 000 грн виручки", 10000000, "legendary", 600, "💎", { badge: true, frame: "gold" }),
    ]),

    trackAch("vaccine", "💉", "Профілактика", stats.vaccineVisits, [
      step("Профілактична практика", "100 вакцинацій", 100, "uncommon", 120, "💉", { badge: true }),
      step("Майстер профілактики", "1000 вакцинацій", 1000, "epic", 350, "🛡", { title: true }),
    ]),

    trackAch("surgery", "⚕️", "Хірургічний досвід", stats.surgeryVisits, [
      step("Перший хірургічний досвід", "Перша операція", 1, "common", 80, "⚕️", { badge: true }),
      step("Хірургічна практика", "100 операцій", 100, "rare", 250, "⚕️", { title: true }),
      step("Майстер хірургії", "500 операцій", 500, "legendary", 700, "👑", { title: true, frame: "mythic" }),
    ]),

    trackAch("activity", "🔥", "Професійна активність", stats.consecutiveShifts, [
      step("Стабільна присутність", "7 змін поспіль без вихідного", 7, "rare", 150, "🔥", { badge: true }),
      step("Надійний спеціаліст", "15 змін поспіль без вихідного", 15, "epic", 300, "⚡", { title: true }),
    ]),
  ];

  const unlockedSteps = tracks.reduce((sum, t) => sum + t.unlockedSteps, 0);

  tracks.push(
    trackAch("collection", "🏅", "Колекція досвіду", unlockedSteps, [
      step("Колекціонер досвіду I", "Відкрити 5 етапів", 5, "common", 200, "🏅", { badge: true }),
      step("Колекціонер досвіду II", "Відкрити 10 етапів", 10, "uncommon", 400, "🏅", { badge: true }),
      step("Колекціонер досвіду III", "Відкрити 20 етапів", 20, "epic", 900, "🏆", { frame: "epic" }),
      step("Жива легенда", "Відкрити всі етапи", 25, "mythic", 2500, "👑", { title: true, frame: "mythic" }),
    ])
  );

  return tracks;
}

function step(name, description, target, rarity, xp, icon, reward = {}) {
  return { name, description, target, rarity, xp, icon, reward };
}

function trackAch(id, icon, groupName, current, steps) {
  const safeCurrent = Number(current || 0);

  const unlockedSteps = steps.filter((s) => safeCurrent >= s.target).length;
  const currentStep = [...steps].reverse().find((s) => safeCurrent >= s.target) || steps[0];
  const nextStep = steps.find((s) => safeCurrent < s.target) || null;

  const activeStep = nextStep || currentStep;
  const target = activeStep.target;
  const visibleCurrent = Math.min(safeCurrent, target);
  const progress = Math.min(100, Math.round((visibleCurrent / target) * 100));
  const unlocked = !nextStep;

  const earnedXp = steps.reduce((sum, s) => {
    return sum + (safeCurrent >= s.target ? Number(s.xp || 0) : 0);
  }, 0);

  return {
    id,
    icon,
    groupName,
    name: activeStep.name,
    description: activeStep.description,
    rarity: activeStep.rarity,
    target,
    current: visibleCurrent,
    rawCurrent: safeCurrent,
    progress,
    unlocked,
    xp: earnedXp,
    nextStep,
    currentStep,
    unlockedSteps,
    totalSteps: steps.length,
    steps,
    reward: getAchievementReward(id, currentStep, unlockedSteps),
  };
}

function getAchievementReward(trackId, currentStep, unlockedSteps) {
  if (!unlockedSteps) {
    return {
      icon: "🔒",
      label: "Нагорода попереду",
      title: "Відкриється після першого етапу",
      frame: null,
      titleReward: null,
      badge: null,
    };
  }

  const title = currentStep?.name || "Досягнення";
  const reward = currentStep?.reward || {};

  return {
    icon: currentStep?.icon || "🏆",
    label: getRewardLabel(trackId, reward),
    title,
    frame: reward.frame || null,
    titleReward: reward.title ? title : null,
    badge: reward.badge ? trackId : null,
  };
}

function getRewardLabel(trackId, reward) {
  if (reward.title && reward.frame) return "Титул і рамка";
  if (reward.title) return "Професійний титул";
  if (reward.frame) return "Рамка профілю";

  const map = {
    dogs: "Профільна відзнака",
    cats: "Профільна відзнака",
    finance: "Відзнака внеску",
    vaccine: "Відзнака профілактики",
    surgery: "Хірургічна відзнака",
    activity: "Відзнака активності",
    collection: "Колекційна відзнака",
  };

  return map[trackId] || "Нагорода";
}

// ==========================================================================
// Career Profile — єдине джерело титулів/рамок
// ==========================================================================

function buildCareerProfile({ staffId, achievements, totalVisits }) {
  const prefs = getStaffCareerPrefs(staffId);

  const availableTitles = getUnlockedCareerTitlesFromAchievements(achievements, totalVisits);
  const availableFrames = getUnlockedCareerFramesFromAchievements(achievements);

  const selectedTitle =
    availableTitles.find((x) => x.id === prefs.titleId) ||
    availableTitles.find((x) => x.id !== "none") ||
    availableTitles[0];

  const selectedFrame =
    availableFrames.find((x) => x.id === prefs.frameId) ||
    availableFrames.find((x) => x.id !== "none") ||
    availableFrames[0];

  return {
    availableTitles,
    availableFrames,
    selectedTitle,
    selectedFrame,
  };
}

function getUnlockedCareerTitlesFromAchievements(achievements, totalVisits = 0) {
  const titles = [
    {
      id: "none",
      label: "Без титулу",
      rarity: "common",
      icon: "—",
    },
  ];

  achievements.forEach((track) => {
    track.steps.forEach((s) => {
      if (track.rawCurrent < s.target) return;
      if (!s.reward?.title) return;

      titles.push({
        id: `${track.id}:${s.name}`,
        label: s.name,
        rarity: s.rarity,
        icon: s.icon,
      });
    });
  });

  if (titles.length === 1 && totalVisits >= 1) {
    titles.push({
      id: "career:Перший крок",
      label: "Перший крок",
      rarity: "common",
      icon: "⚪",
    });
  }

  return uniqueById(titles);
}

function getUnlockedCareerFramesFromAchievements(achievements) {
  const frames = [
    {
      id: "none",
      label: "Без рамки",
      rarity: "common",
      icon: "⬜",
    },
  ];

  achievements.forEach((track) => {
    track.steps.forEach((s) => {
      if (track.rawCurrent < s.target) return;
      if (!s.reward?.frame) return;

      frames.push({
        id: s.reward.frame,
        label: s.name,
        rarity: s.reward.frame === "gold" ? "legendary" : s.rarity,
        icon: s.icon,
      });
    });
  });

  return uniqueById(frames);
}

function uniqueById(arr) {
  const map = new Map();
  arr.forEach((x) => map.set(x.id, x));
  return Array.from(map.values());
}

// Старые названия оставляем для app.js, чтобы ничего не сломалось
function getUnlockedCareerTitles(career) {
  return career.availableTitles || getUnlockedCareerTitlesFromAchievements(career.achievements || [], 0);
}

function getUnlockedCareerFrames(career) {
  return career.availableFrames || getUnlockedCareerFramesFromAchievements(career.achievements || []);
}

// ==========================================================================
// LocalStorage prefs
// ==========================================================================

function getStaffCareerPrefs(staffId) {
  try {
    return JSON.parse(localStorage.getItem(`staff_career_prefs_${staffId}`) || "{}");
  } catch {
    return {};
  }
}

function saveStaffCareerPrefs(staffId, prefs) {
  const current = getStaffCareerPrefs(staffId);
  localStorage.setItem(
    `staff_career_prefs_${staffId}`,
    JSON.stringify({
      ...current,
      ...prefs,
    })
  );
}

// ==========================================================================
// Render
// ==========================================================================

function renderAchievementCard(a) {
  const isComplete = a.unlocked;
  const statusText = isComplete ? "Гілку завершено" : "Наступна ціль";

  return `
    <div class="achievementCard ${isComplete ? "unlocked" : "locked"} rarity-${escapeHtml(a.rarity)}">
      <div class="achievementIcon">${a.icon}</div>

      <div class="achievementBody">
        <div class="achievementTop">
          <b>${escapeHtml(a.groupName)}</b>
          <span>${escapeHtml(achievementRarityLabel(a.rarity))}</span>
        </div>

        <div class="achievementStage">${escapeHtml(a.name)}</div>

        <p>${escapeHtml(a.description)}</p>

        <div class="achievementProgress">
          <div>
            <span>${statusText}: ${Number(a.current || 0).toLocaleString("uk-UA")} / ${Number(a.target || 0).toLocaleString("uk-UA")}</span>
            <b>${a.progress}%</b>
          </div>
          <i><em style="width:${a.progress}%"></em></i>
        </div>

        <div class="achievementReward ${a.unlockedSteps ? "unlocked" : ""}">
          <span>${a.reward?.icon || "🏆"}</span>
          <div>
            <b>${escapeHtml(a.reward?.label || "Нагорода")}</b>
            <small>${escapeHtml(a.reward?.title || "Відкриється пізніше")}</small>
          </div>
        </div>
      </div>

      <div class="achievementXp">+${Number(a.xp || 0).toLocaleString("uk-UA")} XP</div>
    </div>
  `;
}

function achievementRarityLabel(rarity) {
  const map = {
    common: "Звичайне",
    bronze: "Бронзове",
    uncommon: "Незвичайне",
    rare: "Рідкісне",
    epic: "Епічне",
    legendary: "Легендарне",
    mythic: "Міфічне",
    gold: "Золоте",
  };

  return map[rarity] || "Досягнення";
}

// ==========================================================================
// Helpers
// ==========================================================================

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
  const safeXp = Number(xp || 0);
  const level = Math.max(1, Math.floor(Math.sqrt(safeXp / 120)) + 1);
  const currentLevelXp = Math.pow(level - 1, 2) * 120;
  const nextLevelXp = Math.pow(level, 2) * 120;
  const xpInLevel = Math.max(0, safeXp - currentLevelXp);
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