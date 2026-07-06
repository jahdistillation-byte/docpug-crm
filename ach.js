function buildStaffCareer(state) {
  const devUnlockAll = localStorage.getItem("DEV_UNLOCK_ALL_ACHIEVEMENTS") === "1";

  const totalVisits = devUnlockAll ? 3000 : visits.length;
const dogVisits = devUnlockAll ? 3000 : countVisitsBySpecies(visits, ["dog", "соб", "пес", "пёс"]);
const catVisits = devUnlockAll ? 3000 : countVisitsBySpecies(visits, ["cat", "кіт", "кот", "кош"]);
const vaccineVisits = devUnlockAll ? 1200 : countVisitsByText(visits, ["вакцин", "щепл", "vaccine"]);
const surgeryVisits = devUnlockAll ? 700 : countVisitsByText(visits, ["операц", "хірург", "хирург", "surgery"]);

  const achievements = getVeterinaryAchievements({
    totalVisits,
    dogVisits,
    catVisits,
    revenue,
    vaccineVisits,
    surgeryVisits,
    consecutiveShifts: devUnlockAll ? 20 : 0,
  });

  const unlockedCount = achievements.reduce((sum, a) => sum + Number(a.unlockedSteps || 0), 0);

  const xp = achievements.reduce((sum, a) => {
    return sum + Number(a.xp || 0);
  }, totalVisits * 10);

  const level = calculateCareerLevel(xp);
  const title = getCareerTitle(totalVisits);
  const levelIcon = getCareerIcon(totalVisits);

  const activeFrame = getActiveCareerFrame(achievements);

  return {
    xp,
    level: level.level,
    xpInLevel: level.xpInLevel,
    neededForNext: level.neededForNext,
    nextLevelXp: level.nextLevelXp,
    progressPercent: level.progressPercent,
    title,
    levelIcon,
    activeFrame,
    achievements,
    unlockedCount,
    clinicRank: "—",
  };
}

function getVeterinaryAchievements(stats) {
  const tracks = [
    trackAch("dogs", "🐶", "Робота з собаками", stats.dogVisits, [
  step("Базовий досвід", "50 прийомів собак", 50, "common", 80, "🐶"),
  step("Досвід роботи з собаками", "250 прийомів собак", 250, "uncommon", 160, "🐶"),
  step("Експерт з собак", "1000 прийомів собак", 1000, "epic", 350, "🐶"),
  step("Провідний спеціаліст з собак", "2500 прийомів собак", 2500, "legendary", 700, "👑"),
]),

trackAch("cats", "🐱", "Робота з котами", stats.catVisits, [
  step("Базовий досвід", "50 прийомів котів", 50, "common", 80, "🐱"),
  step("Досвід роботи з котами", "250 прийомів котів", 250, "uncommon", 160, "🐱"),
  step("Експерт з котів", "1000 прийомів котів", 1000, "epic", 350, "🐱"),
  step("Провідний спеціаліст з котів", "2500 прийомів котів", 2500, "legendary", 700, "👑"),
]),

trackAch("finance", "💰", "Фінансовий внесок", stats.revenue, [
  step("Перші 100 000 грн", "100 000 грн виручки", 100000, "uncommon", 100, "💵"),
  step("Стабільний внесок", "1 000 000 грн виручки", 1000000, "rare", 250, "💰"),
  step("Високий фінансовий результат", "10 000 000 грн виручки", 10000000, "legendary", 600, "💎"),
]),

trackAch("vaccine", "💉", "Профілактика", stats.vaccineVisits, [
  step("Профілактична практика", "100 вакцинацій", 100, "uncommon", 120, "💉"),
  step("Майстер профілактики", "1000 вакцинацій", 1000, "epic", 350, "🛡"),
]),

trackAch("surgery", "⚕️", "Хірургічний досвід", stats.surgeryVisits, [
  step("Перший хірургічний досвід", "Перша операція", 1, "common", 80, "⚕️"),
  step("Хірургічна практика", "100 операцій", 100, "rare", 250, "⚕️"),
  step("Майстер хірургії", "500 операцій", 500, "legendary", 700, "👑"),
]),

trackAch("activity", "🔥", "Професійна активність", stats.consecutiveShifts, [
  step("Стабільна присутність", "7 змін поспіль без вихідного", 7, "rare", 150, "🔥"),
  step("Надійний спеціаліст", "15 змін поспіль без вихідного", 15, "epic", 300, "⚡"),
]),
  ];

  const unlockedSteps = tracks.reduce((sum, t) => sum + t.unlockedSteps, 0);

  tracks.push(
    trackAch("collection", "🏅", "Колекція досвіду", unlockedSteps, [
      step("Колекціонер досвіду I", "Відкрити 5 етапів", 5, "common", 200, "🏅"),
      step("Колекціонер досвіду II", "Відкрити 10 етапів", 10, "uncommon", 400, "🏅"),
      step("Колекціонер досвіду III", "Відкрити 20 етапів", 20, "epic", 900, "🏆"),
      step("Жива легенда", "Відкрити всі етапи", 25, "mythic", 2500, "👑"),
    ])
  );

  return tracks;
}

