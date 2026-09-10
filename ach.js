const ACHIEVEMENT_TRANSLATIONS = {
  "Робота з собаками": {
    en: "Working with dogs",
    de: "Arbeit mit Hunden",
    pl: "Praca z psami",
  },

  "Базовий досвід": {
    en: "Basic experience",
    de: "Grunderfahrung",
    pl: "Podstawowe doświadczenie",
  },

  "50 прийомів собак": {
    en: "50 dog visits",
    de: "50 Hundetermine",
    pl: "50 wizyt z psami",
  },

  "Досвід роботи з собаками": {
    en: "Dog care experience",
    de: "Erfahrung mit Hunden",
    pl: "Doświadczenie w pracy z psami",
  },

  "250 прийомів собак": {
    en: "250 dog visits",
    de: "250 Hundetermine",
    pl: "250 wizyt z psami",
  },

  "Експерт з собак": {
    en: "Dog expert",
    de: "Hundeexperte",
    pl: "Ekspert od psów",
  },

  "1000 прийомів собак": {
    en: "1,000 dog visits",
    de: "1.000 Hundetermine",
    pl: "1 000 wizyt z psami",
  },

  "Провідний спеціаліст з собак": {
    en: "Leading dog specialist",
    de: "Führender Hundespezialist",
    pl: "Wiodący specjalista od psów",
  },

  "2500 прийомів собак": {
    en: "2,500 dog visits",
    de: "2.500 Hundetermine",
    pl: "2 500 wizyt z psami",
  },

  "Робота з котами": {
    en: "Working with cats",
    de: "Arbeit mit Katzen",
    pl: "Praca z kotami",
  },

  "50 прийомів котів": {
    en: "50 cat visits",
    de: "50 Katzentermine",
    pl: "50 wizyt z kotami",
  },

  "Досвід роботи з котами": {
    en: "Cat care experience",
    de: "Erfahrung mit Katzen",
    pl: "Doświadczenie w pracy z kotami",
  },

  "250 прийомів котів": {
    en: "250 cat visits",
    de: "250 Katzentermine",
    pl: "250 wizyt z kotami",
  },

  "Експерт з котів": {
    en: "Cat expert",
    de: "Katzenexperte",
    pl: "Ekspert od kotów",
  },

  "1000 прийомів котів": {
    en: "1,000 cat visits",
    de: "1.000 Katzentermine",
    pl: "1 000 wizyt z kotami",
  },

  "Провідний спеціаліст з котів": {
    en: "Leading cat specialist",
    de: "Führender Katzenspezialist",
    pl: "Wiodący specjalista od kotów",
  },

  "2500 прийомів котів": {
    en: "2,500 cat visits",
    de: "2.500 Katzentermine",
    pl: "2 500 wizyt z kotami",
  },

  "Фінансовий внесок": {
    en: "Financial contribution",
    de: "Finanzieller Beitrag",
    pl: "Wkład finansowy",
  },

  "Перші 100 000 грн": {
    en: "First UAH 100,000",
    de: "Die ersten 100.000 UAH",
    pl: "Pierwsze 100 000 UAH",
  },

  "100 000 грн виручки": {
    en: "UAH 100,000 in revenue",
    de: "100.000 UAH Umsatz",
    pl: "100 000 UAH przychodu",
  },

  "Стабільний внесок": {
    en: "Consistent contribution",
    de: "Stabiler Beitrag",
    pl: "Stabilny wkład",
  },

  "1 000 000 грн виручки": {
    en: "UAH 1,000,000 in revenue",
    de: "1.000.000 UAH Umsatz",
    pl: "1 000 000 UAH przychodu",
  },

  "Високий фінансовий результат": {
    en: "Outstanding financial result",
    de: "Hervorragendes Finanzergebnis",
    pl: "Wysoki wynik finansowy",
  },

  "10 000 000 грн виручки": {
    en: "UAH 10,000,000 in revenue",
    de: "10.000.000 UAH Umsatz",
    pl: "10 000 000 UAH przychodu",
  },
};


