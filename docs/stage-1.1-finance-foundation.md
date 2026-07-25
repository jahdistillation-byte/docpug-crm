# PUGCRM Stage 1.1: финансовый фундамент и документы расходов

Этот handoff описывает только реализованный срез Stage 1.1. Он не разрешает
применение SQL к hosted Supabase, deploy backend/frontend, push или любые иные
production-изменения. Такие действия выполняются только после отдельного review,
backup и явного разрешения владельца.

На момент подготовки документа production не изменялся. Stage 1.2 (полный
lifecycle закупок, оплата поставщику и auto-receive) в этот срез не входит.

## Реализованный scope

### База данных

Migration
`supabase/migrations/20260721184132_stage_1_1_expense_documents.sql` добавляет:

- `financial_accounts` — UAH-счета типов `cash`, `bank`, `terminal`, `other`;
- `expense_documents` — документы обычных и маркетинговых расходов;
- `finance_documents` — приватные метаданные вложений;
- `recurring_expense_templates` — ручные шаблоны регулярных расходов;
- `finance_audit_log` — append-only история финансовых действий;
- новые измерения в `finance_transactions`: `accounting_kind`,
  `financial_account_id`, ссылки на expense/procurement/payroll и
  `reverses_transaction_id`.

Для каждой организации создаются четыре системных счета по умолчанию. Существующие
completed manual expenses backfill-ятся в `expense_documents` как legacy paid
documents; исходные строки `finance_transactions` не заменяются и не создаются
повторно. Migration связывает существующую транзакцию с новым документом.

Migration также создаёт private bucket `finance-documents` и ограничивает его
размером 10 MiB и MIME-типами PDF, JPEG, PNG, WebP, HEIC и HEIF. Новые таблицы
включены в security-модель Stage 0.1: браузер не получает прямого доступа к
таблицам или RPC, прикладной доступ выполняется server-only ролью Flask.

### Backend

В `server.py` реализованы:

- список финансовых счетов;
- реестр, карточка, создание и разрешённое редактирование expense documents;
- переходы `planned -> paid`, `planned -> cancelled`, `paid -> reversed`;
- атомарные денежные операции, audit trail, optimistic version checks и
  idempotent replay;
- загрузка приватных вложений и выдача короткоживущей signed URL;
- CRUD/deactivation и ручное подтверждение recurring templates;
- серверные CPL, CAC и ROAS;
- decimal-string контракт для новых финансовых API и оплаты визита;
- безопасные пользовательские ошибки без выдачи текста исключения БД.

Старый `POST /api/finance/transactions` больше не принимает
`transaction_type=expense`: обычная витрата создаётся только как документ.
Deposit/withdrawal остаются существующими cash-flow операциями и получают
`accounting_kind`/financial account.

### Frontend

Раздел «Витрати» содержит четыре рабочие области:

- «Усі витрати» — реестр, поиск, период, статус, категория, пагинация, KPI,
  сравнение с предыдущим периодом, карточка и lifecycle-действия;
- «Закупівлі» — существующий закупочный UI, без нового Stage 1.2 lifecycle;
- «Постачальники» — существующие поиск/создание и просмотр контрагентов;
- «Регулярні витрати» — создание, редактирование и ручное подтверждение
  шаблонов.

Форма expense document поддерживает `planned` и `paid`, обычные и маркетинговые
поля, выбор финансового счёта, вложения и безопасные modal-сценарии без browser
`alert`. Адаптивные стили добавлены для текущих mobile breakpoints и тем, но
визуальная приёмка на реальных устройствах остаётся обязательной.

## Бухгалтерские инварианты

- Валюта Stage 1.1 — только UAH.
- Все суммы PostgreSQL хранятся как `numeric`; финансовые суммы API передаются и
  возвращаются строками с двумя десятичными знаками, например `"123.40"`.
- JSON number/float, scientific notation, запятая, знак, более двух знаков после
  точки, ноль/отрицательная сумма и сумма больше `1000000000.00` отклоняются.
- `planned` не создаёт `finance_transactions` и не входит ни в P&L, ни в cash
  flow.
