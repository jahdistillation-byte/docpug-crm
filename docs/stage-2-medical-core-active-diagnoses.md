# Stage 2: Medical Core — активные диагнозы

Статус: реализация подготовлена локально; production migration не применялась.

## Что добавлено

- `patient_diagnoses`: структурированный диагноз, который живёт между визитами.
- `patient_diagnosis_events`: неизменяемая история медицинских изменений.
- Статусы: `active`, `remission`, `resolved`, `entered_in_error`.
- Подтверждение: `provisional`, `confirmed`.
- Тяжесть: `mild`, `moderate`, `severe`, `critical`.
- Оптимистичная блокировка через `version`.
- Запрет физического удаления диагнозов и изменения событий аудита.
- Проверка, что визит-источник принадлежит той же клинике и пациенту.
- Flask API с обязательным `org_id` из защищённой сессии.
- Запись для ролей `owner`, `admin`, `vet`; ассистенту доступно чтение.
- Адаптивный блок Medical Core в обзоре карточки пациента.

## API

- `GET /api/patients/<patient_id>/diagnoses?scope=active`
- `GET /api/patients/<patient_id>/diagnoses?scope=history`
- `POST /api/patients/<patient_id>/diagnoses`
- `PUT /api/patient-diagnoses/<diagnosis_id>`
- `GET /api/patient-diagnoses/<diagnosis_id>/events`

Обновление требует текущий `version`. При параллельном изменении API отвечает
`409` и не перетирает более свежую запись.

## Миграция

Файл:

`supabase/migrations/20260809110450_medical_core_active_diagnoses.sql`

Preflight намеренно проверяет production-shaped UUID-колонки:

- `orgs.id`;
- `patients.id`, `patients.org_id`;
- `visits.id`, `visits.org_id`, `visits.pet_id`.

Если production schema отличается, migration завершится до изменений. Нельзя
удалять preflight ради применения миграции: сначала нужно получить актуальный
schema-only snapshot и адаптировать типы после review.

Новые таблицы явно закрыты от `PUBLIC`, `anon`, `authenticated`. Flask работает
через server-only `service_role`, которому выданы только необходимые права.

## Проверки

Backend:

```bash
python3 -m unittest tests.test_patient_diagnoses_api tests.test_patients_api
```

Database contract использует отдельный test-only fixture:

- `supabase/tests/fixtures/medical_core_active_diagnoses_schema.sql`;
- `supabase/tests/database/medical_core_active_diagnoses.sql`.

Контракт проверяет RLS/ACL, tenant-safe связь с визитом, аудит, версии,
неизменяемость ошибочной записи и запрет физического удаления.

## Перед production

1. Получить свежий schema-only snapshot production.
2. Сверить типы и constraints `orgs`, `patients`, `visits`, `clinic_users`.
3. Сделать backup и сохранить ACL/policy snapshots.
4. Применить migration на production-equivalent локальной базе.
5. Запустить database contract и advisors.
6. Выполнить ручной QA карточки пациента на desktop, tablet и mobile.
7. Проверить роли owner/admin/vet/assistant и две разные клиники.
8. Только после отдельного разрешения применять migration и deploy.

## Ручной UX smoke test

1. Открыть пациента без диагнозов: отображается нейтральное состояние, которое
   не утверждает, что пациент здоров.
2. Создать подтверждённый и предварительный диагнозы.
3. Изменить тяжесть и проверить обновление `version`.
4. Перевести активный диагноз в ремиссию и вернуть обратно.
5. Завершить диагноз и проверить полную историю.
6. Пометить запись ошибочной с обязательной причиной.
7. Убедиться, что ошибочную запись нельзя редактировать или удалить.
8. Открыть журнал и проверить автора, время и причину изменения.
9. Проверить конфликт двух одновременно открытых форм.
10. Повторить на ширине мобильного экрана и в светлой теме.