function getAchievementLanguage() {
  const language =
    typeof getInterfaceLanguage ===
    "function"
      ? getInterfaceLanguage()
      : "uk";

  return [
    "uk",
    "en",
    "de",
    "pl",
  ].includes(language)
    ? language
    : "uk";
}


function translateAchievementText(
  value
) {
  const source =
    String(value || "");

  const language =
    getAchievementLanguage();

  const entry =
    Object.entries(
      ACHIEVEMENT_TRANSLATIONS
    ).find(
      ([
        ukrainian,
        translations,
      ]) =>
        ukrainian === source ||
        Object.values(
          translations
        ).includes(source)
    );

  if (!entry) {
    return source;
  }

  const [
    ukrainian,
    translations,
  ] = entry;

  return language === "uk"
    ? ukrainian
    : (
        translations[language] ||
        ukrainian
      );
}
Object.assign(
  ACHIEVEMENT_TRANSLATIONS,
  {
    "Профілактика": {
      en: "Preventive care",
      de: "Vorsorge",
      pl: "Profilaktyka",
    },

    "Профілактична практика": {
      en: "Preventive care practice",
      de: "Vorsorgepraxis",
      pl: "Praktyka profilaktyczna",
    },

    "100 вакцинацій": {
      en: "100 vaccinations",
      de: "100 Impfungen",
      pl: "100 szczepień",
    },

    "Майстер профілактики": {
      en: "Preventive care master",
      de: "Meister der Vorsorge",
      pl: "Mistrz profilaktyki",
    },

    "1000 вакцинацій": {
      en: "1,000 vaccinations",
      de: "1.000 Impfungen",
      pl: "1 000 szczepień",
    },

    "Хірургічний досвід": {
      en: "Surgical experience",
      de: "Chirurgische Erfahrung",
      pl: "Doświadczenie chirurgiczne",
    },

    "Перший хірургічний досвід": {
      en: "First surgical experience",
      de: "Erste chirurgische Erfahrung",
      pl: "Pierwsze doświadczenie chirurgiczne",
    },

    "Перша операція": {
      en: "First surgery",
      de: "Erste Operation",
      pl: "Pierwsza operacja",
    },

    "Хірургічна практика": {
      en: "Surgical practice",
      de: "Chirurgische Praxis",
      pl: "Praktyka chirurgiczna",
    },

    "100 операцій": {
      en: "100 surgeries",
      de: "100 Operationen",
      pl: "100 operacji",
    },

    "Майстер хірургії": {
      en: "Master of surgery",
      de: "Meister der Chirurgie",
      pl: "Mistrz chirurgii",
    },

    "500 операцій": {
      en: "500 surgeries",
      de: "500 Operationen",
      pl: "500 operacji",
    },

    "Професійна активність": {
      en: "Professional activity",
      de: "Berufliche Aktivität",
      pl: "Aktywność zawodowa",
    },

    "Стабільна присутність": {
      en: "Consistent attendance",
      de: "Beständige Anwesenheit",
      pl: "Regularna obecność",
    },

    "7 змін поспіль без вихідного": {
      en: "7 consecutive shifts without a day off",
      de: "7 Schichten in Folge ohne freien Tag",
      pl: "7 zmian z rzędu bez dnia wolnego",
    },

    "Надійний спеціаліст": {
      en: "Reliable specialist",
      de: "Zuverlässiger Spezialist",
      pl: "Niezawodny specjalista",
    },

    "15 змін поспіль без вихідного": {
      en: "15 consecutive shifts without a day off",
      de: "15 Schichten in Folge ohne freien Tag",
      pl: "15 zmian z rzędu bez dnia wolnego",
    },

    "Колекція досвіду": {
      en: "Experience collection",
      de: "Erfahrungssammlung",
      pl: "Kolekcja doświadczenia",
    },

    "Колекціонер досвіду I": {
      en: "Experience collector I",
      de: "Erfahrungssammler I",
      pl: "Kolekcjoner doświadczenia I",
    },

    "Відкрити 5 етапів": {
      en: "Unlock 5 stages",
      de: "5 Stufen freischalten",
      pl: "Odblokuj 5 etapów",
    },

    "Колекціонер досвіду II": {
      en: "Experience collector II",
      de: "Erfahrungssammler II",
      pl: "Kolekcjoner doświadczenia II",
    },

    "Відкрити 10 етапів": {
      en: "Unlock 10 stages",
      de: "10 Stufen freischalten",
      pl: "Odblokuj 10 etapów",
    },

    "Колекціонер досвіду III": {
      en: "Experience collector III",
      de: "Erfahrungssammler III",
      pl: "Kolekcjoner doświadczenia III",
    },

    "Відкрити 20 етапів": {
      en: "Unlock 20 stages",
      de: "20 Stufen freischalten",
      pl: "Odblokuj 20 etapów",
    },

    "Жива легенда": {
      en: "Living legend",
      de: "Lebende Legende",
      pl: "Żywa legenda",
    },

    "Відкрити всі етапи": {
      en: "Unlock all stages",
      de: "Alle Stufen freischalten",
      pl: "Odblokuj wszystkie etapy",
    },

    "Нагорода попереду": {
      en: "Reward ahead",
      de: "Belohnung voraus",
      pl: "Nagroda przed Tobą",
    },

    "Відкриється після першого етапу": {
      en: "Unlocks after the first stage",
      de: "Wird nach der ersten Stufe freigeschaltet",
      pl: "Odblokuje się po pierwszym etapie",
    },

    "Досягнення": {
      en: "Achievement",
      de: "Erfolg",
      pl: "Osiągnięcie",
    },

    "Професійний титул": {
      en: "Professional title",
      de: "Berufstitel",
      pl: "Tytuł zawodowy",
    },

    "Значок собак": {
      en: "Dog badge",
      de: "Hundeabzeichen",
      pl: "Odznaka psów",
    },

    "Значок котів": {
      en: "Cat badge",
      de: "Katzenabzeichen",
      pl: "Odznaka kotów",
    },

    "Фінансова відзнака": {
      en: "Financial award",
      de: "Finanzauszeichnung",
      pl: "Odznaka finansowa",
    },

    "Значок профілактики": {
      en: "Preventive care badge",
      de: "Vorsorgeabzeichen",
      pl: "Odznaka profilaktyki",
    },

    "Хірургічна відзнака": {
      en: "Surgical award",
      de: "Chirurgische Auszeichnung",
      pl: "Odznaka chirurgiczna",
    },

    "Відзнака активності": {
      en: "Activity award",
      de: "Aktivitätsauszeichnung",
      pl: "Odznaka aktywności",
    },

    "Колекційна рамка": {
      en: "Collection frame",
      de: "Sammlerrahmen",
      pl: "Ramka kolekcjonerska",
    },

    "Нагорода": {
      en: "Reward",
      de: "Belohnung",
      pl: "Nagroda",
    },

    "Легенда ветеринарії": {
      en: "Veterinary legend",
      de: "Legende der Tiermedizin",
      pl: "Legenda weterynarii",
    },

    "Експерт ветеринарії": {
      en: "Veterinary expert",
      de: "Experte der Tiermedizin",
      pl: "Ekspert weterynarii",
    },

    "Майстер ветеринарії": {
      en: "Master of veterinary medicine",
      de: "Meister der Tiermedizin",
      pl: "Mistrz weterynarii",
    },

    "Досвідчений ветеринар": {
      en: "Experienced veterinarian",
      de: "Erfahrener Tierarzt",
      pl: "Doświadczony weterynarz",
    },

    "Практикант": {
      en: "Trainee",
      de: "Praktikant",
      pl: "Praktykant",
    },

    "Перший крок": {
      en: "First step",
      de: "Erster Schritt",
      pl: "Pierwszy krok",
    },

    "Новий спеціаліст": {
      en: "New specialist",
      de: "Neuer Spezialist",
      pl: "Nowy specjalista",
    },

    "Гілку завершено": {
      en: "Track completed",
      de: "Pfad abgeschlossen",
      pl: "Ścieżka ukończona",
    },

    "Наступна ціль": {
      en: "Next goal",
      de: "Nächstes Ziel",
      pl: "Następny cel",
    },

    "Відкриється пізніше": {
      en: "Unlocks later",
      de: "Wird später freigeschaltet",
      pl: "Odblokuje się później",
    },

    "Звичайне": {
      en: "Common",
      de: "Gewöhnlich",
      pl: "Zwykłe",
    },

    "Незвичайне": {
      en: "Uncommon",
      de: "Ungewöhnlich",
      pl: "Niezwykłe",
    },

    "Рідкісне": {
      en: "Rare",
      de: "Selten",
      pl: "Rzadkie",
    },

    "Епічне": {
      en: "Epic",
      de: "Episch",
      pl: "Epickie",
    },

    "Легендарне": {
      en: "Legendary",
      de: "Legendär",
      pl: "Legendarne",
    },

    "Міфічне": {
      en: "Mythic",
      de: "Mythisch",
      pl: "Mityczne",
    },

    "Без титулу": {
      en: "No title",
      de: "Kein Titel",
      pl: "Bez tytułu",
    },

    "Без рамки": {
      en: "No frame",
      de: "Kein Rahmen",
      pl: "Bez ramki",
    },
  }
);
function buildStaffCareer(state) {
  const visits = state.dashboard.live_staff_visits || [];
  const revenue = Number(state.revenue || state.dashboard.revenue || 0);

  const totalVisits = visits.length;
  const dogVisits = countVisitsBySpecies(visits, ["dog", "соб", "пес", "пёс"]);
  const catVisits = countVisitsBySpecies(visits, ["cat", "кіт", "кот", "кош"]);
  const vaccineVisits = countVisitsByText(visits, ["вакцин", "щепл", "vaccine"]);
  const surgeryVisits = countVisitsByText(visits, ["операц", "хірург", "хирург", "surgery"]);

  const achievements = getVeterinaryAchievements({
    totalVisits,
    dogVisits,
    catVisits,
    revenue,
    vaccineVisits,
    surgeryVisits,
    consecutiveShifts: 0,
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

function getAchievementLocale() {
  const language =
    getAchievementLanguage();

  if (language === "en") {
    return "en-GB";
  }

  if (language === "de") {
    return "de-DE";
  }

  if (language === "pl") {
    return "pl-PL";
  }

  return "uk-UA";
}


function renderAchievementCard(a) {
  const isComplete =
    a.unlocked;

  const statusText =
    translateAchievementText(
      isComplete
        ? "Гілку завершено"
        : "Наступна ціль"
    );

  return `
    <div
      class="
        achievementCard
        ${
          isComplete
            ? "unlocked"
            : "locked"
        }
        rarity-${escapeHtml(
          a.rarity
        )}
      "
    >
      <div class="achievementIcon">
        ${a.icon}
      </div>

      <div class="achievementBody">
        <div class="achievementTop">
          <b>
            ${escapeHtml(
              translateAchievementText(
                a.groupName
              )
            )}
          </b>

          <span>
            ${escapeHtml(
              achievementRarityLabel(
                a.rarity
              )
            )}
          </span>
        </div>

        <div class="achievementStage">
          ${escapeHtml(
            translateAchievementText(
              a.name
            )
          )}
        </div>

        <p>
          ${escapeHtml(
            translateAchievementText(
              a.description
            )
          )}
        </p>

        <div class="achievementProgress">
          <div>
            <span>
              ${statusText}:
              ${Number(
                a.current || 0
              ).toLocaleString(
                getAchievementLocale()
              )}
              /
              ${Number(
                a.target || 0
              ).toLocaleString(
                getAchievementLocale()
              )}
            </span>

            <b>
              ${a.progress}%
            </b>
          </div>

          <i>
            <em
              style="
                width:${a.progress}%;
              "
            ></em>
          </i>
        </div>

        <div
          class="
            achievementReward
            ${
              a.unlockedSteps
                ? "unlocked"
                : ""
            }
          "
        >
          <span>
            ${
              a.reward?.icon ||
              "🏆"
            }
          </span>

          <div>
            <b>
              ${escapeHtml(
                translateAchievementText(
                  a.reward?.label ||
                  "Нагорода"
                )
              )}
            </b>

            <small>
              ${escapeHtml(
                translateAchievementText(
                  a.reward?.title ||
                  "Відкриється пізніше"
                )
              )}
            </small>
          </div>
        </div>
      </div>

      <div class="achievementXp">
        +${Number(
          a.xp || 0
        ).toLocaleString(
          getAchievementLocale()
        )}
        XP
      </div>
    </div>
  `;
}


function achievementRarityLabel(
  rarity
) {
  const map = {
    common: "Звичайне",
    uncommon: "Незвичайне",
    rare: "Рідкісне",
    epic: "Епічне",
    legendary: "Легендарне",
    mythic: "Міфічне",
  };

  return translateAchievementText(
    map[rarity] ||
    "Досягнення"
  );
}


function getUnlockedCareerTitles(
  career
) {
  const titles = [
    {
      id: "none",

      label:
        translateAchievementText(
          "Без титулу"
        ),

      rarity: "common",
      icon: "—",
    },
  ];

  const careerTrack =
    career.achievements.find(
      (achievement) =>
        achievement.id ===
        "career"
    );

  const defaultTitle =
    career.title ||
    "Новий спеціаліст";

  if (!careerTrack) {
    titles.push({
      id: defaultTitle,

      label:
        translateAchievementText(
          defaultTitle
        ),

      rarity: "common",

      icon:
        career.levelIcon ||
        "✨",
    });

    return titles;
  }

  careerTrack.steps
    .filter(
      (stepItem) =>
        careerTrack.rawCurrent >=
        stepItem.target
    )
    .forEach(
      (stepItem) => {
        titles.push({
          id: stepItem.name,

          label:
            translateAchievementText(
              stepItem.name
            ),

          rarity:
            stepItem.rarity,

          icon:
            stepItem.icon,
        });
      }
    );

  if (titles.length === 1) {
    titles.push({
      id: defaultTitle,

      label:
        translateAchievementText(
          defaultTitle
        ),

      rarity: "common",

      icon:
        career.levelIcon ||
        "✨",
    });
  }

  return titles;
}


function getUnlockedCareerFrames(
  career
) {
  const frames = [
    {
      id: "none",

      label:
        translateAchievementText(
          "Без рамки"
        ),

      rarity: "common",
      icon: "⬜",
    },
  ];

  career.achievements.forEach(
    (achievement) => {
      const frame =
        achievement.reward?.frame;

      if (!frame) return;

      const frameLabel =
        achievement.reward?.title ||
        achievement.groupName;

      frames.push({
        id: frame,

        label:
          translateAchievementText(
            frameLabel
          ),

        rarity:
          frame === "gold"
            ? "legendary"
            : frame,

        icon:
          achievement.reward?.icon ||
          "🏆",
      });
    }
  );

  const uniqueFrames =
    new Map();

  frames.forEach(
    (frame) => {
      uniqueFrames.set(
        frame.id,
        frame
      );
    }
  );

  return Array.from(
    uniqueFrames.values()
  );
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