- `paid` создаёт одну completed-транзакцию `expense` с
  `accounting_kind=operating_expense`: расход признаётся в P&L и одновременно
  является денежным оттоком.
- Финансовые поля paid-документа неизменяемы. Разрешены только metadata-поля:
  `description`, `counterparty`, `document_number`, `document_url` и marketing
  attribution. Исправление денежного результата выполняется сторно.
- Сторно не удаляет и не переписывает исходную проводку. Оно создаёт отдельный
  reversal document и completed-транзакцию `deposit` с
  `accounting_kind=operating_expense_reversal`, связанную с исходной через
  `reverses_transaction_id`.
- Сторно относится к своему фактическому периоду. Оно не должно задним числом
  убирать исходный расход из периода исходной оплаты.
- `cancelled` допустим только для `planned` и не создаёт денежной транзакции.
- Категории закупок/оплат поставщикам и зарплаты зарезервированы и отклоняются
  как operating expense. Их нельзя использовать для будущего двойного учёта.
- Marketing attribution разрешена только категории «Маркетинг»/`Marketing`;
  `new_clients <= leads`. CPL = spend / leads, CAC = spend / new clients,
  ROAS = attributed revenue / spend. Все исходные данные вводятся вручную.
- Recurring template сам по себе не создаёт документ, P&L или cash flow.
  Действие «Створити план» создаёт только `planned` expense document.
- Список документов фильтруется по `expense_date`; paid/reversal KPI берутся
  из ledger по `finance_transactions.occurred_at` в `Europe/Kyiv`.
  Previous-period comparison использует непосредственно предыдущий
  период той же длины.
- Все чтения и записи ограничены `org_id` защищённой сессии. `org_id` из browser
  payload не является частью API-контракта.

## Общий API-контракт

Все перечисленные маршруты требуют активную роль `owner` или `admin`. Для
успеха используется envelope `{"ok": true, "data": ...}`, для ошибки —
`{"ok": false, "error": "..."}`.

Основные коды ответа:

- `200` — чтение, mutation или idempotent replay;
- `201` — первичное создание документа/шаблона или загрузка файла;
- `400` — невалидный UUID/date/decimal-string/payload;
- `403` — роль не имеет доступа;
- `404` — tenant-scoped сущность не найдена;
- `409` — stale `version`, недопустимый lifecycle-переход или попытка создать
  legacy expense через общий журнал;
- `500` — безопасная общая ошибка без сырого текста Supabase/PostgreSQL.

### Точные endpoints

| Method | Path | Назначение и основные параметры |
|---|---|---|
| `GET` | `/api/finance/financial-accounts` | Список активных счетов организации; `include_inactive=true` включает неактивные. |
| `GET` | `/api/finance/expense-documents` | Реестр и server-side overview. Query: `date_from`, `date_to`, `status`, `category`, `search`, `limit` (1–200), `offset`; период не более 366 дней. |
| `POST` | `/api/finance/expense-documents` | Создать `planned` или `paid` документ. Первое создание — `201`, replay — `200`. |
| `GET` | `/api/finance/expense-documents/<document_id>` | Карточка, безопасные метаданные вложений и audit trail. |
| `PATCH` | `/api/finance/expense-documents/<document_id>` | Разрешённое редактирование с обязательным `version`. |
| `POST` | `/api/finance/expense-documents/<document_id>/pay` | Атомарно оплатить planned-документ; обязательны `version`, UUID `idempotency_key`, `payment_method`, `financial_account_id`. |
| `POST` | `/api/finance/expense-documents/<document_id>/cancel` | Отменить planned-документ; обязательны `version` и непустой `reason`. |
| `POST` | `/api/finance/expense-documents/<document_id>/reverse` | Сторнировать paid-документ; обязательны `version`, UUID `idempotency_key` и `reason`. |
| `POST` | `/api/finance/expense-documents/<document_id>/attachments` | `multipart/form-data`, поле `file`; допустим только planned/paid, успех `201`. |
| `GET` | `/api/finance/expense-documents/<document_id>/attachments/<attachment_id>/download` | Получить signed URL на 300 секунд. |
| `GET` | `/api/finance/recurring-expense-templates` | Список; query `include_inactive=true`, `search`. |
| `POST` | `/api/finance/recurring-expense-templates` | Создать шаблон с UUID `idempotency_key`; первое создание `201`, replay `200`. |
| `GET` | `/api/finance/recurring-expense-templates/<template_id>` | Получить один tenant-scoped шаблон. |
| `PATCH` | `/api/finance/recurring-expense-templates/<template_id>` | Обновить шаблон с обязательным `version`. |
| `DELETE` | `/api/finance/recurring-expense-templates/<template_id>` | Мягко деактивировать шаблон (`is_active=false`); JSON body содержит `version`. |
| `POST` | `/api/finance/recurring-expense-templates/<template_id>/confirm` | Вручную создать planned document; UUID `idempotency_key`, optional `expense_date`/`due_date`. |