function step(name, description, target, rarity, xp, icon) {
  return { name, description, target, rarity, xp, icon };
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

  const reward = getAchievementReward(id, currentStep, unlockedSteps);

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
    reward,
  };
}

function getAchievementReward(trackId, currentStep, unlockedSteps) {
  if (!unlockedSteps) {
    return {
      icon: "🔒",
      label: "Нагорода попереду",
      title: "Відкриється після першого етапу",
      frame: null,
      badge: null,
    };
  }

  const rarity = currentStep?.rarity || "common";
  const title = currentStep?.name || "Досягнення";

  if (trackId === "career") {
  return {
    icon: "🏆",
    label: "Професійний титул",
    title,
    frame: rarity,
    badge: "career",
  };
}

  if (trackId === "dogs") {
    return {
      icon: "🐶",
      label: "Значок собак",
      title,
      frame: rarity === "legendary" ? "legendary" : null,
      badge: "dogs",
    };
  }

  if (trackId === "cats") {
    return {
      icon: "🐱",
      label: "Значок котів",
      title,
      frame: rarity === "legendary" ? "legendary" : null,
      badge: "cats",
    };
  }

if (trackId === "finance") {
  return {
    icon: "💰",
    label: "Фінансова відзнака",
    title,
    frame: rarity === "legendary" ? "gold" : rarity,
    badge: "finance",
  };
}

  if (trackId === "vaccine") {
    return {
      icon: "🛡",
      label: "Значок профілактики",
      title,
      frame: null,
      badge: "vaccine",
    };
  }

  if (trackId === "surgery") {
    return {
      icon: "⚕️",
      label: "Хірургічна відзнака",
      title,
      frame: rarity === "legendary" ? "mythic" : null,
      badge: "surgery",
    };
  }

  if (trackId === "activity") {
    return {
      icon: "🔥",
      label: "Відзнака активності",
      title,
      frame: null,
      badge: "activity",
    };
  }

  if (trackId === "collection") {
    return {
      icon: "🏅",
      label: "Колекційна рамка",
      title,
      frame: rarity,
      badge: "collection",
    };
  }

  return {
    icon: "🏆",
    label: "Нагорода",
    title,
    frame: null,
    badge: "achievement",
  };
}

function getActiveCareerFrame(achievements) {
  const priority = {
    mythic: 6,
    legendary: 5,
    gold: 5,
    epic: 4,
    rare: 3,
    uncommon: 2,
    common: 1,
  };

  let best = null;

  achievements.forEach((a) => {
    const frame = a.reward?.frame;
    if (!frame) return;

    if (!best || (priority[frame] || 0) > (priority[best] || 0)) {
      best = frame;
    }
  });

  return best;
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
    uncommon: "Незвичайне",
    rare: "Рідкісне",
    epic: "Епічне",
    legendary: "Легендарне",
    mythic: "Міфічне",
  };

  return map[rarity] || "Досягнення";
}
function getUnlockedCareerTitles(career) {
  const titles = [
    {
      id: "none",
      label: "Без титулу",
      rarity: "common",
      icon: "—",
    }
  ];

  const careerTrack = career.achievements.find((a) => a.id === "career");

  if (!careerTrack) {
    titles.push({
      id: career.title || "Новий спеціаліст",
      label: career.title || "Новий спеціаліст",
      rarity: "common",
      icon: career.levelIcon || "✨",
    });

    return titles;
  }

  careerTrack.steps
    .filter((s) => careerTrack.rawCurrent >= s.target)
    .forEach((s) => {
      titles.push({
        id: s.name,
        label: s.name,
        rarity: s.rarity,
        icon: s.icon,
      });
    });

  if (titles.length === 1) {
    titles.push({
      id: career.title || "Новий спеціаліст",
      label: career.title || "Новий спеціаліст",
      rarity: "common",
      icon: career.levelIcon || "✨",
    });
  }

  return titles;
}

function getUnlockedCareerFrames(career) {
  const frames = [
    {
      id: "none",
      label: "Без рамки",
      rarity: "common",
      icon: "⬜",
    }
  ];

  career.achievements.forEach((a) => {
    const frame = a.reward?.frame;
    if (!frame) return;

    frames.push({
      id: frame,
      label: a.reward?.title || a.groupName,
      rarity: frame === "gold" ? "legendary" : frame,
      icon: a.reward?.icon || "🏆",
    });
  });

  const unique = new Map();
  frames.forEach((f) => unique.set(f.id, f));

  return Array.from(unique.values());
}

function getStaffCareerPrefs(staffId) {
  try {
    return JSON.parse(localStorage.getItem(`staff_career_prefs_${staffId}`) || "{}");
  } catch {
    return {};
  }
}

function saveStaffCareerPrefs(staffId, prefs) {
  const current = getStaffCareerPrefs(staffId);
  localStorage.setItem(`staff_career_prefs_${staffId}`, JSON.stringify({
    ...current,
    ...prefs,
  }));
}