Существующие `GET /api/finance/overview`,
`GET /api/finance/expenses/overview`, `GET /api/finance/transactions` и
`POST /api/visits/<visit_id>/payments` сохранены. Их денежные ответы также
нормализуются в decimal-строки; payment write принимает сумму только строкой.

### Пример создания planned expense

```json
{
  "idempotency_key": "11111111-1111-4111-8111-111111111111",
  "status": "planned",
  "amount": "123.40",
  "currency": "UAH",
  "category": "Оренда",
  "subcategory": "Кабінет",
  "description": "Оренда за серпень",
  "counterparty": "ТОВ Орендодавець",
  "document_number": "INV-2026-08",
  "document_url": "https://example.invalid/invoice/2026-08",
  "expense_date": "2026-08-01",
  "due_date": "2026-08-05"
}
```

Для `status=paid` дополнительно обязательны `payment_method` (`cash`, `card`,
`terminal`, `transfer`, `other`) и UUID `financial_account_id` совместимого типа.

Marketing-блок имеет только следующий контракт:

```json
{
  "marketing": {
    "campaign": "Літня вакцинація",
    "channel": "Instagram",
    "leads": 20,
    "new_clients": 5,
    "revenue": "2500.00"
  }
}
```

### Idempotency и optimistic version

- В API idempotency key — обязательный UUID для create expense, pay, reverse,
  create recurring template и confirm recurring template.
- Один ключ относится к одной операции внутри организации. Повтор после
  потерянного ответа возвращает существующий результат с
  `idempotent_replay=true` и не создаёт новую строку или проводку.
- UI создаёт ключ один раз при открытии/подтверждении операции и повторно
  использует его при retry.
- `version` — положительное целое число из последней прочитанной карточки.
  Изменяющие RPC блокируют строку, сравнивают версию и увеличивают её после
  успешной mutation. Stale version возвращается клиенту как HTTP `409`.
- Перед повторной пользовательской попыткой после `409` карточку нужно
  перечитать, а не увеличивать version на клиенте.

## Private attachments

- Bucket: `finance-documents`, `public=false`.
- Максимум: 10 MiB.
- Допустимы PDF, JPEG/JPG, PNG, WebP, HEIC, HEIF.
- Backend сверяет расширение, заявленный MIME и сигнатуру содержимого; HTML,
  переименованный в PDF, отклоняется.
- Storage path формируется сервером как
  `<org_id>/<expense_document_id>/<attachment_uuid>-<safe_name>`.
- В API не возвращаются `storage_bucket`, `storage_path` и SHA-256 checksum.
- Download endpoint повторно проверяет `org_id`, document ID, attachment ID и
  префикс пути, затем выдаёт signed URL на 300 секунд.
- Если upload прошёл, а ответ metadata insert потерялся, backend сначала
  проверяет детерминированный attachment ID в БД и удаляет объект только когда
  подтверждено отсутствие metadata row.
- Отдельного DELETE endpoint для вложений в Stage 1.1 нет.
- Публичный bucket `patient-files` для финансовых документов не используется.

## Migration order и локальная проверка

Используется закреплённая Supabase CLI `2.109.1`; команды без версии или `latest`
не являются воспроизводимым handoff.

Порядок схемы неизменяем:

1. проверенный production-equivalent schema-only baseline без данных и секретов;
2. `supabase/migrations/20260721081533_stage_0_1_database_security_baseline.sql`;
3. `supabase/migrations/20260721184132_stage_1_1_expense_documents.sql`.

Stage 1.1 содержит preflight и не предназначена для пустой базы. Нельзя менять
порядок, отмечать Stage 1.1 применённой вручную или использовать test fixture как
production baseline.

Поднять изолированный локальный Supabase:

```bash
npx --yes supabase@2.109.1 start
```

После загрузки baseline применить Stage 0.1 и Stage 1.1 с
`ON_ERROR_STOP=1`. Если migrations применялись через CLI-managed workflow,
дополнительно проверить migration history:

```bash
npx --yes supabase@2.109.1 migration list --local
```

Тестовый harness, который выполняет SQL-файлы напрямую через `psql`,
не записывает `supabase_migrations.schema_migrations`; для него пустая
CLI history не опровергает фактический SQL test run.

Запустить pgTAP-контракты в порядке этапов:

```bash
npx --yes supabase@2.109.1 test db --local \
  supabase/tests/database/stage_0_1_security_baseline.sql

npx --yes supabase@2.109.1 test db --local \
  supabase/tests/database/stage_1_1_expense_documents.sql
```

Test-only fixture `supabase/tests/fixtures/stage_0_1_legacy_schema.sql` допустим
для изолированной проверки migration/ACL-контрактов. Он не является полной
production-схемой и запрещён для hosted project. Финальный SQL review должен
повторно проверить org scope, RLS/grants, function execute privileges,
idempotency, row locks, status transitions, legacy backfill и accounting-period
semantics на production-equivalent snapshot.

Проверки приложения:

```bash
node --check app.js
PYTHONPYCACHEPREFIX=/tmp/docpug-pycache python3 -m py_compile server.py
python3 -m unittest discover -s tests -v
git diff --check
```

Дополнительно выполнить SQL advisors после применения обеих migrations на
локальном production-equivalent snapshot. Зелёный fixture-тест сам по себе не
заменяет advisors и ручной E2E.

## Manual E2E checklist

Ниже — обязательный сценарий приёмки. UUID в примерах нужно заменить UUID из
тестовой организации. Для каждого шага сохранить request, response, HTTP status
и SQL before/after по указанным таблицам.

1. **Tenant и роль.** Выполнить
   `GET /api/finance/expense-documents?date_from=2026-07-01&date_to=2026-07-31`
   под owner/admin: ожидается `200`, только строки текущей организации. Под
   vet/assistant: `403`; изменений таблиц нет.
2. **Planned create и replay.** Отправить пример planned payload выше:
   ожидается `201`; одна строка `expense_documents(status=planned)`, одна audit
   row, новых `finance_transactions` нет. Повторить тот же payload с тем же
   `idempotency_key`: `200`, `idempotent_replay=true`, counts не меняются.
3. **Optimistic edit.** Выполнить
   `PATCH /api/finance/expense-documents/<id>` с
   `{"version":1,"amount":"130.00","description":"Уточнено"}`:
   ожидается `200`, amount обновлён, version увеличен на один, добавлен audit,
   transaction отсутствует. Повтор со старой version: `409`, изменений нет.
4. **Planned cancel.** Для отдельного planned документа вызвать `/cancel` с
   `{"version":1,"reason":"Дублікат"}`: `200`, status `cancelled`, audit
   добавлен, transaction не создан.
5. **Оплата.** Для planned документа вызвать `/pay` с
   `{"version":2,"idempotency_key":"<uuid>","paid_at":"2026-07-21T12:00:00+03:00","payment_method":"cash","financial_account_id":"<cash-account-uuid>"}`:
   `200`; документ `paid`, version +1, одна completed строка
   `finance_transactions(type=expense, accounting_kind=operating_expense)` с
   тем же org/account и ссылкой на документ, плюс audit. Повтор с тем же ключом:
   `200`, replay без второй транзакции.
6. **Paid immutability.** Попробовать PATCH paid-документа с новой `amount`:
   `400`, документ/ledger неизменны. PATCH только `description` и marketing с
   актуальной version: `200`, денежные поля и transaction неизменны.
7. **Сторно и период.** Вызвать `/reverse` с актуальной version, UUID key и
   причиной: `200`; исходный документ `reversed`, создан один reversal document,
   одна completed transaction `deposit/operating_expense_reversal`, ссылки и
   audits согласованы. Повтор ключа не создаёт дубликатов. Если исходная оплата и
   сторно имеют разные отчётные периоды, исходный расход остаётся в первом, а
   компенсация появляется только во втором.
8. **Marketing.** Создать paid «Маркетинг» с spend `"100.00"`, 4 leads, 2 new
   clients и revenue `"300.00"`: документ и overview возвращают CPL `"25.00"`,
   CAC `"50.00"`, ROAS `"3.00"`. `new_clients > leads` и marketing-поля в
   другой категории дают `400` и не меняют таблицы.
9. **Reserved categories.** Создание обычной витраты с «Закупівля препаратів»,
   «Оплата постачальнику» или «Зарплата» даёт `400`; нет document, transaction и
   audit. `POST /api/finance/transactions` с `transaction_type=expense` даёт
   `409`.
10. **Recurring template.** Создать monthly/quarterly/yearly template: `201`,
    одна template row и audit, без document/transaction. Подтвердить через
    `/confirm` с UUID key и датами: `200`, создаётся один planned document,
    template получает `last_created_document_id`, следующую дату и version +1;
    transaction не создаётся. Retry ключа не создаёт второй план.
11. **Вложение.** Загрузить настоящий PDF через multipart endpoint: `201`, один
    private object и одна `finance_documents` row; response не содержит path,
    bucket или checksum. Переименованный HTML и файл >10 MiB: `400`, metadata
    отсутствует. Download: `200`, URL живёт 300 секунд и не работает через ID
    другой организации/документа (`404`).
12. **Legacy backfill.** До migration зафиксировать количество completed manual
    expenses. После migration для каждой исходной строки существует ровно один
    legacy paid document и link, но исходная сумма, дата, type/status/source и
    число транзакций не изменились.
13. **UI.** Проверить «Усі витрати / Закупівлі / Постачальники / Регулярні
    витрати», фильтры периода/статуса/категории/поиска, пагинацию, карточки,
    create/edit/pay/cancel/reverse, upload/download, retry после `409`, empty/error
    states и отсутствие `alert`. Повторить в каждой существующей теме и на
    desktop, tablet и mobile widths; отдельно проверить длинные украинские строки
    и клавиатурный focus.

Этот checklist является инструкцией, а не заявлением, что production E2E уже
выполнен.

## Что не входит в Stage 1.1

- supplier payments, creditor liability/advance и cancellation/ordering lifecycle
  закупки;
- receipt history, idempotent partial/full receive и `received_now` auto-receive;
- долги, кассовые смены, payroll и отчёты/exports;
- автоматическое создание документов из recurring templates;
- FX, ROMI, XLSX и авторассылки.

Все изменения procurement и auto-receive относятся к Stage 1.2 и требуют
отдельной приёмки.

## Production handoff — только после отдельного разрешения

1. Создать backup и новый schema/ACL/function/storage snapshot production.
2. Сравнить snapshot с тем baseline, на котором локально прошли migrations,
   pgTAP, advisors и E2E; отдельно проверить число legacy manual expenses и
   отсутствие orphan org/user links.
3. Применить только reviewed delta migrations в порядке Stage 0.1 -> Stage 1.1.
4. Проверить SQL invariants, RLS/privileges, private bucket и advisors.
5. Deploy backend, затем frontend.
6. Выполнить smoke/manual E2E выше и сверить audit/ledger effects.
7. При ошибке использовать отдельную reviewed corrective migration и
   сохранённые snapshots; не делать несогласованные ручные правки.

Codex в рамках этого среза самостоятельно не выполняет production migration,
deploy, git push, destructive cleanup или переход к Stage 1.2.
